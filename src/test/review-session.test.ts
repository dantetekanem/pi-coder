import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildReviewFileSignatures,
  createReviewSessionId,
  deleteReviewSession,
  getReviewSessionPathForDiagnostics,
  listReviewSessions,
  loadReviewSession,
  rebaseReviewSession,
  REVIEW_SESSION_VERSION,
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

  it("loads v1 losslessly as v2, recovers its revision, and marks legacy line anchors stale", async () => {
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
    })).toEqual({ id: createReviewSessionId(identity), saved: true });
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

    expect(saveReviewSessionWithStatus(identity, sessionData())).toEqual({ id: createReviewSessionId(identity), saved: false });
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

    deleteReviewSession(identity);
    expect(loadReviewSession(identity)).toBeNull();
    expect(listReviewSessions()).toEqual([]);
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

  it("prunes sessions past the retention window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() - 40 * 24 * 60 * 60 * 1000);
    const identity = "/repo|working|worktree|local";
    const id = saveReviewSession(identity, sessionData(), { revision: "worktree" });
    vi.useRealTimers();

    expect(listReviewSessions()).toEqual([]);
    expect(existsSync(getReviewSessionPathForDiagnostics(id))).toBe(false);
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
