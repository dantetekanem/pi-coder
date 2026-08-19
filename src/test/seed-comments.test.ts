import { describe, expect, it } from "vitest";
import { composeReviewPrompt } from "../prompt.js";
import { applyResolvedSeedComments, partitionResolvedSeedComments, resolveSeedComments } from "../seed-comments.js";
import { createInitialReviewState, getFileComment, getLineComment, upsertLineComment } from "../state.js";
import type { ChangeStatus, ReviewFile, ReviewFileComparison } from "../types.js";

function makeComparison(path: string, status: ChangeStatus = "modified"): ReviewFileComparison {
  return {
    status,
    oldPath: status === "added" ? null : path,
    newPath: status === "deleted" ? null : path,
    displayPath: path,
    hasOriginal: status !== "added",
    hasModified: status !== "deleted",
  };
}

function makeFile(path: string, flags?: Partial<ReviewFile>): ReviewFile {
  return {
    id: path,
    path,
    worktreeStatus: "modified",
    hasWorkingTreeFile: true,
    inGitDiff: true,
    inLastCommit: false,
    inAllFiles: false,
    gitDiff: makeComparison(path),
    lastCommit: null,
    allFiles: null,
    ...flags,
  };
}

describe("resolveSeedComments", () => {
  it("maps path, line, side, and intent onto a resolved git-diff comment", () => {
    const { resolved, unresolved } = resolveSeedComments([makeFile("src/app.ts")], ["git-diff"], [
      { path: "src/app.ts", body: "Use a guard clause", side: "added", line: 12, intent: "modify" },
    ]);

    expect(unresolved).toHaveLength(0);
    expect(resolved).toEqual([
      { fileId: "src/app.ts", scope: "git-diff", side: "added", intent: "modify", startLine: 12, endLine: 12, body: "Use a guard clause" },
    ]);
  });

  it("applies defaults of added side, comment intent, and a single line", () => {
    const { resolved } = resolveSeedComments([makeFile("src/app.ts")], ["git-diff"], [
      { path: "src/app.ts", body: "Tidy this", line: 5 },
    ]);

    expect(resolved[0]).toMatchObject({ side: "added", intent: "comment", startLine: 5, endLine: 5 });
  });

  it("prefers startLine over line and honors endLine for ranges", () => {
    const { resolved } = resolveSeedComments([makeFile("src/app.ts")], ["git-diff"], [
      { path: "src/app.ts", body: "Range note", line: 5, startLine: 8, endLine: 10 },
    ]);

    expect(resolved[0]).toMatchObject({ startLine: 8, endLine: 10 });
  });

  it("normalizes a leading ./ in the seed path", () => {
    const { resolved } = resolveSeedComments([makeFile("src/app.ts")], ["git-diff"], [
      { path: "./src/app.ts", body: "Note", line: 1 },
    ]);

    expect(resolved[0]).toMatchObject({ fileId: "src/app.ts", scope: "git-diff" });
  });

  it("falls back to a file comment when side is file or no line is provided", () => {
    const { resolved } = resolveSeedComments([makeFile("src/app.ts")], ["git-diff"], [
      { path: "src/app.ts", body: "Whole file note", side: "file" },
      { path: "src/app.ts", body: "No line note", side: "added" },
    ]);

    expect(resolved).toEqual([
      { fileId: "src/app.ts", scope: "git-diff", side: "file", intent: "comment", startLine: null, endLine: null, body: "Whole file note" },
      { fileId: "src/app.ts", scope: "git-diff", side: "file", intent: "comment", startLine: null, endLine: null, body: "No line note" },
    ]);
  });

  it("marks comments with unknown paths or empty bodies as unresolved", () => {
    const { resolved, unresolved } = resolveSeedComments([makeFile("src/app.ts")], ["git-diff"], [
      { path: "src/missing.ts", body: "Nope", line: 1 },
      { path: "src/app.ts", body: "   ", line: 2 },
    ]);

    expect(resolved).toHaveLength(0);
    expect(unresolved).toHaveLength(2);
    expect(unresolved.map((comment) => comment.path)).toEqual(["src/missing.ts", "src/app.ts"]);
  });

  it("matches files across the visible scopes and records the scope where they appear", () => {
    const files = [
      makeFile("src/app.ts"),
      makeFile("src/legacy.ts", { inGitDiff: false, inLastCommit: true, gitDiff: null, lastCommit: makeComparison("src/legacy.ts") }),
    ];

    const { resolved } = resolveSeedComments(files, ["git-diff", "last-commit"], [
      { path: "src/legacy.ts", body: "Touch up", line: 3 },
    ]);

    expect(resolved[0]).toMatchObject({ fileId: "src/legacy.ts", scope: "last-commit", startLine: 3 });
  });

  it("matches a renamed file by its new path", () => {
    const renamed = makeFile("src/new-name.ts", {
      gitDiff: {
        status: "renamed",
        oldPath: "src/old-name.ts",
        newPath: "src/new-name.ts",
        displayPath: "src/old-name.ts -> src/new-name.ts",
        hasOriginal: true,
        hasModified: true,
      },
    });

    const { resolved } = resolveSeedComments([renamed], ["git-diff"], [
      { path: "src/new-name.ts", body: "ok", line: 2 },
    ]);

    expect(resolved[0]).toMatchObject({ fileId: renamed.id, scope: "git-diff" });
  });
});

describe("partitionResolvedSeedComments", () => {
  it("keeps existing COMMENT and MODIFY items when findings target overlapping lines", () => {
    const files = [makeFile("src/app.ts")];
    let state = createInitialReviewState(files);
    state = upsertLineComment(state, "src/app.ts", "git-diff", "added", 4, "Existing human comment", "comment", 6);
    state = upsertLineComment(state, "src/app.ts", "git-diff", "added", 10, "replacement()", "modify", 10, "original()");
    const { resolved } = resolveSeedComments(files, ["git-diff"], [
      { path: "src/app.ts", body: "Overlaps the human comment", line: 5 },
      { path: "src/app.ts", body: "Overlaps the modification", line: 10 },
      { path: "src/app.ts", body: "New finding", line: 20 },
    ]);

    const partition = partitionResolvedSeedComments(state, resolved);

    expect(partition.conflicts.map((comment) => comment.body)).toEqual([
      "Overlaps the human comment",
      "Overlaps the modification",
    ]);
    expect(partition.applicable.map((comment) => comment.body)).toEqual(["New finding"]);
    expect(getLineComment(state, "src/app.ts", "git-diff", "added", 5)?.body).toBe("Existing human comment");
    expect(getLineComment(state, "src/app.ts", "git-diff", "added", 10)?.intent).toBe("modify");
  });
});

describe("applyResolvedSeedComments", () => {
  it("seeds line and file comments into the draft so they are retrievable like user comments", () => {
    const files = [makeFile("src/app.ts")];
    const { resolved } = resolveSeedComments(files, ["git-diff"], [
      { path: "src/app.ts", body: "Line note", line: 4, intent: "comment" },
      { path: "src/app.ts", body: "File note", side: "file", intent: "discuss" },
    ]);

    const state = applyResolvedSeedComments(createInitialReviewState(files), resolved);

    expect(state.draft.comments).toHaveLength(2);
    expect(getLineComment(state, "src/app.ts", "git-diff", "added", 4)?.body).toBe("Line note");
    expect(getLineComment(state, "src/app.ts", "git-diff", "added", 4)?.intent).toBe("comment");
    expect(getFileComment(state, "src/app.ts", "git-diff")?.body).toBe("File note");
    expect(getFileComment(state, "src/app.ts", "git-diff")?.intent).toBe("discuss");
  });

  it("flows seeded comments through composeReviewPrompt like hand-written ones", () => {
    const files = [makeFile("src/app.ts")];
    const { resolved } = resolveSeedComments(files, ["git-diff"], [
      { path: "src/app.ts", body: "Handle the nil case.", line: 10, intent: "comment" },
    ]);

    const state = applyResolvedSeedComments(createInitialReviewState(files), resolved);
    const prompt = composeReviewPrompt(files, { type: "submit", ...state.draft });

    expect(prompt).toContain("1. src/app.ts:10 (added)");
    expect(prompt).toContain("Handle the nil case.");
  });
});
