import { EventEmitter } from "node:events";
import type { Dirent } from "node:fs";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createWorkbench } from "../workbench/app.js";
import { filterDeletedGitFiles, filterRepositoryFiles, parseGitFileList } from "../workbench/navigator.js";
import { buildGitListingInvocation, createGitFileLister, createNodeWorkspace, createGitOptionalFileLister } from "../workbench/node/workspace.js";
import { createFilesystemFileLister } from "../workbench/node/filesystem-list.js";

function fakeDirent(name: string, kind: "file" | "directory"): Dirent {
  return {
    name,
    isFile: () => kind === "file",
    isDirectory: () => kind === "directory",
    isSymbolicLink: () => false,
  } as unknown as Dirent;
}

function fakeDirectoryHandle(entries: Dirent[]) {
  return {
    async *[Symbol.asyncIterator]() { yield* entries; },
    close: async () => {},
  };
}

async function withTempDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "pi-code-diff-workbench-listing-"));
  try { await run(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

describe("workbench navigation", () => {
  it("parses NUL-delimited Git metadata, filters files, and defers content reads until selection", async () => {
    const readText = vi.fn(async (path: string) => ({ text: `contents of ${path}`, revision: `revision:${path}` }));
    const workbench = createWorkbench({
      listFiles: async () => "src/with space.ts\0src/line\nname.ts\0\0",
      readText,
      saveText: async () => ({ status: "error", message: "not used" }),
      maxReadBytes: 1024,
    });

    await workbench.start();
    expect(workbench.files).toEqual(["src/with space.ts", "src/line\nname.ts"]);
    expect(readText).not.toHaveBeenCalled();

    workbench.setFilter("space");
    expect(workbench.visibleFiles).toEqual(["src/with space.ts"]);
    await workbench.selectVisibleFile(0);

    expect(readText).toHaveBeenCalledOnce();
    expect(readText).toHaveBeenCalledWith("src/with space.ts", 1024);
    expect(workbench.selectedText).toBe("contents of src/with space.ts");
    expect(workbench.selectedText).toBe(workbench.bufferText);
  });

  it("publishes a warmed repository tree atomically and restores an empty warmed tree on dispose", async () => {
    const workbench = createWorkbench({
      listFiles: async () => "src/a.ts\0src/b.ts\0README.md\0",
      readText: async () => ({ text: "", revision: "r" }),
      saveText: async () => ({ status: "error", message: "unused" }),
      maxReadBytes: 1,
    });
    const emptyTree = workbench.repositoryTree;
    expect(emptyTree.rows()).toBe(emptyTree.rows());

    await workbench.start();

    expect(workbench.repositoryTree).not.toBe(emptyTree);
    expect(workbench.repositoryTree.rows()).toBe(workbench.repositoryTree.rows());
    expect(workbench.repositoryTree.rows().map((row) => row.key)).toEqual([
      "folder:", "folder:src", "file:README.md",
    ]);

    workbench.dispose();
    expect(workbench.repositoryTree).not.toBe(emptyTree);
    expect(workbench.repositoryTree.rows()).toBe(workbench.repositoryTree.rows());
    expect(workbench.repositoryTree.rows().map((row) => row.key)).toEqual(["folder:"]);
  });

  it("passes an optional startup AbortSignal to repository listing", async () => {
    const listFiles = vi.fn(async () => "file.ts\0");
    const workbench = createWorkbench({
      listFiles,
      readText: async () => ({ text: "", revision: "r" }),
      saveText: async () => ({ status: "error", message: "unused" }),
      maxReadBytes: 1,
    });
    const controller = new AbortController();

    await workbench.start(controller.signal);

    expect(listFiles).toHaveBeenCalledExactlyOnceWith(controller.signal);
  });

  it("rejects deferred reads that escape the repository or exceed host limits", async () => {
    const readText = vi.fn();
    const workbench = createWorkbench({
      listFiles: async () => "safe.ts\0../outside.ts\0large.ts\0",
      readText,
      saveText: async () => ({ status: "error", message: "not used" }),
      maxReadBytes: 100,
      canReadFile: async (path) => path === "safe.ts",
    });

    await workbench.start();
    await expect(workbench.selectFile("../outside.ts")).rejects.toThrow("outside the repository");
    await expect(workbench.selectFile("large.ts")).rejects.toThrow("not readable");
    expect(readText).not.toHaveBeenCalled();
  });

  it("preserves empty records only as separators", () => {
    expect(parseGitFileList("a.ts\0\0b.ts\0")).toEqual(["a.ts", "b.ts"]);
  });

  it("removes deleted tracked paths from worktree navigation metadata", () => {
    expect(filterDeletedGitFiles("kept.ts\0deleted.ts\0new.ts\0", "deleted.ts\0")).toBe("kept.ts\0new.ts\0");
  });

  it("uses the existing canonical root as workspace identity without listing files", async () => {
    const repository = await createNodeWorkspace(process.cwd());

    expect(repository.workspaceKey).toBe(await realpath(process.cwd()));
  });

  it("discovers a bounded, safe filesystem listing outside Git", async () => {
    await withTempDirectory(async (root) => {
      await mkdir(join(root, "src"));
      await mkdir(join(root, ".git"));
      await mkdir(join(root, "node_modules"));
      await mkdir(join(root, "dist"));
      await writeFile(join(root, "README.md"), "readme\n");
      await writeFile(join(root, "src", "main.ts"), "export {}\n");
      await writeFile(join(root, ".git", "config"), "not a repository\n");
      await writeFile(join(root, "node_modules", "package.js"), "generated\n");
      await writeFile(join(root, "dist", "bundle.js"), "generated\n");
      const outside = join(root, "outside.ts");
      await writeFile(outside, "outside\n");
      try { await symlink(outside, join(root, "linked.ts")); } catch { /* Symlinks are optional in this environment. */ }

      const listing = await createFilesystemFileLister(await realpath(root))(new AbortController().signal);
      expect(parseGitFileList(listing)).toEqual(["README.md", "outside.ts", "src/main.ts"]);

      const repository = await createNodeWorkspace(root);
      await expect(repository.listFiles()).resolves.toBe("README.md\0outside.ts\0src/main.ts\0");
    });
  });

  it.each([
    ["not-a-repository", async (root: string) => undefined],
    ["broken-repository", async (root: string) => { await writeFile(join(root, ".git"), "gitdir: /missing/repository\n"); }],
  ])("falls back to filesystem discovery for a %s Git listing", async (_label, prepare) => {
    await withTempDirectory(async (root) => {
      await writeFile(join(root, "source.ts"), "source\n");
      await prepare(root);
      const repository = await createNodeWorkspace(root);
      await expect(repository.listFiles()).resolves.toBe("source.ts\0");
    });
  });

  it("falls back for malformed, oversized, and timed Git listings but never swallows unconfirmed closure", async () => {
    await withTempDirectory(async (root) => {
      await writeFile(join(root, "source.ts"), "source\n");
      const fallback = createFilesystemFileLister(await realpath(root));
      for (const failure of [
        new Error("malformed Git output"),
        new Error("Git file listing output exceeded its maxBuffer byte limit."),
        new Error("Git file listing timed out."),
      ]) {
        await expect(createGitOptionalFileLister(fallback, async () => { throw failure; })(new AbortController().signal)).resolves.toBe("source.ts\0");
      }
      await expect(createGitOptionalFileLister(fallback, async () => { throw Object.assign(new Error("child did not close"), { code: "CHILD_CLOSURE_UNCONFIRMED" }); })(new AbortController().signal))
        .rejects.toMatchObject({ code: "CHILD_CLOSURE_UNCONFIRMED" });
    });
  });

  it("uses exact hermetic Git listing invocations and excludes untracked internal save artifacts", () => {
    const files = buildGitListingInvocation("/repo", ["ls-files", "--cached", "--others", "--exclude=.pi-workbench-*", "--exclude-standard", "-z"]);
    expect(files.args).toEqual(["-c", "core.fsmonitor=false", "ls-files", "--cached", "--others", "--exclude=.pi-workbench-*", "--exclude-standard", "-z"]);
    expect(files.options.env).toMatchObject({
      GIT_NO_LAZY_FETCH: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_PAGER: "cat",
      GIT_TERMINAL_PROMPT: "0",
    });
    expect(() => buildGitListingInvocation("/repo", ["ls-files", "--recurse-submodules", "-z"])).toThrow("not allowlisted");
  });

  it("bounds, times out, and aborts Git file listing with SIGKILL escalation", async () => {
    vi.useFakeTimers();
    const makeIgnoringChild = () => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn((signal: NodeJS.Signals) => { if (signal === "SIGKILL") child.emit("close", null); return true; }),
      });
      return child;
    };

    const timedChildren = [makeIgnoringChild(), makeIgnoringChild()];
    let timedIndex = 0;
    const timed = createGitFileLister(() => timedChildren[timedIndex++] as never, 10, 32, 5)(new AbortController().signal);
    const timeoutRejection = expect(timed).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(10);
    for (const child of timedChildren) expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    await vi.advanceTimersByTimeAsync(5);
    await timeoutRejection;
    for (const child of timedChildren) expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);

    const abortChildren = [makeIgnoringChild(), makeIgnoringChild()];
    let abortIndex = 0;
    const controller = new AbortController();
    const aborted = createGitFileLister(() => abortChildren[abortIndex++] as never, 100, 32, 5)(controller.signal);
    const abortRejection = expect(aborted).rejects.toThrow("cancelled");
    controller.abort(new Error("cancelled"));
    await vi.advanceTimersByTimeAsync(5);
    await abortRejection;
    for (const child of abortChildren) expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);

    const boundedChildren = [makeIgnoringChild(), makeIgnoringChild()];
    let boundedIndex = 0;
    const bounded = createGitFileLister(() => boundedChildren[boundedIndex++] as never, 100, 8, 5)(new AbortController().signal);
    const boundedRejection = expect(bounded).rejects.toThrow("output exceeded");
    boundedChildren[0].stdout.write("🙂🙂🙂");
    await vi.advanceTimersByTimeAsync(10);
    await boundedRejection;
    vi.useRealTimers();
  });

  it("joins a closed Git-list sibling while kill error closure remains unconfirmed", async () => {
    vi.useFakeTimers();
    try {
      const killError = Object.assign(new Error("kill EPERM"), { code: "EPERM" });
      const stuck = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn((signal: NodeJS.Signals) => { if (signal === "SIGTERM") stuck.emit("error", killError); return false; }),
      });
      const closed = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn(() => true),
      });
      const children = [stuck, closed];
      let index = 0;
      const pending = createGitFileLister(() => children[index++] as never, 100, 8, 5)(new AbortController().signal);
      let settled = false;
      const observed = pending.then(
        (value) => { settled = true; return value; },
        (error: unknown) => { settled = true; throw error; },
      );
      const rejected = expect(observed).rejects.toMatchObject({ code: "CHILD_CLOSURE_UNCONFIRMED" });

      stuck.stdout.write("file.ts\0x");
      closed.emit("close", 2);
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(stuck.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
      expect(closed.kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5);
      expect(settled).toBe(false);
      expect(stuck.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
      await vi.advanceTimersByTimeAsync(5);

      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels the sibling Git listing command when either command fails", async () => {
    const children = Array.from({ length: 2 }, () => Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(function (this: EventEmitter) { this.emit("close", null); return true; }),
    }));
    const spawned: typeof children = [];
    const pending = createGitFileLister(() => {
      const child = children[spawned.length];
      spawned.push(child);
      return child as never;
    })(new AbortController().signal);

    spawned[0]?.emit("close", 2);

    await expect(pending).rejects.toThrow("Git file listing failed");
    expect(spawned[1]?.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
  });

  it("selects stable filesystem paths before file, directory, and byte caps", async () => {
    await withTempDirectory(async (root) => {
      const canonicalRoot = await realpath(root);
      const openWith = (entries: Dirent[], children: Dirent[] = []) => async (path: string) =>
        fakeDirectoryHandle(path === canonicalRoot ? entries : children);
      const fileEntries = ["z.txt", "m.txt", "a.txt"].map((name) => fakeDirent(name, "file"));
      const reverseFileEntries = [...fileEntries].reverse();
      const fileCapped = await createFilesystemFileLister(canonicalRoot, {
        maxFiles: 2,
        maxDirectories: 1,
        openDirectory: openWith(reverseFileEntries),
      })(new AbortController().signal);
      const fileCappedAgain = await createFilesystemFileLister(canonicalRoot, {
        maxFiles: 2,
        maxDirectories: 1,
        openDirectory: openWith(fileEntries),
      })(new AbortController().signal);
      expect(fileCapped).toBe("a.txt\0m.txt\0");
      expect(fileCappedAgain).toBe(fileCapped);

      const byteCapped = await createFilesystemFileLister(canonicalRoot, {
        maxFiles: 10,
        maxDirectories: 1,
        maxOutputBytes: 6,
        openDirectory: openWith([fakeDirent("long", "file"), fakeDirent("b", "file"), fakeDirent("aa", "file")]),
      })(new AbortController().signal);
      const byteCappedAgain = await createFilesystemFileLister(canonicalRoot, {
        maxFiles: 10,
        maxDirectories: 1,
        maxOutputBytes: 6,
        openDirectory: openWith([fakeDirent("aa", "file"), fakeDirent("b", "file"), fakeDirent("long", "file")]),
      })(new AbortController().signal);
      expect(byteCapped).toBe("aa\0b\0");
      expect(byteCappedAgain).toBe(byteCapped);

      await Promise.all([mkdir(join(root, "a")), mkdir(join(root, "m")), mkdir(join(root, "z"))]);
      const directoryEntries = ["z", "m", "a"].map((name) => fakeDirent(name, "directory"));
      const childEntries = [fakeDirent("entry.ts", "file")];
      const directoryCapped = await createFilesystemFileLister(canonicalRoot, {
        maxFiles: 10,
        maxDirectories: 3,
        openDirectory: openWith(directoryEntries, childEntries),
      })(new AbortController().signal);
      const directoryCappedAgain = await createFilesystemFileLister(canonicalRoot, {
        maxFiles: 10,
        maxDirectories: 3,
        openDirectory: openWith([...directoryEntries].reverse(), childEntries),
      })(new AbortController().signal);
      expect(directoryCapped).toBe("a/entry.ts\0m/entry.ts\0");
      expect(directoryCappedAgain).toBe(directoryCapped);
    });
  });

  it("keeps nested descendants in the global path frontier under directory, file, and byte caps", async () => {
    await withTempDirectory(async (root) => {
      await mkdir(join(root, "a", "x"), { recursive: true });
      await mkdir(join(root, "z"));
      const canonicalRoot = await realpath(root);
      const canonicalA = await realpath(join(root, "a"));
      const canonicalX = await realpath(join(root, "a", "x"));
      const canonicalZ = await realpath(join(root, "z"));
      const openWith = (entries: Map<string, Dirent[]>) => async (path: string) => fakeDirectoryHandle(entries.get(path) ?? []);

      // Reverse injected enumeration must still discover a/x before z once a/x is expanded.
      const nestedDirectories = new Map<string, Dirent[]>([
        [canonicalRoot, [fakeDirent("z", "directory"), fakeDirent("a", "directory")]],
        [canonicalA, [fakeDirent("x", "directory")]],
        [canonicalX, [fakeDirent("file.ts", "file")]],
        [canonicalZ, []],
      ]);
      const directoryCapped = await createFilesystemFileLister(canonicalRoot, {
        maxFiles: 10,
        maxDirectories: 3,
        openDirectory: openWith(nestedDirectories),
      })(new AbortController().signal);
      expect(directoryCapped).toBe("a/x/file.ts\0");

      // A later root file cannot be admitted until the earlier directory frontier is visited.
      const nestedFiles = new Map<string, Dirent[]>([
        [canonicalRoot, [fakeDirent("z", "file"), fakeDirent("a", "directory")]],
        [canonicalA, [fakeDirent("x", "file")]],
      ]);
      const fileCapped = await createFilesystemFileLister(canonicalRoot, {
        maxFiles: 1,
        maxDirectories: 3,
        openDirectory: openWith(nestedFiles),
      })(new AbortController().signal);
      expect(fileCapped).toBe("a/x\0");
      const byteCapped = await createFilesystemFileLister(canonicalRoot, {
        maxFiles: 10,
        maxDirectories: 3,
        maxOutputBytes: 4,
        openDirectory: openWith(nestedFiles),
      })(new AbortController().signal);
      expect(byteCapped).toBe("a/x\0");

      const nulEntries = new Map<string, Dirent[]>([
        [canonicalRoot, [fakeDirent("bad\0root.ts", "file"), fakeDirent("a", "directory")]],
        [canonicalA, [fakeDirent("bad\0nested.ts", "file"), fakeDirent("x", "directory")]],
        [canonicalX, [fakeDirent("file.ts", "file")]],
      ]);
      const nulListing = await createFilesystemFileLister(canonicalRoot, {
        maxFiles: 10,
        maxDirectories: 3,
        openDirectory: openWith(nulEntries),
      })(new AbortController().signal);
      expect(nulListing).toBe("a/x/file.ts\0");
      expect(parseGitFileList(nulListing)).toEqual(["a/x/file.ts"]);
      expect(nulListing).not.toContain("bad");
    });
  });

  it("preserves a caller abort reason after an ordinary Git sibling failure", async () => {
    const children = Array.from({ length: 2 }, () => Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => true),
    }));
    const spawned: typeof children = [];
    const controller = new AbortController();
    const pending = createGitFileLister(() => {
      const child = children[spawned.length];
      spawned.push(child);
      return child as never;
    })(controller.signal);

    spawned[0].emit("close", 2);
    await Promise.resolve();
    const callerReason = new Error("caller cancelled");
    controller.abort(callerReason);
    spawned[1].emit("close", 0);

    await expect(pending).rejects.toBe(callerReason);
    expect(spawned[1].kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
  });

  it("keeps a non-empty fuzzy query bounded to the best 200 candidates", () => {
    const files = Array.from({ length: 300 }, (_, index) => `packages/app/src/Component${String(index).padStart(3, "0")}.tsx`);

    const results = filterRepositoryFiles(files, "component");

    expect(results).toHaveLength(200);
    expect(results[0]).toBe("packages/app/src/Component000.tsx");
    expect(results.at(-1)).toBe("packages/app/src/Component199.tsx");
  });
});
