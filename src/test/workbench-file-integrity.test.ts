import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createWorkbench } from "../workbench/app.js";
import { createNodeFileAccess } from "../workbench/node/repository.js";

async function withTempDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "pi-code-diff-workbench-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
}

async function lockPathFor(targetPath: string): Promise<string> {
  const canonicalTarget = await realpath(targetPath);
  const digest = createHash("sha256").update(canonicalTarget).digest("hex");
  return join(dirname(canonicalTarget), `.pi-workbench-${digest}.lock`);
}

const busyResult = {
  status: "error",
  message: "Another save is already in progress for this file; retry.",
} as const;

describe("workbench Node file integrity", () => {
  it("atomically saves text, preserves mode, and returns a refreshed revision", async () => {
    await withTempDirectory(async (root) => {
      const path = join(root, "source.ts");
      await writeFile(path, "const oldValue = 1;\n", "utf8");
      await chmod(path, 0o751);
      const access = await createNodeFileAccess(root, 1024);
      const loaded = await access.readText("source.ts", 1024);

      const result = await access.saveText("source.ts", "const newValue = 2;\n", loaded.revision);

      expect(result).toEqual({
        status: "success",
        effect: "saved",
        revision: expect.not.stringMatching(loaded.revision),
      });
      expect(await readFile(path, "utf8")).toBe("const newValue = 2;\n");
      expect((await stat(path)).mode & 0o777).toBe(0o751);
    });
  });

  it("uses a bounded internal temp basename when the target basename is long", async () => {
    await withTempDirectory(async (root) => {
      const name = `${"x".repeat(220)}.ts`;
      const path = join(root, name);
      await writeFile(path, "original\n", "utf8");
      let tempBasename = "";
      const access = await createNodeFileAccess(root, 1024, {
        renameFile: async (from, to) => {
          tempBasename = basename(from);
          await rename(from, to);
        },
      });
      const loaded = await access.readText(name, 1024);

      await expect(access.saveText(name, "saved\n", loaded.revision)).resolves.toEqual({
        status: "success",
        effect: "saved",
        revision: expect.any(String),
      });
      expect(tempBasename).toMatch(/^\.pi-workbench-[0-9a-f]{64}-\d+-[0-9a-f-]{36}\.tmp$/);
      expect(Buffer.byteLength(tempBasename)).toBeLessThanOrEqual(255);
      expect(await readFile(path, "utf8")).toBe("saved\n");
      expect(await readdir(root)).toEqual([name]);
    });
  });

  it("verifies a no-op save without creating an atomic replacement", async () => {
    await withTempDirectory(async (root) => {
      await writeFile(join(root, "source.ts"), "unchanged\n", "utf8");
      const access = await createNodeFileAccess(root, 1024);
      const loaded = await access.readText("source.ts", 1024);

      await expect(access.saveText("source.ts", loaded.text, loaded.revision)).resolves.toEqual({
        status: "success",
        effect: "unchanged",
        revision: loaded.revision,
      });
      expect(await readdir(root)).toEqual(["source.ts"]);
    });
  });

  it("serializes concurrent no-op validation without changing bytes", async () => {
    await withTempDirectory(async (root) => {
      const path = join(root, "source.ts");
      await writeFile(path, "unchanged\n", "utf8");
      const lockAcquired = deferred();
      const continueFirstSave = deferred();
      const firstAccess = await createNodeFileAccess(root, 1024, {
        openLockFile: async (lockPath) => {
          const handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
          lockAcquired.resolve();
          await continueFirstSave.promise;
          return handle;
        },
      });
      const secondAccess = await createNodeFileAccess(root, 1024);
      const firstLoaded = await firstAccess.readText("source.ts", 1024);
      const secondLoaded = await secondAccess.readText("source.ts", 1024);

      const firstSave = firstAccess.saveText("source.ts", firstLoaded.text, firstLoaded.revision);
      await lockAcquired.promise;
      try {
        await expect(secondAccess.saveText("source.ts", secondLoaded.text, secondLoaded.revision)).resolves.toEqual(busyResult);
      } finally {
        continueFirstSave.resolve();
      }

      await expect(firstSave).resolves.toEqual({
        status: "success",
        effect: "unchanged",
        revision: firstLoaded.revision,
      });
      await expect(secondAccess.saveText("source.ts", secondLoaded.text, secondLoaded.revision)).resolves.toEqual({
        status: "success",
        effect: "unchanged",
        revision: secondLoaded.revision,
      });
      expect(await readFile(path, "utf8")).toBe("unchanged\n");
      expect(await readdir(root)).toEqual(["source.ts"]);
    });
  });

  it("preserves a leading UTF-8 BOM through an exact clean save", async () => {
    await withTempDirectory(async (root) => {
      const path = join(root, "source.ts");
      const contents = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("const value = 1;\n", "utf8")]);
      await writeFile(path, contents);
      const access = await createNodeFileAccess(root, 1024);
      const loaded = await access.readText("source.ts", 1024);

      expect(loaded.text).toBe("\uFEFFconst value = 1;\n");
      await expect(access.saveText("source.ts", loaded.text, loaded.revision)).resolves.toEqual({
        status: "success",
        effect: "unchanged",
        revision: loaded.revision,
      });
      expect(await readFile(path)).toEqual(contents);
    });
  });

  it("rejects a dirty buffer that cannot round-trip exactly through UTF-8", async () => {
    await withTempDirectory(async (root) => {
      const path = join(root, "source.ts");
      await writeFile(path, "original\n", "utf8");
      const renameFile = vi.fn(async (from: string, to: string) => { await rename(from, to); });
      const removeFile = vi.fn(async () => {});
      const access = await createNodeFileAccess(root, 1024, { renameFile, removeFile });
      const workbench = createWorkbench({ ...access, listFiles: async () => "source.ts\0" });
      await workbench.start();
      await workbench.selectFile("source.ts");
      const loadedRevision = workbench.selectedRevision;
      workbench.replaceBuffer("edited \uD800\n");

      await expect(workbench.save()).resolves.toEqual({
        status: "error",
        message: "Edited text cannot be represented exactly as UTF-8.",
      });
      expect(renameFile).not.toHaveBeenCalled();
      expect(removeFile).not.toHaveBeenCalled();
      expect(await readFile(path, "utf8")).toBe("original\n");
      expect(await readdir(root)).toEqual(["source.ts"]);
      expect(workbench.selectedRevision).toBe(loadedRevision);
      expect(workbench.bufferText).toBe("edited \uD800\n");
      expect(workbench.isDirty).toBe(true);
    });
  });

  it("rejects a save when the file changed after the loaded revision", async () => {
    await withTempDirectory(async (root) => {
      const path = join(root, "source.ts");
      await writeFile(path, "loaded\n", "utf8");
      const access = await createNodeFileAccess(root, 1024);
      const loaded = await access.readText("source.ts", 1024);
      await writeFile(path, "external\n", "utf8");

      await expect(access.saveText("source.ts", "workbench\n", loaded.revision)).resolves.toEqual({
        status: "conflict",
        message: "File changed outside the workbench; reload before saving.",
      });
      expect(await readFile(path, "utf8")).toBe("external\n");
    });
  });

  it("allows only one same-revision save to report success across independent access instances", async () => {
    await withTempDirectory(async (root) => {
      const path = join(root, "source.ts");
      await writeFile(path, "loaded\n", "utf8");
      const renameReached = deferred();
      const continueRename = deferred();
      const firstAccess = await createNodeFileAccess(root, 1024, {
        renameFile: async (from, to) => {
          renameReached.resolve();
          await continueRename.promise;
          await rename(from, to);
        },
      });
      const secondAccess = await createNodeFileAccess(root, 1024);
      const firstLoaded = await firstAccess.readText("source.ts", 1024);
      const secondLoaded = await secondAccess.readText("source.ts", 1024);

      const firstSave = firstAccess.saveText("source.ts", "first writer\n", firstLoaded.revision);
      await renameReached.promise;
      try {
        await expect(secondAccess.saveText("source.ts", "second writer\n", secondLoaded.revision)).resolves.toEqual(busyResult);
      } finally {
        continueRename.resolve();
      }

      await expect(firstSave).resolves.toEqual({
        status: "success",
        effect: "saved",
        revision: expect.any(String),
      });
      expect(await readFile(path, "utf8")).toBe("first writer\n");
      await expect(secondAccess.saveText("source.ts", "second writer\n", secondLoaded.revision)).resolves.toEqual({
        status: "conflict",
        message: "File changed outside the workbench; reload before saving.",
      });
      expect(await readFile(path, "utf8")).toBe("first writer\n");
      expect(await readdir(root)).toEqual(["source.ts"]);
    });
  });

  it("does not steal or remove a preexisting fixed save lock", async () => {
    await withTempDirectory(async (root) => {
      const path = join(root, `${"x".repeat(200)}.ts`);
      await writeFile(path, "original\n", "utf8");
      const lockPath = await lockPathFor(path);
      await writeFile(lockPath, "foreign lock\n", { encoding: "utf8", mode: 0o600 });
      const access = await createNodeFileAccess(root, 1024);
      const loaded = await access.readText(basename(path), 1024);

      await expect(access.saveText(basename(path), "changed\n", loaded.revision)).resolves.toEqual(busyResult);
      expect(basename(lockPath)).toMatch(/^\.pi-workbench-[0-9a-f]{64}\.lock$/);
      expect(Buffer.byteLength(basename(lockPath))).toBeLessThanOrEqual(255);
      expect(await readFile(path, "utf8")).toBe("original\n");
      expect(await readFile(lockPath, "utf8")).toBe("foreign lock\n");
    });
  });

  it("does not follow, steal, or remove a preexisting save-lock symlink", async ({ skip }) => {
    await withTempDirectory(async (base) => {
      const root = join(base, "root");
      const outside = join(base, "outside-lock");
      const path = join(root, "source.ts");
      await mkdir(root);
      await writeFile(path, "original\n", "utf8");
      await writeFile(outside, "outside\n", "utf8");
      const lockPath = await lockPathFor(path);
      try {
        await symlink(outside, lockPath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EPERM" || code === "EACCES" || code === "ENOSYS") {
          skip(`Symlink creation is unsupported in this environment (${code}).`);
          return;
        }
        throw error;
      }
      const access = await createNodeFileAccess(root, 1024);
      const loaded = await access.readText("source.ts", 1024);

      await expect(access.saveText("source.ts", "changed\n", loaded.revision)).resolves.toEqual(busyResult);
      expect((await lstat(lockPath)).isSymbolicLink()).toBe(true);
      expect(await readFile(path, "utf8")).toBe("original\n");
      expect(await readFile(outside, "utf8")).toBe("outside\n");
    });
  });

  it("rejects lexical and symlink escapes without changing the outside file", async () => {
    await withTempDirectory(async (base) => {
      const root = join(base, "root");
      const outside = join(base, "outside.ts");
      await writeFile(outside, "outside\n", "utf8");
      await mkdir(root);
      await symlink(outside, join(root, "linked.ts"));
      const access = await createNodeFileAccess(root, 1024);

      await expect(access.readText("../outside.ts", 1024)).rejects.toThrow("outside the repository");
      await expect(access.readText("linked.ts", 1024)).rejects.toThrow("outside the repository");
      await expect(access.saveText("linked.ts", "changed\n", "untrusted-revision")).resolves.toEqual({
        status: "error",
        message: "Selected file is outside the repository.",
      });
      expect(await readFile(outside, "utf8")).toBe("outside\n");
    });
  });

  it("does not remove the temp path after a successful rename", async () => {
    await withTempDirectory(async (root) => {
      const path = join(root, "source.ts");
      await writeFile(path, "original\n", "utf8");
      const renameFile = vi.fn(async (from: string, to: string) => { await rename(from, to); });
      const removeFile = vi.fn(async () => { throw new Error("removal must not run after rename"); });
      const access = await createNodeFileAccess(root, 1024, { renameFile, removeFile });
      const loaded = await access.readText("source.ts", 1024);

      await expect(access.saveText("source.ts", "saved\n", loaded.revision)).resolves.toEqual({
        status: "success",
        effect: "saved",
        revision: expect.any(String),
      });
      expect(renameFile).toHaveBeenCalledOnce();
      expect(removeFile).not.toHaveBeenCalled();
      expect(await readFile(path, "utf8")).toBe("saved\n");
    });
  });

  it("cleans the same-directory temp and lock after rename failure so the next save succeeds", async () => {
    await withTempDirectory(async (root) => {
      const path = join(root, "source.ts");
      await writeFile(path, "original\n", "utf8");
      const renameFile = vi.fn()
        .mockRejectedValueOnce(new Error("injected rename failure"))
        .mockImplementation(async (from: string, to: string) => { await rename(from, to); });
      const access = await createNodeFileAccess(root, 1024, { renameFile });
      const loaded = await access.readText("source.ts", 1024);

      await expect(access.saveText("source.ts", "unsaved\n", loaded.revision)).resolves.toEqual({
        status: "error",
        message: "Could not atomically save source.ts: injected rename failure",
      });

      expect(await readFile(path, "utf8")).toBe("original\n");
      expect(await readdir(root)).toEqual([basename(path)]);
      await expect(access.saveText("source.ts", "saved\n", loaded.revision)).resolves.toEqual({
        status: "success",
        effect: "saved",
        revision: expect.any(String),
      });
      expect(renameFile).toHaveBeenCalledTimes(2);
      expect(await readFile(path, "utf8")).toBe("saved\n");
      expect(await readdir(root)).toEqual([basename(path)]);
    });
  });

  it("keeps rename failure primary when temp cleanup also fails", async () => {
    await withTempDirectory(async (root) => {
      const path = join(root, "source.ts");
      await writeFile(path, "original\n", "utf8");
      const renameFile = vi.fn(async () => { throw new Error("injected rename failure"); });
      const removeFile = vi.fn(async () => { throw new Error("injected cleanup failure"); });
      const access = await createNodeFileAccess(root, 1024, { renameFile, removeFile });
      const workbench = createWorkbench({ ...access, listFiles: async () => "source.ts\0" });
      await workbench.start();
      await workbench.selectFile("source.ts");
      const loadedRevision = workbench.selectedRevision;
      workbench.replaceBuffer("unsaved\n");

      const result = await workbench.save();

      expect(result.status).toBe("error");
      if (result.status !== "error") throw new Error("Expected an atomic-save error.");
      expect(result.message).toContain("injected rename failure");
      expect(result.message).toContain("injected cleanup failure");
      expect(result.message.indexOf("injected rename failure")).toBeLessThan(result.message.indexOf("injected cleanup failure"));
      expect(renameFile).toHaveBeenCalledOnce();
      expect(removeFile).toHaveBeenCalledOnce();
      expect(await readFile(path, "utf8")).toBe("original\n");
      expect(workbench.selectedRevision).toBe(loadedRevision);
      expect(workbench.bufferText).toBe("unsaved\n");
      expect(workbench.isDirty).toBe(true);
    });
  });

  it("reports lock acquisition failures without touching the target", async () => {
    await withTempDirectory(async (root) => {
      const path = join(root, "source.ts");
      await writeFile(path, "original\n", "utf8");
      const access = await createNodeFileAccess(root, 1024, {
        openLockFile: async () => { throw Object.assign(new Error("injected lock acquisition failure"), { code: "EACCES" }); },
      });
      const loaded = await access.readText("source.ts", 1024);

      await expect(access.saveText("source.ts", "changed\n", loaded.revision)).resolves.toEqual({
        status: "error",
        message: "Could not atomically save source.ts: save lock acquisition failed: injected lock acquisition failure",
      });
      expect(await readFile(path, "utf8")).toBe("original\n");
      expect(await readdir(root)).toEqual(["source.ts"]);
    });
  });

  it("keeps a pre-commit failure primary when lock cleanup also fails", async () => {
    await withTempDirectory(async (root) => {
      const path = join(root, "source.ts");
      await writeFile(path, "original\n", "utf8");
      const renameFile = vi.fn(async () => { throw new Error("injected rename failure"); });
      const removeLockFile = vi.fn(async () => { throw new Error("injected lock release failure"); });
      const access = await createNodeFileAccess(root, 1024, { renameFile, removeLockFile });
      const workbench = createWorkbench({ ...access, listFiles: async () => "source.ts\0" });
      await workbench.start();
      await workbench.selectFile("source.ts");
      const loadedRevision = workbench.selectedRevision;
      workbench.replaceBuffer("unsaved\n");

      const result = await workbench.save();

      expect(result.status).toBe("error");
      if (result.status !== "error") throw new Error("Expected an atomic-save error.");
      expect(result.message).toContain("injected rename failure");
      expect(result.message).toContain("save lock cleanup failed: remove: injected lock release failure");
      expect(result.message.indexOf("injected rename failure")).toBeLessThan(result.message.indexOf("injected lock release failure"));
      expect(renameFile).toHaveBeenCalledOnce();
      expect(removeLockFile).toHaveBeenCalledOnce();
      expect(await readFile(path, "utf8")).toBe("original\n");
      expect(workbench.selectedRevision).toBe(loadedRevision);
      expect(workbench.bufferText).toBe("unsaved\n");
      expect(workbench.isDirty).toBe(true);
    });
  });

  it("returns committed success with a warning when lock release fails after rename", async () => {
    await withTempDirectory(async (root) => {
      const path = join(root, "source.ts");
      await writeFile(path, "original\n", "utf8");
      const removeLockFile = vi.fn(async () => { throw new Error("injected lock release failure"); });
      const access = await createNodeFileAccess(root, 1024, { removeLockFile });
      const loaded = await access.readText("source.ts", 1024);

      const result = await access.saveText("source.ts", "committed\n", loaded.revision);

      expect(result).toEqual({
        status: "success",
        effect: "saved",
        revision: createHash("sha256").update("committed\n").digest("hex"),
        warning: "Save committed, but save lock cleanup failed: remove: injected lock release failure",
      });
      expect(removeLockFile).toHaveBeenCalledOnce();
      expect(await readFile(path)).toEqual(Buffer.from("committed\n", "utf8"));
    });
  });

  it("rejects a FIFO without waiting for a writer", async () => {
    await withTempDirectory(async (root) => {
      const fifo = join(root, "source.ts");
      await new Promise<void>((resolve, reject) => {
        execFile("mkfifo", [fifo], (error) => error == null ? resolve() : reject(error));
      });
      const access = await createNodeFileAccess(root, 1024);

      if (access.canReadFile == null) throw new Error("Expected canReadFile capability");
      await expect(access.canReadFile("source.ts")).resolves.toBe(false);
      await expect(access.saveText("source.ts", "text", "untrusted-revision")).resolves.toEqual({
        status: "error",
        message: "Selected path is not a regular file.",
      });
    });
  });

  it("enforces regular-file and byte-size limits at write time", async () => {
    await withTempDirectory(async (root) => {
      await writeFile(join(root, "source.ts"), "small", "utf8");
      const access = await createNodeFileAccess(root, 5);
      const loaded = await access.readText("source.ts", 5);

      await expect(access.saveText("source.ts", "too large", loaded.revision)).resolves.toEqual({
        status: "error",
        message: "Edited file exceeds the workbench write limit.",
      });
      await expect(access.saveText(".", "text", loaded.revision)).resolves.toEqual({
        status: "error",
        message: "Selected path is not a regular file.",
      });
      expect(await readFile(join(root, "source.ts"), "utf8")).toBe("small");
    });
  });
});
