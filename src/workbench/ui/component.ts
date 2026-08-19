import { Key, matchesKey, truncateToWidth, visibleWidth, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import {
  type CodeStory,
  type CodeTarget,
  type Workbench,
  type WorkbenchCompletionResult,
  type WorkbenchLaunch,
} from "../contracts.js";
import { EXPLORER_STATE_VERSION, type ExplorerState, type ExplorerStateSession } from "../explorer-state.js";
import type { RepositoryTree, RepositoryTreeRow } from "../tree.js";
import { clampLineRange, hashTargetSlice } from "../target.js";
import { WorkbenchBufferEditor, type BufferEditorInputResult } from "./buffer-editor.js";

export type WorkbenchForeground = "accent" | "border" | "text" | "muted" | "warning" | "error" | "success";
export type WorkbenchBackground = "selectedBg";

/** Semantic colors required by the product UI, independent of any host theme API. */
export interface WorkbenchTheme {
  fg(color: WorkbenchForeground, text: string): string;
  bg(color: WorkbenchBackground, text: string): string;
  /** Bright yellow match; the current match adds a focused inverse treatment. */
  searchMatch?(text: string, current: boolean): string;
}

export interface WorkbenchClipboard {
  writeText(text: string): Promise<void>;
}

type Pane = "files" | "file-search" | "source" | "buffer-search";

interface BufferMatch { line: number; column: number; }

const BUFFER_MATCH_CAP = 10_000;
const LIVE_HIGHLIGHT_DELAY_MS = 100;
const LIVE_HIGHLIGHT_MAX_BYTES = 64 * 1024;
type LoadingOperation = "file" | "save" | "dirty-choice";

function stripRepositoryControls(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}

function safeSourceLine(text: string): string {
  return text.replace(/[\r\n]/g, "�");
}

const ANSI_RESET = "\u001b[0m";
const MAX_ACTIVE_SOURCE_STYLE_BYTES = 256;

function updateActiveSourceStyle(active: string, sequence: string, parameters: string): string | null {
  const values = parameters === "" ? [0] : parameters.split(";").map((value) => value === "" ? 0 : Number(value));
  if (values.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return null;
  const next = values.includes(0)
    ? values.every((value) => value === 0) ? "" : sequence
    : `${active}${sequence}`;
  return next.length <= MAX_ACTIVE_SOURCE_STYLE_BYTES ? next : null;
}

/** Overlays one source-exact UTF-16 range without trusting or breaking syntax SGR state. */
function highlightSourceMatch(
  highlightedLine: string,
  start: number,
  length: number,
  current: boolean,
  theme: WorkbenchTheme,
): string {
  if (start < 0 || length <= 0) return highlightedLine;
  const end = start + length;
  let sourceOffset = 0;
  let cursor = 0;
  let activeStyle = "";
  let before = "";
  let matched = "";
  let after = "";

  const appendStyled = (target: "before" | "after", text: string, style: string): void => {
    if (text.length === 0) return;
    const rendered = style === "" ? text : `${style}${text}${ANSI_RESET}`;
    if (target === "before") before += rendered;
    else after += rendered;
  };
  const appendChunk = (chunk: string): void => {
    const chunkStart = sourceOffset;
    const chunkEnd = chunkStart + chunk.length;
    const beforeEnd = Math.min(chunkEnd, start);
    if (beforeEnd > chunkStart) appendStyled("before", chunk.slice(0, beforeEnd - chunkStart), activeStyle);
    const matchStart = Math.max(chunkStart, start);
    const matchEnd = Math.min(chunkEnd, end);
    if (matchEnd > matchStart) matched += chunk.slice(matchStart - chunkStart, matchEnd - chunkStart);
    const afterStart = Math.max(chunkStart, end);
    if (chunkEnd > afterStart) appendStyled("after", chunk.slice(afterStart - chunkStart), activeStyle);
    sourceOffset = chunkEnd;
  };

  const sgr = /\u001b\[([0-9;]*)m/g;
  for (let match = sgr.exec(highlightedLine); match != null; match = sgr.exec(highlightedLine)) {
    const chunk = highlightedLine.slice(cursor, match.index);
    if (chunk.includes("\u001b")) return highlightedLine;
    appendChunk(chunk);
    const nextStyle = updateActiveSourceStyle(activeStyle, match[0], match[1] ?? "");
    if (nextStyle == null) return highlightedLine;
    activeStyle = nextStyle;
    cursor = match.index + match[0].length;
  }
  const tail = highlightedLine.slice(cursor);
  if (tail.includes("\u001b")) return highlightedLine;
  appendChunk(tail);
  if (sourceOffset < end || matched.length !== length) return highlightedLine;
  const highlighted = theme.searchMatch?.(matched, current) ?? theme.fg("warning", matched);
  return `${before}${highlighted}${after}`;
}

function fitCell(text: string, width: number): string {
  if (width <= 0) return "";
  const fitted = truncateToWidth(text, width, "…", false);
  return fitted + " ".repeat(Math.max(0, width - visibleWidth(fitted)));
}

const FRAME_PADDING_X = 2;
const FRAME_PADDING_Y = 1;

function renderPaneBox(title: string, width: number, height: number, theme: WorkbenchTheme, lines: readonly string[], focused: boolean): string[] {
  const safeWidth = Math.max(3, Math.floor(width));
  const safeHeight = Math.max(2, Math.floor(height));
  const innerWidth = safeWidth - 2;
  const innerHeight = Math.max(0, safeHeight - 2);
  const label = focused ? `▶ ${title}` : title;
  const titleText = truncateToWidth(` ${label} `, Math.max(1, innerWidth - 2), "", false);
  const leftPad = Math.max(0, Math.floor((innerWidth - visibleWidth(titleText)) / 2));
  const rightPad = Math.max(0, innerWidth - visibleWidth(titleText) - leftPad);
  const borderColor = focused ? "accent" : "border";
  const top = theme.fg(borderColor, `┌${"─".repeat(leftPad)}${titleText}${"─".repeat(rightPad)}┐`);
  const bottom = theme.fg(borderColor, `└${"─".repeat(innerWidth)}┘`);
  const body = Array.from({ length: innerHeight }, (_, index) => `${theme.fg(borderColor, "│")}${fitCell(lines[index] ?? "", innerWidth)}${theme.fg(borderColor, "│")}`);
  return [top, ...body, bottom];
}

function renderOuterFrame(width: number, height: number, theme: WorkbenchTheme, title: string, lines: readonly string[]): string[] {
  const safeWidth = Math.max(8, Math.floor(width));
  const safeHeight = Math.max(6, Math.floor(height));
  const innerWidth = safeWidth - 2;
  const innerHeight = safeHeight - 2;
  const contentWidth = Math.max(1, innerWidth - FRAME_PADDING_X * 2);
  const contentHeight = Math.max(1, innerHeight - FRAME_PADDING_Y * 2);
  const titleText = truncateToWidth(` ${title} `, Math.max(1, innerWidth - 2), "", false);
  const top = theme.fg("accent", `┌─${titleText}${"─".repeat(Math.max(0, innerWidth - visibleWidth(titleText) - 1))}┐`);
  const bottom = theme.fg("accent", `└${"─".repeat(innerWidth)}┘`);
  const sidePadding = " ".repeat(FRAME_PADDING_X);
  const body = Array.from({ length: innerHeight }, (_, index) => {
    const contentIndex = index - FRAME_PADDING_Y;
    const line = contentIndex >= 0 && contentIndex < contentHeight
      ? `${sidePadding}${fitCell(lines[contentIndex] ?? "", contentWidth)}${sidePadding}`
      : " ".repeat(innerWidth);
    return `${theme.fg("accent", "│")}${line}${theme.fg("accent", "│")}`;
  });
  return [top, ...body, bottom];
}

function renderCompactViewport(width: number, height: number, theme: WorkbenchTheme): string[] {
  const safeWidth = Math.max(0, Math.floor(width));
  const safeHeight = Math.max(0, Math.floor(height));
  if (safeHeight === 0) return [];
  if (safeWidth === 0) return Array.from({ length: safeHeight }, () => "");
  if (safeWidth < 8 || safeHeight < 3) {
    const lines = [theme.fg("accent", "code"), theme.fg("muted", "Esc close")];
    return Array.from({ length: safeHeight }, (_, index) => fitCell(lines[index] ?? "", safeWidth));
  }

  const innerWidth = safeWidth - 2;
  const bodyHeight = safeHeight - 2;
  const contentWidth = Math.max(1, innerWidth - 2);
  const titleText = truncateToWidth(" code ", Math.max(1, innerWidth - 2), "", false);
  const top = theme.fg("accent", `┌─${titleText}${"─".repeat(Math.max(0, innerWidth - visibleWidth(titleText) - 1))}┐`);
  const bottom = theme.fg("accent", `└${"─".repeat(innerWidth)}┘`);
  const notices = bodyHeight === 1
    ? ["Esc close"]
    : bodyHeight === 2
      ? ["Resize to 40×12", "Esc close"]
      : ["Viewport too small", "Resize to 40×12", "Esc close"];
  const noticeTop = Math.max(0, Math.floor((bodyHeight - notices.length) / 2));
  const body = Array.from({ length: bodyHeight }, (_, index) => {
    const notice = notices[index - noticeTop] ?? "";
    const content = notice.length === 0 ? "" : theme.fg(index - noticeTop === 0 ? "warning" : "muted", notice);
    return `${theme.fg("accent", "│")} ${fitCell(content, contentWidth)} ${theme.fg("accent", "│")}`;
  });
  return [top, ...body, bottom];
}

export class WorkbenchComponent implements Component, Focusable {
  private fileSearch = "";
  private fileSearchRows: readonly Extract<RepositoryTreeRow, { type: "file" }>[] | null = null;
  private fileSearchIndex = 0;
  private fileSearchViewport = 0;
  private fileSearchRestore: { index: number; viewport: number } | null = null;
  private bufferSearch = "";
  private acceptedBufferSearch: string | null = null;
  private bufferMatches: readonly BufferMatch[] = [];
  private bufferMatchText: string | null = null;
  private bufferMatchQuery: string | null = null;
  private bufferMatchesCapped = false;
  private bufferSearchRestore: {
    acceptedQuery: string | null;
    matches: readonly BufferMatch[];
    text: string | null;
    query: string | null;
    capped: boolean;
  } | null = null;
  private pane: Pane = "files";
  private tree: RepositoryTree;
  private readonly restoredExplorerState: ExplorerState | undefined;
  private explorerStateTree: RepositoryTree | null = null;
  private treeIndex = 0;
  private treeViewport = 0;
  private sourceViewport = 0;
  private rangeAnchorLine: number | null = null;
  private lastBodyHeight = 12;
  private loadingOperation: LoadingOperation | null = null;
  private operationVersion = 0;
  private closeQueued = false;
  private completed = false;
  private error: string | null = null;
  private warning: string | null = null;
  private status: string | null = null;
  private awaitingDirtyChoice = false;
  private bufferEditor: WorkbenchBufferEditor | null = null;
  private internalClipboard: string | null = null;
  private clipboardOperationVersion = 0;
  private liveHighlightTimer: ReturnType<typeof setTimeout> | null = null;
  private liveHighlightVersion = 0;
  /** Normalized launch data is cloned so caller-owned stories can never be mutated. */
  private readonly stories: readonly CodeStory[];
  private readonly discussEnabled: boolean;
  private storyIndex: number | null = null;
  private readonly staleStories = new Set<number>();
  private pendingStoryIndex: number | null = null;
  private pendingDiscuss: { range: CodeTarget["range"]; note?: string } | null = null;
  private noteEditor: WorkbenchBufferEditor | null = null;
  private _focused = false;

  constructor(
    private readonly tui: TUI,
    private readonly theme: WorkbenchTheme,
    private readonly workbench: Workbench,
    private readonly done: (result: WorkbenchCompletionResult) => void,
    private readonly explorerState?: ExplorerStateSession,
    launch: WorkbenchLaunch = {},
    private readonly clipboard?: WorkbenchClipboard,
  ) {
    this.stories = (launch.stories ?? []).map((story) => ({
      id: story.id,
      prose: story.prose,
      target: { path: story.target.path, range: { ...story.target.range }, ...(story.target.anchor == null ? {} : { anchor: { ...story.target.anchor } }) },
    }));
    this.discussEnabled = launch.capabilities?.discuss === true;
    this.tree = workbench.repositoryTree;
    this.restoredExplorerState = explorerState?.load();
    this.restoreExplorerState();
  }

  get focused(): boolean { return this._focused; }
  set focused(value: boolean) {
    this._focused = value;
    if (this.bufferEditor != null) this.bufferEditor.focused = value;
    if (this.noteEditor != null) this.noteEditor.focused = value;
  }

  handleInput(data: string): void {
    if (this.completed) return;
    if (this.loadingOperation != null) {
      if (matchesKey(data, Key.escape)) this.requestClose();
      return;
    }
    if (this.awaitingDirtyChoice) {
      if (matchesKey(data, Key.escape) || data.toLowerCase() === "c") void this.resolveDirtyChoice("cancel");
      else if (data.toLowerCase() === "s") void this.resolveDirtyChoice("save");
      else if (data.toLowerCase() === "d") void this.resolveDirtyChoice("discard");
      return;
    }
    if (this.pane === "file-search" || this.pane === "buffer-search") {
      if (matchesKey(data, Key.escape)) { this.cancelContextualSearch(); return; }
      this.handleContextualSearchInput(data);
      return;
    }
    if (this.noteEditor != null) { this.handleNoteInput(data); return; }
    if (matchesKey(data, Key.ctrl("s"))) { void this.saveBuffer(); return; }
    if (this.bufferEditor != null) {
      if (matchesKey(data, Key.escape)) { this.finishBufferEdit(); return; }
      const editor = this.bufferEditor;
      if (matchesKey(data, Key.super("c")) || matchesKey(data, Key.ctrlShift("c"))) { this.copyBufferSelection(editor, false); return; }
      if (matchesKey(data, Key.super("x")) || matchesKey(data, Key.ctrl("x")) || matchesKey(data, Key.ctrlShift("x"))) { this.copyBufferSelection(editor, true); return; }
      if (matchesKey(data, Key.super("v")) || matchesKey(data, Key.ctrl("v")) || matchesKey(data, Key.ctrlShift("v"))) {
        if (this.internalClipboard == null) {
          this.status = "Nothing copied in /code; use the terminal paste shortcut.";
          this.tui.requestRender();
        } else this.applyBufferEditorUpdate(editor, editor.insertText(this.internalClipboard));
        return;
      }
      this.applyBufferEditorUpdate(editor, editor.handleInput(data));
      return;
    }
    if (matchesKey(data, Key.escape)) {
      if (this.pane !== "files") { this.pane = "files"; this.tui.requestRender(); }
      else this.requestClose();
      return;
    }
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift(Key.tab))) {
      this.pane = this.pane === "files" && this.workbench.bufferText != null ? "source" : "files";
      this.tui.requestRender();
      return;
    }
    // Canonical modified-arrow events remain backward-compatible, but Enter/Escape/Tab are the primary pane navigation.
    if (matchesKey(data, Key.alt(Key.left))) { this.pane = "files"; this.tui.requestRender(); return; }
    if (matchesKey(data, Key.alt(Key.right))) { this.pane = "source"; this.tui.requestRender(); return; }

    if (this.pane === "source") {
      if (data === "[" || data === "]") {
        void this.activateStory(data === "]" ? 1 : -1);
        return;
      } else if (data === "d" && this.discussEnabled) {
        this.beginDiscuss();
        return;
      } else if (matchesKey(data, Key.shift("up"))) {
        this.extendSourceRange(-1);
        this.status = null;
      } else if (matchesKey(data, Key.shift("down"))) {
        this.extendSourceRange(1);
        this.status = null;
      } else if (this.isUp(data)) {
        this.workbench.setSelectedLine((this.workbench.selectedLine ?? 1) - 1);
        this.rangeAnchorLine = null;
        this.status = null;
      } else if (this.isDown(data)) {
        this.workbench.setSelectedLine((this.workbench.selectedLine ?? 1) + 1);
        this.rangeAnchorLine = null;
        this.status = null;
      } else if (matchesKey(data, Key.enter)) this.beginBufferEdit();
      else if (data === "/") this.openBufferSearch();
      else if (data === "n") this.navigateBufferMatches(1);
      else if (data === "N") this.navigateBufferMatches(-1);
      else return;
      this.tui.requestRender();
      return;
    }

    if (this.pane === "files" && data === "/") { this.openFileSearch(); return; }
    if (this.pane === "files") this.handleTreeInput(data);
  }

  render(width: number): string[] {
    this.ensureTree();
    const viewportWidth = Math.max(0, Math.floor(width));
    const terminalRows = (this.tui as TUI & { terminal?: { rows?: number } }).terminal?.rows;
    const viewportHeight = Math.max(0, Math.floor(terminalRows ?? 24));
    if (viewportWidth < 40 || viewportHeight < 12) return renderCompactViewport(viewportWidth, viewportHeight, this.theme);
    const frameWidth = viewportWidth;
    const totalHeight = Math.min(viewportHeight, Math.max(12, viewportHeight - 4));
    const availableWidth = Math.max(20, frameWidth - 2 - FRAME_PADDING_X * 2);
    const availableHeight = Math.max(8, totalHeight - 2 - FRAME_PADDING_Y * 2);
    const paneHeight = Math.max(4, availableHeight - 4);
    const paneBodyHeight = Math.max(2, paneHeight - 2);
    this.lastBodyHeight = paneBodyHeight;
    const explorerWidth = Math.max(12, Math.min(32, Math.max(24, Math.round(availableWidth * 0.3)), availableWidth - 19));
    const sourceWidth = Math.max(3, availableWidth - explorerWidth - 1);
    const explorerTitle = this.pane === "file-search" ? "FIND FILE" : "EXPLORER";
    const explorerFocused = this.pane === "files" || this.pane === "file-search";
    const rightFocused = this.pane === "source" || this.pane === "buffer-search";
    const view = this.pane === "file-search" ? "FIND FILE" : this.pane === "buffer-search" ? "FIND BUFFER" : this.pane.toUpperCase();
    const interaction = this.noteEditor != null ? "NOTE" : this.bufferEditor != null ? "INSERT" : this.awaitingDirtyChoice ? "CONFIRM" : this.loadingOperation != null ? "BUSY" : "NORMAL";
    const path = stripRepositoryControls(this.workbench.selectedPath ?? "no file");
    const dirty = this.workbench.isDirty ? " [modified]" : "";
    const header = fitCell(this.theme.fg("accent", `${interaction} ${view}`) + this.theme.fg("text", `  ${path}${dirty}`), availableWidth);
    const explorer = this.renderExplorer(paneBodyHeight, Math.max(1, explorerWidth - 2));
    const right = this.renderSource(paneBodyHeight, Math.max(1, sourceWidth - 2));
    const explorerBox = renderPaneBox(explorerTitle, explorerWidth, paneHeight, this.theme, explorer, explorerFocused);
    const rightBox = renderPaneBox("SOURCE", sourceWidth, paneHeight, this.theme, right, rightFocused);
    const body = Array.from({ length: paneHeight }, (_, index) => `${explorerBox[index] ?? " ".repeat(explorerWidth)} ${rightBox[index] ?? " ".repeat(sourceWidth)}`);
    const status = fitCell(this.renderStatus(), availableWidth);
    const navigationHelpText = this.noteEditor != null
      ? "NOTE • Enter submits • Shift+Enter newline • Esc cancels"
      : this.bufferEditor == null
        ? "Enter opens/edits • Esc Explorer/Close • Tab panes • ↑/↓ or j/k move"
        : "INSERT • Esc NORMAL • Shift+arrows select • Option/Alt+←/→ words";
    const actionHelpText = this.noteEditor != null
      ? "Maximum 4096 UTF-8 bytes"
      : this.bufferEditor == null
        ? `Ctrl+S save${this.discussEnabled ? " • d discuss" : ""}${this.stories.length > 0 ? " • [/] stories" : ""}`
        : "Cmd+C/X/V • Ctrl+S save • Ctrl+Z undo";
    const navigationHelp = fitCell(this.theme.fg("muted", navigationHelpText), availableWidth);
    const actionHelp = fitCell(this.theme.fg("muted", actionHelpText), availableWidth);
    return renderOuterFrame(frameWidth, totalHeight, this.theme, "code", [header, ...body, status, navigationHelp, actionHelp]);
  }

  invalidate(): void { this.bufferEditor?.invalidate(); }

  private ensureTree(): void {
    const repositoryTree = this.workbench.repositoryTree;
    if (this.tree === repositoryTree) return;
    const selectedKey = this.tree.rows()[this.treeIndex]?.key;
    this.tree = repositoryTree;
    if (this.restoredExplorerState != null) { this.restoreExplorerState(); return; }
    const rows = this.tree.rows();
    const currentFileKey = this.workbench.selectedPath == null ? null : `file:${this.workbench.selectedPath}`;
    const nextIndex = rows.findIndex((row) => row.key === currentFileKey || (currentFileKey == null && row.key === selectedKey));
    this.treeIndex = nextIndex === -1 ? 0 : nextIndex;
    this.treeViewport = Math.min(this.treeViewport, Math.max(0, rows.length - 1));
  }

  private restoreExplorerState(): void {
    if (this.explorerStateTree === this.tree) return;
    this.explorerStateTree = this.tree;
    const state = this.restoredExplorerState;
    if (state == null) return;
    const selectedKey = this.tree.restore(state, state.selectedKey);
    this.treeIndex = this.tree.indexOfKey(selectedKey) ?? 0;
    const topIndex = this.tree.indexOfKey(state.viewport.topKey);
    const offsetFallback = Math.max(0, this.treeIndex - state.viewport.selectedOffset);
    this.treeViewport = topIndex != null && topIndex <= this.treeIndex ? topIndex : offsetFallback;
  }

  private renderExplorer(height: number, width: number): string[] {
    if (this.pane === "file-search" && this.fileSearchRows != null) {
      const rows = this.fileSearchRows;
      this.fileSearchIndex = Math.min(this.fileSearchIndex, Math.max(0, rows.length - 1));
      this.fileSearchViewport = this.followViewport(this.fileSearchIndex, this.fileSearchViewport, rows.length, height);
      return rows.slice(this.fileSearchViewport, this.fileSearchViewport + height).map((row, offset) => this.explorerCell(stripRepositoryControls(row.path), this.fileSearchViewport + offset === this.fileSearchIndex, width));
    }
    const rows = this.tree.rows();
    this.treeIndex = Math.min(this.treeIndex, Math.max(0, rows.length - 1));
    this.treeViewport = this.followViewport(this.treeIndex, this.treeViewport, rows.length, height);
    return rows.slice(this.treeViewport, this.treeViewport + height).map((row, offset) => this.explorerCell(this.formatTreeRow(row), this.treeViewport + offset === this.treeIndex, width));
  }

  private renderSource(height: number, width: number): string[] {
    if (this.noteEditor != null) {
      const rows = this.noteEditor.renderRows(Math.max(0, width - 6), height);
      const numberWidth = Math.max(4, String(rows.at(-1)?.logicalLine ?? 1).length + 1);
      return rows.map((row) => {
        const marker = row.hasCursor ? this.theme.fg("accent", ">") : " ";
        const number = row.continuation ? " ".repeat(numberWidth) : String(row.logicalLine).padStart(numberWidth, " ");
        const gutter = this.theme.bg("selectedBg", `${marker}${number} `);
        return fitCell(`${gutter}${row.text}`, width);
      });
    }
    const highlighted = this.workbench.highlightedLines;
    if (highlighted == null) return [fitCell(this.theme.fg("muted", "Open a file from EXPLORER."), width)];
    const selected = this.workbench.selectedLine ?? 1;
    const selection = this.workbench.selectedRange;
    const numberWidth = Math.max(4, String(highlighted.length).length + 1);
    const gutterWidth = numberWidth + 2;
    const contentWidth = Math.max(0, width - gutterWidth);
    // The card receives a fixed fraction of SOURCE content rows in both NORMAL and INSERT,
    // never prose/file-sized space. NOTE deliberately renders its own editor without a card.
    const cardRows = this.storyIndex == null ? 0 : Math.min(4, Math.floor(height / 4));
    const sourceRows = height - cardRows;

    if (this.bufferEditor != null) {
      const editor = this.bufferEditor;
      const cursorLine = editor.getCursor().line + 1;
      const rows = editor.renderRows(contentWidth, sourceRows, highlighted);
      const rendered = rows.map((row, index) => {
        const activeLine = row.logicalLine === cursorLine;
        const marker = row.hasCursor ? this.theme.fg("accent", ">") : " ";
        const firstVisibleRowForLine = index === 0 || rows[index - 1]?.logicalLine !== row.logicalLine;
        const number = !row.continuation || firstVisibleRowForLine ? String(row.logicalLine).padStart(numberWidth, " ") : " ".repeat(numberWidth);
        const gutterText = `${marker}${number} `;
        const gutter = activeLine ? this.theme.bg("selectedBg", gutterText) : this.theme.fg("muted", gutterText);
        return fitCell(`${gutter}${row.text}`, width);
      });
      return cardRows === 0 ? rendered : [...rendered, ...this.renderStoryCard(cardRows, width)];
    }

    const selectedIndex = Math.max(0, selected - 1);
    const searchQuery = this.bufferHighlightQuery();
    const searchQueryLength = searchQuery?.length ?? 0;
    this.sourceViewport = this.followViewport(selectedIndex, this.sourceViewport, highlighted.length, sourceRows);
    const rows = highlighted.slice(this.sourceViewport, this.sourceViewport + sourceRows).map((line, offset) => {
      const lineNumber = this.sourceViewport + offset + 1;
      const active = lineNumber === selected;
      const marker = active ? this.theme.fg("accent", ">") : " ";
      const gutterText = `${marker}${String(lineNumber).padStart(numberWidth, " ")} `;
      const gutter = active ? this.theme.bg("selectedBg", gutterText) : this.theme.fg("muted", gutterText);
      const match = searchQuery == null ? null : this.bufferMatches.find((candidate) => candidate.line === lineNumber) ?? null;
      const source = match == null
        ? safeSourceLine(line)
        : highlightSourceMatch(safeSourceLine(line), match.column - 1, searchQueryLength, active, this.theme);
      const content = truncateToWidth(source, contentWidth, "…", false);
      const row = fitCell(`${gutter}${content}`, width);
      return selection != null && lineNumber >= selection.startLine && lineNumber <= selection.endLine ? this.theme.bg("selectedBg", row) : row;
    });
    return cardRows === 0 ? rows : [...rows, ...this.renderStoryCard(cardRows, width)];
  }

  private renderStatus(): string {
    const notices: string[] = [];
    if (this.awaitingDirtyChoice) notices.push(this.theme.fg("warning", "Unsaved changes — Save / Discard / Cancel? [s/d/c]"));
    if (this.loadingOperation != null) notices.push(this.theme.fg("muted", this.closeQueued ? "Waiting to close safely…" : `Loading ${this.loadingOperation}…`));
    if (this.error != null) notices.push(this.theme.fg("error", stripRepositoryControls(this.error)));
    if (this.warning != null && this.loadingOperation == null) notices.push(this.theme.fg("warning", stripRepositoryControls(this.warning)));
    if (this.status != null && this.loadingOperation == null) notices.push(this.theme.fg("success", stripRepositoryControls(this.status)));
    if (this.storyIndex != null && Math.min(4, Math.floor(this.lastBodyHeight / 4)) === 0) notices.push(this.theme.fg("muted", this.storyIndicator()));
    if (notices.length > 0) return notices.join(" • ");
    if (this.pane === "file-search") return this.theme.fg("muted", `Find file: ${this.fileSearch || "type path (Esc cancels)"} • ${this.fileSearchRows?.length ?? 0} results`);
    if (this.pane === "buffer-search") return this.renderBufferSearchStatus();
    return this.pane === "source" ? this.bufferNavigationStatus() : this.theme.fg("muted", "Explorer folders/files");
  }

  private formatTreeRow(row: RepositoryTreeRow): string {
    const indent = "  ".repeat(row.depth);
    if (row.type === "folder") return stripRepositoryControls(`${indent}${row.expanded ? "▾" : "▸"} ${row.name}`);
    if (row.type === "more") return stripRepositoryControls(`${indent}… show ${row.remaining} more`);
    return stripRepositoryControls(`${indent}· ${row.name}`);
  }

  private explorerCell(text: string, selected: boolean, width: number): string {
    const content = selected
      ? `${this.theme.fg("accent", "›")} ${this.theme.fg("accent", text)}`
      : `  ${text}`;
    const fitted = fitCell(content, width);
    return selected ? this.theme.bg("selectedBg", fitted) : fitted;
  }

  private followViewport(index: number, viewport: number, total: number, height: number): number {
    if (total <= height) return 0;
    if (index < viewport) return index;
    if (index >= viewport + height) return index - height + 1;
    return Math.min(viewport, total - height);
  }

  private isUp(data: string): boolean { return matchesKey(data, Key.up) || data === "k"; }
  private isDown(data: string): boolean { return matchesKey(data, Key.down) || data === "j"; }
  private isArrowUp(data: string): boolean { return matchesKey(data, Key.up); }
  private isArrowDown(data: string): boolean { return matchesKey(data, Key.down); }

  private handleTreeInput(data: string): void {
    this.ensureTree();
    const rows = this.tree.rows();
    if (this.isUp(data)) this.treeIndex = Math.max(0, this.treeIndex - 1);
    else if (this.isDown(data)) this.treeIndex = Math.min(Math.max(0, rows.length - 1), this.treeIndex + 1);
    else if (matchesKey(data, Key.enter)) { void this.activateTreeRow("toggle"); return; }
    else if (matchesKey(data, Key.right) || data === "l") { void this.activateTreeRow("expand"); return; }
    else if (matchesKey(data, Key.left) || data === "h") { this.moveTreeLeft(); }
    else return;
    this.tui.requestRender();
  }

  private async activateTreeRow(action: "toggle" | "expand"): Promise<void> {
    const row = this.tree.rows()[this.treeIndex];
    if (row == null) return;
    if (row.type === "folder") {
      if (action === "toggle") this.tree.toggleFolder(row.path);
      else this.tree.expandFolder(row.path);
      this.restoreTreeSelection(row.key);
      this.tui.requestRender();
      return;
    }
    if (row.type === "more") {
      this.tree.revealFolder(row.path);
      const rows = this.tree.rows();
      this.treeIndex = Math.min(this.treeIndex, rows.length - 1);
      this.tui.requestRender();
      return;
    }
    await this.openPath(row.path);
  }

  private moveTreeLeft(): void {
    const row = this.tree.rows()[this.treeIndex];
    if (row == null) return;
    if (row.type === "folder" && row.expanded && row.path !== "") {
      this.tree.collapseFolder(row.path);
      this.restoreTreeSelection(row.key);
      return;
    }
    const parent = this.tree.parentFolder(row.path);
    if (parent == null) return;
    const parentIndex = this.tree.rows().findIndex((candidate) => candidate.type === "folder" && candidate.path === parent);
    if (parentIndex >= 0) this.treeIndex = parentIndex;
  }

  private restoreTreeSelection(key: RepositoryTreeRow["key"]): void {
    const index = this.tree.rows().findIndex((row) => row.key === key);
    this.treeIndex = index === -1 ? Math.min(this.treeIndex, this.tree.rows().length - 1) : index;
  }

  private async openPath(path: string): Promise<void> {
    const operation = this.beginLoading("file");
    this.tui.requestRender();
    try {
      const result = await this.workbench.selectFile(path);
      if (!this.isCurrentOperation(operation)) return;
      this.awaitingDirtyChoice = result.status === "confirmation-required";
      if (result.status === "opened") this.enterSourcePane();
      this.error = null;
      this.status = result.status === "opened" ? `Opened ${result.path}` : "Choose what to do with the current buffer.";
    } catch (error) {
      if (this.isCurrentOperation(operation)) this.error = error instanceof Error ? error.message : String(error);
    } finally { if (this.settleLoading(operation)) this.tui.requestRender(); }
  }

  private openFileSearch(): void {
    this.ensureTree();
    this.fileSearchRestore = { index: this.treeIndex, viewport: this.treeViewport };
    this.fileSearch = "";
    this.fileSearchRows = null;
    this.fileSearchIndex = 0;
    this.fileSearchViewport = 0;
    this.pane = "file-search";
    this.error = null;
    this.status = null;
    this.tui.requestRender();
  }

  private openBufferSearch(): void {
    if (this.workbench.bufferText == null) return;
    this.bufferSearchRestore = {
      acceptedQuery: this.acceptedBufferSearch,
      matches: this.bufferMatches,
      text: this.bufferMatchText,
      query: this.bufferMatchQuery,
      capped: this.bufferMatchesCapped,
    };
    this.bufferSearch = "";
    this.pane = "buffer-search";
    this.error = null;
    this.status = null;
    this.tui.requestRender();
  }

  private cancelContextualSearch(): void {
    if (this.pane === "file-search") {
      this.pane = "files";
      if (this.fileSearchRestore != null) {
        this.treeIndex = this.fileSearchRestore.index;
        this.treeViewport = this.fileSearchRestore.viewport;
      }
      this.fileSearchRestore = null;
    } else {
      this.pane = "source";
      if (this.bufferSearchRestore != null) {
        this.acceptedBufferSearch = this.bufferSearchRestore.acceptedQuery;
        this.bufferMatches = this.bufferSearchRestore.matches;
        this.bufferMatchText = this.bufferSearchRestore.text;
        this.bufferMatchQuery = this.bufferSearchRestore.query;
        this.bufferMatchesCapped = this.bufferSearchRestore.capped;
      }
      this.bufferSearchRestore = null;
    }
    this.error = null;
    this.status = null;
    this.tui.requestRender();
  }

  private handleContextualSearchInput(data: string): void {
    const fileSearch = this.pane === "file-search";
    const query = fileSearch ? this.fileSearch : this.bufferSearch;
    if (this.isArrowUp(data)) {
      if (fileSearch) this.fileSearchIndex = Math.max(0, this.fileSearchIndex - 1);
    } else if (this.isArrowDown(data)) {
      if (fileSearch) this.fileSearchIndex = Math.min(Math.max(0, (this.fileSearchRows?.length ?? 0) - 1), this.fileSearchIndex + 1);
    } else if (matchesKey(data, Key.backspace)) {
      this.setContextualQuery(query.slice(0, -1));
    } else if (matchesKey(data, Key.enter)) {
      if (fileSearch) {
        const row = this.fileSearchRows?.[this.fileSearchIndex];
        if (row != null) void this.openPath(row.path);
        else { this.pane = "files"; this.fileSearchRestore = null; }
      } else this.acceptBufferSearch();
      this.tui.requestRender();
      return;
    } else if (data.length === 1 && data >= " ") {
      this.setContextualQuery(query + data);
    } else return;
    this.tui.requestRender();
  }

  private setContextualQuery(query: string): void {
    if (this.pane === "file-search") {
      this.fileSearch = query;
      this.fileSearchRows = query.trim().length === 0 ? null : this.tree.searchFiles(query);
      this.fileSearchIndex = 0;
      this.fileSearchViewport = 0;
    } else {
      this.bufferSearch = query;
      this.cacheBufferMatches(query);
    }
  }

  private cacheBufferMatches(query: string): void {
    const text = this.workbench.bufferText;
    this.bufferMatchText = text;
    this.bufferMatchQuery = query;
    this.bufferMatchesCapped = false;
    if (text == null || query.length === 0) { this.bufferMatches = []; return; }
    // Smart case: all-lowercase queries ignore case; any uppercase makes the literal case-sensitive.
    const sensitive = /[A-Z]/.test(query);
    const needle = sensitive ? query : query.toLowerCase();
    const matches: BufferMatch[] = [];
    const lines = text.split(/\r\n|\r|\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      const column = (sensitive ? line : line.toLowerCase()).indexOf(needle);
      if (column >= 0) {
        if (matches.length === BUFFER_MATCH_CAP) { this.bufferMatchesCapped = true; break; }
        matches.push({ line: index + 1, column: column + 1 });
      }
    }
    this.bufferMatches = matches;
  }

  private ensureBufferMatches(): void {
    if (this.acceptedBufferSearch != null && (this.bufferMatchText !== this.workbench.bufferText || this.bufferMatchQuery !== this.acceptedBufferSearch)) this.cacheBufferMatches(this.acceptedBufferSearch);
  }

  private acceptBufferSearch(): void {
    this.acceptedBufferSearch = this.bufferSearch;
    this.ensureBufferMatches();
    this.bufferSearchRestore = null;
    this.pane = "source";
    this.status = null;
    if (this.bufferMatches.length === 0) { this.error = `No matches for ${this.bufferSearch}.`; return; }
    this.error = null;
    this.workbench.setSelectedLine(this.bufferMatches[0]!.line);
  }

  private navigateBufferMatches(direction: 1 | -1): void {
    if (this.acceptedBufferSearch == null) return;
    this.status = null;
    this.ensureBufferMatches();
    if (this.bufferMatches.length === 0) { this.error = `No matches for ${this.acceptedBufferSearch}.`; this.tui.requestRender(); return; }
    const selected = this.workbench.selectedLine ?? 1;
    let index = this.bufferMatches.findIndex((match) => match.line === selected);
    if (index >= 0) index = (index + direction + this.bufferMatches.length) % this.bufferMatches.length;
    else if (direction === 1) {
      index = this.bufferMatches.findIndex((match) => match.line > selected);
      if (index < 0) index = 0;
    } else {
      index = this.bufferMatches.length - 1;
      while (index >= 0 && this.bufferMatches[index]!.line >= selected) index -= 1;
      if (index < 0) index = this.bufferMatches.length - 1;
    }
    this.workbench.setSelectedLine(this.bufferMatches[index]!.line);
    this.error = null;
    this.status = null;
    this.tui.requestRender();
  }

  private bufferMatchStatus(): string {
    const suffix = this.bufferMatchesCapped ? "+ (capped)" : "";
    return `${this.bufferMatches.length}${suffix} matches`;
  }

  private bufferHighlightQuery(): string | null {
    const query = this.pane === "buffer-search" ? this.bufferSearch : this.acceptedBufferSearch;
    if (query == null || query.length === 0) return null;
    if (this.bufferMatchText !== this.workbench.bufferText || this.bufferMatchQuery !== query) return null;
    return query;
  }

  private renderBufferSearchStatus(): string {
    const query = stripRepositoryControls(this.bufferSearch);
    const value = query.length === 0 ? this.theme.fg("muted", "type text (Esc cancels)") : this.theme.fg("warning", query);
    return `${this.theme.fg("muted", "Find buffer: ")}${value}${this.theme.fg("muted", ` • ${this.bufferMatchStatus()} • Enter, then `)}${this.theme.fg("warning", "n/N")}${this.theme.fg("muted", " next/previous")}`;
  }

  private bufferNavigationStatus(): string {
    if (this.acceptedBufferSearch == null) return this.theme.fg("muted", `source navigation • line ${this.workbench.selectedLine ?? 1}`);
    if (this.bufferMatchText !== this.workbench.bufferText || this.bufferMatchQuery !== this.acceptedBufferSearch) {
      return `${this.theme.fg("muted", "buffer changed • ")}${this.theme.fg("warning", "n/N")}${this.theme.fg("muted", " refresh")}`;
    }
    const selected = this.workbench.selectedLine ?? 1;
    const current = this.bufferMatches.findIndex((match) => match.line === selected);
    const match = current < 0 ? null : this.bufferMatches[current]!;
    const location = `${current + 1 || 0}/${this.bufferMatches.length}${this.bufferMatchesCapped ? "+" : ""} • line ${selected}${match == null ? "" : `, col ${match.column}`}`;
    return `${this.theme.fg("warning", `/${stripRepositoryControls(this.acceptedBufferSearch)}`)}${this.theme.fg("muted", ` • ${location} • `)}${this.theme.fg("warning", "n/N")}${this.theme.fg("muted", " next/previous")}`;
  }

  private storyIndicator(): string {
    if (this.storyIndex == null) return "";
    return `Story ${this.storyIndex + 1}/${this.stories.length}${this.staleStories.has(this.storyIndex) ? " • stale" : ""}`;
  }

  private renderStoryCard(rows: number, width: number): string[] {
    const story = this.storyIndex == null ? null : this.stories[this.storyIndex];
    if (story == null || rows <= 0 || width <= 0) return [];
    const title = `${this.storyIndicator()} • ${stripRepositoryControls(story.id)}`;
    const prose = stripRepositoryControls(story.prose);
    const words = prose.split(/\s+/).filter(Boolean);
    const lines = [title];
    const proseRows = rows - 1;
    let current = "";
    let wordIndex = 0;
    let truncated = false;

    // Bound wrapping before rendering: prose never determines allocation or source viewport size.
    while (wordIndex < words.length) {
      if (lines.length - 1 >= proseRows) { truncated = true; break; }
      const word = words[wordIndex]!;
      if (current.length === 0) {
        if (visibleWidth(word) > width) {
          lines.push(truncateToWidth(word, width, "…", false));
          wordIndex += 1;
          truncated = true;
          break;
        }
        current = word;
        wordIndex += 1;
        continue;
      }
      const next = `${current} ${word}`;
      if (visibleWidth(next) <= width) {
        current = next;
        wordIndex += 1;
        continue;
      }
      lines.push(current);
      current = "";
    }
    if (current.length > 0 && lines.length - 1 < proseRows) lines.push(current);
    if (wordIndex < words.length) truncated = true;

    if (truncated) {
      const lastLine = lines.length > 1 ? lines.length - 1 : 0;
      const existing = lines[lastLine] ?? "";
      // Reserve one cell for the marker so exact-width and many-short-word prose both show it.
      const prefix = truncateToWidth(existing, Math.max(0, width - 1), "", false);
      lines[lastLine] = `${prefix}…`;
    }
    if (lines.length === 1 && words.length > 0) {
      lines[0] = truncateToWidth(`${title} …`, width, "…", false);
    }
    return Array.from({ length: rows }, (_, index) => fitCell(this.theme.fg(index === 0 ? "accent" : "muted", lines[index] ?? ""), width));
  }

  private async activateStory(delta: 1 | -1): Promise<void> {
    const requested = this.storyIndex == null ? (delta > 0 ? 0 : -1) : this.storyIndex + delta;
    if (requested < 0 || requested >= this.stories.length) {
      this.status = requested < 0 ? "Already at the first story." : "Already at the last story.";
      this.tui.requestRender();
      return;
    }
    const story = this.stories[requested]!;
    const operation = this.beginLoading("file");
    this.tui.requestRender();
    try {
      const target = await this.workbench.openTarget(story.target);
      if (!this.isCurrentOperation(operation)) return;
      // openTarget routes cross-file dirty buffers through the normal guard. It can report
      // unreadable while that guard is pending, so inspect the guard before failure handling.
      if (this.workbench.pendingAction?.action === "switch") {
        this.pendingStoryIndex = requested;
        this.awaitingDirtyChoice = true;
        this.status = "Choose what to do with the current buffer.";
        return;
      }
      if (target.status === "missing" || target.status === "unreadable") {
        if (target.status === "missing") this.storyIndex = requested;
        this.error = target.message;
        this.status = null;
        return;
      }
      this.commitStory(requested, target.stale, target.message);
    } catch (error) {
      if (this.isCurrentOperation(operation)) this.error = error instanceof Error ? error.message : String(error);
    } finally { if (this.settleLoading(operation)) this.tui.requestRender(); }
  }

  private commitStory(index: number, stale: boolean, message?: string): void {
    this.storyIndex = index;
    if (stale) this.staleStories.add(index); else this.staleStories.delete(index);
    this.pendingStoryIndex = null;
    this.enterSourcePane();
    this.error = null;
    this.status = message ?? `${this.storyIndicator()} opened.`;
    this.tui.requestRender();
  }

  private beginDiscuss(): void {
    if (this.workbench.selectedPath == null || this.workbench.selectedRange == null) {
      this.error = "Open an available source file before discussing.";
      this.tui.requestRender();
      return;
    }
    this.noteEditor = new WorkbenchBufferEditor("", { maxBytes: 4096 });
    this.noteEditor.focused = this.focused;
    this.error = null;
    this.status = "Optional note (maximum 4096 UTF-8 bytes).";
    this.tui.requestRender();
  }

  private handleNoteInput(data: string): void {
    const editor = this.noteEditor;
    if (editor == null) return;
    if (matchesKey(data, Key.escape)) { this.noteEditor = null; this.status = "Discussion cancelled."; this.tui.requestRender(); return; }
    if (matchesKey(data, Key.shift("enter"))) {
      this.updateNoteEditor(editor.handleInput("\r"));
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const note = editor.getText();
      this.noteEditor = null;
      this.pendingDiscuss = { range: { ...(this.workbench.selectedRange ?? { startLine: 1, endLine: 1 }) }, ...(note.trim().length > 0 ? { note } : {}) };
      this.requestDiscussCompletion();
      return;
    }
    this.updateNoteEditor(editor.handleInput(data));
  }

  private updateNoteEditor(update: { handled: boolean; textChanged: boolean; cursorChanged: boolean }): void {
    if (!update.handled) return;
    if (update.textChanged) this.error = null;
    this.tui.requestRender();
  }

  private requestDiscussCompletion(): void {
    const exit = this.workbench.requestExit();
    if (exit.status === "closed") this.completeDiscuss(exit.changedPaths);
    else { this.awaitingDirtyChoice = true; this.status = "Choose what to do with the current buffer."; this.tui.requestRender(); }
  }

  private completeDiscuss(changedPaths: readonly string[]): void {
    const request = this.pendingDiscuss;
    this.pendingDiscuss = null;
    if (request == null || this.workbench.bufferText == null || this.workbench.selectedPath == null) return;
    const range = clampLineRange(this.workbench.selectedRange ?? request.range, this.workbench.bufferText);
    const target: CodeTarget = { path: this.workbench.selectedPath, range, anchor: hashTargetSlice(this.workbench.bufferText, range) };
    this.complete({ status: "discuss", changedPaths, target, ...(request.note == null ? {} : { note: request.note }) });
  }

  private extendSourceRange(delta: -1 | 1): void {
    const active = this.workbench.selectedLine ?? 1;
    this.rangeAnchorLine ??= active;
    const next = active + delta;
    this.workbench.setSelectedRange({ startLine: Math.min(this.rangeAnchorLine, next), endLine: Math.max(this.rangeAnchorLine, next) }, next);
  }

  private applyBufferEditorUpdate(editor: WorkbenchBufferEditor, update: BufferEditorInputResult): void {
    if (!update.handled) return;
    let deltaRejected = false;
    if (update.textChanged && this.workbench.bufferText !== editor.getText()) {
      try {
        if (update.deltas == null || update.deltas.length === 0) throw new Error("Missing editor delta.");
        this.workbench.applyBufferDeltas(update.deltas, editor.getCursor().line + 1);
      } catch {
        // The editor already owns the exact text; resynchronize explicitly rather than publishing untrusted hints.
        this.workbench.replaceBuffer(editor.getText(), editor.getCursor().line + 1);
        deltaRejected = true;
        this.status = "Editor delta rejected; source resynchronized.";
      }
      this.scheduleLiveHighlight(editor.getByteCount());
      if (this.storyIndex != null && this.stories[this.storyIndex]?.target.path === this.workbench.selectedPath) this.staleStories.add(this.storyIndex);
    }
    if (update.cursorChanged && !update.textChanged) this.workbench.setSelectedLine(editor.getCursor().line + 1, editor.getLineCount());
    if (!deltaRejected) {
      this.status = null;
      this.error = null;
    }
    this.tui.requestRender();
  }

  private copyBufferSelection(editor: WorkbenchBufferEditor, cut: boolean): void {
    const selection = editor.getSelection();
    if (selection == null) {
      this.status = "Select source text before copying or cutting.";
      this.tui.requestRender();
      return;
    }
    this.internalClipboard = selection.text;
    const operation = ++this.clipboardOperationVersion;
    const action = cut ? "Cut" : "Copied";
    if (cut) this.applyBufferEditorUpdate(editor, editor.deleteSelection());
    this.status = `${action} selection.`;
    this.tui.requestRender();
    if (this.clipboard == null) return;
    void Promise.resolve().then(() => this.clipboard?.writeText(selection.text)).then(() => {
      if (this.completed || operation !== this.clipboardOperationVersion) return;
      this.status = `${action} selection.`;
      this.tui.requestRender();
    }).catch((error) => {
      if (this.completed || operation !== this.clipboardOperationVersion) return;
      const message = stripRepositoryControls(error instanceof Error ? error.message : String(error));
      this.status = `${action} selection in /code; system clipboard failed${message.length === 0 ? "." : `: ${message}`}`;
      this.tui.requestRender();
    });
  }

  private beginBufferEdit(): void {
    const text = this.workbench.bufferText;
    if (text == null) { this.error = "Open an available source file before editing."; return; }
    this.pane = "source";
    // Ranges are navigation-only; INSERT always begins at the active singleton line.
    this.workbench.setSelectedLine(this.workbench.selectedLine ?? 1);
    this.rangeAnchorLine = null;
    const editor = new WorkbenchBufferEditor(text, { selectedLine: this.workbench.selectedLine ?? 1 });
    editor.focused = this.focused;
    this.bufferEditor = editor;
    this.error = null;
    this.status = "INSERT mode (whole buffer); Esc returns to NORMAL.";
  }

  private finishBufferEdit(): void {
    if (this.bufferEditor == null) return;
    this.cancelLiveHighlight();
    this.workbench.setSelectedLine(this.bufferEditor.getCursor().line + 1, this.bufferEditor.getLineCount());
    this.bufferEditor = null;
    this.error = null;
    this.status = "Buffer updated; Ctrl+S saves it.";
    this.tui.requestRender();
  }

  private scheduleLiveHighlight(byteCount: number): void {
    this.cancelLiveHighlight();
    if (!this.workbench.supportsSourceHighlighting || byteCount > LIVE_HIGHLIGHT_MAX_BYTES) return;
    const version = this.liveHighlightVersion;
    this.liveHighlightTimer = setTimeout(() => {
      this.liveHighlightTimer = null;
      void this.workbench.refreshHighlight().then(() => {
        if (!this.completed && version === this.liveHighlightVersion) this.tui.requestRender();
      });
    }, LIVE_HIGHLIGHT_DELAY_MS);
  }

  private cancelLiveHighlight(): void {
    this.liveHighlightVersion += 1;
    if (this.liveHighlightTimer != null) clearTimeout(this.liveHighlightTimer);
    this.liveHighlightTimer = null;
  }

  /** Requests the safe dirty-buffer exit used by Escape. */
  requestClose(): void {
    if (this.completed) return;
    if (this.bufferEditor != null) this.finishBufferEdit();
    if (this.loadingOperation != null) {
      const cancellationAlreadyRequested = this.closeQueued;
      this.closeQueued = true;
      this.status = "Waiting for the current operation before closing safely.";
      this.tui.requestRender();
      return;
    }
    const result = this.workbench.requestExit();
    if (result.status === "closed") this.complete(result);
    else {
      this.awaitingDirtyChoice = true;
      this.error = null;
      this.status = "Choose what to do with the current buffer.";
      this.tui.requestRender();
    }
  }

  private async saveBuffer(): Promise<void> {
    this.cancelLiveHighlight();
    const operation = this.beginLoading("save");
    this.error = null;
    this.warning = null;
    this.status = null;
    this.tui.requestRender();
    try {
      const result = await this.workbench.save();
      if (!this.isCurrentOperation(operation)) return;
      if (result.status === "success") {
        this.status = result.effect === "saved" ? `Saved ${this.workbench.selectedPath ?? "source file"}` : "No changes to save.";
        this.warning = result.warning ?? null;
        if (result.warning != null) this.closeQueued = false;
      } else this.error = result.message;
    } finally { if (this.settleLoading(operation)) this.tui.requestRender(); }
  }

  private async resolveDirtyChoice(choice: "save" | "discard" | "cancel"): Promise<void> {
    this.cancelLiveHighlight();
    const operation = this.beginLoading("dirty-choice");
    this.tui.requestRender();
    try {
      const result = await this.workbench.resolveDirtyChoice(choice);
      if (!this.isCurrentOperation(operation)) return;
      if (result.status === "closed") {
        this.awaitingDirtyChoice = false;
        if (this.pendingDiscuss != null) this.completeDiscuss(result.changedPaths);
        else this.complete(result);
      } else if (result.status === "opened") {
        this.awaitingDirtyChoice = false;
        this.enterSourcePane();
        this.error = null;
        this.warning = result.warning ?? null;
        this.status = `Opened ${result.path}`;
        const storyIndex = this.pendingStoryIndex;
        if (storyIndex != null) {
          const target = await this.workbench.openTarget(this.stories[storyIndex]!.target);
          if (target.status === "opened") this.commitStory(storyIndex, target.stale, target.message);
          else { this.pendingStoryIndex = null; this.error = target.message; }
        }
      } else if (result.status === "warning") {
        this.awaitingDirtyChoice = false;
        this.pendingDiscuss = null;
        this.error = null;
        this.warning = result.warning;
        this.status = "Saved committed changes; exit again when ready.";
        this.closeQueued = false;
      } else if (result.status === "cancelled") {
        this.awaitingDirtyChoice = false;
        this.pendingDiscuss = null;
        this.pendingStoryIndex = null;
        this.error = null;
        this.warning = null;
        this.status = "Cancelled; current buffer kept.";
      } else {
        // A failed save leaves the workbench's pending switch intact. Preserve the
        // requested story too, so a later Save or Discard can still commit it.
        this.awaitingDirtyChoice = true;
        this.warning = null;
        this.status = null;
        this.error = result.save.message;
      }
    } catch (error) {
      if (!this.isCurrentOperation(operation)) return;
      // A target read can fail after the dirty action itself has settled. There is
      // then no choice left to resolve; keep the current buffer and surface the
      // target error rather than leaving a dead confirmation prompt.
      if (this.pendingStoryIndex != null && this.workbench.pendingAction == null) {
        this.pendingStoryIndex = null;
        this.awaitingDirtyChoice = false;
      } else this.awaitingDirtyChoice = true;
      this.error = error instanceof Error ? error.message : String(error);
    } finally { if (this.settleLoading(operation)) this.tui.requestRender(); }
  }

  private complete(result: WorkbenchCompletionResult): void {
    if (this.completed) return;
    this.cancelLiveHighlight();
    this.saveExplorerState();
    this.completed = true;
    this.closeQueued = false;
    this.awaitingDirtyChoice = false;
    this.loadingOperation = null;
    this.operationVersion += 1;
    this.done(result);
  }

  private saveExplorerState(): void {
    if (this.explorerState == null) return;
    this.ensureTree();
    const rows = this.tree.rows();
    const selectedIndex = Math.max(0, Math.min(this.treeIndex, Math.max(0, rows.length - 1)));
    const topIndex = Math.max(0, Math.min(this.treeViewport, selectedIndex));
    const selectedKey = rows[selectedIndex]?.key ?? "folder:";
    const topKey = rows[topIndex]?.key ?? selectedKey;
    try {
      this.explorerState.save({
        version: EXPLORER_STATE_VERSION,
        ...this.tree.snapshot(),
        selectedKey,
        viewport: { topKey, selectedOffset: selectedIndex - topIndex },
      });
    } catch {
      // Explorer memory is optional convenience state and must never block safe completion.
    }
  }

  private beginLoading(operation: LoadingOperation): number { this.loadingOperation = operation; return ++this.operationVersion; }
  private isCurrentOperation(operation: number): boolean { return !this.completed && operation === this.operationVersion && this.loadingOperation != null; }
  private settleLoading(operation: number): boolean {
    if (this.completed || !this.isCurrentOperation(operation)) return false;
    this.loadingOperation = null;
    if (this.closeQueued) { this.closeQueued = false; this.requestClose(); return false; }
    return true;
  }

  private enterSourcePane(): void {
    this.pane = "source";
    this.acceptedBufferSearch = null;
    this.bufferMatches = [];
    this.bufferMatchText = null;
    this.bufferMatchQuery = null;
    this.bufferMatchesCapped = false;
    this.bufferSearchRestore = null;
    const selected = Math.max(0, (this.workbench.selectedLine ?? 1) - 1);
    this.sourceViewport = this.followViewport(selected, this.sourceViewport, this.workbench.highlightedLines?.length ?? 0, this.lastBodyHeight);
  }
}

export function createWorkbenchComponent(
  tui: TUI,
  theme: WorkbenchTheme,
  workbench: Workbench,
  done: (result: WorkbenchCompletionResult) => void,
  explorerState?: ExplorerStateSession,
  launch?: WorkbenchLaunch,
  clipboard?: WorkbenchClipboard,
): WorkbenchComponent {
  return new WorkbenchComponent(tui, theme, workbench, done, explorerState, launch, clipboard);
}
