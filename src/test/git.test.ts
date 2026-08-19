import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { getBranchBaseRef, getChangedFileReferenceCounts, getChangedFileReferenceGraph, getReviewWindowData, getReviewWindowDataForRevisionRange, getWorkingTreeContent, isPathInside, isReviewFileSizeAllowed, isReviewableFilePath, limitReviewItems, loadReviewFileContents, mapWithConcurrency, MAX_REVIEW_FILE_BYTES, MAX_REVIEW_FILE_COUNT, mergeChangedPaths, parseLocalBranchRefs, parseNameStatus, parseNumStat, parseRawDiff, parseStatusPorcelain, parseUntrackedPaths, selectClosestAncestorBranch } from "../git.js";

describe("git helpers", () => {
  it("parses modified, added, deleted, and renamed files", () => {
    const output = [
      "M\tsrc/app.ts",
      "A\tREADME.md",
      "D\told.txt",
      "R100\tsrc/old-name.ts\tsrc/new-name.ts",
    ].join("\n");

    expect(parseNameStatus(output)).toEqual([
      { status: "modified", oldPath: "src/app.ts", newPath: "src/app.ts" },
      { status: "added", oldPath: null, newPath: "README.md" },
      { status: "deleted", oldPath: "old.txt", newPath: null },
      { status: "renamed", oldPath: "src/old-name.ts", newPath: "src/new-name.ts" },
    ]);
  });

  it("parses raw submodule gitlink changes with exact commits", () => {
    expect(parseRawDiff(":160000 160000 abc1234 def5678 M\0packages/app\0")).toEqual([
      {
        status: "modified",
        oldPath: "packages/app",
        newPath: "packages/app",
        oldMode: "160000",
        newMode: "160000",
        oldSha: "abc1234",
        newSha: "def5678",
      },
    ]);
  });

  it("merges tracked and untracked changes without duplicates", () => {
    const tracked = [{ status: "modified" as const, oldPath: "src/a.ts", newPath: "src/a.ts" }];
    const untracked = [
      { status: "added" as const, oldPath: null, newPath: "src/new.ts" },
      { status: "modified" as const, oldPath: "src/a.ts", newPath: "src/a.ts" },
    ];

    expect(mergeChangedPaths(tracked, untracked)).toEqual([
      { status: "modified", oldPath: "src/a.ts", newPath: "src/a.ts" },
      { status: "added", oldPath: null, newPath: "src/new.ts" },
    ]);
  });

  it("parses untracked paths", () => {
    expect(parseUntrackedPaths("src/new.ts\nnotes.md\n")).toEqual([
      { status: "added", oldPath: null, newPath: "src/new.ts" },
      { status: "added", oldPath: null, newPath: "notes.md" },
    ]);
  });

  it("parses porcelain status entries for local worktree changes", () => {
    const output = [
      " M app/admin/dashboard.rb",
      "M  app/models/game_play_session.rb",
      "R  app/renamed.rb",
      "app/old.rb",
      " D app/views/games/play.html.erb",
      "?? app/channels/game_play_channel.rb",
      "?? test/javascript/controllers/game_play_heartbeat_controller_test.js",
      "",
    ].join("\0");

    expect(parseStatusPorcelain(output)).toEqual([
      { status: "modified", oldPath: "app/admin/dashboard.rb", newPath: "app/admin/dashboard.rb" },
      { status: "modified", oldPath: "app/models/game_play_session.rb", newPath: "app/models/game_play_session.rb" },
      { status: "renamed", oldPath: "app/old.rb", newPath: "app/renamed.rb" },
      { status: "deleted", oldPath: "app/views/games/play.html.erb", newPath: null },
      { status: "added", oldPath: null, newPath: "app/channels/game_play_channel.rb" },
      { status: "added", oldPath: null, newPath: "test/javascript/controllers/game_play_heartbeat_controller_test.js" },
    ]);
  });

  it("defaults local reviews invoked from a workspace to that workspace pathspec", async () => {
    const exec = vi.fn(async (_command: string, args: string[]) => {
      const key = args.join(" ");
      if (key === "rev-parse --show-toplevel") return { code: 0, stdout: "/repo\n", stderr: "" };
      if (key === "rev-parse --verify HEAD") return { code: 1, stdout: "", stderr: "" };
      if (key === "ls-files --others --exclude-standard -- packages/widget") return { code: 0, stdout: "packages/widget/src/app.ts\n", stderr: "" };
      if (key === "status --porcelain=v1 -z --untracked-files=all -- packages/widget") return { code: 0, stdout: "?? packages/widget/src/app.ts\0", stderr: "" };
      if (key === "ls-files --cached -- packages/widget") return { code: 0, stdout: "", stderr: "" };
      if (key === "ls-files --deleted -- packages/widget") return { code: 0, stdout: "", stderr: "" };
      return { code: 1, stdout: "", stderr: `unexpected command: ${key}` };
    });

    const data = await getReviewWindowData({ exec } as never, "/repo/packages/widget");

    expect(data.workspacePath).toBe("packages/widget");
    expect(data.files.map((file) => file.path)).toEqual(["packages/widget/src/app.ts"]);
  });

  it("keeps every git status file in the git diff scope when branch comparison is huge", async () => {
    const modifiedFiles = [
      "app/admin/dashboard.rb",
      "app/assets/stylesheets/base.scss",
      "app/assets/stylesheets/mobile.scss",
      "app/javascript/controllers/application.js",
      "app/models/game_play_session.rb",
      "app/views/games/play.html.erb",
      "config/locales/backend.en.yml",
      "config/locales/backend.pt-BR.yml",
      "test/controllers/admin/irc_admin_test.rb",
    ];
    const untrackedFiles = [
      "app/channels/game_play_channel.rb",
      "app/javascript/controllers/game_play_heartbeat_controller.js",
      "test/channels/game_play_channel_test.rb",
      "test/javascript/controllers/game_play_heartbeat_controller_test.js",
    ];
    const statusOutput = [
      ...modifiedFiles.map((path) => ` M ${path}`),
      ...untrackedFiles.map((path) => `?? ${path}`),
      "",
    ].join("\0");
    const trackedFiles = modifiedFiles.join("\n");
    const untrackedOutput = untrackedFiles.join("\n");
    const partialDiffOutput = [
      "M\tapp/admin/dashboard.rb",
      "M\tapp/assets/stylesheets/base.scss",
      "M\tapp/assets/stylesheets/mobile.scss",
      "A\tapp/channels/game_play_channel.rb",
    ].join("\n");
    const numStatOutput = [
      "275\t206\tapp/admin/dashboard.rb",
      "7\t3\tapp/assets/stylesheets/base.scss",
      "2\t0\tapp/assets/stylesheets/mobile.scss",
    ].join("\n");
    const branchOnlyFiles = Array.from({ length: MAX_REVIEW_FILE_COUNT }, (_, index) => `app/games/generated_${String(index).padStart(3, "0")}.rb`);
    const branchDiffOutput = branchOnlyFiles.map((path) => `A\t${path}`).join("\n");
    const branchNumStatOutput = branchOnlyFiles.map((path) => `1\t0\t${path}`).join("\n");
    const exec = vi.fn(async (_command: string, args: string[]) => {
      const key = args.join(" ");
      if (key === "rev-parse --show-toplevel") return { code: 0, stdout: "/repo\n", stderr: "" };
      if (key === "rev-parse --verify HEAD") return { code: 0, stdout: "abc123\n", stderr: "" };
      if (key === "diff --find-renames -M --name-status HEAD --") return { code: 0, stdout: partialDiffOutput, stderr: "" };
      if (key === "diff --find-renames -M --numstat HEAD --") return { code: 0, stdout: numStatOutput, stderr: "" };
      if (key === "ls-files --others --exclude-standard") return { code: 0, stdout: untrackedOutput, stderr: "" };
      if (key === "status --porcelain=v1 -z --untracked-files=all") return { code: 0, stdout: statusOutput, stderr: "" };
      if (key === "ls-files --cached") return { code: 0, stdout: trackedFiles, stderr: "" };
      if (key === "ls-files --deleted") return { code: 0, stdout: "", stderr: "" };
      if (key.startsWith("diff-tree ")) return { code: 0, stdout: "", stderr: "" };
      if (key === "branch --show-current") return { code: 0, stdout: "feature\n", stderr: "" };
      if (key === "for-each-ref --format=%(refname:short)%09%(objectname) refs/heads") return { code: 0, stdout: "main\tabc123\nfeature\tdef456\n", stderr: "" };
      if (key === "merge-base --is-ancestor main HEAD") return { code: 0, stdout: "", stderr: "" };
      if (key === "rev-list --count main..HEAD") return { code: 0, stdout: "1\n", stderr: "" };
      if (key === "merge-base main HEAD") return { code: 0, stdout: "base123\n", stderr: "" };
      if (key === "diff --find-renames -M --name-status base123 HEAD --") return { code: 0, stdout: branchDiffOutput, stderr: "" };
      if (key === "diff --find-renames -M --numstat base123 HEAD --") return { code: 0, stdout: branchNumStatOutput, stderr: "" };
      if (key.startsWith("symbolic-ref ")) return { code: 1, stdout: "", stderr: "" };
      if (key.startsWith("rev-parse --verify --quiet ")) return { code: 1, stdout: "", stderr: "" };
      return { code: 1, stdout: "", stderr: `unexpected command: ${key}` };
    });

    const data = await getReviewWindowData({ exec } as never, "/repo");

    expect(data.files.filter((file) => file.inGitDiff).map((file) => file.path)).toEqual([
      "app/admin/dashboard.rb",
      "app/assets/stylesheets/base.scss",
      "app/assets/stylesheets/mobile.scss",
      "app/channels/game_play_channel.rb",
      "app/javascript/controllers/application.js",
      "app/javascript/controllers/game_play_heartbeat_controller.js",
      "app/models/game_play_session.rb",
      "app/views/games/play.html.erb",
      "config/locales/backend.en.yml",
      "config/locales/backend.pt-BR.yml",
      "test/channels/game_play_channel_test.rb",
      "test/controllers/admin/irc_admin_test.rb",
      "test/javascript/controllers/game_play_heartbeat_controller_test.js",
    ]);
  });

  it("keeps git diff files ahead of last commit files when limiting the local review list", async () => {
    const currentPath = "zz/current_status_file.rb";
    const lastCommitFiles = Array.from({ length: MAX_REVIEW_FILE_COUNT }, (_, index) => `aa/last_commit_${String(index).padStart(3, "0")}.rb`);
    const lastCommitOutput = lastCommitFiles.map((path) => `A\t${path}`).join("\n");
    const lastCommitNumStatOutput = lastCommitFiles.map((path) => `1\t0\t${path}`).join("\n");
    const exec = vi.fn(async (_command: string, args: string[]) => {
      const key = args.join(" ");
      if (key === "rev-parse --show-toplevel") return { code: 0, stdout: "/repo\n", stderr: "" };
      if (key === "rev-parse --verify HEAD") return { code: 0, stdout: "abc123\n", stderr: "" };
      if (key === "diff --find-renames -M --name-status HEAD --") return { code: 0, stdout: `M\t${currentPath}\n`, stderr: "" };
      if (key === "diff --find-renames -M --numstat HEAD --") return { code: 0, stdout: `3\t1\t${currentPath}\n`, stderr: "" };
      if (key === "status --porcelain=v1 -z --untracked-files=all") return { code: 0, stdout: ` M ${currentPath}\0`, stderr: "" };
      if (key === "ls-files --others --exclude-standard") return { code: 0, stdout: "", stderr: "" };
      if (key === "ls-files --cached") return { code: 0, stdout: `${currentPath}\n`, stderr: "" };
      if (key === "ls-files --deleted") return { code: 0, stdout: "", stderr: "" };
      if (key === "diff-tree --root --find-renames -M --name-status --no-commit-id -r HEAD") return { code: 0, stdout: lastCommitOutput, stderr: "" };
      if (key === "diff-tree --root --find-renames -M --numstat --no-commit-id -r HEAD") return { code: 0, stdout: lastCommitNumStatOutput, stderr: "" };
      if (key === "branch --show-current") return { code: 1, stdout: "", stderr: "" };
      if (key.startsWith("symbolic-ref ")) return { code: 1, stdout: "", stderr: "" };
      if (key.startsWith("rev-parse --verify --quiet ")) return { code: 1, stdout: "", stderr: "" };
      return { code: 1, stdout: "", stderr: `unexpected command: ${key}` };
    });

    const data = await getReviewWindowData({ exec } as never, "/repo");

    expect(data.files).toHaveLength(MAX_REVIEW_FILE_COUNT);
    expect(data.files.some((file) => file.path === currentPath && file.inGitDiff)).toBe(true);
    expect(data.files.filter((file) => file.inGitDiff).map((file) => file.path)).toEqual([currentPath]);
  });

  it("parses numstat additions and deletions", () => {
    expect(parseNumStat("12\t3\tsrc/app.ts\n-\t-\tassets/generated.bin\n")).toEqual(new Map([
      ["src/app.ts", { additions: 12, deletions: 3 }],
      ["assets/generated.bin", { additions: 0, deletions: 0 }],
    ]));
  });

  it("preserves merge-base semantics and pathspecs for custom ranges", async () => {
    const exec = vi.fn(async (_command: string, args: string[]) => {
      const key = args.join(" ");
      if (key === "rev-parse --show-toplevel") return { code: 0, stdout: "/repo\n", stderr: "" };
      if (key === "merge-base base head") return { code: 0, stdout: "merged-base\n", stderr: "" };
      if (key === "diff --find-renames -M --name-status merged-base head -- packages/widget") return { code: 0, stdout: "M\tpackages/widget/src/app.ts\n", stderr: "" };
      if (key === "diff --find-renames -M --numstat merged-base head -- packages/widget") return { code: 0, stdout: "2\t1\tpackages/widget/src/app.ts\n", stderr: "" };
      if (key === "diff --find-renames -M --raw -z merged-base head -- packages/widget") return { code: 0, stdout: ":100644 100644 aaa111 bbb222 M\0packages/widget/src/app.ts\0", stderr: "" };
      if (key === "cat-file -s head:packages/widget/src/app.ts") return { code: 0, stdout: "20\n", stderr: "" };
      if (key === "show head:packages/widget/src/app.ts") return { code: 0, stdout: "export const app = 1;\n", stderr: "" };
      return { code: 1, stdout: "", stderr: `unexpected command: ${key}` };
    });

    const data = await getReviewWindowDataForRevisionRange(
      { exec } as never,
      "/repo/packages/widget",
      "base",
      "head",
      { mergeBase: true, pathspecs: ["packages/widget"] },
    );

    expect(data.branchBaseRevision).toBe("merged-base");
    expect(data.workspacePath).toBe("packages/widget");
    expect(data.files).toHaveLength(1);
    expect(data.files[0]?.allFiles).toMatchObject({ originalBlobSha: "aaa111", modifiedBlobSha: "bbb222" });
  });

  it("marks nested submodule ranges and loads their explicit revisions", async () => {
    const exec = vi.fn(async (_command: string, args: string[], options?: { cwd?: string }) => {
      const key = args.join(" ");
      if (key === "rev-parse --show-toplevel" && options?.cwd === "/repo") return { code: 0, stdout: "/repo\n", stderr: "" };
      if (key === "rev-parse --show-toplevel" && options?.cwd === "/repo/packages/app") return { code: 0, stdout: "/repo/packages/app\n", stderr: "" };
      if (key === "diff --find-renames -M --name-status old-sha new-sha --") return { code: 0, stdout: "M\tpackages/app\n", stderr: "" };
      if (key === "diff --find-renames -M --numstat old-sha new-sha --") return { code: 0, stdout: "-\t-\tpackages/app\n", stderr: "" };
      if (key === "diff --find-renames -M --raw -z old-sha new-sha --") return { code: 0, stdout: ":160000 160000 abc1234 def5678 M\0packages/app\0", stderr: "" };
      if (key === "cat-file -s new-sha:packages/app") return { code: 0, stdout: "0\n", stderr: "" };
      if (key === "show new-sha:packages/app") return { code: 0, stdout: "", stderr: "" };
      if (key === "cat-file -s abc1234:src/app.ts") return { code: 0, stdout: "4\n", stderr: "" };
      if (key === "show abc1234:src/app.ts") return { code: 0, stdout: "old\n", stderr: "" };
      if (key === "cat-file -s def5678:src/app.ts") return { code: 0, stdout: "4\n", stderr: "" };
      if (key === "show def5678:src/app.ts") return { code: 0, stdout: "new\n", stderr: "" };
      return { code: 1, stdout: "", stderr: `unexpected command: ${key}` };
    });

    const data = await getReviewWindowDataForRevisionRange({ exec } as never, "/repo", "old-sha", "new-sha");
    expect(data.files[0]?.submodule?.["all-files"]).toMatchObject({
      repoRoot: "/repo/packages/app",
      path: "packages/app",
      oldSha: "abc1234",
      newSha: "def5678",
      available: true,
    });

    const contents = await loadReviewFileContents({ exec } as never, "/repo/packages/app", {
      id: "nested",
      path: "src/app.ts",
      worktreeStatus: null,
      hasWorkingTreeFile: true,
      inGitDiff: false,
      inLastCommit: false,
      inAllFiles: true,
      gitDiff: null,
      lastCommit: null,
      allFiles: {
        status: "modified",
        oldPath: "src/app.ts",
        newPath: "src/app.ts",
        displayPath: "src/app.ts",
        hasOriginal: true,
        hasModified: true,
        originalRevision: "abc1234",
        modifiedRevision: "def5678",
      },
    }, "all-files");
    expect(contents).toEqual({
      originalContent: "old\n",
      modifiedContent: "new\n",
      originalAvailable: true,
      modifiedAvailable: true,
    });
  });

  it("distinguishes unavailable revision bytes from a valid empty file", async () => {
    const exec = vi.fn(async (_command: string, args: string[]) => {
      const objectSpec = args[args.length - 1];
      if (args[0] === "cat-file" && objectSpec === "base:src/app.ts") return { code: 0, stdout: "0\n", stderr: "" };
      if (args[0] === "show" && objectSpec === "base:src/app.ts") return { code: 0, stdout: "", stderr: "" };
      return { code: 1, stdout: "", stderr: "missing revision" };
    });
    const file = {
      id: "range", path: "src/app.ts", worktreeStatus: null, hasWorkingTreeFile: false,
      inGitDiff: false, inLastCommit: false, inAllFiles: true, gitDiff: null, lastCommit: null,
      allFiles: {
        status: "modified" as const, oldPath: "src/app.ts", newPath: "src/app.ts", displayPath: "src/app.ts",
        hasOriginal: true, hasModified: true, originalRevision: "base", modifiedRevision: "missing",
      },
    };

    expect(await loadReviewFileContents({ exec } as never, "/repo", file, "all-files")).toEqual({
      originalContent: "",
      modifiedContent: "",
      originalAvailable: true,
      modifiedAvailable: false,
    });
  });

  it("counts changed files referenced by other changed files", () => {
    const changes = [
      { status: "added" as const, oldPath: null, newPath: "src/root.ts" },
      { status: "modified" as const, oldPath: "src/a.ts", newPath: "src/a.ts" },
      { status: "modified" as const, oldPath: "src/nested/b.ts", newPath: "src/nested/b.ts" },
    ];
    const contents = new Map([
      ["src/a.ts", "import { root } from './root';\n"],
      ["src/nested/b.ts", "export { root } from '../root';\n"],
    ]);

    expect(getChangedFileReferenceCounts(changes, contents).get("src/root.ts")).toBe(2);
    const graph = getChangedFileReferenceGraph(changes, contents);
    expect(graph.outgoing.get("src/a.ts")).toEqual(["src/root.ts"]);
    expect(graph.incoming.get("src/root.ts")).toEqual(["src/a.ts", "src/nested/b.ts"]);
  });

  it("resolves configured workspace import aliases between changed files", () => {
    const changes = [
      { status: "modified" as const, oldPath: "packages/app/src/page.ts", newPath: "packages/app/src/page.ts" },
      { status: "modified" as const, oldPath: "packages/shared/src/button.ts", newPath: "packages/shared/src/button.ts" },
    ];
    const contents = new Map([
      ["packages/app/src/page.ts", "import { Button } from '@workspace/shared/button';\n"],
      ["packages/shared/src/button.ts", "export const Button = true;\n"],
    ]);

    const graph = getChangedFileReferenceGraph(changes, contents, {
      importAliases: { "@workspace/shared": "packages/shared/src" },
    });

    expect(graph.outgoing.get("packages/app/src/page.ts")).toEqual(["packages/shared/src/button.ts"]);
    expect(graph.incoming.get("packages/shared/src/button.ts")).toEqual(["packages/app/src/page.ts"]);
  });

  it("filters obvious binary or minified assets", () => {
    expect(isReviewableFilePath("src/app.ts")).toBe(true);
    expect(isReviewableFilePath("assets/logo.png")).toBe(false);
    expect(isReviewableFilePath("dist/app.min.js")).toBe(false);
  });

  it("parses local branch refs", () => {
    const output = [
      "main\tabc123",
      "parent branch\tdef456",
      "malformed",
      "child\t789abc",
    ].join("\n");

    expect(parseLocalBranchRefs(output)).toEqual([
      { name: "main", commit: "abc123" },
      { name: "parent branch", commit: "def456" },
      { name: "child", commit: "789abc" },
    ]);
  });

  it("selects the nearest ancestor branch instead of always using trunk", () => {
    expect(selectClosestAncestorBranch([
      { name: "main", distanceFromHead: 4 },
      { name: "parent", distanceFromHead: 1 },
      { name: "same-head", distanceFromHead: 0 },
    ])).toBe("parent");
  });

  it("uses the nearest local ancestor branch as the branch diff base", async () => {
    const exec = vi.fn(async (_command: string, args: string[]) => {
      if (args.join(" ") === "branch --show-current") return { code: 0, stdout: "child\n", stderr: "" };
      if (args[0] === "for-each-ref") return { code: 0, stdout: "main\tabc123\nparent\tdef456\nchild\t789abc\n", stderr: "" };
      if (args.join(" ") === "merge-base --is-ancestor main HEAD") return { code: 0, stdout: "", stderr: "" };
      if (args.join(" ") === "merge-base --is-ancestor parent HEAD") return { code: 0, stdout: "", stderr: "" };
      if (args.join(" ") === "rev-list --count main..HEAD") return { code: 0, stdout: "4\n", stderr: "" };
      if (args.join(" ") === "rev-list --count parent..HEAD") return { code: 0, stdout: "1\n", stderr: "" };
      return { code: 1, stdout: "", stderr: "unexpected command" };
    });

    expect(await getBranchBaseRef({ exec } as never, "/repo")).toBe("parent");
  });

  it("checks path containment", () => {
    expect(isPathInside("/repo", "/repo/src/app.ts")).toBe(true);
    expect(isPathInside("/repo", "/repo")).toBe(true);
    expect(isPathInside("/repo", "/repo2/src/app.ts")).toBe(false);
    expect(isPathInside("/repo", "/tmp/secret.txt")).toBe(false);
  });

  it("bounds asynchronous file loading concurrency", async () => {
    let active = 0;
    let maximumActive = 0;
    const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active -= 1;
      return value * 2;
    });

    expect(results).toEqual([2, 4, 6, 8, 10]);
    expect(maximumActive).toBe(2);
  });

  it("limits review item counts and file sizes", () => {
    expect(limitReviewItems(Array.from({ length: MAX_REVIEW_FILE_COUNT + 3 }, (_, index) => index))).toHaveLength(MAX_REVIEW_FILE_COUNT);
    expect(isReviewFileSizeAllowed(MAX_REVIEW_FILE_BYTES)).toBe(true);
    expect(isReviewFileSizeAllowed(MAX_REVIEW_FILE_BYTES + 1)).toBe(false);
  });

  it("does not read working-tree symlinks outside the repo", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-code-diff-"));
    const repo = join(root, "repo");
    await mkdir(repo);
    const secret = join(root, "secret.txt");
    await writeFile(secret, "secret", "utf8");
    await symlink(secret, join(repo, "leak.txt"));

    expect(await getWorkingTreeContent(repo, "leak.txt")).toBe("");
  });

  it("reads working-tree symlinks that stay inside the repo", async () => {
    const repo = await mkdtemp(join(tmpdir(), "pi-code-diff-"));
    await writeFile(join(repo, "target.txt"), "safe", "utf8");
    await symlink(join(repo, "target.txt"), join(repo, "link.txt"));

    expect(await getWorkingTreeContent(repo, "link.txt")).toBe("safe");
  });
});
