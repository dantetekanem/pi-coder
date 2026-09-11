export type ReviewActionSection = "Core" | "Navigation" | "Diff actions" | "Comments" | "Editor";

export interface ReviewActionDefinition {
  id: string;
  section: ReviewActionSection;
  keys: string;
  label: string;
  inputs?: string[];
  footer?: boolean;
}

export const REVIEW_ACTIONS: ReviewActionDefinition[] = [
  { id: "scope", section: "Core", keys: "Alt+1/2/3", label: "switch review scope" },
  { id: "panes", section: "Core", keys: "1/2/3/4/5", label: "toggle Navigator/Diff/Comments/PR context/Replies", footer: true },
  { id: "focus", section: "Core", keys: "Tab / Shift+Tab", label: "cycle focus", footer: true },
  { id: "search", section: "Core", keys: "/", label: "search focused pane • n/N next/prev search", footer: true },
  { id: "help", section: "Core", keys: "?", label: "toggle help/actions", inputs: ["?"], footer: true },
  { id: "wrap", section: "Core", keys: "w", label: "wrap lines", inputs: ["w"] },
  { id: "view", section: "Core", keys: "v", label: "toggle diff view", inputs: ["v"], footer: true },
  { id: "unchanged", section: "Core", keys: "u", label: "toggle unchanged context", inputs: ["u"] },
  { id: "contextNavigation", section: "Core", keys: "C", label: "include context in Up/Down", inputs: ["C"] },
  { id: "commentsPane", section: "Core", keys: "h", label: "hide/show comments", inputs: ["h"] },
  { id: "submit", section: "Core", keys: "s", label: "submit", inputs: ["s"], footer: true },
  { id: "exit", section: "Core", keys: "Esc / Ctrl+C", label: "exit review", footer: true },
  { id: "navigatorMove", section: "Navigation", keys: "↑↓/j/k", label: "move files" },
  { id: "halfPage", section: "Navigation", keys: "Ctrl+d/u", label: "half-page" },
  { id: "fullPage", section: "Navigation", keys: "Ctrl+f/b • PageDown/PageUp", label: "full page" },
  { id: "boundary", section: "Navigation", keys: "gg/G", label: "top/bottom" },
  { id: "replyThreads", section: "Navigation", keys: "Replies: t / Enter / o / A", label: "personal/all threads • inspect • browser • read-only analysis" },
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
  { id: "hunk", section: "Diff actions", keys: "n/p", label: "next/previous hunk without search" },
  { id: "templates", section: "Diff actions", keys: "t", label: "templates", inputs: ["t"] },
  { id: "openCode", section: "Diff actions", keys: "o", label: "open current line in /code", inputs: ["o"] },
  { id: "externalEditor", section: "Diff actions", keys: "e", label: "edit file in $EDITOR", inputs: ["e"] },
  { id: "modify", section: "Diff actions", keys: "Enter/m", label: "modify" },
  { id: "comment", section: "Diff actions", keys: "c", label: "comment", inputs: ["c"] },
  { id: "discuss", section: "Diff actions", keys: "d", label: "discuss line", inputs: ["d"] },
  { id: "copy", section: "Diff actions", keys: "y/Y/P/S", label: "copy source/location/patch/suggestion", inputs: ["y", "Y", "P", "S"] },
  { id: "delete", section: "Diff actions", keys: "x", label: "delete comment", inputs: ["x"] },
  { id: "fileComment", section: "Diff actions", keys: "l", label: "file comment", inputs: ["l"] },
  { id: "allLines", section: "Diff actions", keys: "a", label: "all-lines comment", inputs: ["a"] },
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

export function getReviewAction(id: string): ReviewActionDefinition {
  const action = REVIEW_ACTIONS.find((candidate) => candidate.id === id);
  if (action == null) throw new Error(`Unknown review action: ${id}`);
  return action;
}

export function matchesReviewAction(id: string, input: string): boolean {
  return getReviewAction(id).inputs?.includes(input) ?? false;
}

export function getReviewHelpSections(): Array<{ title: ReviewActionSection; lines: string[] }> {
  const sections: ReviewActionSection[] = ["Core", "Navigation", "Diff actions", "Comments", "Editor"];
  return sections.map((section) => ({
    title: section,
    lines: REVIEW_ACTIONS.filter((action) => action.section === section).map((action) => `${action.keys} ${action.label}`),
  }));
}

export function getReviewFooterHint(): string {
  return REVIEW_ACTIONS.filter((action) => action.footer).map((action) => `${action.keys} ${action.label}`).join(" • ");
}
