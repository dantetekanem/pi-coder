import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parsePullRequestHandoff } from "../pr-handoff.js";
import { clearRemoteReviewTargetCache, extractBranchFromRemote, formatPullRequestContext, getRemoteCacheRoot, resolveRemoteReviewTarget } from "../remote.js";

const originalSettingsPath = process.env.PI_CODE_DIFF_SETTINGS_PATH;
const originalCacheRoot = process.env.PI_CODE_DIFF_REMOTE_CACHE_ROOT;
const suppliedHead = "a".repeat(40);
let directory: string;
let settingsPath: string;

function neutralSettings(repositories: Record<string, unknown> = {}) {
  const fields = {
    number: "id",
    title: "subject",
    body: "description",
    additions: "metrics.added",
    deletions: "metrics.removed",
    changedFiles: "metrics.files",
    author: "actor.handle",
    state: "phase",
    reviewState: "decision",
    headRefName: "source.name",
    headRefOid: "source.oid",
    baseRefName: "target.name",
    baseRefOid: "target.oid",
  };
  return {
    version: 1,
    providers: {
      primary: {
        label: "Primary code host",
        executable: "cli-one",
        urls: {
          patterns: [
            { host: "code.example", path: "/{repo}/change/{number}" },
            { host: "stack.example", path: "/review/{repo}/{number}" },
          ],
          canonical: "https://code.example/{repo}/change/{number}",
          clone: "https://code.example/{repo}.git",
        },
        operations: {
          pullRequest: { args: ["change", "show", "{repo}", "{number}"] },
          reviews: { args: ["change", "reviews", "{repo}", "{number}"] },
          branchLookup: { args: ["change", "lookup", "{repo}", "{branch}"] },
        },
        refs: { head: "refs/changes/{number}/head" },
        fields,
        capabilities: { baseRevisionRequired: false },
      },
      pinned: {
        label: "Pinned code host",
        executable: "cli-two",
        urls: {
          patterns: [
            { host: "pinned.example", path: "/projects/{repo}/reviews/{number}" },
            { host: "pinned.example", path: "/projects/{repo}/reviews/{number}/files" },
          ],
          canonical: "https://pinned.example/projects/{repo}/reviews/{number}",
          clone: "https://mirror.example/{repo}.git",
        },
        operations: {
          pullRequest: { args: ["request", "show", "{repo}", "{number}"] },
          reviews: { args: ["request", "reviews", "{repo}", "{number}"] },
        },
        refs: { base: "review/{number}/base", head: "review/{number}/head" },
        fields,
        capabilities: { baseRevisionRequired: true },
      },
    },
    repositories,
  };
}

function writeSettings(repositories: Record<string, unknown> = {}): void {
  writeFileSync(settingsPath, JSON.stringify(neutralSettings(repositories)), "utf8");
}

function metadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 123,
    subject: "Add review mode",
    description: "Body",
    metrics: { added: 10, removed: 4, files: 3 },
    actor: { handle: "author-one" },
    phase: "open",
    source: { name: "feature/review", oid: suppliedHead },
    target: { name: "main", oid: "b".repeat(40) },
    ...overrides,
  };
}

function reviewPayload() {
  return [{ actor: { handle: "reviewer-one" }, decision: "APPROVED" }];
}

function suppliedHandoff() {
  return parsePullRequestHandoff({
    provider: "primary",
    repo: "example/widgets",
    number: "123",
    url: "https://code.example/example/widgets/change/123",
    title: "Child change",
    authorLogin: "author-one",
    state: "OPEN",
    body: "Body",
    baseRefName: "main",
    headRefName: "child/review",
    headRefOid: suppliedHead,
    additions: 10,
    deletions: 4,
    changedFiles: 3,
  });
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "pi-code-diff-remote-"));
  settingsPath = join(directory, "settings.json");
  process.env.PI_CODE_DIFF_SETTINGS_PATH = settingsPath;
  writeSettings();
  clearRemoteReviewTargetCache();
});

afterEach(() => {
  if (originalSettingsPath == null) delete process.env.PI_CODE_DIFF_SETTINGS_PATH;
  else process.env.PI_CODE_DIFF_SETTINGS_PATH = originalSettingsPath;
  if (originalCacheRoot == null) delete process.env.PI_CODE_DIFF_REMOTE_CACHE_ROOT;
  else process.env.PI_CODE_DIFF_REMOTE_CACHE_ROOT = originalCacheRoot;
  rmSync(directory, { recursive: true, force: true });
  vi.useRealTimers();
});

describe("remote review helpers", () => {
  it("parses built-in GitHub and configured URL patterns while rejecting attacker-shaped URLs", () => {
    expect(extractBranchFromRemote("https://github.com/dantetekanem/pi-extended-teams/pull/18")).toEqual({
      branch: "__pr__18",
      repo: "dantetekanem/pi-extended-teams",
      prNumber: "18",
      provider: "github",
    });
    expect(extractBranchFromRemote("https://code.example/example/widgets/change/123")).toEqual({
      branch: "__pr__123",
      repo: "example/widgets",
      prNumber: "123",
      provider: "primary",
    });
    expect(extractBranchFromRemote("https://stack.example/review/example/widgets/456")).toEqual({
      branch: "__pr__456",
      repo: "example/widgets",
      prNumber: "456",
      provider: "primary",
    });
    expect(extractBranchFromRemote("https://pinned.example/projects/example/widgets/reviews/8/files")).toEqual({
      branch: "__pr__8",
      repo: "example/widgets",
      prNumber: "8",
      provider: "pinned",
    });
    expect(extractBranchFromRemote("feature/stack-branch")).toEqual({ branch: "feature/stack-branch" });
    expect(extractBranchFromRemote("https://evil.example/https://code.example/example/widgets/change/1")).toBeNull();
    expect(extractBranchFromRemote("https://code.example.evil.example/example/widgets/change/1")).toBeNull();
    expect(extractBranchFromRemote("https://user@code.example/example/widgets/change/1")).toBeNull();
    expect(extractBranchFromRemote("http://code.example/example/widgets/change/1")).toBeNull();
    expect(extractBranchFromRemote("https://code.example/example/widgets/change/1?next=x")).toBeNull();
    expect(extractBranchFromRemote("https://code.example/example/widgets/change/1/commits")).toBeNull();
  });

  it("keeps cache paths inside the configured root and rejects dot segments", () => {
    const root = join(directory, "cache-root");
    process.env.PI_CODE_DIFF_REMOTE_CACHE_ROOT = root;

    expect(getRemoteCacheRoot("example/widgets")).toBe(join(root, "example", "widgets"));
    expect(() => getRemoteCacheRoot("../..")).toThrow("Invalid repository name");
    expect(() => getRemoteCacheRoot("../sessions")).toThrow("Invalid repository name");
  });

  it("renders provider operations as executable plus argv and fetches branch refs", async () => {
    const fetchCalls: string[][] = [];
    const exec = vi.fn(async (command: string, args: string[]) => {
      if (command === "cli-one" && args[1] === "show") return { code: 0, stdout: JSON.stringify(metadata()), stderr: "", killed: false };
      if (command === "cli-one" && args[1] === "reviews") return { code: 0, stdout: JSON.stringify(reviewPayload()), stderr: "", killed: false };
      if (command === "git" && args[1] === "fetch") {
        fetchCalls.push(args);
        return { code: 0, stdout: "", stderr: "", killed: false };
      }
      if (command === "git" && args[0] === "merge-base") return { code: 0, stdout: "merge-base-oid\n", stderr: "", killed: false };
      return { code: 1, stdout: "", stderr: `unexpected ${command} ${args.join(" ")}`, killed: false };
    });

    await expect(resolveRemoteReviewTarget(
      { exec } as never,
      "/repo",
      "https://stack.example/review/example/widgets/123",
      "/repo",
    )).resolves.toMatchObject({
      provider: "primary",
      remote: "https://code.example/example/widgets/change/123",
      gitRoot: "/repo",
      baseRef: "merge-base-oid",
      headRef: "origin/feature/review",
      branch: "feature/review",
      repo: "example/widgets",
      pullRequest: {
        number: "123",
        authorLogin: "author-one",
        reviews: [{ author: { login: "reviewer-one" }, state: "APPROVED" }],
      },
    });
    expect(exec).toHaveBeenCalledWith("cli-one", ["change", "show", "example/widgets", "123"], expect.any(Object));
    expect(exec).toHaveBeenCalledWith("cli-one", ["change", "reviews", "example/widgets", "123"], expect.any(Object));
    expect(fetchCalls[0]).toContain("+refs/heads/main:refs/remotes/origin/main");
    expect(fetchCalls[0]).toContain("+refs/heads/feature/review:refs/remotes/origin/feature/review");
  });

  it("renders fallback clone and provider head refs when the source branch is unavailable", async () => {
    const fetchCalls: string[][] = [];
    const exec = vi.fn(async (command: string, args: string[]) => {
      if (command === "cli-one" && args[1] === "show") return { code: 0, stdout: JSON.stringify(metadata()), stderr: "", killed: false };
      if (command === "cli-one" && args[1] === "reviews") return { code: 0, stdout: "[]", stderr: "", killed: false };
      if (command === "git" && args[1] === "fetch") {
        fetchCalls.push(args);
        return { code: fetchCalls.length === 1 ? 1 : 0, stdout: "", stderr: fetchCalls.length === 1 ? "missing branch" : "", killed: false };
      }
      if (command === "git" && args[0] === "merge-base") return { code: 0, stdout: "base-oid\n", stderr: "", killed: false };
      return { code: 1, stdout: "", stderr: "unexpected", killed: false };
    });

    await expect(resolveRemoteReviewTarget({ exec } as never, "/repo", "https://code.example/example/widgets/change/123", "/repo"))
      .resolves.toMatchObject({ headRef: "origin/review/primary/123/head" });
    expect(fetchCalls[1]?.[3]).toBe("https://code.example/example/widgets.git");
    expect(fetchCalls[1]).toContain("+refs/changes/123/head:refs/remotes/origin/review/primary/123/head");
  });

  it("renders pinned ref templates and keeps the fetched head at the advertised revision", async () => {
    const fetchCalls: string[][] = [];
    const exec = vi.fn(async (command: string, args: string[]) => {
      if (command === "cli-two" && args[1] === "show") return { code: 0, stdout: JSON.stringify(metadata({ id: 8 })), stderr: "", killed: false };
      if (command === "cli-two" && args[1] === "reviews") return { code: 0, stdout: "[]", stderr: "", killed: false };
      if (command === "git" && args[1] === "fetch") {
        fetchCalls.push(args);
        return { code: 0, stdout: "", stderr: "", killed: false };
      }
      if (command === "git" && args[0] === "rev-parse") return { code: 0, stdout: `${suppliedHead}\n`, stderr: "", killed: false };
      if (command === "git" && args[0] === "merge-base") return { code: 0, stdout: "base-oid\n", stderr: "", killed: false };
      return { code: 1, stdout: "", stderr: "unexpected", killed: false };
    });

    await expect(resolveRemoteReviewTarget(
      { exec } as never,
      "/repo",
      "https://pinned.example/projects/example/widgets/reviews/8/files",
      "/repo",
    )).resolves.toMatchObject({
      remote: "https://pinned.example/projects/example/widgets/reviews/8",
      baseRef: "base-oid",
      headRef: "origin/review/8/head",
    });
    expect(fetchCalls[0]).toContain("+refs/heads/main:refs/remotes/origin/review/8/base");
    expect(fetchCalls[0]).toContain("+refs/heads/feature/review:refs/remotes/origin/review/8/head");
  });

  it("fails closed when a pinned provider head drifts", async () => {
    const fetchCalls: string[][] = [];
    const exec = vi.fn(async (command: string, args: string[]) => {
      if (command === "cli-two" && args[1] === "show") return { code: 0, stdout: JSON.stringify(metadata({ id: 8 })), stderr: "", killed: false };
      if (command === "cli-two" && args[1] === "reviews") return { code: 0, stdout: "[]", stderr: "", killed: false };
      if (command === "git" && args[1] === "fetch") {
        fetchCalls.push(args);
        return { code: 0, stdout: "", stderr: "", killed: false };
      }
      if (command === "git" && args[0] === "rev-parse") return { code: 0, stdout: "different-oid\n", stderr: "", killed: false };
      return { code: 1, stdout: "", stderr: "unexpected", killed: false };
    });

    await expect(resolveRemoteReviewTarget(
      { exec } as never,
      "/repo",
      "https://pinned.example/projects/example/widgets/reviews/8",
      "/repo",
    )).rejects.toThrow(/head changed while preparing the review/i);
    expect(fetchCalls[0]).toContain("+refs/heads/main:refs/remotes/origin/review/8/base");
    expect(fetchCalls[0]).toContain("+refs/heads/feature/review:refs/remotes/origin/review/8/head");
  });

  it("loads repository profiles from provider settings", async () => {
    const checkout = join(directory, "checkout");
    mkdirSync(join(checkout, "packages/widgets"), { recursive: true });
    writeSettings({
      "example/widgets": {
        cwd: checkout,
        subdir: "packages/widgets",
        pathspecs: ["packages/widgets", "shared/ui"],
        importAliases: { "@shared": "shared/ui" },
      },
    });
    const exec = vi.fn(async (command: string, args: string[]) => {
      if (command === "git" && args[0] === "remote") return { code: 0, stdout: "ssh://code.example/example/widgets.git\n", stderr: "", killed: false };
      if (command === "cli-one" && args[1] === "show") return { code: 0, stdout: JSON.stringify(metadata()), stderr: "", killed: false };
      if (command === "cli-one" && args[1] === "reviews") return { code: 0, stdout: "[]", stderr: "", killed: false };
      if (command === "git" && args[1] === "fetch") return { code: 0, stdout: "", stderr: "", killed: false };
      return { code: 1, stdout: "", stderr: "unexpected", killed: false };
    });

    await expect(resolveRemoteReviewTarget({ exec } as never, "/other", "https://code.example/example/widgets/change/123"))
      .resolves.toMatchObject({
        gitRoot: checkout,
        workspacePath: "packages/widgets",
        pathspecs: ["packages/widgets", "shared/ui"],
        importAliases: { "@shared": "shared/ui" },
      });
  });

  it("uses a local cache and the rendered clone URL for an unmatched repository", async () => {
    const cacheRoot = join(directory, "cache");
    process.env.PI_CODE_DIFF_REMOTE_CACHE_ROOT = cacheRoot;
    const exec = vi.fn(async (command: string, args: string[], options?: { cwd?: string }) => {
      if (command === "git" && args[0] === "init") return { code: 0, stdout: "initialized", stderr: "", killed: false };
      if (command === "git" && args[0] === "rev-parse" && args[1] === "--show-toplevel") {
        return options?.cwd === "/other"
          ? { code: 1, stdout: "", stderr: "not a repository", killed: false }
          : { code: 0, stdout: `${options?.cwd ?? ""}\n`, stderr: "", killed: false };
      }
      if (command === "git" && args[0] === "remote") return { code: 1, stdout: "", stderr: "no remote", killed: false };
      if (command === "cli-one" && args[1] === "show") return { code: 0, stdout: JSON.stringify(metadata()), stderr: "", killed: false };
      if (command === "cli-one" && args[1] === "reviews") return { code: 0, stdout: "[]", stderr: "", killed: false };
      if (command === "git" && args[1] === "fetch") return { code: 0, stdout: "", stderr: "", killed: false };
      return { code: 1, stdout: "", stderr: "unexpected", killed: false };
    });

    const target = await resolveRemoteReviewTarget({ exec } as never, "/other", "https://code.example/example/widgets/change/123");
    expect(target.gitRoot).toBe(join(cacheRoot, "example", "widgets"));
    expect(exec).toHaveBeenCalledWith("git", expect.arrayContaining(["https://code.example/example/widgets.git"]), expect.any(Object));
  });

  it("uses supplied handoff metadata, skips provider operations, and verifies the fetched head", async () => {
    const progress: string[] = [];
    const exec = vi.fn(async (command: string, args: string[]) => {
      if (command === "git" && args[1] === "fetch") return { code: 0, stdout: "", stderr: "", killed: false };
      if (command === "git" && args.join(" ") === "rev-parse origin/child/review") return { code: 0, stdout: `${suppliedHead}\n`, stderr: "", killed: false };
      if (command === "git" && args[0] === "merge-base") return { code: 0, stdout: "base-oid\n", stderr: "", killed: false };
      return { code: 1, stdout: "", stderr: "unexpected", killed: false };
    });

    const target = await resolveRemoteReviewTarget(
      { exec } as never,
      "/repo",
      "https://code.example/example/widgets/change/123",
      "/repo",
      (message) => progress.push(message),
      suppliedHandoff(),
    );

    expect(target).toMatchObject({
      baseRef: "base-oid",
      headRef: "origin/child/review",
      provider: "primary",
      pullRequest: { number: "123", title: "Child change" },
      handoff: { number: "123" },
    });
    expect(exec).not.toHaveBeenCalledWith("cli-one", expect.anything(), expect.anything());
    expect(progress).toContain("Using supplied PR #123 metadata…");
  });

  it("bypasses cached targets for DISCUSS continuation and replaces the normal cache on success", async () => {
    const exec = vi.fn(async (command: string, args: string[]) => {
      if (command === "git" && args[0] === "symbolic-ref") return { code: 0, stdout: "origin/main\n", stderr: "", killed: false };
      if (command === "git" && args[1] === "fetch") return { code: 0, stdout: "", stderr: "", killed: false };
      return { code: 1, stdout: "", stderr: `unexpected ${command} ${args.join(" ")}`, killed: false };
    });

    await resolveRemoteReviewTarget({ exec } as never, "/repo", "feature/review", "/repo");
    const callsAfterInitial = exec.mock.calls.length;
    await resolveRemoteReviewTarget({ exec } as never, "/repo", "feature/review", "/repo", undefined, { cacheMode: "bypass" });
    const callsAfterRefresh = exec.mock.calls.length;
    await resolveRemoteReviewTarget({ exec } as never, "/repo", "feature/review", "/repo");

    expect(callsAfterRefresh).toBeGreaterThan(callsAfterInitial);
    expect(exec.mock.calls.length).toBe(callsAfterRefresh);
  });

  it("retains the old cache when a forced DISCUSS refresh fails", async () => {
    let failRefresh = false;
    const exec = vi.fn(async (command: string, args: string[]) => {
      if (command === "git" && args[0] === "symbolic-ref") return { code: 0, stdout: "origin/main\n", stderr: "", killed: false };
      if (command === "git" && args[1] === "fetch") return failRefresh
        ? { code: 1, stdout: "", stderr: "refresh failed", killed: false }
        : { code: 0, stdout: "", stderr: "", killed: false };
      return { code: 1, stdout: "", stderr: `unexpected ${command} ${args.join(" ")}`, killed: false };
    });

    const original = await resolveRemoteReviewTarget({ exec } as never, "/repo", "feature/review", "/repo");
    failRefresh = true;
    await expect(resolveRemoteReviewTarget({ exec } as never, "/repo", "feature/review", "/repo", undefined, { cacheMode: "bypass" })).rejects.toThrow("refresh failed");
    const callsAfterFailure = exec.mock.calls.length;
    await expect(resolveRemoteReviewTarget({ exec } as never, "/repo", "feature/review", "/repo")).resolves.toBe(original);
    expect(exec.mock.calls.length).toBe(callsAfterFailure);
  });

  it("preserves plain branch resolution and the remote target cache TTL", async () => {
    vi.useFakeTimers();
    const exec = vi.fn(async (command: string, args: string[]) => {
      if (command === "git" && args[0] === "symbolic-ref") return { code: 0, stdout: "origin/main\n", stderr: "", killed: false };
      if (command === "git" && args[1] === "fetch") return { code: 0, stdout: "", stderr: "", killed: false };
      return { code: 1, stdout: "", stderr: "unexpected", killed: false };
    });

    await expect(resolveRemoteReviewTarget({ exec } as never, "/repo", "feature/review", "/repo")).resolves.toMatchObject({
      baseRef: "origin/main",
      headRef: "origin/feature/review",
      branch: "feature/review",
    });
    const firstCallCount = exec.mock.calls.length;
    const progress: string[] = [];
    await resolveRemoteReviewTarget({ exec } as never, "/repo", "feature/review", "/repo", (message) => progress.push(message));
    expect(exec).toHaveBeenCalledTimes(firstCallCount);
    expect(progress).toContain("Using cached remote review for feature/review…");

    vi.advanceTimersByTime(10 * 60 * 1000 + 1);
    await resolveRemoteReviewTarget({ exec } as never, "/repo", "feature/review", "/repo");
    expect(exec.mock.calls.length).toBeGreaterThan(firstCallCount);
  });

  it("formats pull request context with the latest state per reviewer", () => {
    expect(formatPullRequestContext({
      number: "123",
      repo: "example/widgets",
      title: "Add review mode",
      body: "",
      additions: 10,
      deletions: 4,
      changedFiles: 3,
      authorLogin: "author-one",
      state: "OPEN",
      reviews: [
        { author: { login: "reviewer-one" }, state: "COMMENTED" },
        { author: { login: "reviewer-one" }, state: "APPROVED" },
      ],
      headRefName: "feature/review",
      headRefOid: suppliedHead,
      baseRefName: "main",
    })).toContain("reviewer-one (approved)");
  });
});
