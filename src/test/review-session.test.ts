import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildReviewFileSignatures,
  createReviewSessionId,
  createReviewInstanceId,
  deleteReviewSession,
  hasReviewSessionIdentity,
  getReviewSessionPathForDiagnostics,
  listReviewSessions,
  loadReviewSession,
  rebaseReviewSession,
  REVIEW_SESSION_VERSION,
  REVIEW_SESSION_TTL_MS,
  saveReviewSession,
  saveReviewSessionWithStatus,
  type PersistedReviewSession,
  type ReviewSessionData,
} from "../review-session.js";
import type { DiffReviewComment, ReviewFile, ReviewState } from "../types.js";

const originalSessionsDir = process.env.PI_CODE_DIFF_SESSIONS_DIR;
let sessionsDir: string;

function state(comments?: DiffReviewComment[]): ReviewState {
  return {
    activeScope: "git-diff",
    activeFileId: "src/app.ts",
    searchQuery: "app",
    focus: "diff",
    wrapLines: true,
    hideUnchanged: false,
    selectedCommentIndex: 0,
    selectedLineTargetByScopeFile: { "git-diff::src/app.ts": { side: "added", line: 4 } },
    draft: {
      allComment: "Review note",
      allIntent: "discuss",
      comments: comments ?? [{
        id: "line:git-diff:src/app.ts:added:4",
        fileId: "src/app.ts",
        scope: "git-diff",
        side: "added",
        intent: "comment",
        startLine: 4,
        endLine: 4,
        body: "Keep this covered.",
      }],
    },
  };
}

function sessionData(overrides: Partial<ReviewSessionData> = {}): ReviewSessionData {
  return {
    state: state(),
    diffViewMode: "unified",
    navigatorTreeMode: true,
    contextLineNavigation: false,
    commentsGlobal: false,
    reviewedFileIds: [],
    navigatorScroll: 0,
    diffScroll: 0,
    commentsScroll: 0,
    ...overrides,
  };
}

function reviewFile(path: string, additions: number, modifiedBlobSha = `${path}:${additions}`): ReviewFile {
  return {
    id: `${path}::working::${path}::::`,
    path,
    worktreeStatus: "modified",
    hasWorkingTreeFile: true,
    inGitDiff: true,
    inLastCommit: false,
    inAllFiles: false,
    gitDiff: {
      status: "modified",
      oldPath: path,
      newPath: path,
      displayPath: path,
      hasOriginal: true,
      hasModified: true,
      additions,
      deletions: 0,
      originalBlobSha: `base:${path}`,
      modifiedBlobSha,
    },
    lastCommit: null,
    allFiles: null,
  };
}

beforeEach(async () => {
  sessionsDir = await mkdtemp(join(tmpdir(), "pi-code-diff-sessions-"));
  process.env.PI_CODE_DIFF_SESSIONS_DIR = sessionsDir;
});

afterEach(async () => {
  vi.useRealTimers();
  if (originalSessionsDir == null) delete process.env.PI_CODE_DIFF_SESSIONS_DIR;
  else process.env.PI_CODE_DIFF_SESSIONS_DIR = originalSessionsDir;
  await rm(sessionsDir, { recursive: true, force: true });
});

describe("review sessions", () => {
  it("keeps independent instances discoverable under one target and validates terminal continuation identity", () => {
    const identity = "pr|github|example/widgets|1";
    const first = createReviewInstanceId();
    const second = createReviewInstanceId();
    expect(first).not.toBe(second);
    const a = saveReviewSessionWithStatus(identity, sessionData(), { id: first, revision: "head" });
    const b = saveReviewSessionWithStatus(identity, sessionData(), { id: second, revision: "head" });
    expect(a).toMatchObject({ saved: true, generation: 1 });
    expect(b).toMatchObject({ saved: true, generation: 1 });
    expect(listReviewSessions().map((entry) => entry.id)).toEqual(expect.arrayContaining([first, second]));
    expect(hasReviewSessionIdentity(identity, first)).toBe(true);
    expect(hasReviewSessionIdentity("pr|github|another/repo|1", first)).toBe(false);
    expect(hasReviewSessionIdentity(identity, "missing")).toBe(false);
    expect(deleteReviewSession(identity, first, 1)).toMatchObject({ deleted: true });
    expect(loadReviewSession(identity, first)).toBeNull();
    expect(hasReviewSessionIdentity(identity, first)).toBe(true);
    expect(hasReviewSessionIdentity("pr|github|another/repo|1", first)).toBe(false);
    expect(loadReviewSession(identity, second)).toMatchObject({ id: second, generation: 1 });
  });

  it("migrates a resumed legacy target identity without changing the instance or permitting a stale old-identity writer", () => {
    const previousIdentity = "/repo|origin/main|old-sha|example/widgets#1";
    const identity = "pr|github|example/widgets|1";
    const id = saveReviewSession(previousIdentity, sessionData(), { revision: "old-sha" });
    const migration = saveReviewSessionWithStatus(identity, sessionData(), { id, revision: "new-sha", expectedGeneration: 1, previousIdentity });
    expect(migration).toMatchObject({ saved: true, generation: 2 });
    expect(loadReviewSession(identity, id)).toMatchObject({ id, identity, generation: 2 });
    expect(saveReviewSessionWithStatus(previousIdentity, sessionData(), { id, revision: "old-sha", expectedGeneration: 1 })).toMatchObject({ saved: false, status: "conflict" });
    expect(hasReviewSessionIdentity(identity, id)).toBe(true);
  });

  it("persists and restores a versioned review snapshot by identity", () => {
    const identity = "/repo|base|head";
    const id = saveReviewSession(identity, sessionData({
      state: state(),
      diffViewMode: "side-by-side",
      commentsGlobal: true,
      showAllLocales: true,
      reviewedFileIds: ["src/app.ts"],
      navigatorScroll: 2,
      diffScroll: 8,
      commentsScroll: 1,
    }), { revision: "head-sha", fileSignatures: { "src/app.ts": "modified:src/app.ts:2:0" } });

    expect(id).toBe(createReviewSessionId(identity));
    expect(loadReviewSession(identity)).toMatchObject({
      version: REVIEW_SESSION_VERSION,
      id,
      identity,
      revision: "head-sha",
      fileSignatures: { "src/app.ts": "modified:src/app.ts:2:0" },
      diffViewMode: "side-by-side",
      showAllLocales: true,
      reviewedFileIds: ["src/app.ts"],
      state: { activeFileId: "src/app.ts", draft: { allComment: "Review note" } },
    });
  });

  it("loads v1 losslessly at the current version, recovers its revision, and marks legacy line anchors stale", async () => {
    const identity = "/repo|origin/main|abc123|local";
    const id = createReviewSessionId(identity);
    const path = getReviewSessionPathForDiagnostics(id);
    const legacy = {
      version: 1,
      id,
      identity,
      updatedAt: "2025-01-01T00:00:00.000Z",
      ...sessionData(),
    };
    legacy.state.draft.comments.push({
      id: "modify", fileId: "src/app.ts", scope: "git-diff", side: "added", intent: "modify",
      startLine: 6, endLine: 7, body: "replacement", originalText: "before\ntext",
    });
    legacy.state.draft.comments.push({
      id: "file", fileId: "src/app.ts", scope: "git-diff", side: "file", intent: "comment",
      startLine: null, endLine: null, body: "file note", fileTarget: "file",
    });
    const serialized = `${JSON.stringify(legacy, null, 2)}\n`;
    await writeFile(path, serialized, "utf8");

    const migrated = loadReviewSession(identity);
    expect(migrated).toMatchObject({ version: REVIEW_SESSION_VERSION, revision: "abc123", fileSignatures: {} });
    expect(migrated?.state.draft.comments).toMatchObject([
      { id: "line:git-diff:src/app.ts:added:4", anchorStatus: "stale" },
      { id: "modify", originalText: "before\ntext", anchorStatus: "stale" },
      { id: "file", side: "file", anchorStatus: "mapped" },
    ]);
    expect(readFileSync(path, "utf8")).toBe(serialized);
  });

  it("round-trips unresolved anchor fields and reports a durable save", () => {
    const identity = "/repo|base|head";
    const exact: DiffReviewComment = {
      id: "stable-id",
      fileId: "src/app.ts",
      scope: "git-diff",
      side: "deleted",
      intent: "modify",
      startLine: 7,
      endLine: 9,
      body: "\treplacement()  \r\n  child()",
      originalText: "\toriginal()  \r\n  child()",
      captureHash: { algorithm: "sha256", value: "a".repeat(64) },
      anchorStatus: "stale",
    };
    const data = sessionData({
      state: { ...state(), draft: { allComment: "Review note", allIntent: "modify", comments: [exact] } },
      commentsGlobal: true,
      reviewedFileIds: ["src/app.ts"],
      navigatorScroll: 3,
      diffScroll: 4,
      commentsScroll: 5,
    });

    expect(saveReviewSessionWithStatus(identity, data, {
      revision: "head",
      fileSignatures: { "src/app.ts": "signature" },
      meta: { kind: "local", label: "/repo", cwd: "/repo" },
    })).toEqual({ id: createReviewSessionId(identity), saved: true, status: "saved", generation: 1, indexUpdated: true });
    expect(loadReviewSession(identity)).toMatchObject({
      revision: "head",
      fileSignatures: { "src/app.ts": "signature" },
      meta: { kind: "local", label: "/repo", cwd: "/repo" },
      state: { draft: data.state.draft },
    });
  });

  it("reports persistence failure without claiming a durable save", async () => {
    const identity = "/repo|base|head";
    const invalidParent = join(sessionsDir, "not-a-directory");
    await writeFile(invalidParent, "occupied", "utf8");
    process.env.PI_CODE_DIFF_SESSIONS_DIR = invalidParent;

    expect(saveReviewSessionWithStatus(identity, sessionData())).toMatchObject({ id: createReviewSessionId(identity), saved: false, status: "error" });
  });

  it("rejects corrupted or future-version session data", async () => {
    const identity = "/repo|base|head";
    const path = getReviewSessionPathForDiagnostics(createReviewSessionId(identity));
    await writeFile(path, JSON.stringify({ version: 99, identity }), "utf8");

    expect(loadReviewSession(identity)).toBeNull();
  });

  it("deletes a persisted review session and its index entry", () => {
    const identity = "/repo|base|head";
    saveReviewSession(identity, sessionData(), { revision: "head-sha" });

    deleteReviewSession(identity, undefined, loadReviewSession(identity)!.generation);
    expect(loadReviewSession(identity)).toBeNull();
    expect(listReviewSessions()).toEqual([]);
  });
});

describe("expected-generation snapshots", () => {
  it("preserves both feedback versions when a loaded writer is stale", () => {
    const identity = "stale-writers";
    saveReviewSession(identity, sessionData());
    const first = loadReviewSession(identity)!;
    const second = loadReviewSession(identity)!;
    first.state.draft.comments[0]!.body = "First writer's comment";
    second.state.draft.allComment = "Second writer's note";

    expect(saveReviewSessionWithStatus(identity, first, {
      revision: "head", expectedGeneration: first.generation,
    })).toMatchObject({ saved: true, status: "saved", generation: 2 });
    const conflict = saveReviewSessionWithStatus(identity, second, {
      revision: "head", expectedGeneration: second.generation,
    });

    expect(conflict).toMatchObject({
      saved: false, status: "conflict", reason: "generation-mismatch",
      expectedGeneration: 1, actualGeneration: 2,
      current: { state: { draft: { comments: [{ body: "First writer's comment" }] } } },
      attempted: { state: { draft: { allComment: "Second writer's note" } } },
    });
    expect(loadReviewSession(identity)?.state.draft.comments[0]?.body).toBe("First writer's comment");
  });

  it("requires an explicit loaded generation to replace an existing draft", () => {
    const identity = "generation-required";
    saveReviewSession(identity, sessionData());
    expect(saveReviewSessionWithStatus(identity, sessionData())).toMatchObject({
      saved: false, status: "conflict", reason: "generation-mismatch", actualGeneration: 1,
    });
    expect(() => saveReviewSession(identity, sessionData())).toThrow();
  });

  it("cannot recreate a deleted draft from either a stale or a create-only save", () => {
    const identity = "deleted-draft";
    const id = saveReviewSession(identity, sessionData());
    const stale = loadReviewSession(identity)!;
    expect(deleteReviewSession(identity, id, stale.generation)).toMatchObject({ deleted: true, generation: 2 });

    expect(saveReviewSessionWithStatus(identity, stale, {
      revision: "head", expectedGeneration: stale.generation,
    })).toMatchObject({ saved: false, status: "conflict", reason: "deleted", actualGeneration: 2 });
    expect(saveReviewSessionWithStatus(identity, sessionData())).toMatchObject({ saved: false, reason: "deleted" });
    expect(loadReviewSession(identity)).toBeNull();
    expect(listReviewSessions()).toEqual([]);
  });

  it("rejects stale deletion and stale feedback after consumption", () => {
    const identity = "consumed-draft";
    const id = saveReviewSession(identity, sessionData());
    const stale = loadReviewSession(identity)!;
    const consumed = sessionData({ state: { ...state(), draft: { allComment: "", allIntent: "comment", comments: [] } } });
    expect(saveReviewSessionWithStatus(identity, consumed, {
      revision: "head", expectedGeneration: stale.generation,
    })).toMatchObject({ saved: true, generation: 2 });
    expect(deleteReviewSession(identity, id, stale.generation)).toMatchObject({ deleted: false, status: "conflict" });
    expect(saveReviewSessionWithStatus(identity, stale, {
      revision: "head", expectedGeneration: stale.generation,
    })).toMatchObject({ saved: false, status: "conflict" });
    expect(loadReviewSession(identity)?.state.draft).toEqual(consumed.state.draft);
  });

  it.each([1, 2])("loads legacy v%s at generation zero without allowing blind replacement", async (version) => {
    const identity = `legacy-${version}`;
    const id = createReviewSessionId(identity);
    await writeFile(getReviewSessionPathForDiagnostics(id), JSON.stringify({
      ...sessionData(), version, id, identity, updatedAt: new Date().toISOString(), revision: "head",
    }));
    const legacy = loadReviewSession(identity)!;
    expect(legacy.generation).toBe(0);
    expect(saveReviewSessionWithStatus(identity, legacy)).toMatchObject({ saved: false, status: "conflict" });
    expect(saveReviewSessionWithStatus(identity, legacy, {
      revision: "head", expectedGeneration: 0,
    })).toMatchObject({ saved: true, generation: 1 });
  });

  it.each(["index", "INDEX"])("rejects reserved snapshot id %s instead of overwriting feedback with the index", (id) => {
    const result = saveReviewSessionWithStatus("reserved-id", sessionData(), { id, revision: "head" });
    expect(result).toMatchObject({ saved: false });
    expect(loadReviewSession("reserved-id", id)).toBeNull();
  });

  it("reports a committed generation separately from an index write failure", async () => {
    await mkdir(join(sessionsDir, "index.json"));
    const identity = "index-write-failed";
    expect(saveReviewSessionWithStatus(identity, sessionData())).toMatchObject({ saved: true, generation: 1, indexUpdated: false });
    expect(loadReviewSession(identity)?.state.draft.allComment).toBe("Review note");
    expect(saveReviewSessionWithStatus(identity, sessionData())).toMatchObject({ saved: false, status: "conflict", actualGeneration: 1 });
  });

  it("does not overwrite corrupt or unsupported snapshot files", async () => {
    const identity = "corrupt-snapshot";
    const path = getReviewSessionPathForDiagnostics(createReviewSessionId(identity));
    await writeFile(path, "{ incomplete");
    expect(saveReviewSessionWithStatus(identity, sessionData())).toMatchObject({ saved: false, status: "conflict", reason: "unreadable" });
    expect(readFileSync(path, "utf8")).toBe("{ incomplete");
  });
});

describe("review session index", () => {
  it("keeps a newest-first index with resume metadata and counts", () => {
    const now = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(now - 60_000);
    saveReviewSession("pr|github|example/widgets|1", sessionData({ reviewedFileIds: ["src/app.ts"] }), {
      revision: "abc123",
      meta: { kind: "remote", label: "example/widgets#1 Add review mode", url: "https://github.com/example/widgets/pull/1", resumeArgs: "remote example/widgets#1", cwd: "/repo" },
    });
    vi.setSystemTime(now - 1_000);
    saveReviewSession("/repo|working|worktree|local", sessionData(), {
      revision: "worktree",
      meta: { kind: "local", label: "/repo", resumeArgs: "", cwd: "/repo" },
    });
    vi.useRealTimers();

    const entries = listReviewSessions();
    expect(entries.map((entry) => entry.identity)).toEqual(["/repo|working|worktree|local", "pr|github|example/widgets|1"]);
    expect(entries[1]).toMatchObject({
      revision: "abc123",
      commentCount: 2,
      reviewedCount: 1,
      kind: "remote",
      label: "example/widgets#1 Add review mode",
      url: "https://github.com/example/widgets/pull/1",
      resumeArgs: "remote example/widgets#1",
    });
  });

  it("rebuilds the index from session files when it is corrupted", async () => {
    saveReviewSession("pr|github|example/widgets|1", sessionData(), { revision: "abc123", meta: { kind: "remote", label: "example/widgets#1" } });
    await writeFile(join(sessionsDir, "index.json"), "{ not json", "utf8");

    const entries = listReviewSessions();
    expect(entries.map((entry) => entry.identity)).toEqual(["pr|github|example/widgets|1"]);
    expect(JSON.parse(readFileSync(join(sessionsDir, "index.json"), "utf8")).sessions).toHaveLength(1);
  });

  it.each(["list", "save", "delete"])("repairs valid but incomplete index membership during %s", async (operation) => {
    const indexPath = join(sessionsDir, "index.json");
    saveReviewSession("indexed", sessionData());
    const incomplete = readFileSync(indexPath, "utf8");
    const recoveredId = saveReviewSession("omitted", sessionData(), { revision: "recovered-head" });
    await writeFile(indexPath, incomplete);

    if (operation === "list") listReviewSessions();
    else if (operation === "save") expect(saveReviewSessionWithStatus("new", sessionData())).toMatchObject({ saved: true, indexUpdated: true });
    else expect(deleteReviewSession("unused")).toMatchObject({ deleted: true, indexUpdated: true });

    const entries = JSON.parse(readFileSync(indexPath, "utf8")).sessions;
    expect(entries).toHaveLength(operation === "save" ? 3 : 2);
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ identity: "indexed" }),
      expect.objectContaining({ id: recoveredId, identity: "omitted", revision: "recovered-head", commentCount: 2 }),
    ]));
    expect(loadReviewSession("omitted")).toMatchObject({ generation: 1, state: { draft: { allComment: "Review note" } } });
  });

  it("uses canonical snapshots rather than stale identities, duplicates, or misplaced recovery files", async () => {
    const previousIdentity = "legacy-target";
    const id = saveReviewSession(previousIdentity, sessionData());
    const indexPath = join(sessionsDir, "index.json");
    const previous = JSON.parse(readFileSync(indexPath, "utf8")).sessions[0];
    expect(saveReviewSessionWithStatus("canonical-target", sessionData(), {
      id, revision: "new-head", previousIdentity, expectedGeneration: 1,
    })).toMatchObject({ saved: true, generation: 2 });
    const misplaced = JSON.stringify({ ...loadReviewSession("canonical-target", id), identity: previousIdentity });
    const misplacedPath = join(sessionsDir, "zz-recovery-copy.json");
    await writeFile(misplacedPath, misplaced);
    await writeFile(indexPath, JSON.stringify({ version: REVIEW_SESSION_VERSION, sessions: [previous, previous] }));

    expect(listReviewSessions()).toMatchObject([{ id, identity: "canonical-target", revision: "new-head" }]);
    expect(readFileSync(misplacedPath, "utf8")).toBe(misplaced);
    expect(loadReviewSession("canonical-target", id)?.generation).toBe(2);
  });

  it.each([
    { updatedAt: "unknown" },
    { version: 99 },
    { generation: Number.MAX_SAFE_INTEGER + 1 },
    { generation: Number.MAX_SAFE_INTEGER },
  ])("preserves snapshots that cannot safely expire: %j", async (fields) => {
    const identity = "uncertain-retention";
    const id = saveReviewSession(identity, sessionData());
    const path = getReviewSessionPathForDiagnostics(id);
    const contents = JSON.stringify({ ...loadReviewSession(identity), updatedAt: "1970-01-01T00:00:00Z", ...fields });
    await writeFile(path, contents);
    const malformedPath = join(sessionsDir, "malformed.json");
    await writeFile(malformedPath, "{ incomplete");
    const temporaryPath = `${path}.interrupted.tmp`;
    await writeFile(temporaryPath, contents);

    expect(listReviewSessions()).toMatchObject([{ id, identity }]);
    expect(readFileSync(path, "utf8")).toBe(contents);
    expect(readFileSync(malformedPath, "utf8")).toBe("{ incomplete");
    expect(readFileSync(temporaryPath, "utf8")).toBe(contents);
  });

  it("expires omitted snapshots at their current generation and retains terminal identity indefinitely", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now - REVIEW_SESSION_TTL_MS - 1);
    const identity = "omitted-expired";
    const id = saveReviewSession(identity, sessionData());
    const loaded = loadReviewSession(identity)!;
    expect(saveReviewSessionWithStatus(identity, loaded, { revision: "head", expectedGeneration: loaded.generation })).toMatchObject({ generation: 2 });
    await writeFile(join(sessionsDir, "index.json"), JSON.stringify({ version: REVIEW_SESSION_VERSION, sessions: [] }));
    vi.setSystemTime(now);

    expect(listReviewSessions()).toEqual([]);
    const path = getReviewSessionPathForDiagnostics(id);
    const terminal = readFileSync(path, "utf8");
    expect(JSON.parse(terminal)).toMatchObject({ id, identity, deleted: true, generation: 3 });
    vi.setSystemTime(now + 10 * REVIEW_SESSION_TTL_MS);
    expect(listReviewSessions()).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe(terminal);
    expect(saveReviewSessionWithStatus(identity, sessionData())).toMatchObject({ saved: false, reason: "deleted", actualGeneration: 3 });
  });

  it("does not expire a refreshed snapshot using an old index timestamp", () => {
    const identity = "refreshed-snapshot";
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() - 40 * 24 * 60 * 60 * 1000);
    saveReviewSession(identity, sessionData());
    const previous = loadReviewSession(identity)!;
    vi.useRealTimers();
    expect(saveReviewSessionWithStatus(identity, previous, {
      revision: "head", expectedGeneration: previous.generation,
    })).toMatchObject({ saved: true, generation: 2 });
    expect(listReviewSessions()).toHaveLength(1);
    expect(loadReviewSession(identity)?.generation).toBe(2);
  });

  it("prunes sessions past the retention window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() - 40 * 24 * 60 * 60 * 1000);
    const identity = "/repo|working|worktree|local";
    const id = saveReviewSession(identity, sessionData(), { revision: "worktree" });
    vi.useRealTimers();

    expect(listReviewSessions()).toEqual([]);
    expect(loadReviewSession(identity)).toBeNull();
    expect(JSON.parse(readFileSync(getReviewSessionPathForDiagnostics(id), "utf8"))).toMatchObject({ deleted: true, generation: 2 });
    expect(saveReviewSessionWithStatus(identity, sessionData(), { revision: "worktree", expectedGeneration: 1 })).toMatchObject({
      saved: false, status: "conflict", reason: "deleted",
    });
  });
});

describe("rebasing a parked review onto a new head", () => {
  function parkedSession(): PersistedReviewSession {
    const comments: DiffReviewComment[] = [
      { id: "1", fileId: "src/app.ts::working::src/app.ts::::", scope: "git-diff", side: "added", intent: "comment", startLine: 4, endLine: 4, body: "Still valid." },
      { id: "2", fileId: "src/app.ts::working::src/app.ts::::", scope: "git-diff", side: "added", intent: "modify", startLine: 10, endLine: 10, body: "replacement()", originalText: "original()" },
      { id: "3", fileId: "src/api.ts::working::src/api.ts::::", scope: "git-diff", side: "added", intent: "comment", startLine: 7, endLine: 7, body: "Check the new branch." },
      { id: "4", fileId: "src/api.ts::working::src/api.ts::::", scope: "git-diff", side: "file", intent: "comment", startLine: null, endLine: null, body: "File-wide note.", fileTarget: "file" },
      { id: "5", fileId: "src/gone.ts::working::src/gone.ts::::", scope: "git-diff", side: "added", intent: "discuss", startLine: 3, endLine: 3, body: "Why was this added?" },
    ];
    const previousFiles = [reviewFile("src/app.ts", 2), reviewFile("src/api.ts", 1), reviewFile("src/gone.ts", 4)];
    const identity = "pr|github|example/widgets|1";
    saveReviewSession(identity, sessionData({
      state: { ...state(comments), draft: { allComment: "Overall note", allIntent: "discuss", comments } },
      reviewedFileIds: [reviewFile("src/app.ts", 2).id, reviewFile("src/api.ts", 1).id],
    }), { revision: "1111111111111111111111111111111111111111", fileSignatures: buildReviewFileSignatures(previousFiles) });
    return loadReviewSession(identity)!;
  }

  it("keeps stable anchors, marks changed files, and folds missing files into the review note", () => {
    const session = parkedSession();
    const nextFiles = [reviewFile("src/app.ts", 2), reviewFile("src/api.ts", 6)];
    const result = rebaseReviewSession(session, nextFiles, ["git-diff"], buildReviewFileSignatures(nextFiles));

    expect(result.previousRevision).toBe("1111111111111111111111111111111111111111");
    expect(result.reanchored).toBe(3);
    expect(result.needsAttention).toBe(1);
    expect(result.unanchored).toBe(1);

    const comments = result.data.state.draft.comments;
    const stable = comments.find((comment) => comment.startLine === 4)!;
    expect(stable.body).toBe("Still valid.");
    expect(stable.fileId).toBe(reviewFile("src/app.ts", 2).id);

    const modify = comments.find((comment) => comment.intent === "modify")!;
    expect(modify.originalText).toBe("original()");

    const marked = comments.find((comment) => comment.startLine === 7)!;
    expect(marked.body).toBe("[needs attention · anchored on 1111111]\nCheck the new branch.");

    const fileComment = comments.find((comment) => comment.side === "file")!;
    expect(fileComment.body).toBe("File-wide note.");

    expect(result.data.state.draft.allComment).toContain("Needs attention (unanchored from 1111111):");
    expect(result.data.state.draft.allComment).toContain("- src/gone.ts:3: Why was this added?");
    expect(comments.some((comment) => comment.body.includes("Why was this added?"))).toBe(false);
  });

  it("marks same-stat content changes instead of preserving stale anchors", () => {
    const session = parkedSession();
    const nextFiles = [
      reviewFile("src/app.ts", 2, "different-app-blob"),
      reviewFile("src/api.ts", 1),
    ];
    const result = rebaseReviewSession(session, nextFiles, ["git-diff"], buildReviewFileSignatures(nextFiles));

    const appComments = result.data.state.draft.comments.filter((comment) => comment.fileId.startsWith("src/app.ts"));
    expect(result.needsAttention).toBe(2);
    expect(appComments).toHaveLength(2);
    expect(appComments.every((comment) => comment.body.startsWith("[needs attention"))).toBe(true);
    expect(result.data.reviewedFileIds).toEqual([reviewFile("src/api.ts", 1).id]);
  });

  it("keeps reviewed files only while their content is unchanged", () => {
    const session = parkedSession();
    const nextFiles = [reviewFile("src/app.ts", 2), reviewFile("src/api.ts", 6)];
    const result = rebaseReviewSession(session, nextFiles, ["git-diff"], buildReviewFileSignatures(nextFiles));

    expect(result.data.reviewedFileIds).toEqual([reviewFile("src/app.ts", 2).id]);
  });

  it("does not stack needs-attention markers across repeated rebases", () => {
    const session = parkedSession();
    const secondFiles = [reviewFile("src/app.ts", 2), reviewFile("src/api.ts", 6)];
    const first = rebaseReviewSession(session, secondFiles, ["git-diff"], buildReviewFileSignatures(secondFiles));

    const thirdFiles = [reviewFile("src/app.ts", 2), reviewFile("src/api.ts", 9)];
    const parked: PersistedReviewSession = { ...session, ...first.data, revision: "2222222222222222222222222222222222222222", fileSignatures: buildReviewFileSignatures(secondFiles) };
    const second = rebaseReviewSession(parked, thirdFiles, ["git-diff"], buildReviewFileSignatures(thirdFiles));

    const marked = second.data.state.draft.comments.find((comment) => comment.startLine === 7)!;
    expect(marked.body).toBe("[needs attention · anchored on 2222222]\nCheck the new branch.");
  });
});
