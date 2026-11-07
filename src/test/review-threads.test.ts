import { describe, expect, it } from "vitest";
import type { ReplyThread } from "../review-replies.js";
import { anchorTextFromDiffHunk, isOpenReviewThread, placeReviewThread } from "../review-threads.js";

const lines = [
  "function total(items) {",
  "  let sum = 0;",
  "  for (const item of items) sum += item.price;",
  "  return sum;",
  "}",
  "",
  "function count(items) {",
  "  return items.length;",
  "}",
];

function thread(overrides: Partial<ReplyThread> = {}): ReplyThread {
  return {
    id: "thread-1",
    resolved: false,
    side: "added",
    path: "src/cart.ts",
    line: 3,
    comments: [{ id: "1", author: "reviewer", body: "Use reduce here?" }],
    ...overrides,
  };
}

describe("review thread placement", () => {
  it("reads the commented side's lines from the end of a diff hunk", () => {
    const hunk = "@@ -1,4 +1,5 @@\n function total(items) {\n-  let sum = 1;\n+  let sum = 0;\n+  for (const item of items) sum += item.price;\n";
    expect(anchorTextFromDiffHunk(hunk, "added")).toEqual(["function total(items) {", "  let sum = 0;", "  for (const item of items) sum += item.price;"]);
    expect(anchorTextFromDiffHunk("@@ -1,3 +1,2 @@\n keep\n-removed one\n-removed two", "deleted")).toEqual(["keep", "removed one", "removed two"]);
    expect(anchorTextFromDiffHunk("@@ -1 +1 @@\n-old\n+new", "deleted")).toBeUndefined();
    expect(anchorTextFromDiffHunk("@@ -1 +1 @@\n+new\n\\ No newline at end of file", "added")).toEqual(["new"]);
    expect(anchorTextFromDiffHunk(42, "added")).toBeUndefined();
    expect(anchorTextFromDiffHunk("@@ -1 +1 @@\n+new", undefined)).toBeUndefined();
  });

  it("places a thread whose hunk text ends on its line, with its whole range", () => {
    const placed = placeReviewThread(thread({ startLine: 2, anchorText: ["  let sum = 0;", "  for (const item of items) sum += item.price;"] }),
      { side: "added", lines, sameRevision: false });
    expect(placed).toMatchObject({ side: "added", startLine: 2, endLine: 3 });
    expect(placed?.movedFrom).toBeUndefined();
  });

  it("follows code that moved since the comment was written", () => {
    const moved = ["// header", "// more header", ...lines];
    const placed = placeReviewThread(thread({ startLine: 2, anchorText: ["  let sum = 0;", "  for (const item of items) sum += item.price;"] }),
      { side: "added", lines: moved, sameRevision: false });
    expect(placed).toMatchObject({ startLine: 4, endLine: 5, movedFrom: 3 });
  });

  it("does not guess when the code is gone, short, or equally near twice", () => {
    const anchor = ["  for (const item of items) sum += item.price;"];
    expect(placeReviewThread(thread({ anchorText: ["  for (const entry of entries) sum += entry.cost;"] }), { side: "added", lines, sameRevision: true })).toBeNull();
    expect(placeReviewThread(thread({ line: 7, anchorText: ["}"] }), { side: "added", lines, sameRevision: false })).toBeNull();
    const twice = ["x", anchor[0]!, "y", anchor[0]!, "z"];
    expect(placeReviewThread(thread({ line: 3, anchorText: anchor }), { side: "added", lines: twice, sameRevision: false })).toBeNull();
  });

  it("uses the line alone only for a current thread on the exact reviewed revision", () => {
    expect(placeReviewThread(thread(), { side: "added", lines, sameRevision: true })).toMatchObject({ startLine: 3, endLine: 3 });
    expect(placeReviewThread(thread(), { side: "added", lines, sameRevision: false })).toBeNull();
    expect(placeReviewThread(thread({ outdated: true }), { side: "added", lines, sameRevision: true })).toBeNull();
    expect(placeReviewThread(thread({ line: 40 }), { side: "added", lines, sameRevision: true })).toBeNull();
    expect(placeReviewThread(thread({ line: null, originalLine: 3 }), { side: "added", lines, sameRevision: true })).toBeNull();
  });

  it("relocates an outdated thread from its original line when its hunk text still exists", () => {
    const placed = placeReviewThread(thread({ line: null, originalLine: 2, outdated: true, anchorText: ["  for (const item of items) sum += item.price;"] }),
      { side: "added", lines, sameRevision: false });
    expect(placed).toMatchObject({ endLine: 3, movedFrom: 2 });
  });

  it("skips resolved threads and threads on the other side", () => {
    expect(isOpenReviewThread(thread({ resolved: true }))).toBe(false);
    expect(isOpenReviewThread(thread({ resolved: null }))).toBe(true);
    expect(placeReviewThread(thread({ resolved: true }), { side: "added", lines, sameRevision: true })).toBeNull();
    expect(placeReviewThread(thread({ side: "deleted" }), { side: "added", lines, sameRevision: true })).toBeNull();
    expect(placeReviewThread(thread({ side: undefined }), { side: "added", lines, sameRevision: true })).toMatchObject({ endLine: 3 });
  });
});
