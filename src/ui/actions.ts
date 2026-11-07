import { Key, matchesKey } from "@earendil-works/pi-tui";

export type ReviewActionSection = "Core" | "Navigation" | "Diff actions" | "Comments" | "Editor";
export type StoryActionSection = "Story" | "Panes" | "Move" | "Other pane" | "Comments";
export type ShortcutsMode = "review" | "story";

interface ActionDefinition<Section extends string> {
  id: string;
  section: Section;
  keys: string;
  label: string;
  inputs?: string[];
}

export type ReviewActionDefinition = ActionDefinition<ReviewActionSection>;
export type StoryActionDefinition = ActionDefinition<StoryActionSection>;

export interface FooterShortcut {
  key: string;
  label: string;
  color: "success" | "warning" | "accent" | "muted";
  mode?: ShortcutsMode;
}

const FOOTER_SHORTCUTS: FooterShortcut[] = [
  { key: "c", label: "Comment", color: "success" },
  { key: "d", label: "Discuss with Agent", color: "warning" },
  { key: "Ctrl+?", label: "All Shortcuts", color: "muted" },
  { key: "i", label: "Info", color: "accent", mode: "story" },
];

/** Legacy Ctrl+? is the Backspace byte (0x7F), so `?` and Ctrl+/ (0x1F) are the aliases every terminal can send. */
const SHORTCUTS_KEYS = [Key.ctrl("/"), Key.ctrlShift("/"), Key.ctrl("?"), Key.ctrlShift("?"), Key.ctrl("_")] as const;

export function isShortcutsKey(data: string): boolean {
  return data === "?" || SHORTCUTS_KEYS.some((key) => matchesKey(data, key));
}

export const REVIEW_ACTIONS: ReviewActionDefinition[] = [
  { id: "panes", section: "Core", keys: "1/2/3/4/5", label: "toggle Navigator/Diff/Comments/PR context/Replies" },
  { id: "focus", section: "Core", keys: "Tab / Shift+Tab", label: "cycle focus" },
  { id: "search", section: "Core", keys: "/", label: "search focused pane • n/N next/prev search" },
  { id: "help", section: "Core", keys: "Ctrl+? / ? / Ctrl+/", label: "toggle this shortcuts list" },
  { id: "wrap", section: "Core", keys: "w", label: "wrap lines", inputs: ["w"] },
  { id: "view", section: "Core", keys: "v", label: "toggle diff view", inputs: ["v"] },
  { id: "unchanged", section: "Core", keys: "u", label: "toggle unchanged context", inputs: ["u"] },
  { id: "contextNavigation", section: "Core", keys: "C", label: "include context in Up/Down", inputs: ["C"] },
  { id: "commentsPane", section: "Core", keys: "h", label: "hide/show comments", inputs: ["h"] },
  { id: "submit", section: "Core", keys: "s", label: "submit", inputs: ["s"] },
  { id: "exit", section: "Core", keys: "Esc / Ctrl+C", label: "exit review" },
  { id: "navigatorMove", section: "Navigation", keys: "↑↓/j/k", label: "move files" },
  { id: "halfPage", section: "Navigation", keys: "Ctrl+d/u", label: "half-page" },
  { id: "fullPage", section: "Navigation", keys: "Ctrl+f/b • PageDown/PageUp", label: "full page" },
  { id: "boundary", section: "Navigation", keys: "gg/G • Home/End", label: "top/bottom" },
  { id: "replyThreads", section: "Navigation", keys: "Replies: t / Enter / o / A", label: "personal/all threads • inspect • browser • read-only analysis" },
  { id: "threadCode", section: "Navigation", keys: "Thread: v", label: "jump to verified code location" },
  { id: "threadResponse", section: "Navigation", keys: "Thread: e", label: "edit window-only response" },
  { id: "tree", section: "Navigation", keys: "T", label: "tree/flat files", inputs: ["T"] },
  { id: "order", section: "Navigation", keys: "O", label: "risk/alphabetical file order", inputs: ["O"] },
  { id: "locales", section: "Navigation", keys: "L", label: "show/hide other locales", inputs: ["L"] },
  { id: "reviewed", section: "Navigation", keys: "R", label: "mark reviewed", inputs: ["R"] },
  { id: "unreviewed", section: "Navigation", keys: "]/ [", label: "next/previous unreviewed", inputs: ["]", "["] },
  { id: "related", section: "Navigation", keys: "r", label: "related filter", inputs: ["r"] },
  { id: "submodule", section: "Navigation", keys: "Enter/Right", label: "open submodule" },
  { id: "parent", section: "Navigation", keys: "b", label: "return to parent submodule review", inputs: ["b", "B"] },
  { id: "diffMove", section: "Diff actions", keys: "↑↓", label: "move changed lines" },
  { id: "expandAbove", section: "Diff actions", keys: "k/K", label: "expand 10 lines above", inputs: ["k", "K"] },
  { id: "expandBelow", section: "Diff actions", keys: "j/J", label: "expand 10 lines below", inputs: ["j", "J"] },
  { id: "side", section: "Diff actions", keys: "←/→", label: "cross old/new before pane focus" },
  { id: "extend", section: "Diff actions", keys: "Shift+↑↓", label: "extend range" },
  { id: "contextReach", section: "Diff actions", keys: "Option+↑↓/PgUp/PgDn/Home/End", label: "reach unchanged lines; add Shift to select a range" },
  { id: "hunk", section: "Diff actions", keys: "n/p", label: "next/previous hunk without search" },
  { id: "templates", section: "Diff actions", keys: "t", label: "templates", inputs: ["t"] },
  { id: "openCode", section: "Diff actions", keys: "o", label: "open current line in /code", inputs: ["o"] },
  { id: "externalEditor", section: "Diff actions", keys: "e", label: "edit file in $EDITOR", inputs: ["e"] },
  { id: "modify", section: "Diff actions", keys: "Enter/m", label: "modify" },
  { id: "comment", section: "Diff actions", keys: "c", label: "comment", inputs: ["c"] },
  { id: "discuss", section: "Diff actions", keys: "d", label: "discuss line", inputs: ["d"] },
  { id: "copy", section: "Diff actions", keys: "y/Y/P/S", label: "copy source/location/patch/suggestion", inputs: ["y", "Y", "P", "S"] },
  { id: "mouseCopy", section: "Diff actions", keys: "Mouse drag", label: "copy selected text; diffs copy code only • double-click word • triple-click line" },
  { id: "openSource", section: "Diff actions", keys: "gf", label: "open the selected line on the code host (settings: urls.file)" },
  { id: "findDefinition", section: "Diff actions", keys: "gd / Ctrl+click", label: "search where the selected symbol is defined (settings: search)" },
  { id: "delete", section: "Diff actions", keys: "x", label: "delete comment", inputs: ["x"] },
  { id: "fileComment", section: "Diff actions", keys: "l", label: "file comment", inputs: ["l"] },
  { id: "allLines", section: "Diff actions", keys: "a", label: "all-lines comment", inputs: ["a"] },
  { id: "prThreads", section: "Diff actions", keys: "I", label: "show/hide open PR threads under their lines (○ marks them)", inputs: ["I"] },
  { id: "commentMove", section: "Comments", keys: "↑↓/j/k", label: "move comments" },
  { id: "commentEdit", section: "Comments", keys: "e/Enter", label: "edit selected comment" },
  { id: "commentDelete", section: "Comments", keys: "d/r", label: "delete selected comment", inputs: ["d", "r"] },
  { id: "commentCopy", section: "Comments", keys: "y", label: "copy selected comment" },
  { id: "globalComments", section: "Comments", keys: "A", label: "active-file/all-comments view", inputs: ["A"] },
  { id: "intent", section: "Editor", keys: "Tab", label: "toggle intent" },
  { id: "editorSave", section: "Editor", keys: "Enter", label: "save • Shift+Enter newline" },
  { id: "editorReplace", section: "Editor", keys: "MODIFY", label: "typing or paste replaces highlighted source" },
  { id: "editorCancel", section: "Editor", keys: "Esc", label: "cancel" },
];

export const STORY_ACTIONS: StoryActionDefinition[] = [
  { id: "storyStep", section: "Story", keys: "Shift+←/→", label: "previous/next step" },
  { id: "storySeen", section: "Story", keys: "R", label: "mark the step seen" },
  { id: "storyInfo", section: "Story", keys: "i", label: "story info: steps, files, totals" },
  { id: "storySidebar", section: "Story", keys: "1", label: "show/hide the step sidebar; hidden, new stories skip the agent's step notes" },
  { id: "storyContext", section: "Story", keys: "4", label: "PR context • D brief/description • Esc back" },
  { id: "storyThreads", section: "Story", keys: "I", label: "show/hide open PR threads under their lines" },
  { id: "storyFullDiff", section: "Story", keys: "F", label: "full diff; F returns to the story" },
  { id: "storySubmit", section: "Story", keys: "s", label: "finish and submit" },
  { id: "storyExit", section: "Story", keys: "Esc / Ctrl+C", label: "park or discard the review" },
  { id: "storyShortcuts", section: "Story", keys: "Ctrl+? / ? / Ctrl+/", label: "toggle this shortcuts list" },
  { id: "storyPanes", section: "Panes", keys: "←/→", label: "tests/code pane" },
  { id: "storyFocus", section: "Panes", keys: "Tab / Shift+Tab", label: "cycle tests, code, comments" },
  { id: "storyCommentsPane", section: "Panes", keys: "h", label: "show/hide comments" },
  { id: "storyRelated", section: "Panes", keys: "[ / ]", label: "previous/next file in the pane" },
  { id: "storyMove", section: "Move", keys: "↑↓", label: "move changed lines" },
  { id: "storyExtend", section: "Move", keys: "Shift+↑↓", label: "extend range" },
  { id: "storyPage", section: "Move", keys: "PgUp/PgDn • Ctrl+f/b", label: "page" },
  { id: "storyHalfPage", section: "Move", keys: "Ctrl+d/u", label: "half page" },
  { id: "storyBoundary", section: "Move", keys: "Home/End • gg/G", label: "first/last line" },
  { id: "storyContextNavigation", section: "Move", keys: "C", label: "include unchanged lines in ↑↓" },
  { id: "storyOtherRow", section: "Other pane", keys: "Option+↑↓", label: "scroll the other pane one row; focus stays" },
  { id: "storyOtherPage", section: "Other pane", keys: "Option+PgUp/PgDn", label: "scroll the other pane one page" },
  { id: "storyOtherEdge", section: "Other pane", keys: "Option+Shift+↑↓ • Option+Home/End", label: "other pane top/bottom" },
  { id: "storyComment", section: "Comments", keys: "c / d", label: "comment / discuss with the agent" },
  { id: "storyModify", section: "Comments", keys: "Enter/m", label: "modify" },
  { id: "storyFileComment", section: "Comments", keys: "l / a", label: "file comment / all-lines comment" },
  { id: "storyDelete", section: "Comments", keys: "x", label: "delete the comment on the selected line" },
  { id: "storyCopy", section: "Comments", keys: "y/Y/P/S", label: "copy source/location/patch/suggestion" },
  { id: "storyCommentsList", section: "Comments", keys: "In Comments: ↑↓/j/k • e/Enter • d/r • y", label: "move • edit • delete • copy" },
];

export function getReviewAction(id: string): ReviewActionDefinition {
  const action = REVIEW_ACTIONS.find((candidate) => candidate.id === id);
  if (action == null) throw new Error(`Unknown review action: ${id}`);
  return action;
}

export function matchesReviewAction(id: string, input: string): boolean {
  return getReviewAction(id).inputs?.includes(input) ?? false;
}

export function getReviewHelpSections(codeCommand = "/code"): Array<{ title: ReviewActionSection; lines: string[] }> {
  const sections: ReviewActionSection[] = ["Core", "Navigation", "Diff actions", "Comments", "Editor"];
  return sections.map((section) => ({
    title: section,
    lines: REVIEW_ACTIONS.filter((action) => action.section === section).map((action) => `${action.keys} ${action.label.replace("/code", codeCommand)}`),
  }));
}

export function getStoryHelpSections(): Array<{ title: StoryActionSection; lines: string[] }> {
  const sections: StoryActionSection[] = ["Story", "Panes", "Move", "Other pane", "Comments"];
  return sections.map((section) => ({
    title: section,
    lines: STORY_ACTIONS.filter((action) => action.section === section).map((action) => `${action.keys} ${action.label}`),
  }));
}

export function getFooterShortcuts(mode: ShortcutsMode = "review"): FooterShortcut[] {
  return FOOTER_SHORTCUTS.filter((shortcut) => shortcut.mode == null || shortcut.mode === mode);
}

export function getFooterShortcutsText(mode: ShortcutsMode = "review"): string {
  return `Shortcuts: ${getFooterShortcuts(mode).map(({ key, label }) => `${key} (${label})`).join(" - ")}`;
}
