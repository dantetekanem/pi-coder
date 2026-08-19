import { describe, expect, it } from "vitest";
import { composeDiscussionPrompt, composeReviewPrompt } from "../prompt.js";
import type { ReviewFile } from "../types.js";

const files: ReviewFile[] = [
  {
    id: "foo",
    path: "src/foo.ts",
    worktreeStatus: "modified",
    hasWorkingTreeFile: true,
    inGitDiff: true,
    inLastCommit: true,
    inAllFiles: false,
    gitDiff: {
      status: "modified",
      oldPath: "src/foo.ts",
      newPath: "src/foo.ts",
      displayPath: "src/foo.ts",
      hasOriginal: true,
      hasModified: true,
    },
    lastCommit: {
      status: "renamed",
      oldPath: "src/old-foo.ts",
      newPath: "src/foo.ts",
      displayPath: "src/old-foo.ts -> src/foo.ts",
      hasOriginal: true,
      hasModified: true,
    },
    allFiles: null,
  },
  {
    id: "bar",
    path: "src/bar.ts",
    worktreeStatus: "modified",
    hasWorkingTreeFile: true,
    inGitDiff: true,
    inLastCommit: false,
    inAllFiles: false,
    gitDiff: {
      status: "modified",
      oldPath: "src/bar.ts",
      newPath: "src/bar.ts",
      displayPath: "src/bar.ts",
      hasOriginal: true,
      hasModified: true,
    },
    lastCommit: null,
    allFiles: null,
  },
];

describe("composeReviewPrompt", () => {
  it("uses discuss-only instructions in prose", () => {
    const prompt = composeReviewPrompt(files, {
      type: "submit",
      allComment: "",
      allIntent: "discuss",
      comments: [
        {
          id: "1",
          fileId: "foo",
          scope: "all-files",
          side: "added",
          intent: "discuss",
          startLine: 3,
          endLine: 3,
          body: "First line\nSecond line",
        },
      ],
    });

    expect(prompt).toBe([
      "Respond to the following review discussion items in prose only.",
      "Do not edit files, write code, run write/editing tools, or make repo changes.",
      "",
      "DISCUSS",
      "",
      "Lines:",
      "1. src/foo.ts:3",
      "   First line",
      "   Second line",
    ].join("\n"));
    expect(prompt).not.toContain("MODIFY items");
  });

  it("renders all-lines file comments with the current file path", () => {
    const prompt = composeReviewPrompt(files, {
      type: "submit",
      allComment: "",
      allIntent: "discuss",
      comments: [
        {
          id: "file:git-diff:bar",
          fileId: "bar",
          scope: "git-diff",
          side: "file",
          intent: "comment",
          startLine: null,
          endLine: null,
          body: "Explain every line in this file change.",
        },
      ],
    });

    expect(prompt).toBe([
      "Treat the following review comments as actionable feedback about the change.",
      "Answer questions in prose, and make local edits when a comment asks for a change or states a preferred implementation.",
      "",
      "COMMENT",
      "",
      "Files:",
      "- src/bar.ts",
      "  Explain every line in this file change.",
    ].join("\n"));
    expect(prompt).not.toContain("Review-wide:");
    expect(prompt).not.toContain("DISCUSS");
  });

  it("uses comment-only instructions", () => {
    const prompt = composeReviewPrompt(files, {
      type: "submit",
      allComment: "",
      allIntent: "discuss",
      comments: [
        {
          id: "1",
          fileId: "bar",
          scope: "git-diff",
          side: "added",
          intent: "comment",
          startLine: 4,
          endLine: 4,
          body: "Can this be simplified?",
        },
      ],
    });

    expect(prompt).toBe([
      "Treat the following review comments as actionable feedback about the change.",
      "Answer questions in prose, and make local edits when a comment asks for a change or states a preferred implementation.",
      "",
      "COMMENT",
      "",
      "Lines:",
      "1. src/bar.ts:4 (added)",
      "   Can this be simplified?",
    ].join("\n"));
  });

  it("uses modify-only instructions for proposed code changes", () => {
    const prompt = composeReviewPrompt(files, {
      type: "submit",
      allComment: "",
      allIntent: "discuss",
      comments: [
        {
          id: "1",
          fileId: "bar",
          scope: "git-diff",
          side: "added",
          intent: "modify",
          startLine: 27,
          endLine: 27,
          body: "return early()",
        },
      ],
    });

    expect(prompt).toBe([
      "Apply the following proposed code changes exactly as written, as local edits.",
      "",
      "MODIFY",
      "",
      "Lines:",
      "1. src/bar.ts:27 (added)",
      "   return early()",
    ].join("\n"));
    expect(prompt).not.toContain("DISCUSS items");
  });

  it("renders a MODIFY line edit as a LINE CHANGED old-to-new block", () => {
    const prompt = composeReviewPrompt(files, {
      type: "submit",
      allComment: "",
      allIntent: "discuss",
      comments: [
        {
          id: "1",
          fileId: "bar",
          scope: "git-diff",
          side: "added",
          intent: "modify",
          startLine: 27,
          endLine: 27,
          originalText: "const x = compute(1)",
          body: "const x = compute(1, { cached: true })",
        },
      ],
    });

    expect(prompt).toBe([
      "Apply the following proposed code changes exactly as written, as local edits.",
      "",
      "MODIFY",
      "",
      "Lines:",
      "1. src/bar.ts:27 (added)",
      "   LINE CHANGED",
      "   - const x = compute(1)",
      "   + const x = compute(1, { cached: true })",
    ].join("\n"));
  });

  it("preserves exact MODIFY whitespace and line deletion", () => {
    const prompt = composeReviewPrompt(files, {
      type: "submit",
      allComment: "",
      allIntent: "discuss",
      comments: [
        {
          id: "1",
          fileId: "bar",
          scope: "git-diff",
          side: "added",
          intent: "modify",
          startLine: 27,
          endLine: 27,
          originalText: "\tremove()  ",
          body: "",
        },
        {
          id: "2",
          fileId: "bar",
          scope: "git-diff",
          side: "added",
          intent: "modify",
          startLine: 28,
          endLine: 28,
          originalText: "\told()  ",
          body: "\tnew()  ",
        },
      ],
    });

    expect(prompt).toContain("   - \tremove()  ");
    expect(prompt).toContain("   - \told()  ");
    expect(prompt).toContain("   + \tnew()  ");
  });

  it("renders a multi-line MODIFY edit with every old and new line", () => {
    const prompt = composeReviewPrompt(files, {
      type: "submit",
      allComment: "",
      allIntent: "discuss",
      comments: [
        {
          id: "1",
          fileId: "bar",
          scope: "git-diff",
          side: "added",
          intent: "modify",
          startLine: 10,
          endLine: 11,
          originalText: "foo()\nbar()",
          body: "foo()\nbaz()",
        },
      ],
    });

    expect(prompt).toContain("   LINE CHANGED");
    expect(prompt).toContain("   - foo()");
    expect(prompt).toContain("   - bar()");
    expect(prompt).toContain("   + foo()");
    expect(prompt).toContain("   + baz()");
  });

  it("formats line ranges", () => {
    const prompt = composeReviewPrompt(files, {
      type: "submit",
      allComment: "",
      allIntent: "discuss",
      comments: [
        {
          id: "1",
          fileId: "bar",
          scope: "git-diff",
          side: "added",
          intent: "comment",
          startLine: 27,
          endLine: 29,
          body: "Apply this to the whole block.",
        },
      ],
    });

    expect(prompt).toContain("1. src/bar.ts:27-29 (added)");
  });

  it("keeps only DISCUSS items in an agent discussion prompt", () => {
    const prompt = composeDiscussionPrompt(files, {
      type: "submit",
      allComment: "Why do we need this review-wide change?",
      allIntent: "discuss",
      comments: [
        {
          id: "1",
          fileId: "bar",
          scope: "git-diff",
          side: "added",
          intent: "comment",
          startLine: 10,
          endLine: 10,
          body: "Tell the PR author to handle nil.",
        },
        {
          id: "2",
          fileId: "bar",
          scope: "git-diff",
          side: "added",
          intent: "modify",
          startLine: 20,
          endLine: 20,
          originalText: "oldCall()",
          body: "newCall()",
        },
        {
          id: "3",
          fileId: "bar",
          scope: "git-diff",
          side: "added",
          intent: "discuss",
          startLine: 30,
          endLine: 30,
          body: "Can you explain this branch?",
        },
      ],
    });

    expect(prompt).toContain("Why do we need this review-wide change?");
    expect(prompt).toContain("Can you explain this branch?");
    expect(prompt).not.toContain("Tell the PR author to handle nil.");
    expect(prompt).not.toContain("oldCall()");
    expect(prompt).not.toContain("newCall()");
    expect(prompt).not.toContain("COMMENT");
    expect(prompt).not.toContain("MODIFY");
  });

  it("returns an empty agent discussion prompt when the review has no DISCUSS items", () => {
    const prompt = composeDiscussionPrompt(files, {
      type: "submit",
      allComment: "Review-wide human comment",
      allIntent: "comment",
      comments: [{
        id: "1",
        fileId: "bar",
        scope: "git-diff",
        side: "added",
        intent: "modify",
        startLine: 20,
        endLine: 20,
        originalText: "oldCall()",
        body: "newCall()",
      }],
    });

    expect(prompt).toBe("");
  });

  it("separates modify, comment, and discuss sections in mixed mode", () => {
    const prompt = composeReviewPrompt(files, {
      type: "submit",
      allComment: "Tighten naming.",
      allIntent: "discuss",
      comments: [
        {
          id: "1",
          fileId: "bar",
          scope: "git-diff",
          side: "added",
          intent: "modify",
          startLine: 20,
          endLine: 20,
          originalText: "user = find(id)",
          body: "user = fetchUser(id)",
        },
        {
          id: "2",
          fileId: "bar",
          scope: "git-diff",
          side: "added",
          intent: "comment",
          startLine: 10,
          endLine: 10,
          body: "Handle the nil case.",
        },
        {
          id: "3",
          fileId: "bar",
          scope: "git-diff",
          side: "added",
          intent: "discuss",
          startLine: 30,
          endLine: 30,
          body: "Why is this needed?",
        },
      ],
    });

    expect(prompt).toContain("- For MODIFY items: apply the exact code change shown (LINE CHANGED old -> new) as a local edit.");
    expect(prompt).toContain("- For COMMENT items: treat them as actionable review feedback. Answer questions in prose, and make local edits when a comment asks for a change or states a preferred implementation.");
    expect(prompt).toContain("- For DISCUSS items: respond only in prose.");
    expect(prompt).toContain("- Keep responses or edits scoped to the feedback under each item.");
    expect(prompt.indexOf("\nMODIFY\n")).toBeLessThan(prompt.indexOf("\nCOMMENT\n"));
    expect(prompt.indexOf("\nCOMMENT\n")).toBeLessThan(prompt.indexOf("\nDISCUSS\n"));
  });
});
