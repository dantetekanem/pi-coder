import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { buildStructuredDiff } from "../diff.js";
import type { DiffReviewComment, ReviewFile, ReviewState } from "../types.js";
import { buildCommentPanelEmptyStateLines, buildCommentPanelTextLines, buildContextPanelLines, buildDiffActionHintLine, buildDisplayRows, buildEditorLaunchArgs, buildFooterLines, buildReviewHeaderLine, buildReviewHeaderText, buildHelpPanelLines, buildModifyPreviewLines, buildSelectionClipboardText, buildSideBySideDisplayRows, diffTextMatchesSearch, fitFooterLines, formatFocusStatus, formatPaneTitle, formatSelectedLineTargetLabel, getCancelAction, getChangedLineTargets, getDraftCommentCount, getEditorLineForTarget, getHalfPageStep, getMatchingDiffLineTargets, getMeasuredPageRange, getNavigatorGroup, getNavigatorMoveIndex, getNextSearchIndex, getPaneLayout, getPaneLayoutForVisibility, getPaneLayoutWithContext, getRelatedFileMarker, getRelatedFilePanelSections, getRelatedFilePaths, getReviewVerticalLayout, getSideBySideColumnTarget, getSideBySideLineTargets, getSideBySidePairedLineTarget, getSourceLineRangeText, getStableDiffScroll, getStackedPaneLayout, getStackedPaneLayoutForVisibility, getStackedPaneLayoutWithContext, getVirtualRowRange, groupNavigatorFiles, isUnchangedModify, parseMouseWheelInput, renderCenteredOverlay, setBoundedMapEntry, shouldStackPanes, shouldStackPanesWithContext } from "../ui/review-app.js";

function makeFile(path: string, flags?: Partial<ReviewFile>): ReviewFile {
  return {
    id: path,
    path,
    worktreeStatus: null,
    hasWorkingTreeFile: true,
    inGitDiff: false,
    inLastCommit: false,
    inAllFiles: true,
    gitDiff: null,
    lastCommit: null,
    allFiles: null,
    ...flags,
  };
}

function makeState(draft?: Partial<ReviewState["draft"]>): ReviewState {
  return {
    activeScope: "git-diff",
    activeFileId: "src/app.ts",
    searchQuery: "",
    focus: "diff",
    wrapLines: false,
    hideUnchanged: false,
    selectedCommentIndex: 0,
    selectedLineTargetByScopeFile: {},
    draft: {
      allComment: "",
      allIntent: "discuss",
      comments: [],
      ...draft,
    },
  };
}

const lineComment: DiffReviewComment = {
  id: "line:git-diff:src/app.ts:added:2",
  fileId: "src/app.ts",
  scope: "git-diff",
  side: "added",
  intent: "comment",
  startLine: 2,
  endLine: 2,
  body: "Rename this.",
};

describe("buildDisplayRows", () => {
  it("keeps deleted and added rows independently commentable when line numbers overlap", () => {
    const diff = buildStructuredDiff(
      ["alpha", "removed", "kept"].join("\n") + "\n",
      ["alpha", "kept"].join("\n") + "\n",
      3,
    );

    const rowsAtLineTwo = buildDisplayRows(diff).filter((row) => row.displayLineNumber === 2);

    expect(rowsAtLineTwo).toHaveLength(2);
    expect(rowsAtLineTwo.map((row) => ({ kind: row.kind, commentLineNumber: row.commentLineNumber, commentSide: row.commentSide }))).toEqual([
      { kind: "removed", commentLineNumber: 2, commentSide: "deleted" },
      { kind: "context", commentLineNumber: 2, commentSide: "added" },
    ]);
  });
});

describe("changed-line navigation", () => {
  it("skips unchanged context while retaining both sides of replacements", () => {
    const diff = buildStructuredDiff("alpha\nold\nomega\n", "alpha\nnew\nomega\n", 3);

    expect(getChangedLineTargets(diff)).toEqual([
      { side: "deleted", line: 2 },
      { side: "added", line: 2 },
    ]);
  });
});

describe("side-by-side diff helpers", () => {
  it("pairs replacement rows into old and new cells", () => {
    const diff = buildStructuredDiff(
      ["alpha", "old value", "omega"].join("\n") + "\n",
      ["alpha", "new value", "omega"].join("\n") + "\n",
      3,
    );

    const rows = buildSideBySideDisplayRows(diff);
    const replacement = rows.find((row) => row.kind === "change" && row.oldCell?.text === "old value");

    expect(replacement?.oldCell).toMatchObject({ side: "deleted", lineNumber: 2, text: "old value" });
    expect(replacement?.newCell).toMatchObject({ side: "added", lineNumber: 2, text: "new value" });
  });

  it("builds per-side navigation targets for side-by-side movement", () => {
    const diff = buildStructuredDiff(
      ["alpha", "old value", "removed", "omega"].join("\n") + "\n",
      ["alpha", "new value", "added", "omega"].join("\n") + "\n",
      3,
    );

    const rows = buildSideBySideDisplayRows(diff);

    expect(getSideBySideLineTargets(rows, "deleted")).toEqual([
      { side: "deleted", line: 1 },
      { side: "deleted", line: 2 },
      { side: "deleted", line: 3 },
      { side: "deleted", line: 4 },
    ]);
    expect(getSideBySideLineTargets(rows, "added")).toEqual([
      { side: "added", line: 1 },
      { side: "added", line: 2 },
      { side: "added", line: 3 },
      { side: "added", line: 4 },
    ]);
  });

  it("finds the paired side for side-by-side selections", () => {
    const diff = buildStructuredDiff(
      ["alpha", "old value", "omega"].join("\n") + "\n",
      ["alpha", "new value", "omega"].join("\n") + "\n",
      3,
    );

    expect(getSideBySidePairedLineTarget(diff, { side: "deleted", line: 1 })).toEqual({ side: "added", line: 1 });
    expect(getSideBySidePairedLineTarget(diff, { side: "added", line: 1 })).toEqual({ side: "deleted", line: 1 });
    expect(getSideBySidePairedLineTarget(diff, { side: "deleted", line: 2 })).toEqual({ side: "added", line: 2 });
    expect(getSideBySidePairedLineTarget(diff, { side: "added", line: 2 })).toEqual({ side: "deleted", line: 2 });
  });

  it("jumps to the previous available target-side line when crossing out of an insertion block", () => {
    const diff = buildStructuredDiff(
      ["same", "after"].join("\n") + "\n",
      ["same", "inserted a", "inserted b", "after"].join("\n") + "\n",
      3,
    );

    const rows = buildSideBySideDisplayRows(diff);

    expect(getSideBySideColumnTarget(rows, { side: "added", line: 3 }, "deleted")).toEqual({ side: "deleted", line: 1 });
  });

  it("describes the selected side and range", () => {
    expect(formatSelectedLineTargetLabel({ side: "deleted", line: 4 })).toBe("selected deleted line 4");
    expect(formatSelectedLineTargetLabel({ side: "added", line: 8, endLine: 10 })).toBe("selected added lines 8-10");
  });
});

describe("getEditorLineForTarget", () => {
  it("maps deleted lines to the nearest surviving working-tree line", () => {
    const diff = buildStructuredDiff(
      ["alpha", "removed", "kept"].join("\n") + "\n",
      ["alpha", "kept"].join("\n") + "\n",
      3,
    );

    expect(getEditorLineForTarget(diff, { side: "deleted", line: 2 })).toBe(2);
  });
});

describe("getHalfPageStep", () => {
  it("uses at least one row and otherwise half the visible rows", () => {
    expect(getHalfPageStep(1)).toBe(1);
    expect(getHalfPageStep(9)).toBe(4);
    expect(getHalfPageStep(10)).toBe(5);
  });
});

describe("search and navigator movement helpers", () => {
  it("finds matching diff line targets by code text", () => {
    const diff = buildStructuredDiff(
      ["alpha", "old value", "omega"].join("\n") + "\n",
      ["alpha", "new value", "omega"].join("\n") + "\n",
      3,
    );

    expect(getMatchingDiffLineTargets(buildDisplayRows(diff), "new value")).toEqual([{ side: "added", line: 2 }]);
    expect(getMatchingDiffLineTargets(buildDisplayRows(diff), "old value")).toEqual([{ side: "deleted", line: 2 }]);
  });

  it("matches diff search text case-insensitively for highlighting", () => {
    expect(diffTextMatchesSearch("const UserName = name", "username")).toBe(true);
    expect(diffTextMatchesSearch("const UserName = name", "missing")).toBe(false);
    expect(diffTextMatchesSearch("const UserName = name", "   ")).toBe(false);
  });

  it("wraps search result indexes for n and N", () => {
    expect(getNextSearchIndex(-1, 3, 1)).toBe(0);
    expect(getNextSearchIndex(-1, 3, -1)).toBe(2);
    expect(getNextSearchIndex(2, 3, 1)).toBe(0);
    expect(getNextSearchIndex(0, 3, -1)).toBe(2);
  });

  it("wraps single-step navigator movement and clamps page jumps", () => {
    expect(getNavigatorMoveIndex(0, 3, -1)).toBe(2);
    expect(getNavigatorMoveIndex(2, 3, 1)).toBe(0);
    expect(getNavigatorMoveIndex(0, 3, 99)).toBe(2);
    expect(getNavigatorMoveIndex(2, 3, -99)).toBe(0);
  });
});

describe("navigator grouping", () => {
  it("groups common monorepo roots and keeps a deterministic tree order", () => {
    const files = [
      makeFile("packages/shop/src/app.ts"),
      makeFile("README.md"),
      makeFile("packages/admin/src/app.ts"),
      makeFile("apps/web/page.ts"),
    ];

    expect(getNavigatorGroup(files[0]!)).toBe("packages/shop");
    expect(getNavigatorGroup(files[1]!)).toBe("root");
    expect(groupNavigatorFiles(files).map((file) => file.path)).toEqual([
      "apps/web/page.ts",
      "packages/admin/src/app.ts",
      "packages/shop/src/app.ts",
      "README.md",
    ]);
  });
});

describe("pane layout", () => {
  it("gives the diff pane the comments width when comments are hidden", () => {
    const shown = getPaneLayout(100, false);
    const hidden = getPaneLayout(100, true);

    expect(hidden.commentsWidth).toBe(0);
    expect(hidden.navigatorWidth).toBe(shown.navigatorWidth);
    expect(hidden.diffWidth).toBeGreaterThan(shown.diffWidth);
  });

  it("keeps navigator and comments panes the same width", () => {
    const shown = getPaneLayout(120, false);

    expect(shown.navigatorWidth).toBe(shown.commentsWidth);
  });

  it("keeps remote comments narrow while PR context stays wider", () => {
    const local = getPaneLayoutWithContext(200, false, false);
    const remote = getPaneLayoutWithContext(200, false, true);

    expect(remote.navigatorWidth).toBeLessThanOrEqual(local.navigatorWidth);
    expect(remote.commentsWidth).toBe(remote.navigatorWidth);
    expect(remote.contextWidth).toBeGreaterThan(remote.commentsWidth);
    expect(remote.diffWidth).toBeLessThan(local.diffWidth);
    expect(remote).toMatchObject({ navigatorWidth: 32, commentsWidth: 32, contextWidth: 58, diffWidth: 75 });
    expect(remote.navigatorWidth + remote.diffWidth + remote.commentsWidth + remote.contextWidth + 3).toBe(200);
  });

  it("allocates hidden pane widths to the visible diff pane", () => {
    const layout = getPaneLayoutForVisibility(120, {
      navigator: false,
      diff: true,
      comments: true,
      context: false,
      replies: false,
    });

    expect(layout.navigatorWidth).toBe(0);
    expect(layout.contextWidth).toBe(0);
    expect(layout.diffWidth + layout.commentsWidth + 1).toBe(120);
  });

  it("keeps PR context visible when Comments is hidden", () => {
    const layout = getPaneLayoutForVisibility(200, {
      navigator: true,
      diff: true,
      comments: false,
      context: true,
      replies: false,
    });

    expect(layout.commentsWidth).toBe(0);
    expect(layout.contextWidth).toBeGreaterThan(0);
    expect(layout.navigatorWidth + layout.diffWidth + layout.contextWidth + 2).toBe(200);
  });

  it("stacks panes below the desktop width breakpoint", () => {
    expect(shouldStackPanes(99)).toBe(true);
    expect(shouldStackPanes(100)).toBe(false);
  });

  it("stacks remote context reviews until the terminal is wide enough for four panes", () => {
    expect(shouldStackPanesWithContext(155, true)).toBe(true);
    expect(shouldStackPanesWithContext(156, true)).toBe(false);
    expect(shouldStackPanesWithContext(120, false)).toBe(false);
  });

  it("allocates stacked pane heights with more room for the diff", () => {
    expect(getStackedPaneLayout(11, false)).toEqual({
      navigatorHeight: 3,
      diffHeight: 5,
      commentsHeight: 3,
    });

    expect(getStackedPaneLayout(9, true)).toEqual({
      navigatorHeight: 3,
      diffHeight: 6,
      commentsHeight: 0,
    });
  });

  it("allocates a stacked PR context panel after comments", () => {
    expect(getStackedPaneLayoutWithContext(14, false, true)).toEqual({
      navigatorHeight: 3,
      diffHeight: 5,
      commentsHeight: 3,
      contextHeight: 3,
    });
  });

  it("allocates stacked height only to visible panes", () => {
    expect(getStackedPaneLayoutForVisibility(11, {
      navigator: false,
      diff: true,
      comments: false,
      context: true,
      replies: false,
    })).toEqual({
      navigatorHeight: 0,
      diffHeight: 7,
      commentsHeight: 0,
      contextHeight: 4,
      repliesHeight: 0,
    });
  });

  it("compresses stacked panes below three rows when the footer needs the space", () => {
    expect(getStackedPaneLayoutForVisibility(10, {
      navigator: true,
      diff: true,
      comments: true,
      context: true,
      replies: false,
    }, 2)).toEqual({
      navigatorHeight: 2,
      diffHeight: 4,
      commentsHeight: 2,
      contextHeight: 2,
      repliesHeight: 0,
    });
  });
});

describe("related navigator helpers", () => {
  it("marks incoming, outgoing, and bidirectional related files", () => {
    const active = makeFile("src/active.ts", {
      allFilesOutgoingReferences: ["src/out.ts", "src/both.ts"],
      allFilesIncomingReferences: ["src/in.ts", "src/both.ts"],
    });

    expect(getRelatedFileMarker(makeFile("src/out.ts"), active, "all-files")).toBe("→");
    expect(getRelatedFileMarker(makeFile("src/in.ts"), active, "all-files")).toBe("←");
    expect(getRelatedFileMarker(makeFile("src/both.ts"), active, "all-files")).toBe("↔");
    expect(getRelatedFileMarker(makeFile("src/other.ts"), active, "all-files")).toBeNull();
  });

  it("combines incoming and outgoing related file paths", () => {
    const active = makeFile("src/active.ts", {
      allFilesOutgoingReferences: ["src/out.ts", "src/both.ts"],
      allFilesIncomingReferences: ["src/in.ts", "src/both.ts"],
    });

    expect([...getRelatedFilePaths(active)].sort()).toEqual(["src/both.ts", "src/in.ts", "src/out.ts"]);
  });

  it("builds right-panel sections for all-files related context", () => {
    const active = makeFile("src/active.ts", {
      allFilesOutgoingReferences: ["src/out.ts", "src/both.ts"],
      allFilesIncomingReferences: ["src/in.ts", "src/both.ts"],
    });

    expect(getRelatedFilePanelSections(active, "all-files")).toEqual([
      { title: "Imports changed files", paths: ["src/both.ts", "src/out.ts"] },
      { title: "Imported by changed files", paths: ["src/both.ts", "src/in.ts"] },
    ]);
  });

  it("hides related right-panel sections outside all-files scope", () => {
    const active = makeFile("src/active.ts", {
      allFilesOutgoingReferences: ["src/out.ts"],
      allFilesIncomingReferences: ["src/in.ts"],
    });

    expect(getRelatedFilePanelSections(active, "git-diff")).toEqual([]);
  });
});

describe("parseMouseWheelInput", () => {
  it("parses SGR mouse wheel events", () => {
    expect(parseMouseWheelInput("\x1b[<64;10;5M")).toEqual({ direction: "up", col: 10, row: 5 });
    expect(parseMouseWheelInput("\x1b[<65;10;5M")).toEqual({ direction: "down", col: 10, row: 5 });
  });

  it("ignores non-wheel mouse events", () => {
    expect(parseMouseWheelInput("\x1b[<0;10;5M")).toBeNull();
  });
});

describe("cancel helpers", () => {
  it("counts scoped comments and the review-wide note", () => {
    expect(getDraftCommentCount(makeState())).toBe(0);
    expect(getDraftCommentCount(makeState({ comments: [lineComment] }))).toBe(1);
    expect(getDraftCommentCount(makeState({ allComment: "Explain the diff.", comments: [lineComment] }))).toBe(2);
  });

  it("confirms cancellation when draft feedback or reviewed-file state exists", () => {
    expect(getCancelAction(makeState())).toBe("cancel");
    expect(getCancelAction(makeState({ comments: [lineComment] }))).toBe("confirm");
    expect(getCancelAction(makeState(), 2)).toBe("confirm");
  });
});

describe("renderCenteredOverlay", () => {
  it("draws a centered overlay without replacing the background outside the popup", () => {
    const base = [
      ".......",
      ".......",
      ".......",
      ".......",
      ".......",
      ".......",
      ".......",
    ];
    const overlay = [
      "+-+",
      "|x|",
      "+-+",
    ];

    expect(renderCenteredOverlay(base, overlay, 7, 7)).toEqual([
      ".......",
      ".......",
      "..+-+..",
      "..|x|..",
      "..+-+..",
      ".......",
      ".......",
    ]);
  });
});

describe("buildEditorLaunchArgs", () => {
  it("returns process argv without shell command assembly", () => {
    expect(buildEditorLaunchArgs("nvim", "/tmp/a b's.ts", 12)).toEqual({ command: "nvim", args: ["+12", "--", "/tmp/a b's.ts"] });
  });

  it("parses quoted executable paths and arguments with quote/backslash escapes", () => {
    const editor = String.raw`'/Applications/Visual Studio Code.app/Contents/MacOS/Electron' --wait --title "a \"quote\" \\path"`;
    expect(buildEditorLaunchArgs(editor, "/tmp/file.ts", 9)).toEqual({
      command: "/Applications/Visual Studio Code.app/Contents/MacOS/Electron",
      args: ["--wait", "--title", 'a "quote" \\path', "+9", "--", "/tmp/file.ts"],
    });
  });

  it("does not expand environment variables, home paths, globs, or commands", () => {
    expect(buildEditorLaunchArgs("$EDITOR ~/src/*.ts", "/tmp/file.ts", 2)).toEqual({
      command: "$EDITOR",
      args: ["~/src/*.ts", "+2", "--", "/tmp/file.ts"],
    });
  });

  it.each(["'unterminated", '"unterminated', "nvim trailing\\"])("rejects malformed editor command %s", (editor) => {
    expect(() => buildEditorLaunchArgs(editor, "/tmp/file.ts", 1)).toThrow(/unterminated|backslash/i);
  });

  it("falls back to vi and clamps invalid line numbers", () => {
    expect(buildEditorLaunchArgs(" ", "/tmp/file.ts", 0)).toEqual({ command: "vi", args: ["+1", "--", "/tmp/file.ts"] });
  });
});

const plainTheme = {
  fg(_color: string, text: string) { return text; },
  bg(_color: string, text: string) { return text; },
};

describe("focused panel feedback", () => {
  it("marks the active panel title explicitly", () => {
    expect(formatPaneTitle("Navigator", true)).toBe("▶ Navigator");
    expect(formatPaneTitle("Diff (2 hunks)", true)).toBe("▶ Diff (2 hunks)");
    expect(formatPaneTitle("Comments", false)).toBe("Comments");
  });

  it("describes the current focus in the status footer", () => {
    expect(formatFocusStatus("navigator")).toBe("Focus: Navigator");
    expect(formatFocusStatus("diff")).toBe("Focus: Diff");
    expect(formatFocusStatus("comments")).toBe("Focus: Comments");
    expect(formatFocusStatus("replies")).toBe("Focus: Replies");
  });
});

describe("persistent review header", () => {
  const info = {
    identity: "example/widgets#1",
    title: "Add review mode",
    state: "OPEN",
    revision: "b".repeat(40),
    queue: { position: 2, total: 5 },
    openThreads: 3,
    awaitingReply: 1,
  };

  it("shows PR identity, queue position, revision, progress, and thread counts", () => {
    expect(buildReviewHeaderText(info, { files: 12, reviewed: 4, comments: 2 })).toBe(
      "example/widgets#1 • Add review mode • OPEN • queue 2/5 • @bbbbbbb • 4/12 reviewed • 2 comments • 3 open threads, 1 awaiting reply",
    );
  });

  it("drops the parts the caller did not supply", () => {
    expect(buildReviewHeaderText({ identity: "example/widgets#7" }, { files: 1, reviewed: 0, comments: 1 })).toBe(
      "example/widgets#7 • 0/1 reviewed • 1 comment",
    );
  });

  it("fits the header into the frame width", () => {
    const line = buildReviewHeaderLine(plainTheme as any, 30, info, { files: 12, reviewed: 4, comments: 2 });

    expect(visibleWidth(line)).toBeLessThanOrEqual(30);
    expect(line.startsWith("example/widgets#1")).toBe(true);
  });
});

describe("action and shortcut help rendering", () => {
  it("wraps the persistent footer without hiding later shortcuts", () => {
    const lines = buildFooterLines(plainTheme as any, "Tab focus • / search • ? help • 1/2/3 scopes • h hide comments • o open in $EDITOR • s submit • Esc exit", 80);
    const text = lines.join(" ");

    expect(lines.length).toBeGreaterThan(2);
    expect(text).toContain("1/2/3/4/5 toggle Navigator/Diff/Comments/PR context/Replies");
    expect(text).toContain("Esc / Ctrl+C exit");
    expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
  });

  it("uses an explicit help marker when the frame cannot fit every footer line", () => {
    const fitted = fitFooterLines(plainTheme as any, ["one", "two", "three", "four", "five"], 3, 40);

    expect(fitted).toEqual(["one", "two", "+3 more • ? help"]);
  });

  it("keeps header, panes, and footer within the vertical frame budget", () => {
    const prompt = "Focus: Navigator • stacked layout • Tab/Left/Right focus • / search • t templates • v diff view • ? help • 1/2/3/4 panes • o editor • s submit • Esc exit";
    for (const height of [10, 16, 22]) {
      for (const width of [20, 48, 74, 120]) {
        for (const headerLineCount of [0, 1]) {
          for (const visiblePaneCount of [0, 1, 3, 4]) {
            const stacked = visiblePaneCount > 1;
            const footer = buildFooterLines(plainTheme as any, prompt, width);
            const layout = getReviewVerticalLayout(
              plainTheme as any,
              height,
              headerLineCount,
              visiblePaneCount,
              stacked,
              footer,
              width,
            );

            expect(headerLineCount + layout.bodyHeight + layout.footerLines.length).toBeLessThanOrEqual(height);
            expect(layout.footerLines.every((line) => visibleWidth(line) <= width)).toBe(true);
            expect(layout.bodyHeight).toBeGreaterThanOrEqual(visiblePaneCount === 0 ? 1 : stacked ? visiblePaneCount : 1);
          }
        }
      }
    }
  });

  it("wraps full help text to the comments sidebar width", () => {
    const lines = buildHelpPanelLines(plainTheme as any, 24, [
      { id: "explain-added", key: "e", label: "explain", intent: "discuss", side: "added", text: "Explain what this code is doing." },
    ], "/home/user/.pi/agent/extensions/code-diff.json");

    expect(lines).toContain("Navigation");
    expect(lines).toContain("Diff actions");
    expect(lines.some((line) => line.includes("navigator: ↑↓/j/k files") && line.includes("diff:"))).toBe(false);
    expect(lines.every((line) => visibleWidth(line) <= 22)).toBe(true);
  });

  it("wraps comments-panel guidance to the comments width", () => {
    const lines = buildCommentPanelEmptyStateLines(plainTheme as any, 24);

    expect(lines.join(" ")).toContain("m modify");
    expect(lines.length).toBeGreaterThan(2);
    expect(lines.every((line) => visibleWidth(line) <= 22)).toBe(true);
  });

  it("wraps parsed PR context to the fourth column width with padding", () => {
    const lines = buildContextPanelLines(plainTheme as any, 24, "Title:\\x0aKeep the original title\\x0a\\x0aProblem:\\x0aThis PR fixes a checkout path that confused buyers during free trials.");

    expect(lines).toContain("  Title:");
    expect(lines).toContain("  Problem:");
    expect(lines.some((line) => line.includes("\\x0a"))).toBe(false);
    expect(lines.length).toBeGreaterThan(4);
    expect(lines.every((line) => line.startsWith("  "))).toBe(true);
    expect(lines.every((line) => visibleWidth(line) <= 22)).toBe(true);
  });

  it("accounts for comment preview indentation when wrapping", () => {
    const lines = buildCommentPanelTextLines(plainTheme as any, 24, "This preview wraps within the comments panel content area.", "muted", "   ", 3);

    expect(lines.length).toBe(3);
    expect(lines.every((line) => line.startsWith("   "))).toBe(true);
    expect(lines.every((line) => visibleWidth(line) <= 22)).toBe(true);
  });

  it("shows line action keys in the diff pane hint", () => {
    const hint = buildDiffActionHintLine(plainTheme as any, 120);

    for (const token of ["Enter/m", "modify", "c", "comment", "d", "discuss", "l", "file", "a", "all lines", "k/j", "context", "w", "wrap"]) {
      expect(hint).toContain(token);
    }
  });
});

describe("review editing and clipboard helpers", () => {
  const target = { side: "added" as const, line: 12, endLine: 14 };

  it("formats source, location, patch, and suggestion clipboard content", () => {
    const source = "  first()\n\tsecond()";

    expect(buildSelectionClipboardText("source", "src/app.ts", target, source)).toBe(source);
    expect(buildSelectionClipboardText("location", "src/app.ts", target, source)).toBe("src/app.ts:12-14");
    expect(buildSelectionClipboardText("patch", "src/app.ts", target, source)).toBe([
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ added lines 12-14 @@",
      "+  first()",
      "+\tsecond()",
    ].join("\n"));
    expect(buildSelectionClipboardText("suggestion", "src/app.ts", target, source)).toBe("```suggestion\n  first()\n\tsecond()\n```");
  });

  it("uses an existing modify comment for old/new patch content", () => {
    const comment: DiffReviewComment = {
      ...lineComment,
      intent: "modify",
      startLine: 12,
      endLine: 14,
      originalText: "old()",
      body: "\tnew()  ",
    };

    expect(buildSelectionClipboardText("patch", "src/app.ts", target, "ignored", comment)).toContain("-old()\n+\tnew()  ");
    expect(buildSelectionClipboardText("suggestion", "src/app.ts", target, "ignored", comment)).toBe("```suggestion\n\tnew()  \n```");
  });

  it("builds an exact old/new MODIFY preview", () => {
    expect(buildModifyPreviewLines("\told()  ", "\tnew()  ")).toEqual(["- \told()  ", "+ \tnew()  "]);
    expect(buildModifyPreviewLines("remove()", "")).toEqual(["- remove()"]);
    expect(buildModifyPreviewLines("one\r\ntwo\nthree\rfour", "replacement", 3)).toEqual(["- one", "- two", "- three"]);
  });

  it("detects unchanged modify submissions without trimming", () => {
    expect(isUnchangedModify("\tvalue  ", "\tvalue  ")).toBe(true);
    expect(isUnchangedModify("\tvalue  ", "value")).toBe(false);
    expect(isUnchangedModify(undefined, "value")).toBe(false);
  });

  it("extracts selected source lines without corrupting CRLF boundaries", () => {
    const content = "first\r\n\tsecond\r\n  third  \r\nfourth\r\n";

    expect(getSourceLineRangeText(content, 2, 3)).toBe("\tsecond\r\n  third  ");
    expect(getSourceLineRangeText(content, 4, 4)).toBe("fourth");
  });

  it("recenters once at the viewport edge instead of shifting on every following row", () => {
    const recentered = getStableDiffScroll(0, 12, 12, 13);

    expect(recentered).toBeGreaterThan(1);
    expect(getStableDiffScroll(recentered, 12, 13, 14)).toBe(recentered);
    expect(getStableDiffScroll(recentered, 12, 14, 15)).toBe(recentered);
  });

  it("keeps a tall wrapped row fully visible", () => {
    const scroll = getStableDiffScroll(0, 12, 10, 15);

    expect(scroll).toBeGreaterThan(0);
    expect(scroll).toBeLessThanOrEqual(10);
    expect(scroll + 12).toBeGreaterThanOrEqual(15);
  });

  it("measures wrapped item heights when selecting a comment page", () => {
    expect(getMeasuredPageRange([2, 6, 2], 2, 0, 7)).toEqual({ start: 2, end: 3 });
    expect(getMeasuredPageRange([2, 2, 2], 1, 0, 5)).toEqual({ start: 0, end: 2 });
  });

  it("selects only viewport rows plus overscan from cached row heights", () => {
    expect(getVirtualRowRange([1, 3, 1, 2], 3, 2, 1)).toEqual({
      startRow: 1,
      endRow: 4,
      startOffset: 1,
      offsets: [0, 1, 4, 5, 7],
    });
  });

  it("evicts the least recently inserted bounded cache entry", () => {
    const cache = new Map<string, number>();
    setBoundedMapEntry(cache, "a", 1, 2);
    setBoundedMapEntry(cache, "b", 2, 2);
    setBoundedMapEntry(cache, "a", 3, 2);
    setBoundedMapEntry(cache, "c", 4, 2);

    expect([...cache.entries()]).toEqual([["a", 3], ["c", 4]]);
  });
});
