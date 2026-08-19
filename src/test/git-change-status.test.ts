import { describe, expect, it, vi } from "vitest";
import { FILTER_CONFIG_ARGS, filterOverrideArgs, parseFilterConfigPrefixes } from "../git-filter-policy.js";
import {
  RepositoryChangeStatusController,
  formatRepositoryChangeSummary,
  loadRepositoryChangeSummary,
  parsePorcelainChangeCounts,
  parseShortStat,
  runBoundedGit,
  type ExecFileLike,
  type RepositoryGitCommand,
} from "../git-change-status.js";

function semanticCommand(args: readonly string[]): string | undefined {
  let index = 0;
  while (args[index] === "-c") index += 2;
  return args[index];
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => { resolve = promiseResolve; });
  return { promise, resolve };
}

describe("Git filter policy", () => {
  it("strictly parses complete filter keys into deterministic unique prefixes", () => {
    expect(FILTER_CONFIG_ARGS).toEqual(["config", "--null", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|smudge|process|required)$"]);
    expect(parseFilterConfigPrefixes("filter.zed.required\0filter.lfs.clean\0filter.lfs.process\0filter.zed.smudge\0filter.lfs.clean\0"))
      .toEqual({ kind: "success", prefixes: ["filter.lfs", "filter.zed"] });
  });

  it.each([
    ["missing terminator", "filter.lfs.clean", "malformed"],
    ["empty key", "filter.lfs.clean\0\0", "malformed"],
    ["unsafe key", "filter.bad=driver.clean\0", "unsafe"],
  ] as const)("rejects %s filter configuration keys", (_label, output, reason) => {
    expect(parseFilterConfigPrefixes(output)).toEqual({ kind: "failure", reason });
  });

  it("generates exactly four neutralizing overrides for each prefix", () => {
    expect(filterOverrideArgs("filter.lfs")).toEqual([
      "-c", "filter.lfs.clean=",
      "-c", "filter.lfs.smudge=",
      "-c", "filter.lfs.process=",
      "-c", "filter.lfs.required=false",
    ]);
  });
});

describe("repository change footer status", () => {
  it("counts staged, unstaged, renamed, and untracked porcelain records exactly", () => {
    expect(parsePorcelainChangeCounts(" M src/app.ts\0A  staged.ts\0R  renamed.ts\0old.ts\0?? new.ts\0", false)).toEqual({
      files: 4,
      filesCapped: false,
      untrackedFiles: 1,
    });
    expect(parsePorcelainChangeCounts(" M complete.ts\0?? new.ts\0 M truncated", true)).toEqual({
      files: 2,
      filesCapped: true,
      untrackedFiles: 1,
    });
    expect(() => parsePorcelainChangeCounts(" M missing-terminator", false)).toThrow("malformed Git status");
  });

  it("parses bounded English shortstat output without trusting paths", () => {
    expect(parseShortStat(" 12 files changed, 232 insertions(+), 123 deletions(-)\n")).toEqual({ additions: 232, deletions: 123 });
    expect(parseShortStat(" 1 file changed, 7 insertions(+)\n")).toEqual({ additions: 7, deletions: 0 });
    expect(parseShortStat(" 2 files changed, 4 deletions(-)\n")).toEqual({ additions: 0, deletions: 4 });
    expect(parseShortStat("\n")).toEqual({ additions: 0, deletions: 0 });
    expect(() => parseShortStat("not localized shortstat")).toThrow("malformed Git shortstat");
  });

  it("loads a read-only summary relative to HEAD and disables configured filters", async () => {
    const run: RepositoryGitCommand = vi.fn(async (_cwd, args) => {
      switch (semanticCommand(args)) {
        case "config":
          return { stdout: "filter.zed.required\0filter.lfs.clean\0filter.lfs.process\0", stderr: "", exitCode: 0, capped: false };
        case "status":
          return { stdout: " M src/app.ts\0A  staged.ts\0?? new.ts\0", stderr: "", exitCode: 0, capped: false };
        case "diff":
          return { stdout: " 2 files changed, 9 insertions(+), 3 deletions(-)\n", stderr: "", exitCode: 0, capped: false };
        default:
          throw new Error("unexpected Git command");
      }
    });

    await expect(loadRepositoryChangeSummary("/repo", new AbortController().signal, run)).resolves.toEqual({
      files: 3,
      filesCapped: false,
      additions: 9,
      deletions: 3,
      untrackedFiles: 1,
    });

    const calls = vi.mocked(run).mock.calls.map(([, args]) => args);
    const overrides = [
      "-c", "filter.lfs.clean=",
      "-c", "filter.lfs.smudge=",
      "-c", "filter.lfs.process=",
      "-c", "filter.lfs.required=false",
      "-c", "filter.zed.clean=",
      "-c", "filter.zed.smudge=",
      "-c", "filter.zed.process=",
      "-c", "filter.zed.required=false",
    ];
    expect(calls.find((args) => semanticCommand(args) === "status")).toEqual([
      ...overrides,
      "status", "--porcelain=v1", "-z", "--untracked-files=normal", "--ignore-submodules=all",
    ]);
    expect(calls.find((args) => semanticCommand(args) === "diff")).toEqual([
      ...overrides,
      "diff", "--shortstat", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", "HEAD", "--", ".",
    ]);
  });

  it("returns no summary outside Git and keeps unborn or binary repositories honest", async () => {
    const outside: RepositoryGitCommand = vi.fn(async (_cwd, args) => {
      if (semanticCommand(args) === "config") return { stdout: "", stderr: "", exitCode: 1, capped: false };
      return { stdout: "", stderr: "not a repository", exitCode: 128, capped: false };
    });
    await expect(loadRepositoryChangeSummary("/outside", new AbortController().signal, outside)).resolves.toBeNull();

    const unborn: RepositoryGitCommand = vi.fn(async (_cwd, args) => {
      if (semanticCommand(args) === "config") return { stdout: "", stderr: "", exitCode: 1, capped: false };
      if (semanticCommand(args) === "status") return { stdout: "A  first.bin\0?? second.txt\0", stderr: "", exitCode: 0, capped: false };
      return { stdout: "", stderr: "unknown revision HEAD", exitCode: 128, capped: false };
    });
    await expect(loadRepositoryChangeSummary("/unborn", new AbortController().signal, unborn)).resolves.toEqual({
      files: 2,
      filesCapped: false,
      additions: null,
      deletions: null,
      untrackedFiles: 1,
    });
  });

  it("formats dirty repositories with exact ANSI colors and resets each segment", () => {
    const formatted = formatRepositoryChangeSummary({ files: 29, filesCapped: false, additions: 344, deletions: 723, untrackedFiles: 4 });
    expect(formatted).toBe("29 files · \x1b[32m+344\x1b[0m \x1b[31m−723\x1b[0m · \x1b[95m/diff\x1b[0m for details");
    expect(formatted?.replace(/\x1b\[[0-9;]*m/g, "")).toBe("29 files · +344 −723 · /diff for details");
    expect(formatted?.match(/\x1b\[[0-9;]*m/g)).toEqual(["\x1b[32m", "\x1b[0m", "\x1b[31m", "\x1b[0m", "\x1b[95m", "\x1b[0m"]);

    expect(formatRepositoryChangeSummary({ files: 2, filesCapped: false, additions: 0, deletions: 0, untrackedFiles: 2 }))
      .toBe("2 files · \x1b[95m/diff\x1b[0m for details");
    expect(formatRepositoryChangeSummary({ files: 200, filesCapped: true, additions: 5, deletions: 1, untrackedFiles: 3 }))
      .toBe("200+ files · \x1b[32m+5\x1b[0m \x1b[31m−1\x1b[0m · \x1b[95m/diff\x1b[0m for details");
    expect(formatRepositoryChangeSummary({ files: 0, filesCapped: false, additions: 0, deletions: 0, untrackedFiles: 0 }))
      .toBeUndefined();
    expect(formatRepositoryChangeSummary(null)).toBeUndefined();
  });

  it("runs Git with a hard timeout, output cap, inert environment, and no shell", async () => {
    const execFile = vi.fn((_file, _args, options, callback) => {
      callback(null, "ok", "");
      return {} as never;
    }) as unknown as ExecFileLike;

    await expect(runBoundedGit("/repo", ["status"], new AbortController().signal, execFile)).resolves.toEqual({
      stdout: "ok",
      stderr: "",
      exitCode: 0,
      capped: false,
    });
    expect(execFile).toHaveBeenCalledWith("git", ["-c", "core.fsmonitor=false", "status"], expect.objectContaining({
      cwd: "/repo",
      encoding: "utf8",
      maxBuffer: 64 * 1024,
      timeout: 3_000,
      killSignal: "SIGKILL",
      windowsHide: true,
      env: expect.objectContaining({
        GIT_NO_LAZY_FETCH: "1",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
        LC_ALL: "C",
      }),
    }), expect.any(Function));
  });

  it("publishes asynchronously, clears clean/non-Git state, and suppresses stale loads", async () => {
    const first = deferred<Awaited<ReturnType<typeof loadRepositoryChangeSummary>>>();
    const second = deferred<Awaited<ReturnType<typeof loadRepositoryChangeSummary>>>();
    const load = vi.fn()
      .mockImplementationOnce(async () => first.promise)
      .mockImplementationOnce(async () => second.promise);
    const controller = new RepositoryChangeStatusController(load);
    const setStatus = vi.fn();
    const ctx = { cwd: "/repo", hasUI: true, ui: { setStatus } };

    const firstRefresh = controller.refresh(ctx, { clear: true });
    const secondRefresh = controller.refresh(ctx);
    first.resolve({ files: 9, filesCapped: false, additions: 9, deletions: 0, untrackedFiles: 0 });
    second.resolve({ files: 2, filesCapped: false, additions: 1, deletions: 1, untrackedFiles: 0 });
    await Promise.all([firstRefresh, secondRefresh]);

    expect(setStatus).toHaveBeenLastCalledWith("pi-code-diff-local-changes", "2 files · \x1b[32m+1\x1b[0m \x1b[31m−1\x1b[0m · \x1b[95m/diff\x1b[0m for details");
    expect(setStatus).not.toHaveBeenCalledWith("pi-code-diff-local-changes", "9 files · \x1b[32m+9\x1b[0m \x1b[31m−0\x1b[0m · \x1b[95m/diff\x1b[0m for details");

    load.mockResolvedValueOnce({ files: 0, filesCapped: false, additions: 0, deletions: 0, untrackedFiles: 0 });
    await controller.refresh(ctx);
    expect(setStatus).toHaveBeenLastCalledWith("pi-code-diff-local-changes", undefined);

    await controller.shutdown(ctx);
    expect(setStatus).toHaveBeenLastCalledWith("pi-code-diff-local-changes", undefined);
  });

  it("aborts and joins an in-flight refresh before session shutdown completes", async () => {
    const pending = deferred<Awaited<ReturnType<typeof loadRepositoryChangeSummary>>>();
    let signal: AbortSignal | undefined;
    const load = vi.fn(async (_cwd: string, loadSignal: AbortSignal) => {
      signal = loadSignal;
      return pending.promise;
    });
    const controller = new RepositoryChangeStatusController(load);
    const setStatus = vi.fn();
    const ctx = { cwd: "/repo", hasUI: true, ui: { setStatus } };
    const refresh = controller.refresh(ctx);
    let shutdownSettled = false;
    const shutdown = controller.shutdown(ctx).then(() => { shutdownSettled = true; });

    await Promise.resolve();
    expect(signal?.aborted).toBe(true);
    expect(shutdownSettled).toBe(false);
    pending.resolve({ files: 4, filesCapped: false, additions: 4, deletions: 0, untrackedFiles: 0 });
    await Promise.all([refresh, shutdown]);

    expect(setStatus).toHaveBeenLastCalledWith("pi-code-diff-local-changes", undefined);
    expect(setStatus).not.toHaveBeenCalledWith("pi-code-diff-local-changes", expect.stringContaining("4 files"));
    await controller.refresh(ctx);
    expect(load).toHaveBeenCalledOnce();
  });

  it("turns Git failures into an absent footer instead of an extension failure", async () => {
    const controller = new RepositoryChangeStatusController(async () => { throw new Error("git failed"); });
    const setStatus = vi.fn();
    await expect(controller.refresh({ cwd: "/repo", hasUI: true, ui: { setStatus } })).resolves.toBeUndefined();
    expect(setStatus).toHaveBeenCalledWith("pi-code-diff-local-changes", undefined);
  });
});
