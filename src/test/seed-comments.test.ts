import { describe, expect, it, vi } from "vitest";
import { composeReviewPrompt } from "../prompt.js";
import { anchorResolvedSeedComments, applyResolvedSeedComments, partitionResolvedSeedComments, resolveSeedComments } from "../seed-comments.js";
import { createInitialReviewState, getFileComment, getLineComment, upsertLineComment } from "../state.js";
import type { ChangeStatus, ReviewFile, ReviewFileComparison, ReviewFileContents } from "../types.js";
import { hashTargetSlice } from "../workbench/target.js";

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
    inAllFiles: false,
    gitDiff: makeComparison(path),
    allFiles: null,
    ...flags,
  };
}

describe("resolveSeedComments", () => {
  it("maps path, line, side, and intent onto a resolved git-diff comment", () => {
    const { resolved, unresolved } = resolveSeedComments([makeFile("src/app.ts")], "git-diff", [
      { path: "src/app.ts", body: "Use a guard clause", side: "added", line: 12, intent: "modify" },
    ]);

    expect(unresolved).toHaveLength(0);
    expect(resolved).toEqual([
      { fileId: "src/app.ts", scope: "git-diff", side: "added", intent: "modify", startLine: 12, endLine: 12, body: "Use a guard clause" },
    ]);
  });

  it("applies defaults of added side, comment intent, and a single line", () => {
    const { resolved } = resolveSeedComments([makeFile("src/app.ts")], "git-diff", [
      { path: "src/app.ts", body: "Tidy this", line: 5 },
    ]);

    expect(resolved[0]).toMatchObject({ side: "added", intent: "comment", startLine: 5, endLine: 5 });
  });

  it("prefers startLine over line and honors endLine for ranges", () => {
    const { resolved } = resolveSeedComments([makeFile("src/app.ts")], "git-diff", [
      { path: "src/app.ts", body: "Range note", line: 5, startLine: 8, endLine: 10 },
    ]);

    expect(resolved[0]).toMatchObject({ startLine: 8, endLine: 10 });
  });

  it("normalizes a leading ./ in the seed path", () => {
    const { resolved } = resolveSeedComments([makeFile("src/app.ts")], "git-diff", [
      { path: "./src/app.ts", body: "Note", line: 1 },
    ]);

    expect(resolved[0]).toMatchObject({ fileId: "src/app.ts", scope: "git-diff" });
  });

  it("falls back to a file comment when side is file or no line is provided", () => {
    const { resolved } = resolveSeedComments([makeFile("src/app.ts")], "git-diff", [
      { path: "src/app.ts", body: "Whole file note", side: "file" },
      { path: "src/app.ts", body: "No line note", side: "added" },
    ]);

    expect(resolved).toEqual([
      { fileId: "src/app.ts", scope: "git-diff", side: "file", intent: "comment", startLine: null, endLine: null, body: "Whole file note" },
      { fileId: "src/app.ts", scope: "git-diff", side: "file", intent: "comment", startLine: null, endLine: null, body: "No line note" },
    ]);
  });

  it("marks comments with unknown paths or empty bodies as unresolved", () => {
    const { resolved, unresolved } = resolveSeedComments([makeFile("src/app.ts")], "git-diff", [
      { path: "src/missing.ts", body: "Nope", line: 1 },
      { path: "src/app.ts", body: "   ", line: 2 },
    ]);

    expect(resolved).toHaveLength(0);
    expect(unresolved).toHaveLength(2);
    expect(unresolved.map((comment) => comment.path)).toEqual(["src/missing.ts", "src/app.ts"]);
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

    const { resolved } = resolveSeedComments([renamed], "git-diff", [
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
    const { resolved } = resolveSeedComments(files, "git-diff", [
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

describe("anchorResolvedSeedComments", () => {
  it("captures the reviewed bytes of each side and loads each file scope once", async () => {
    const files = [makeFile("src/app.ts")];
    const contents: ReviewFileContents = { originalContent: "old()\r\nkept()\n", modifiedContent: "one()\ntwo()\nthree()\n" };
    const load = vi.fn(async () => contents);
    const { resolved } = resolveSeedComments(files, "git-diff", [
      { path: "src/app.ts", body: "Range", startLine: 3, endLine: 2 },
      { path: "src/app.ts", body: "new()", side: "deleted", line: 1, intent: "modify" },
      { path: "src/app.ts", body: "Whole file", side: "file" },
    ]);

    const anchored = await anchorResolvedSeedComments(resolved, files, load);

    expect(anchored[0]).toEqual({ ...resolved[0], captureHash: hashTargetSlice(contents.modifiedContent, { startLine: 2, endLine: 3 }) });
    expect(anchored[1]).toEqual({ ...resolved[1], originalText: "old()", captureHash: hashTargetSlice(contents.originalContent, { startLine: 1, endLine: 1 }) });
    expect(anchored[2]).toEqual(resolved[2]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith(files[0], "git-diff");
  });

  it("leaves seeds unanchored past the end, on unavailable sides, and after load errors", async () => {
    const files = [makeFile("src/app.ts"), makeFile("src/broken.ts")];
    const load = vi.fn(async (file: ReviewFile): Promise<ReviewFileContents> => {
      if (file.id === "src/broken.ts") throw new Error("no bytes");
      return { originalContent: "", modifiedContent: "only()\n", originalAvailable: false };
    });
    const { resolved } = resolveSeedComments(files, "git-diff", [
      { path: "src/app.ts", body: "Past the end", line: 4 },
      { path: "src/app.ts", body: "No base side", side: "deleted", line: 1 },
      { path: "src/broken.ts", body: "Load error", line: 1 },
    ]);

    expect(await anchorResolvedSeedComments(resolved, files, load)).toEqual(resolved);
  });

  it("anchors only lines the diff shows, so a code host can take them as line comments", async () => {
    const files = [makeFile("src/app.ts")];
    const original = Array.from({ length: 12 }, (_, index) => `line${index + 1}()`).join("\n") + "\n";
    const modifiedContent = original.replace("line12()", "changed()");
    const load = vi.fn(async () => ({ originalContent: original, modifiedContent }));
    const { resolved } = resolveSeedComments(files, "git-diff", [
      { path: "src/app.ts", body: "Context line", line: 10 },
      { path: "src/app.ts", body: "Outside the hunk", line: 3 },
      { path: "src/app.ts", body: "Range leaving the hunk", startLine: 8, endLine: 11 },
      { path: "src/app.ts", body: "After the final newline", line: 13 },
      { path: "src/app.ts", body: "Fractional", line: 10.5 },
    ]);

    const anchored = await anchorResolvedSeedComments(resolved, files, load);

    expect(anchored[0]).toEqual({ ...resolved[0], captureHash: hashTargetSlice(modifiedContent, { startLine: 10, endLine: 10 }) });
    expect(anchored.slice(1)).toEqual(resolved.slice(1));
  });
});

describe("applyResolvedSeedComments", () => {
  it("seeds line and file comments into the draft so they are retrievable like user comments", () => {
    const files = [makeFile("src/app.ts")];
    const { resolved } = resolveSeedComments(files, "git-diff", [
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

  it("starts anchored seeds mapped and unanchored line seeds stale", () => {
    const files = [makeFile("src/app.ts")];
    const captureHash = hashTargetSlice("a\nb\n", { startLine: 2, endLine: 2 });
    const state = applyResolvedSeedComments(createInitialReviewState(files), [
      { fileId: "src/app.ts", scope: "git-diff", side: "added", intent: "comment", startLine: 2, endLine: 2, body: "Anchored", captureHash },
      { fileId: "src/app.ts", scope: "git-diff", side: "added", intent: "modify", startLine: 5, endLine: 5, body: "new()", originalText: "old()", captureHash },
      { fileId: "src/app.ts", scope: "git-diff", side: "deleted", intent: "comment", startLine: 9, endLine: 9, body: "Unanchored" },
    ]);

    expect(getLineComment(state, "src/app.ts", "git-diff", "added", 2)).toMatchObject({ captureHash, anchorStatus: "mapped" });
    expect(getLineComment(state, "src/app.ts", "git-diff", "added", 5)).toMatchObject({ originalText: "old()", captureHash, anchorStatus: "mapped" });
    expect(getLineComment(state, "src/app.ts", "git-diff", "deleted", 9)?.anchorStatus).toBe("stale");
  });

  it("flows seeded comments through composeReviewPrompt like hand-written ones", () => {
    const files = [makeFile("src/app.ts")];
    const { resolved } = resolveSeedComments(files, "git-diff", [
      { path: "src/app.ts", body: "Handle the nil case.", line: 10, intent: "comment" },
    ]);

    const state = applyResolvedSeedComments(createInitialReviewState(files), resolved);
    const prompt = composeReviewPrompt(files, { type: "submit", ...state.draft });

    expect(prompt).toContain("1. src/app.ts:10 (added)");
    expect(prompt).toContain("Handle the nil case.");
  });
});
