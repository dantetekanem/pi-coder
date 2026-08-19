import { describe, expect, it, vi } from "vitest";
import { hashTargetSlice } from "../workbench/target.js";
import { resolveReviewResume, revalidateReviewDraftAnchors } from "../adapters/pi/review-bridge.js";
import type { DiffReviewComment, ReviewFile, ReviewResumeReference, ReviewScope, ReviewState } from "../types.js";

const file = {
  id: "src/app.ts::working::::", path: "src/app.ts", worktreeStatus: "modified" as const,
  hasWorkingTreeFile: true, inGitDiff: true, inLastCommit: false, inAllFiles: false,
  gitDiff: { status: "modified" as const, oldPath: "src/app.ts", newPath: "src/app.ts", displayPath: "src/app.ts", hasOriginal: true, hasModified: true },
  lastCommit: null, allFiles: null,
};

function state(): ReviewState {
  return { activeScope: "git-diff", activeFileId: file.id, searchQuery: "", focus: "diff", wrapLines: true, hideUnchanged: false, selectedCommentIndex: 0, selectedLineTargetByScopeFile: {}, draft: { allComment: "", allIntent: "discuss", comments: [] } };
}

function resume(content: string, line: number): ReviewResumeReference {
  const range = { startLine: line, endLine: line };
  return { version: 1, repository: "/repo", sessionId: "s", identity: "i", scope: "git-diff", path: "src/app.ts", side: "added", range, focus: { pane: "diff", navigatorScroll: 2, diffScroll: 3, commentsScroll: 4 }, contextHash: hashTargetSlice(content, range) };
}

function resumeV2(content: string, line: number): ReviewResumeReference {
  const range = { startLine: line, endLine: line };
  return {
    ...resume(content, line), version: 2, scopeFingerprint: "frame", selectedHash: hashTargetSlice(content, range),
    context: { before: 1, after: 1, hash: hashTargetSlice(content, { startLine: Math.max(1, line - 1), endLine: Math.min(content.split(/\r\n|\r|\n/).length, line + 1) }) },
  };
}

describe("review draft anchor validation", () => {
  function lineComment(
    id: string,
    fileId: string,
    scope: ReviewScope,
    side: "added" | "deleted",
    content: string,
    anchorStatus: "mapped" | "stale" = "mapped",
  ): DiffReviewComment {
    return {
      id,
      fileId,
      scope,
      side,
      intent: "comment",
      startLine: 1,
      endLine: 1,
      body: `${id} body`,
      captureHash: hashTargetSlice(content, { startLine: 1, endLine: 1 }),
      anchorStatus,
    };
  }

  function withDraft(comments: DiffReviewComment[]): ReviewState {
    return { ...state(), draft: { allComment: "", allIntent: "discuss", comments } };
  }

  it("validates every persisted file and caches content loads by file plus scope", async () => {
    const second: ReviewFile = {
      ...file,
      id: "src/other.ts::working::::",
      path: "src/other.ts",
      gitDiff: { ...file.gitDiff!, oldPath: "src/other.ts", newPath: "src/other.ts", displayPath: "src/other.ts" },
    };
    const unchanged = lineComment("unchanged", file.id, "git-diff", "added", "current\n");
    const changed = lineComment("changed", second.id, "git-diff", "added", "before\n");
    const alreadyStale = lineComment("already-stale", file.id, "git-diff", "added", "current\n", "stale");
    const fileDraft: DiffReviewComment = {
      id: "file", fileId: second.id, scope: "git-diff", side: "file", intent: "comment",
      startLine: null, endLine: null, body: "whole file", fileTarget: "file", anchorStatus: "mapped",
    };
    const load = vi.fn(async (candidate: ReviewFile, scope: ReviewScope) => ({
      originalContent: "old\n",
      modifiedContent: candidate.id === second.id ? "after\n" : "current\n",
    }));

    const validated = await revalidateReviewDraftAnchors(
      withDraft([unchanged, changed, alreadyStale, fileDraft]),
      [file, second],
      load,
    );

    expect(validated.draft.comments).toEqual([
      unchanged,
      { ...changed, anchorStatus: "stale" },
      alreadyStale,
      fileDraft,
    ]);
    expect(load).toHaveBeenCalledTimes(2);
    expect(load).toHaveBeenCalledWith(file, "git-diff");
    expect(load).toHaveBeenCalledWith(second, "git-diff");
  });

  it("validates deleted, last-commit, and all-files anchors against their own comparison bytes", async () => {
    const scopedFile: ReviewFile = {
      ...file,
      inLastCommit: true,
      inAllFiles: true,
      lastCommit: { ...file.gitDiff!, originalRevision: "HEAD^", modifiedRevision: "HEAD" },
      allFiles: { ...file.gitDiff!, originalRevision: "base", modifiedRevision: "head" },
    };
    const gitDeleted = lineComment("git-deleted", file.id, "git-diff", "deleted", "git original\n");
    const lastCommit = lineComment("last-commit", file.id, "last-commit", "added", "commit current\n");
    const allFiles = lineComment("all-files", file.id, "all-files", "added", "range current\n");
    const contents: Record<ReviewScope, { originalContent: string; modifiedContent: string }> = {
      "git-diff": { originalContent: "git original\n", modifiedContent: "git current\n" },
      "last-commit": { originalContent: "commit original\n", modifiedContent: "commit current\n" },
      "all-files": { originalContent: "range original\n", modifiedContent: "range current\n" },
    };
    const load = vi.fn(async (_candidate: ReviewFile, scope: ReviewScope) => contents[scope]);

    const validated = await revalidateReviewDraftAnchors(withDraft([gitDeleted, lastCommit, allFiles]), [scopedFile], load);

    expect(validated.draft.comments).toEqual([gitDeleted, lastCommit, allFiles]);
    expect(load.mock.calls.map((call) => call[1]).sort()).toEqual(["all-files", "git-diff", "last-commit"]);
  });

  it("fails closed for missing files, missing or unavailable sides, malformed anchors, and load errors", async () => {
    const missingFile = lineComment("missing-file", "missing", "git-diff", "added", "x\n");
    const missingScope = lineComment("missing-scope", file.id, "last-commit", "added", "x\n");
    const missingSideFile: ReviewFile = {
      ...file,
      id: "deleted",
      path: "deleted.ts",
      hasWorkingTreeFile: false,
      gitDiff: { ...file.gitDiff!, status: "deleted", newPath: null, hasModified: false },
    };
    const missingSide = lineComment("missing-side", missingSideFile.id, "git-diff", "added", "\n");
    const malformed = { ...lineComment("malformed", file.id, "git-diff", "added", "x\n"), startLine: 0 };
    const loadError = lineComment("load-error", "error", "git-diff", "added", "x\n");
    const errorFile: ReviewFile = { ...file, id: "error", path: "error.ts" };
    const unavailableBytes = lineComment("unavailable-bytes", "empty", "git-diff", "added", "");
    const emptyFile: ReviewFile = { ...file, id: "empty", path: "empty.ts" };
    const load = vi.fn(async (candidate: ReviewFile) => {
      if (candidate.id === errorFile.id) throw new Error("unavailable revision bytes");
      if (candidate.id === emptyFile.id) return { originalContent: "", modifiedContent: "", modifiedAvailable: false };
      return { originalContent: "x\n", modifiedContent: "x\n" };
    });

    const validated = await revalidateReviewDraftAnchors(
      withDraft([missingFile, missingScope, missingSide, malformed, loadError, unavailableBytes]),
      [file, missingSideFile, errorFile, emptyFile],
      load,
    );

    expect(validated.draft.comments.map((comment) => comment.anchorStatus)).toEqual([
      "stale", "stale", "stale", "stale", "stale", "stale",
    ]);
  });
});

describe("review bridge resume resolution", () => {
  it("uses exact anchors and bounded same-file relocation without source snapshots", async () => {
    const old = "a\nneedle\nz\n";
    const exact = await resolveReviewResume(resume(old, 2), state(), [file], "/repo", vi.fn(async () => ({ originalContent: "a\nold\nz\n", modifiedContent: old })));
    expect(exact).toMatchObject({ stale: false, state: { selectedLineTargetByScopeFile: { [`git-diff::${file.id}`]: { side: "added", line: 2 } } } });

    const moved = await resolveReviewResume(resume(old, 2), state(), [file], "/repo", vi.fn(async () => ({ originalContent: "x\na\nold\nz\n", modifiedContent: "x\na\nneedle\nz\n" })));
    expect(moved).toMatchObject({ stale: true, state: { selectedLineTargetByScopeFile: { [`git-diff::${file.id}`]: { line: 3 } } } });
  });

  it("fails closed when a v2 frame has another identity, session, or scope fingerprint", async () => {
    const token = resumeV2("old\nnew\n", 2);
    const expected = { repository: "/repo", identity: "i", sessionId: "s", scopeFingerprint: "frame" };
    for (const invalid of [
      { ...token, identity: "other" },
      { ...token, sessionId: "other" },
      { ...token, scopeFingerprint: "other" },
      { ...token, repository: "/elsewhere" },
    ]) {
      const resolved = await resolveReviewResume(invalid, state(), [file], "/repo", vi.fn(async () => ({ originalContent: "old\nold\n", modifiedContent: "old\nnew\n" })), expected);
      expect(resolved).toMatchObject({ stale: true, banner: expect.stringMatching(/repository frame/i), state: { activeFileId: file.id } });
    }
  });

  it("never treats unchanged bytes or deletion-only files as writable resume targets", async () => {
    const token = resumeV2("same\nselected\nnew\n", 2);
    const unchanged = await resolveReviewResume(token, state(), [file], "/repo", vi.fn(async () => ({ originalContent: "same\nselected\nold\n", modifiedContent: "same\nselected\nnew\n" })), { repository: "/repo", identity: "i", sessionId: "s", scopeFingerprint: "frame" });
    expect(unchanged).toMatchObject({ stale: true, banner: expect.stringMatching(/nearest/i), state: { selectedLineTargetByScopeFile: { [`git-diff::${file.id}`]: { line: 3 } } } });

    const deleted = { ...file, id: "gone", path: "gone.ts", hasWorkingTreeFile: false, gitDiff: { ...file.gitDiff!, status: "deleted" as const, newPath: null, hasModified: false } };
    const deletionOnly = await resolveReviewResume(token, state(), [deleted], "/repo", vi.fn());
    expect(deletionOnly).toMatchObject({ stale: true, banner: expect.stringMatching(/no writable/i), state: { activeFileId: null } });
  });

  it("falls back visibly to a surviving file and handles an empty fresh diff", async () => {
    const missing = await resolveReviewResume(resume("needle\n", 1), state(), [{ ...file, id: "src/b.ts", path: "src/b.ts", gitDiff: { ...file.gitDiff, oldPath: "src/b.ts", newPath: "src/b.ts", displayPath: "src/b.ts" } }], "/repo", vi.fn(async () => ({ originalContent: "old\n", modifiedContent: "b\n" })));
    expect(missing.stale).toBe(true);
    expect(missing.banner).toMatch(/stale/i);
    expect(missing.state.activeFileId).toBe("src/b.ts");

    const empty = await resolveReviewResume(resume("needle\n", 1), state(), [], "/repo", vi.fn());
    expect(empty).toMatchObject({ stale: true, state: { activeFileId: null } });
  });
});
