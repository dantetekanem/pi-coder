import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { copyToClipboard, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Editor, type EditorTheme, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { adjustStructuredDiffContext, buildStructuredDiff, getContextExpansionRowIndexes, revealStructuredDiffRows, type ContextExpansionDirection, type StructuredDiff, type StructuredDiffVisibleItem } from "../diff.js";
import { filterReviewFilesByLocale } from "../locale-files.js";
import {
  clampSelectedLineTarget,
  createInitialReviewState,
  deleteComment,
  ensureActiveFile,
  extendSelectedLineTarget,
  getCommentsForFileScope,
  getFileComment,
  getLineComment,
  getLineTargetRange,
  getScopedFiles,
  getSelectedLineTarget,
  hasDraftContent,
  hasSubmittableDraftContent,
  isSubmittableComment,
  moveSelectedCommentIndex,
  moveSelectedLineTarget,
  setActiveFileId,
  setFocus,
  setAllComment,
  setScope,
  setSearchQuery,
  setSelectedLineTarget,
  setWrapLines,
  toggleHideUnchanged,
  upsertFileComment,
  upsertLineComment,
} from "../state.js";
import { detectPiLanguage, highlightCodeLineWithPi } from "../pi-render.js";
import { loadReviewPreferences, saveReviewPreference, type ReviewPaneVisibility } from "../preferences.js";
import { orderNavigatorFiles, type NavigatorFileOrder, type ReviewOrderSignals } from "../review-order.js";
import { createReviewInstanceId, type ReviewSessionData } from "../review-session.js";
import { COMPOSITION_FLUSH_MS } from "../review-composition.js";
import { applyResolvedSeedComments, type ResolvedSeedComment } from "../seed-comments.js";
import { getShortcutConfigPath, getShortcutsForSide, type CommentShortcut } from "../shortcuts.js";
import { filterFilesBySearch } from "../search.js";
import { sanitizeTerminalText } from "../sanitize.js";
import { highlightJsonLine, highlightMarkdownLine } from "../theme-highlight.js";
import type { CommentIntent, DiffReviewComment, ReviewComposition, ReviewCompositionTarget, ReviewContextPanelSource, ReviewExitDisposition, ReviewFile, ReviewFileContents, ReviewFocus, ReviewLineTarget, ReviewRepliesPanelSource, ReviewRepliesSnapshot, ReviewReplyItem, ReviewResult, ReviewResumeReference, ReviewScope, ReviewState, ReviewSubmoduleInfo } from "../types.js";
import { formatIntentLabel, formatScopeLabel, getReviewFileDisplayPath, getSubmoduleInfo, hasExactSubmoduleRange, joinReviewPath } from "../types.js";
import { getReviewFooterHint, getReviewHelpSections, matchesReviewAction } from "./actions.js";
import { openExternalUrl, type UrlOpenResult } from "./open-url.js";
import { ExactTextEditor } from "./exact-text-editor.js";
import { fullScreenOverlayOptions } from "./full-screen-overlay.js";
import { hashTargetSlice, logicalLineCount } from "../workbench/target.js";
import { validateReviewDraftAnchor } from "../adapters/pi/review-bridge.js";

interface LoadedEntryReady {
  status: "ready";
  contents: ReviewFileContents;
  baseDiff: StructuredDiff;
}

interface LoadedEntryError {
  status: "error";
  error: string;
}

interface LoadedEntryLoading {
  status: "loading";
}

type LoadedEntry = LoadedEntryReady | LoadedEntryError | LoadedEntryLoading;

type ContextPanelState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; text: string }
  | { status: "error"; error: string };

type RepliesPanelState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; snapshot: ReviewRepliesSnapshot }
  | { status: "error"; error: string };

type ReplyAnalysisState =
  | { status: "idle" }
  | { status: "loading"; replyId: string }
  | { status: "ready"; replyId: string; text: string }
  | { status: "error"; replyId: string; error: string };

type EditTarget = ReviewCompositionTarget;

interface ReanchorCandidate {
  readonly fileId: string;
  readonly scope: ReviewScope;
  readonly range: Readonly<{ startLine: number; endLine: number }>;
  readonly captureHash: Readonly<NonNullable<DiffReviewComment["captureHash"]>>;
  readonly originalText: string;
}

interface ReanchorTransactionBase {
  commentId: string;
  fileId: string;
  scope: ReviewScope;
  originalComment: Readonly<DiffReviewComment>;
}

type ReanchorTransaction =
  | (ReanchorTransactionBase & { phase: "loading" })
  | (ReanchorTransactionBase & { phase: "selecting" })
  | (ReanchorTransactionBase & {
      phase: "confirm-modify";
      candidate: Readonly<ReanchorCandidate>;
      proposedReplacement: string;
    });

type CommentPanelItem =
  | { kind: "all"; body: string; intent: CommentIntent }
  | { kind: "comment"; comment: DiffReviewComment };

interface ReviewAppOptions {
  files: ReviewFile[];
  repoRoot: string;
  loadFileContents: (repoRoot: string, file: ReviewFile, scope: ReviewScope) => Promise<ReviewFileContents>;
  loadSubmoduleReviewData?: (submodule: ReviewSubmoduleInfo) => Promise<{ repoRoot: string; files: ReviewFile[]; visibleScopes: ReviewScope[] }>;
  commentShortcuts: CommentShortcut[];
  allowEmptySubmit?: boolean;
  visibleScopes?: ReviewScope[];
  seedComments?: ResolvedSeedComment[];
  contextPanelSource?: ReviewContextPanelSource;
  repliesSource?: ReviewRepliesPanelSource;
  orderSignals?: ReviewOrderSignals;
  reviewHeader?: ReviewHeaderInfo;
  initialSession?: ReviewSessionData;
  onSessionChange?: (data: ReviewSessionData) => boolean | void;
  initialComposition?: ReviewComposition;
  onCompositionSave?: (data: ReviewComposition) => boolean;
  onCompositionRemove?: (id: string) => boolean;
  reviewIdentity?: string;
  reviewSessionId?: string;
  reviewScopeFingerprint?: string;
  initialBanner?: string;
  openUrl?: (url: string) => Promise<UrlOpenResult>;
  notify: ExtensionContext["ui"]["notify"];
}

interface ReviewFrame {
  files: ReviewFile[];
  repoRoot: string;
  visibleScopes: ReviewScope[];
  state: ReviewState;
  navigatorScroll: number;
  diffScroll: number;
  commentsScroll: number;
}

interface MousePaneBounds {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

interface MousePaneLayout {
  navigator: MousePaneBounds | null;
  diff: MousePaneBounds | null;
  comments: MousePaneBounds | null;
  context: MousePaneBounds | null;
  replies: MousePaneBounds | null;
}

const SEARCHABLE_SCOPES: ReviewScope[] = ["git-diff", "last-commit", "all-files"];
const DEFAULT_VISIBLE_SCOPES: ReviewScope[] = ["git-diff", "last-commit"];
const DEFAULT_CONTEXT_LINES = 3;
const CONTEXT_EXPANSION_LINES = 10;
const STACKED_LAYOUT_MAX_WIDTH = 99;
const STACKED_CONTEXT_LAYOUT_MAX_WIDTH = 155;
const STACKED_WIDE_PANE_STEP_WIDTH = 56;
const MINIMUM_WIDE_PANE_WIDTH = 24;
const MAXIMUM_WIDE_PANE_WIDTH = 72;
const CONTEXT_PANEL_PADDING_X = 2;
const MAX_LOADED_FILE_ENTRIES = 50;
const MAX_DIFF_LAYOUT_ENTRIES = 100;
const MAX_SYNTAX_LINE_ENTRIES = 5000;
const STATUS_TEXT_MAX_CELLS = 96;
const STATUS_TEXT_MAX_BYTES = 256;
const REVIEW_PANE_ORDER = ["navigator", "diff", "comments", "context", "replies"] as const;
type ReviewPaneName = typeof REVIEW_PANE_ORDER[number];

/** PR context and Replies share the same wide side-pane role and split that space evenly. */
const WIDE_PANE_ORDER: ReviewPaneName[] = ["context", "replies"];

const FOCUSABLE_PANE_ORDER: ReviewFocus[] = ["navigator", "diff", "comments", "context", "replies"];
const SCOPE_KEYS = [Key.alt("1"), Key.alt("2"), Key.alt("3")] as const;
const REVIEW_PANE_LABELS: Record<ReviewPaneName, string> = {
  navigator: "Navigator",
  diff: "Diff",
  comments: "Comments",
  context: "PR context",
  replies: "Replies",
};

export interface ReviewPaneLayout {
  navigatorWidth: number;
  diffWidth: number;
  commentsWidth: number;
  contextWidth: number;
  repliesWidth: number;
}

export interface StackedReviewPaneLayout {
  navigatorHeight: number;
  diffHeight: number;
  commentsHeight: number;
  contextHeight: number;
  repliesHeight: number;
}

export function parseEditorCommand(editorCommand: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let started = false;
  let quote: "single" | "double" | null = null;

  const finish = () => {
    if (!started) return;
    tokens.push(token);
    token = "";
    started = false;
  };

  for (let index = 0; index < editorCommand.length; index += 1) {
    const character = editorCommand[index]!;
    if (quote === "single") {
      if (character === "'") quote = null;
      else token += character;
      continue;
    }
    if (quote === "double") {
      if (character === '"') {
        quote = null;
        continue;
      }
      if (character === "\\") {
        const escaped = editorCommand[++index];
        if (escaped !== '"' && escaped !== "\\") throw new Error('Malformed $EDITOR command: double-quoted escapes accept only \\" and \\\\.');
        token += escaped;
      } else token += character;
      continue;
    }
    if (/\s/.test(character)) {
      finish();
      continue;
    }
    started = true;
    if (character === "'") quote = "single";
    else if (character === '"') quote = "double";
    else if (character === "\\") {
      const escaped = editorCommand[++index];
      if (escaped == null) throw new Error("Malformed $EDITOR command: trailing backslash.");
      token += escaped;
    } else token += character;
  }
  if (quote != null) throw new Error(`Malformed $EDITOR command: unterminated ${quote} quote.`);
  finish();
  return tokens;
}

export function buildEditorLaunchArgs(editorCommand: string, filePath: string, line: number): { command: string; args: string[] } {
  const tokens = parseEditorCommand(editorCommand.trim());
  const command = tokens.shift() || "vi";
  return { command, args: [...tokens, `+${Math.max(1, Math.floor(line))}`, "--", filePath] };
}

export function getEditorLineForTarget(diff: StructuredDiff, target: ReviewLineTarget): number {
  if (target.side === "added") return target.line;

  const rowIndex = diff.rows.findIndex((row) => row.oldLineNumber === target.line);
  if (rowIndex < 0) return target.line;

  const selectedRow = diff.rows[rowIndex]!;
  if (selectedRow.newLineNumber != null) return selectedRow.newLineNumber;

  for (let index = rowIndex + 1; index < diff.rows.length; index += 1) {
    const line = diff.rows[index]!.newLineNumber;
    if (line != null) return line;
  }

  for (let index = rowIndex - 1; index >= 0; index -= 1) {
    const line = diff.rows[index]!.newLineNumber;
    if (line != null) return line;
  }

  return 1;
}

export function getHalfPageStep(visibleRows: number): number {
  return Math.max(1, Math.floor(visibleRows / 2));
}

export function shouldStackPanes(frameInnerWidth: number): boolean {
  return frameInnerWidth <= STACKED_LAYOUT_MAX_WIDTH;
}

export function shouldStackPanesWithContext(frameInnerWidth: number, contextVisible: boolean): boolean {
  return shouldStackPanes(frameInnerWidth) || (contextVisible && frameInnerWidth <= STACKED_CONTEXT_LAYOUT_MAX_WIDTH);
}

export function countVisibleWidePanes(visibility: ReviewPaneVisibility): number {
  return WIDE_PANE_ORDER.filter((pane) => visibility[pane]).length;
}

/**
 * Each extra wide pane needs its own readable column, so the side-by-side breakpoint moves up
 * with every visible wide pane instead of squeezing five panes into a laptop terminal.
 */
export function shouldStackPanesForVisibility(frameInnerWidth: number, visibility: ReviewPaneVisibility): boolean {
  const wideCount = countVisibleWidePanes(visibility);
  if (wideCount === 0) return shouldStackPanes(frameInnerWidth);
  const threshold = STACKED_CONTEXT_LAYOUT_MAX_WIDTH + (wideCount - 1) * (STACKED_WIDE_PANE_STEP_WIDTH + 1);
  return shouldStackPanes(frameInnerWidth) || frameInnerWidth <= threshold;
}

export function getPaneLayout(frameInnerWidth: number, commentsHidden: boolean): { navigatorWidth: number; diffWidth: number; commentsWidth: number } {
  const sideWidth = Math.max(24, Math.min(36, Math.floor(frameInnerWidth * 0.26)));
  if (commentsHidden) {
    return {
      navigatorWidth: sideWidth,
      diffWidth: Math.max(24, frameInnerWidth - sideWidth - 1),
      commentsWidth: 0,
    };
  }

  return {
    navigatorWidth: sideWidth,
    commentsWidth: sideWidth,
    diffWidth: Math.max(24, frameInnerWidth - sideWidth * 2 - 2),
  };
}

export function getPaneLayoutWithContext(frameInnerWidth: number, commentsHidden: boolean, contextVisible: boolean): { navigatorWidth: number; diffWidth: number; commentsWidth: number; contextWidth: number } {
  const base = getPaneLayout(frameInnerWidth, commentsHidden);
  if (!contextVisible || commentsHidden) return { ...base, contextWidth: 0 };

  const navigatorWidth = Math.max(20, Math.min(32, base.navigatorWidth));
  const commentsWidth = navigatorWidth;
  const contextWidth = getWidePaneWidth(frameInnerWidth, navigatorWidth, 1);
  return {
    navigatorWidth,
    commentsWidth,
    contextWidth,
    diffWidth: Math.max(24, frameInnerWidth - navigatorWidth - commentsWidth - contextWidth - 3),
  };
}

/** Every wide pane gets the same width so PR context and Replies stay visually equal. */
function getWidePaneWidth(frameInnerWidth: number, navigatorWidth: number, wideCount: number): number {
  const minimumDiffWidth = 48;
  const separators = wideCount + 2;
  const readable = Math.floor((frameInnerWidth - navigatorWidth - minimumDiffWidth - separators) / (wideCount + 1));
  return Math.max(MINIMUM_WIDE_PANE_WIDTH, Math.min(MAXIMUM_WIDE_PANE_WIDTH, readable));
}

export function getPaneLayoutForVisibility(frameInnerWidth: number, visibility: ReviewPaneVisibility): ReviewPaneLayout {
  const wideCount = countVisibleWidePanes(visibility);
  const narrowBase = getPaneLayout(frameInnerWidth, !visibility.comments);
  const navigatorWidth = wideCount === 0 ? narrowBase.navigatorWidth : Math.max(20, Math.min(32, narrowBase.navigatorWidth));
  const commentsWidth = wideCount === 0 ? narrowBase.commentsWidth : navigatorWidth;
  const wideWidth = wideCount === 0 ? 0 : getWidePaneWidth(frameInnerWidth, navigatorWidth, wideCount);
  const usedSideWidth = (visibility.navigator ? navigatorWidth : 0) + (visibility.comments ? commentsWidth : 0) + wideCount * wideWidth;

  const layout: ReviewPaneLayout = {
    navigatorWidth: visibility.navigator ? navigatorWidth : 0,
    diffWidth: 0,
    commentsWidth: visibility.comments ? commentsWidth : 0,
    contextWidth: visibility.context ? wideWidth : 0,
    repliesWidth: visibility.replies ? wideWidth : 0,
  };
  const visiblePanes = REVIEW_PANE_ORDER.filter((pane) => visibility[pane]);
  if (visiblePanes.length === 0) return layout;

  const separators = visiblePanes.length - 1;
  if (visibility.diff) layout.diffWidth = Math.max(24, frameInnerWidth - usedSideWidth - separators);

  const usedWidth = visiblePanes.reduce((total, pane) => total + layout[`${pane}Width`], 0) + separators;
  const primaryPane = visiblePanes.includes("diff")
    ? "diff"
    : visiblePanes.includes("context")
      ? "context"
      : visiblePanes[0]!;
  layout[`${primaryPane}Width`] += Math.max(0, frameInnerWidth - usedWidth);
  return layout;
}

export function getStackedPaneLayout(bodyHeight: number, commentsHidden: boolean): { navigatorHeight: number; diffHeight: number; commentsHeight: number } {
  const safeBodyHeight = Math.max(commentsHidden ? 6 : 9, Math.floor(bodyHeight));
  const minimums = commentsHidden ? [3, 3] : [3, 3, 3];
  const weights = commentsHidden ? [1, 2] : [1, 2, 1];
  const heights = [...minimums];
  let remaining = safeBodyHeight - heights.reduce((sum, height) => sum + height, 0);

  while (remaining > 0) {
    let selectedIndex = 0;
    for (let index = 1; index < weights.length; index += 1) {
      if (heights[index]! / weights[index]! < heights[selectedIndex]! / weights[selectedIndex]!) {
        selectedIndex = index;
      }
    }
    heights[selectedIndex]! += 1;
    remaining -= 1;
  }

  return {
    navigatorHeight: heights[0]!,
    diffHeight: heights[1]!,
    commentsHeight: commentsHidden ? 0 : heights[2]!,
  };
}

export function getStackedPaneLayoutWithContext(bodyHeight: number, commentsHidden: boolean, contextVisible: boolean): { navigatorHeight: number; diffHeight: number; commentsHeight: number; contextHeight: number } {
  if (!contextVisible || commentsHidden) return { ...getStackedPaneLayout(bodyHeight, commentsHidden), contextHeight: 0 };

  const safeBodyHeight = Math.max(12, Math.floor(bodyHeight));
  const minimums = [3, 3, 3, 3];
  const weights = [1, 2, 1, 1];
  const heights = [...minimums];
  let remaining = safeBodyHeight - heights.reduce((sum, height) => sum + height, 0);

  while (remaining > 0) {
    let selectedIndex = 0;
    for (let index = 1; index < weights.length; index += 1) {
      if (heights[index]! / weights[index]! < heights[selectedIndex]! / weights[selectedIndex]!) {
        selectedIndex = index;
      }
    }
    heights[selectedIndex]! += 1;
    remaining -= 1;
  }

  return {
    navigatorHeight: heights[0]!,
    diffHeight: heights[1]!,
    commentsHeight: heights[2]!,
    contextHeight: heights[3]!,
  };
}

export function getStackedPaneLayoutForVisibility(bodyHeight: number, visibility: ReviewPaneVisibility, minimumPaneHeight = 3): StackedReviewPaneLayout {
  const visiblePanes = REVIEW_PANE_ORDER.filter((pane) => visibility[pane]);
  const layout: StackedReviewPaneLayout = {
    navigatorHeight: 0,
    diffHeight: 0,
    commentsHeight: 0,
    contextHeight: 0,
    repliesHeight: 0,
  };
  if (visiblePanes.length === 0) return layout;

  const paneMinimum = Math.max(1, Math.floor(minimumPaneHeight));
  const safeBodyHeight = Math.max(visiblePanes.length * paneMinimum, Math.floor(bodyHeight));
  for (const pane of visiblePanes) layout[`${pane}Height`] = paneMinimum;
  let remaining = safeBodyHeight - visiblePanes.length * paneMinimum;
  while (remaining > 0) {
    let selectedPane = visiblePanes[0]!;
    for (const pane of visiblePanes.slice(1)) {
      const paneWeight = pane === "diff" ? 2 : 1;
      const selectedWeight = selectedPane === "diff" ? 2 : 1;
      if (layout[`${pane}Height`] / paneWeight < layout[`${selectedPane}Height`] / selectedWeight) selectedPane = pane;
    }
    layout[`${selectedPane}Height`] += 1;
    remaining -= 1;
  }
  return layout;
}

export type MouseWheelDirection = "up" | "down";

export interface MouseWheelEvent {
  direction: MouseWheelDirection;
  col: number;
  row: number;
}

export function parseMouseWheelInput(data: string): MouseWheelEvent | null {
  const match = data.match(/^\x1b\[<(\d+);(\d+);(\d+)[Mm]$/);
  if (match == null) return null;

  const button = Number.parseInt(match[1]!, 10);
  if ((button & 64) === 0) return null;

  const wheelButton = button & 3;
  if (wheelButton !== 0 && wheelButton !== 1) return null;

  return {
    direction: wheelButton === 0 ? "up" : "down",
    col: Number.parseInt(match[2]!, 10),
    row: Number.parseInt(match[3]!, 10),
  };
}

type PaneName = ReviewFocus;

type RelatedFileMarker = "→" | "←" | "↔";

export interface RelatedFilePanelSection {
  title: string;
  paths: string[];
}

export function getRelatedFilePaths(file: ReviewFile | null): Set<string> {
  return new Set([
    ...(file?.allFilesOutgoingReferences ?? []),
    ...(file?.allFilesIncomingReferences ?? []),
  ]);
}

export function getRelatedFilePanelSections(file: ReviewFile | null, scope: ReviewScope): RelatedFilePanelSection[] {
  if (file == null || scope !== "all-files") return [];

  const outgoing = [...new Set(file.allFilesOutgoingReferences ?? [])].sort((a, b) => a.localeCompare(b));
  const incoming = [...new Set(file.allFilesIncomingReferences ?? [])].sort((a, b) => a.localeCompare(b));
  const sections: RelatedFilePanelSection[] = [];

  if (outgoing.length > 0) sections.push({ title: "Imports changed files", paths: outgoing });
  if (incoming.length > 0) sections.push({ title: "Imported by changed files", paths: incoming });

  return sections;
}

export function getRelatedFileMarker(file: ReviewFile, activeFile: ReviewFile | null, scope: ReviewScope): RelatedFileMarker | null {
  if (activeFile == null || scope !== "all-files" || file.id === activeFile.id) return null;
  const outgoing = new Set(activeFile.allFilesOutgoingReferences ?? []).has(file.path);
  const incoming = new Set(activeFile.allFilesIncomingReferences ?? []).has(file.path);
  if (outgoing && incoming) return "↔";
  if (outgoing) return "→";
  if (incoming) return "←";
  return null;
}

export type ReviewAppTheme = Parameters<ExtensionContext["ui"]["custom"]>[0] extends (tui: any, theme: infer T, kb: any, done: any) => any ? T : never;
type Theme = ReviewAppTheme;

function repeat(char: string, count: number): string {
  return count <= 0 ? "" : char.repeat(count);
}

export function setBoundedMapEntry<K, V>(map: Map<K, V>, key: K, value: V, maximumSize: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > Math.max(1, maximumSize)) {
    const oldestKey = map.keys().next().value as K | undefined;
    if (oldestKey === undefined) break;
    map.delete(oldestKey);
  }
}

export function getMeasuredPageRange(itemHeights: number[], selectedIndex: number, currentStart: number, viewportHeight: number): { start: number; end: number } {
  if (itemHeights.length === 0) return { start: 0, end: 0 };
  const selected = Math.max(0, Math.min(itemHeights.length - 1, selectedIndex));
  let start = Math.max(0, Math.min(selected, currentStart));
  const selectedHeight = () => itemHeights.slice(start, selected + 1).reduce((total, height) => total + Math.max(1, height), 0);
  while (start < selected && selectedHeight() > Math.max(1, viewportHeight)) start += 1;
  let end = start;
  let usedHeight = 0;
  while (end < itemHeights.length) {
    const height = Math.max(1, itemHeights[end]!);
    if (end > start && usedHeight + height > Math.max(1, viewportHeight)) break;
    usedHeight += height;
    end += 1;
  }
  return { start, end: Math.max(start + 1, end) };
}

export function getStableDiffScroll(currentScroll: number, viewportHeight: number, selectedStart: number, selectedEnd: number): number {
  const height = Math.max(1, viewportHeight);
  const current = Math.max(0, currentScroll);
  const start = Math.max(0, selectedStart);
  const end = Math.max(start + 1, selectedEnd);
  if (start >= current && end <= current + height) return current;
  const selectionHeight = end - start;
  if (selectionHeight >= height) return start;
  const rowsBeforeSelection = Math.floor((height - selectionHeight) / 2);
  return Math.max(0, start - rowsBeforeSelection);
}

export function getRowOffsets(rowHeights: number[]): number[] {
  const offsets = [0];
  for (const height of rowHeights) offsets.push(offsets[offsets.length - 1]! + Math.max(1, height));
  return offsets;
}

export function getVirtualRowRange(rowHeights: number[], scroll: number, viewportHeight: number, overscan: number, cachedOffsets?: number[]): { startRow: number; endRow: number; startOffset: number; offsets: number[] } {
  const offsets = cachedOffsets?.length === rowHeights.length + 1 ? cachedOffsets : getRowOffsets(rowHeights);
  const startTarget = Math.max(0, scroll - Math.max(0, overscan));
  const endTarget = Math.max(startTarget, scroll + Math.max(1, viewportHeight) + Math.max(0, overscan));
  let low = 0;
  let high = rowHeights.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (offsets[middle + 1]! <= startTarget) low = middle + 1;
    else high = middle;
  }
  const startRow = low;
  low = startRow;
  high = rowHeights.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (offsets[middle]! < endTarget) low = middle + 1;
    else high = middle;
  }
  const endRow = low;
  return { startRow, endRow, startOffset: offsets[startRow] ?? 0, offsets };
}

function padLine(text: string, width: number): string {
  const truncated = truncateToWidth(text, width, "", true);
  const padding = Math.max(0, width - visibleWidth(truncated));
  return truncated + " ".repeat(padding);
}

function wrapAnsiText(text: string, width: number, wrapLines: boolean): string[] {
  const safeWidth = Math.max(1, width);
  if (!wrapLines) return [truncateToWidth(text, safeWidth, "…", false)];
  const wrapped = wrapTextWithAnsi(text, safeWidth).map((line) => truncateToWidth(line, safeWidth, "", false));
  return wrapped.length > 0 ? wrapped : [""];
}

function getScopeComparison(file: ReviewFile | null, scope: ReviewScope) {
  if (file == null) return null;
  if (scope === "git-diff") return file.gitDiff;
  if (scope === "last-commit") return file.lastCommit;
  return file.allFiles;
}

function getScopeDisplayPath(file: ReviewFile | null, scope: ReviewScope): string {
  return sanitizeTerminalText(getReviewFileDisplayPath(file, scope));
}

function getStatusLabel(file: ReviewFile | null, scope: ReviewScope): string {
  const status = getScopeComparison(file, scope)?.status ?? file?.worktreeStatus;
  switch (status) {
    case "added": return "A";
    case "deleted": return "D";
    case "renamed": return "R";
    case "modified": return "M";
    default: return "·";
  }
}

function getChangeCountLabel(theme: Theme, file: ReviewFile, scope: ReviewScope): string {
  const comparison = getScopeComparison(file, scope);
  const additions = comparison?.additions;
  const deletions = comparison?.deletions;
  if (additions == null && deletions == null) return "";
  const safeAdditions = additions ?? 0;
  const safeDeletions = deletions ?? 0;
  if (safeAdditions === 0 && safeDeletions === 0) return "";
  return ` ${theme.fg("success", `+${safeAdditions}`)} ${theme.fg("error", `-${safeDeletions}`)}`;
}

function getFileCommentCount(state: ReviewState, fileId: string, scope: ReviewScope): number {
  return state.draft.comments.filter((comment) => comment.fileId === fileId && comment.scope === scope).length;
}

function getLineCommentIndex(state: ReviewState, fileId: string, scope: ReviewScope): Map<string, DiffReviewComment> {
  const index = new Map<string, DiffReviewComment>();
  for (const comment of state.draft.comments) {
    if (comment.fileId !== fileId || comment.scope !== scope || comment.side === "file" || comment.startLine == null) continue;
    const endLine = comment.endLine ?? comment.startLine;
    for (let line = comment.startLine; line <= endLine; line += 1) index.set(`${comment.side}:${line}`, comment);
  }
  return index;
}

function getCommentPanelItems(state: ReviewState, fileId: string | null, scope: ReviewScope, global = false): CommentPanelItem[] {
  const items: CommentPanelItem[] = [];
  if (state.draft.allComment.trim().length > 0) {
    items.push({ kind: "all", body: state.draft.allComment.trim(), intent: state.draft.allIntent });
  }
  const comments = global
    ? [...state.draft.comments].sort((left, right) => left.fileId.localeCompare(right.fileId)
        || left.scope.localeCompare(right.scope)
        || (left.startLine ?? -1) - (right.startLine ?? -1))
    : fileId == null
      ? []
      : getCommentsForFileScope(state, fileId, scope);
  for (const comment of comments) items.push({ kind: "comment", comment });
  return items;
}

function getIntentBadge(theme: Theme, intent: CommentIntent): string {
  const text = `[${formatIntentLabel(intent)}]`;
  if (intent === "modify") return theme.fg("accent", text);
  if (intent === "comment") return theme.fg("success", text);
  return theme.fg("warning", text);
}

function getCommentIndicator(theme: Theme, intent: CommentIntent): string {
  if (intent === "modify") return theme.fg("accent", "\u25cf");
  if (intent === "comment") return theme.fg("success", "\u25a0");
  return theme.fg("warning", "\u25c6");
}

function formatLineSideLabel(side: ReviewLineTarget["side"]): string {
  return side === "deleted" ? "Deleted" : "Added";
}

function formatLineRangeLabel(startLine: number, endLine: number): string {
  return startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`;
}

function sanitizeStatusText(text: string): string {
  const singleLine = text.replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, " ");
  const cellBound = truncateToWidth(singleLine, STATUS_TEXT_MAX_CELLS, "…", false)
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, "");
  let result = "";
  let byteLength = 0;
  for (const character of cellBound) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (byteLength + characterBytes > STATUS_TEXT_MAX_BYTES) break;
    result += character;
    byteLength += characterBytes;
  }
  return result;
}

export type SelectionClipboardFormat = "source" | "location" | "patch" | "suggestion";

export function isUnchangedModify(originalText: string | undefined, replacementText: string): boolean {
  return originalText != null && originalText === replacementText;
}

function appendPreviewLines(lines: string[], text: string, prefix: "-" | "+", maximumLines: number): void {
  let start = 0;
  while (lines.length < maximumLines) {
    const nextCr = text.indexOf("\r", start);
    const nextLf = text.indexOf("\n", start);
    const end = nextCr < 0 ? nextLf : nextLf < 0 ? nextCr : Math.min(nextCr, nextLf);
    if (end < 0) {
      lines.push(`${prefix} ${text.slice(start)}`);
      return;
    }
    lines.push(`${prefix} ${text.slice(start, end)}`);
    start = text[end] === "\r" && text[end + 1] === "\n" ? end + 2 : end + 1;
  }
}

export function buildModifyPreviewLines(originalText: string, replacementText: string, maximumLines = 8): string[] {
  const limit = Math.max(1, maximumLines);
  const lines: string[] = [];
  appendPreviewLines(lines, originalText, "-", limit);
  if (replacementText.length > 0 && lines.length < limit) appendPreviewLines(lines, replacementText, "+", limit);
  return lines;
}

export function getSourceLineRangeText(content: string, startLine: number, endLine: number): string {
  const parts = content.split(/(\r\n|\n|\r)/);
  const lines: Array<{ text: string; ending: string }> = [];
  for (let index = 0; index < parts.length; index += 2) {
    lines.push({ text: parts[index] ?? "", ending: parts[index + 1] ?? "" });
  }
  const selected = lines.slice(Math.max(0, startLine - 1), Math.max(startLine, endLine));
  return selected.map((line, index) => `${line.text}${index < selected.length - 1 ? line.ending : ""}`).join("");
}

export function buildSelectionClipboardText(
  format: SelectionClipboardFormat,
  path: string,
  target: ReviewLineTarget,
  sourceText: string,
  comment?: DiffReviewComment,
): string {
  const range = getLineTargetRange(target);
  const rangeLabel = formatLineRangeLabel(range.startLine, range.endLine);
  if (format === "source") return sourceText;
  if (format === "location") return `${path}:${rangeLabel}`;

  const modifyComment = comment?.intent === "modify" ? comment : undefined;
  const replacementText = modifyComment?.body ?? sourceText;
  if (format === "suggestion") return `\`\`\`suggestion\n${replacementText}\n\`\`\``;

  const lines = [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ ${target.side} ${range.startLine === range.endLine ? "line" : "lines"} ${rangeLabel} @@`,
  ];
  if (modifyComment?.originalText != null) {
    for (const line of modifyComment.originalText.split(/\r?\n/)) lines.push(`-${line}`);
    for (const line of replacementText.split(/\r?\n/)) lines.push(`+${line}`);
  } else {
    const prefix = target.side === "deleted" ? "-" : "+";
    for (const line of sourceText.split(/\r?\n/)) lines.push(`${prefix}${line}`);
  }
  return lines.join("\n");
}

function getPanelItemLabel(theme: Theme, item: CommentPanelItem): string {
  if (item.kind === "all") return `${getIntentBadge(theme, item.intent)} All note`;
  if (item.comment.side === "file") return `${getIntentBadge(theme, item.comment.intent)} ${item.comment.fileTarget === "all-lines" ? "All-lines comment" : "File comment"}`;
  return `${getIntentBadge(theme, item.comment.intent)} ${formatLineSideLabel(item.comment.side)} line ${formatLineRangeLabel(item.comment.startLine ?? 0, item.comment.endLine ?? item.comment.startLine ?? 0)}`;
}

export function getDraftCommentCount(state: ReviewState): number {
  return state.draft.comments.length + (state.draft.allComment.trim().length > 0 ? 1 : 0);
}

export function getCancelAction(state: ReviewState, reviewedCount = 0): "cancel" | "confirm" {
  return hasDraftContent(state) || reviewedCount > 0 ? "confirm" : "cancel";
}

function centerText(text: string, width: number): string {
  const clean = truncateToWidth(text, width, "", false);
  const remaining = Math.max(0, width - visibleWidth(clean));
  const left = Math.floor(remaining / 2);
  return `${" ".repeat(left)}${clean}`;
}

const MONOREPO_GROUP_ROOTS = new Set(["apps", "areas", "modules", "packages", "services"]);

export interface ReviewHeaderInfo {
  identity: string;
  title?: string;
  state?: string;
  revision?: string;
  queue?: { position: number; total?: number };
  openThreads?: number;
  awaitingReply?: number;
}

export interface ReviewHeaderCounts {
  files: number;
  reviewed: number;
  comments: number;
}

const HEADER_TITLE_WIDTH = 40;

function shortHeaderRevision(revision: string): string {
  return /^[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(revision) ? revision.slice(0, 7) : revision;
}

export function buildReviewHeaderText(info: ReviewHeaderInfo, counts: ReviewHeaderCounts): string {
  const parts = [info.identity];
  if (info.title != null && info.title.length > 0) parts.push(truncateToWidth(info.title, HEADER_TITLE_WIDTH, "…", false));
  if (info.state != null && info.state.length > 0) parts.push(info.state);
  if (info.queue != null) parts.push(`queue ${info.queue.position}${info.queue.total == null ? "" : `/${info.queue.total}`}`);
  if (info.revision != null && info.revision.length > 0) parts.push(`@${shortHeaderRevision(info.revision)}`);
  parts.push(`${counts.reviewed}/${counts.files} reviewed`);
  parts.push(`${counts.comments} comment${counts.comments === 1 ? "" : "s"}`);
  if (info.openThreads != null) {
    const awaiting = info.awaitingReply == null || info.awaitingReply === 0 ? "" : `, ${info.awaitingReply} awaiting reply`;
    parts.push(`${info.openThreads} open thread${info.openThreads === 1 ? "" : "s"}${awaiting}`);
  }
  return parts.join(" • ");
}

export function buildReviewHeaderLine(theme: Theme, width: number, info: ReviewHeaderInfo, counts: ReviewHeaderCounts): string {
  return theme.fg("muted", truncateToWidth(sanitizeTerminalText(buildReviewHeaderText(info, counts)), Math.max(1, width), "…", false));
}

export function getNavigatorGroup(file: ReviewFile): string {
  if (file.pathPrefix != null && file.pathPrefix.length > 0) return file.pathPrefix;
  const parts = file.path.split("/").filter(Boolean);
  if (parts.length === 0) return "root";
  if (parts.length > 1 && MONOREPO_GROUP_ROOTS.has(parts[0]!)) return `${parts[0]}/${parts[1]}`;
  return parts.length === 1 ? "root" : parts[0]!;
}

export function groupNavigatorFiles(files: ReviewFile[]): ReviewFile[] {
  return [...files].sort((left, right) => {
    const groupOrder = getNavigatorGroup(left).localeCompare(getNavigatorGroup(right));
    return groupOrder !== 0 ? groupOrder : left.path.localeCompare(right.path);
  });
}

export function shortenNavigatorPath(path: string, maxWidth: number): string {
  const safeWidth = Math.max(1, maxWidth);
  if (visibleWidth(path) <= safeWidth) return path;

  const parts = path.split("/").filter((part) => part.length > 0);
  const baseName = parts[parts.length - 1] ?? path;
  if (parts.length <= 1) {
    return truncateToWidth(baseName, safeWidth, "…", false);
  }

  let suffix = baseName;
  for (let index = parts.length - 2; index >= 0; index -= 1) {
    const nextSuffix = `${parts[index]}/${suffix}`;
    if (visibleWidth(`…/${nextSuffix}`) > safeWidth) break;
    suffix = nextSuffix;
  }

  const candidate = `…/${suffix}`;
  if (visibleWidth(candidate) <= safeWidth) return candidate;
  return truncateToWidth(baseName, safeWidth, "…", false);
}

export function formatPaneTitle(title: string, focused: boolean): string {
  return focused ? `▶ ${title}` : title;
}

export function formatFocusStatus(focus: ReviewState["focus"]): string {
  switch (focus) {
    case "navigator": return "Focus: Navigator";
    case "diff": return "Focus: Diff";
    case "comments": return "Focus: Comments";
    case "context": return "Focus: PR context";
    case "replies": return "Focus: Replies";
  }
}

function renderBox(title: string, width: number, height: number, theme: Theme, lines: string[], focused = false): string[] {
  const innerWidth = Math.max(1, width - 2);
  const safeHeight = Math.max(1, Math.floor(height));
  const innerHeight = Math.max(0, safeHeight - 2);
  const titleText = truncateToWidth(` ${formatPaneTitle(title, focused)} `, Math.max(1, innerWidth - 2), "", false);
  const leftPad = Math.max(0, Math.floor((innerWidth - visibleWidth(titleText)) / 2));
  const rightPad = Math.max(0, innerWidth - visibleWidth(titleText) - leftPad);
  const borderColor = focused ? "accent" : "border";
  const top = theme.fg(borderColor, `┌${repeat("─", leftPad)}${titleText}${repeat("─", rightPad)}┐`);
  const bottom = theme.fg(borderColor, `└${repeat("─", innerWidth)}┘`);
  if (safeHeight === 1) return [top];
  if (safeHeight === 2) return [top, bottom];

  const body: string[] = [];
  for (let i = 0; i < innerHeight; i += 1) {
    const line = padLine(lines[i] ?? "", innerWidth);
    body.push(`${theme.fg(borderColor, "│")}${line}${theme.fg(borderColor, "│")}`);
  }

  return [top, ...body, bottom];
}

const MODAL_INNER_PADDING_X = 2;
const MODAL_INNER_PADDING_Y = 1;

function renderOuterFrame(
  width: number,
  height: number,
  theme: Theme,
  title: string,
  lines: string[],
  color: "accent" | "border" | "borderMuted" = "accent",
  paddingX = MODAL_INNER_PADDING_X,
  paddingY = MODAL_INNER_PADDING_Y,
): string[] {
  const innerWidth = Math.max(1, width - 2);
  const innerHeight = Math.max(1, height - 2);
  const contentWidth = Math.max(1, innerWidth - paddingX * 2);
  const contentHeight = Math.max(1, innerHeight - paddingY * 2);
  const titleText = truncateToWidth(` ${title} `, Math.max(1, innerWidth - 2), "", false);
  const leftPad = 1;
  const rightPad = Math.max(0, innerWidth - visibleWidth(titleText) - leftPad);
  const top = theme.fg(color, `┌${repeat("─", leftPad)}${titleText}${repeat("─", rightPad)}┐`);
  const bottom = theme.fg(color, `└${repeat("─", innerWidth)}┘`);
  const body: string[] = [];
  const sidePadding = " ".repeat(paddingX);

  for (let i = 0; i < innerHeight; i += 1) {
    let line = "";
    if (i >= paddingY && i < paddingY + contentHeight) {
      line = `${sidePadding}${padLine(lines[i - paddingY] ?? "", contentWidth)}${sidePadding}`;
    } else {
      line = " ".repeat(innerWidth);
    }
    body.push(`${theme.fg(color, "│")}${line}${theme.fg(color, "│")}`);
  }

  return [top, ...body, bottom];
}

const FOOTER_ACTION_HINT = getReviewFooterHint();
const HELP_KEY_SECTIONS = getReviewHelpSections();

function pushWrappedAnsiText(lines: string[], text: string, width: number, prefix = ""): void {
  const availableWidth = Math.max(1, width - visibleWidth(prefix));
  const wrapped = wrapAnsiText(text, availableWidth, true);
  for (const line of wrapped) {
    lines.push(`${prefix}${line}`);
  }
}

function pushWrappedText(lines: string[], theme: Theme, text: string, width: number, color: "muted" | "dim" = "muted", prefix = ""): void {
  pushWrappedAnsiText(lines, theme.fg(color, sanitizeTerminalText(text)), width, prefix);
}

export function buildCommentPanelTextLines(theme: Theme, width: number, text: string, color: "muted" | "dim" = "muted", prefix = "", maxLines?: number): string[] {
  const lines: string[] = [];
  const contentWidth = Math.max(1, width - 2);
  pushWrappedText(lines, theme, text, contentWidth, color, prefix);
  return maxLines == null ? lines : lines.slice(0, Math.max(0, maxLines));
}

export function buildCommentPanelEmptyStateLines(theme: Theme, width: number): string[] {
  return [
    ...buildCommentPanelTextLines(theme, width, "No comments yet.", "dim"),
    ...buildCommentPanelTextLines(theme, width, "Use Enter/m modify, c comment, d discuss for a line or range, l for file, or a for all lines in the current file.", "dim"),
  ];
}

function normalizeContextPanelText(text: string): string {
  return text
    .replace(/\\+x0a/gi, "\n")
    .replace(/\\+u000a/gi, "\n")
    .replace(/&#10;/g, "\n")
    .replace(/\\+n/g, "\n");
}

export function buildContextPanelLines(theme: Theme, width: number, text: string): string[] {
  const prefix = " ".repeat(CONTEXT_PANEL_PADDING_X);
  const contentWidth = Math.max(1, width - 2 - CONTEXT_PANEL_PADDING_X * 2);
  const lines: string[] = [];
  for (const rawLine of normalizeContextPanelText(text).split(/\r?\n/)) {
    const line = sanitizeTerminalText(rawLine).trim();
    if (line.length === 0) {
      lines.push(prefix);
      continue;
    }
    if (/^[A-Za-z][A-Za-z ]{1,32}:$/.test(line)) {
      pushWrappedAnsiText(lines, theme.fg("warning", line), contentWidth, prefix);
      continue;
    }
    pushWrappedText(lines, theme, line, contentWidth, "muted", prefix);
  }
  return lines;
}

export function buildDiffActionHintLine(theme: Theme, width: number): string {
  const sep = theme.fg("dim", " • ");
  const part = (key: string, label: string, color: "accent" | "success" | "warning" | "muted") =>
    `${theme.fg(color, key)} ${theme.fg("dim", label)}`;
  const hint = [
    part("Enter/m", "modify", "accent"),
    part("c", "comment", "success"),
    part("d", "discuss", "warning"),
    part("l", "file", "muted"),
    part("a", "all lines", "muted"),
    part("k/j", "context", "muted"),
    part("y", "copy", "muted"),
    part("w", "wrap", "muted"),
  ].join(sep);
  return truncateToWidth(hint, Math.max(1, width - 2), "…", false);
}

export function buildRelatedFilePanelLines(theme: Theme, width: number, file: ReviewFile | null, scope: ReviewScope, maxPathsPerSection = 6): string[] {
  const sections = getRelatedFilePanelSections(file, scope);
  if (sections.length === 0) return [];

  const lines: string[] = [];
  const contentWidth = Math.max(1, width - 2);
  lines.push(theme.fg("muted", "related files:"));

  for (const section of sections) {
    const hiddenCount = Math.max(0, section.paths.length - maxPathsPerSection);
    const title = `${section.title} (${section.paths.length})`;
    pushWrappedText(lines, theme, title, contentWidth, "dim", "  ");

    for (const path of section.paths.slice(0, maxPathsPerSection)) {
      pushWrappedText(lines, theme, shortenNavigatorPath(path, Math.max(8, contentWidth - 4)), contentWidth, "muted", "    ");
    }

    if (hiddenCount > 0) {
      pushWrappedText(lines, theme, `… ${hiddenCount} more`, contentWidth, "dim", "    ");
    }
  }

  return lines;
}

export function buildFooterLines(theme: Theme, promptStatus: string, frameInnerWidth: number): string[] {
  const width = Math.max(1, frameInnerWidth);
  return [
    ...wrapAnsiText(theme.fg("dim", promptStatus), width, true),
    ...wrapAnsiText(theme.fg("dim", FOOTER_ACTION_HINT), width, true),
  ];
}

export function fitFooterLines(theme: Theme, lines: string[], maxLines: number, width: number): string[] {
  const budget = Math.max(0, Math.floor(maxLines));
  if (lines.length <= budget) return lines;
  if (budget === 0) return [];

  const visibleLineCount = budget - 1;
  const hiddenLineCount = lines.length - visibleLineCount;
  const marker = truncateToWidth(theme.fg("warning", `+${hiddenLineCount} more • ? help`), Math.max(1, width), "", false);
  return [...lines.slice(0, visibleLineCount), marker];
}

export interface ReviewVerticalLayout {
  bodyHeight: number;
  footerLines: string[];
  stackedPaneMinimumHeight: number;
}

export function getReviewVerticalLayout(
  theme: Theme,
  frameInnerHeight: number,
  headerLineCount: number,
  visiblePaneCount: number,
  stacked: boolean,
  footerLines: string[],
  width: number,
): ReviewVerticalLayout {
  const safeHeight = Math.max(1, Math.floor(frameInnerHeight));
  const safeHeaderCount = Math.max(0, Math.floor(headerLineCount));
  const minimumBodyHeight = visiblePaneCount === 0 ? 1 : stacked ? visiblePaneCount : 1;
  const footerBudget = Math.max(0, safeHeight - safeHeaderCount - minimumBodyHeight);
  const fittedFooterLines = fitFooterLines(theme, footerLines, footerBudget, width);
  const bodyHeight = Math.max(minimumBodyHeight, safeHeight - safeHeaderCount - fittedFooterLines.length);
  const stackedPaneMinimumHeight = stacked && visiblePaneCount > 0
    ? Math.max(1, Math.min(3, Math.floor(bodyHeight / visiblePaneCount)))
    : 3;
  return { bodyHeight, footerLines: fittedFooterLines, stackedPaneMinimumHeight };
}

export function buildHelpPanelLines(theme: Theme, width: number, activeShortcuts: CommentShortcut[], configPath: string): string[] {
  const lines: string[] = [];
  const contentWidth = Math.max(1, width - 2);

  pushWrappedText(lines, theme, "? toggle help • Esc close", contentWidth, "muted");

  for (const section of HELP_KEY_SECTIONS) {
    lines.push("");
    lines.push(truncateToWidth(theme.fg("warning", section.title), contentWidth, "", false));
    for (const line of section.lines) {
      pushWrappedText(lines, theme, line, contentWidth, "muted");
    }
  }

  lines.push("");
  lines.push(truncateToWidth(theme.fg("warning", "Template shortcuts"), contentWidth, "", false));
  if (activeShortcuts.length === 0) {
    pushWrappedText(lines, theme, "No active shortcuts for the current selection.", contentWidth, "dim");
  } else {
    for (const shortcut of activeShortcuts) {
      const badge = getIntentBadge(theme, shortcut.intent);
      pushWrappedText(lines, theme, `${shortcut.key} ${shortcut.label} ${badge}`, contentWidth, "muted");
    }
  }

  lines.push("");
  lines.push(truncateToWidth(theme.fg("warning", "Config"), contentWidth, "", false));
  pushWrappedText(lines, theme, configPath, contentWidth, "muted");

  return lines;
}

function sliceAnsiByColumn(line: string, startCol: number, length: number): string {
  if (length <= 0) return "";

  const ansiPattern = /\x1b\[[0-9;?]*[ -/]*[@-~]/y;
  let column = 0;
  let index = 0;
  let result = "";
  let activeSequences = "";
  let started = false;

  while (index < line.length) {
    ansiPattern.lastIndex = index;
    const ansiMatch = ansiPattern.exec(line);
    if (ansiMatch != null) {
      const sequence = ansiMatch[0]!;
      index += sequence.length;
      if (!started && column < startCol) {
        activeSequences += sequence;
      } else {
        result += sequence;
      }
      continue;
    }

    const char = line[index]!;
    const charWidth = visibleWidth(char);
    const charStart = column;
    const charEnd = column + charWidth;

    if (charEnd > startCol && charStart < startCol + length) {
      if (!started) {
        result = activeSequences + result;
        started = true;
      }
      result += char;
    }

    column = charEnd;
    index += char.length;
    if (column >= startCol + length) break;
  }

  return result;
}

function compositeLineAt(baseLine: string, overlayLine: string, left: number, totalWidth: number): string {
  const prefix = sliceAnsiByColumn(baseLine, 0, left);
  const overlayWidth = visibleWidth(overlayLine);
  const suffixStart = left + overlayWidth;
  const suffix = sliceAnsiByColumn(baseLine, suffixStart, Math.max(0, totalWidth - suffixStart));
  const composed = `${prefix}${overlayLine}${suffix}`;
  return composed + " ".repeat(Math.max(0, totalWidth - visibleWidth(composed)));
}

export function renderCenteredOverlay(baseLines: string[], overlayLines: string[], totalWidth: number, totalHeight = baseLines.length): string[] {
  if (overlayLines.length === 0) return [...baseLines];

  const overlayWidth = Math.min(totalWidth, Math.max(...overlayLines.map((line) => visibleWidth(line))));
  const overlayHeight = Math.min(totalHeight, overlayLines.length);
  const left = Math.max(0, Math.floor((totalWidth - overlayWidth) / 2));
  const top = Math.max(0, Math.floor((totalHeight - overlayHeight) / 2));
  const result = [...baseLines];

  for (let i = 0; i < overlayHeight; i += 1) {
    const row = top + i;
    const baseLine = result[row] ?? " ".repeat(totalWidth);
    const overlayLine = visibleWidth(overlayLines[i]!) > overlayWidth
      ? sliceAnsiByColumn(overlayLines[i]!, 0, overlayWidth)
      : overlayLines[i]!;
    result[row] = compositeLineAt(baseLine, overlayLine, left, totalWidth);
  }

  return result;
}

export type DisplayRow =
  | { kind: "gap"; displayLineNumber: null; commentLineNumber: null; commentSide: null; sign: " "; codeText: string; pairedText?: undefined }
  | { kind: "context" | "added" | "removed"; displayLineNumber: number | null; commentLineNumber: number | null; commentSide: ReviewLineTarget["side"] | null; sign: " " | "+" | "-"; codeText: string; pairedText?: string };

export interface SideBySideCell {
  side: ReviewLineTarget["side"];
  lineNumber: number;
  sign: " " | "+" | "-";
  text: string;
  tone: DiffTone;
}

export type SideBySideDisplayRow =
  | { kind: "gap"; label: string; oldCell: null; newCell: null }
  | { kind: "context" | "change"; oldCell: SideBySideCell | null; newCell: SideBySideCell | null };

export function diffTextMatchesSearch(text: string, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  return normalizedQuery.length > 0 && text.toLowerCase().includes(normalizedQuery);
}

export function getMatchingDiffLineTargets(rows: DisplayRow[], query: string): ReviewLineTarget[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) return [];

  const seen = new Set<string>();
  const targets: ReviewLineTarget[] = [];
  for (const row of rows) {
    if (row.commentLineNumber == null || row.commentSide == null) continue;
    if (!diffTextMatchesSearch(row.codeText, normalizedQuery)) continue;
    const key = `${row.commentSide}:${row.commentLineNumber}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ side: row.commentSide, line: row.commentLineNumber });
  }
  return targets;
}

export function getNextSearchIndex(currentIndex: number, matchCount: number, direction: 1 | -1): number {
  if (matchCount <= 0) return -1;
  if (currentIndex < 0) return direction > 0 ? 0 : matchCount - 1;
  return (currentIndex + direction + matchCount) % matchCount;
}

export function getNavigatorMoveIndex(currentIndex: number, fileCount: number, delta: number): number {
  if (fileCount <= 0) return -1;
  const safeCurrentIndex = currentIndex >= 0 ? currentIndex : 0;
  if (Math.abs(delta) === 1) return (safeCurrentIndex + delta + fileCount) % fileCount;
  return Math.max(0, Math.min(fileCount - 1, safeCurrentIndex + delta));
}

export type DiffViewMode = "unified" | "side-by-side";

type DiffTone = "added" | "removed" | "context";

interface DiffLayout {
  displayDiff: StructuredDiff;
  unifiedRows: DisplayRow[];
  sideBySideRows: SideBySideDisplayRow[];
  commentableTargets: ReviewLineTarget[];
  sideBySideCommentableTargets: ReviewLineTarget[];
  unifiedTargetRowIndexes: Map<string, number>;
  sideBySideTargetRowIndexes: Map<string, number>;
  rowRenderCache: Map<DisplayRow, Map<string, string[]>>;
  sideBySideRowRenderCache: Map<SideBySideDisplayRow, Map<string, { oldLines: string[]; newLines: string[] }>>;
  unifiedRowHeights: Map<string, number[]>;
  unifiedRowOffsets: Map<string, number[]>;
  sideBySideRowHeights: Map<string, number[]>;
  sideBySideRowOffsets: Map<string, number[]>;
}

function applyLineBackground(theme: Theme, text: string, tone: DiffTone): string {
  if (tone === "added") return theme.bg("toolSuccessBg", text);
  if (tone === "removed") return theme.bg("toolErrorBg", text);
  return text;
}

function highlightCodeLine(theme: Theme, _tone: DiffTone, text: string, language: string | undefined): string {
  if (text.length === 0) return "";
  if (language === "json") return highlightJsonLine(theme, text);
  if (language === "markdown") return highlightMarkdownLine(theme, text);
  return highlightCodeLineWithPi(text, language);
}

export function buildDisplayRows(diff: StructuredDiff): DisplayRow[] {
  const rows: DisplayRow[] = [];

  const pushLine = (
    sign: " " | "+" | "-",
    displayLineNumber: number | undefined,
    commentLineNumber: number | undefined,
    commentSide: ReviewLineTarget["side"] | undefined,
    codeText: string,
    kind: "context" | "added" | "removed",
    pairedText?: string,
  ) => {
    rows.push({
      sign,
      displayLineNumber: displayLineNumber ?? null,
      commentLineNumber: commentLineNumber ?? null,
      commentSide: commentSide ?? null,
      codeText,
      kind,
      pairedText,
    });
  };

  for (const item of diff.visibleItems) {
    if (item.type === "gap") {
      rows.push({ sign: " ", displayLineNumber: null, commentLineNumber: null, commentSide: null, codeText: item.label, kind: "gap" });
      continue;
    }

    const row = item.row;
    if (row.kind === "equal") {
      pushLine(" ", row.newLineNumber, row.newLineNumber, "added", row.newText, "context");
      continue;
    }
    if (row.kind === "delete") {
      pushLine("-", row.oldLineNumber, row.oldLineNumber, "deleted", row.oldText, "removed");
      continue;
    }
    if (row.kind === "insert") {
      pushLine("+", row.newLineNumber, row.newLineNumber, "added", row.newText, "added");
      continue;
    }

    pushLine("-", row.oldLineNumber, row.oldLineNumber, "deleted", row.oldText, "removed", row.newText);
    pushLine("+", row.newLineNumber, row.newLineNumber, "added", row.newText, "added", row.oldText);
  }

  return rows;
}

export function buildSideBySideDisplayRows(diff: StructuredDiff): SideBySideDisplayRow[] {
  const rows: SideBySideDisplayRow[] = [];

  for (const item of diff.visibleItems) {
    if (item.type === "gap") {
      rows.push({ kind: "gap", label: item.label, oldCell: null, newCell: null });
      continue;
    }

    const row = item.row;
    if (row.kind === "equal") {
      rows.push({
        kind: "context",
        oldCell: row.oldLineNumber == null ? null : { side: "deleted", lineNumber: row.oldLineNumber, sign: " ", text: row.oldText, tone: "context" },
        newCell: row.newLineNumber == null ? null : { side: "added", lineNumber: row.newLineNumber, sign: " ", text: row.newText, tone: "context" },
      });
      continue;
    }

    if (row.kind === "delete") {
      rows.push({
        kind: "change",
        oldCell: row.oldLineNumber == null ? null : { side: "deleted", lineNumber: row.oldLineNumber, sign: "-", text: row.oldText, tone: "removed" },
        newCell: null,
      });
      continue;
    }

    if (row.kind === "insert") {
      rows.push({
        kind: "change",
        oldCell: null,
        newCell: row.newLineNumber == null ? null : { side: "added", lineNumber: row.newLineNumber, sign: "+", text: row.newText, tone: "added" },
      });
      continue;
    }

    rows.push({
      kind: "change",
      oldCell: row.oldLineNumber == null ? null : { side: "deleted", lineNumber: row.oldLineNumber, sign: "-", text: row.oldText, tone: "removed" },
      newCell: row.newLineNumber == null ? null : { side: "added", lineNumber: row.newLineNumber, sign: "+", text: row.newText, tone: "added" },
    });
  }

  return rows;
}

export function getSideBySideLineTargets(rows: SideBySideDisplayRow[], side?: ReviewLineTarget["side"]): ReviewLineTarget[] {
  const seen = new Set<string>();
  const targets: ReviewLineTarget[] = [];
  const pushCell = (cell: SideBySideCell | null): void => {
    if (cell == null || (side != null && cell.side !== side)) return;
    const key = `${cell.side}:${cell.lineNumber}`;
    if (seen.has(key)) return;
    seen.add(key);
    targets.push({ side: cell.side, line: cell.lineNumber });
  };

  for (const row of rows) {
    if (row.kind === "gap") continue;
    pushCell(row.oldCell);
    pushCell(row.newCell);
  }

  return targets;
}

export function getSideBySideColumnTarget(rows: SideBySideDisplayRow[], current: ReviewLineTarget, targetSide: ReviewLineTarget["side"]): ReviewLineTarget | null {
  const candidates: Array<{ target: ReviewLineTarget; rowIndex: number }> = [];
  let currentRowIndex = -1;

  rows.forEach((row, rowIndex) => {
    if (row.kind === "gap") return;
    const cells = [row.oldCell, row.newCell];
    for (const cell of cells) {
      if (cell == null) continue;
      if (cell.side === current.side && cell.lineNumber === current.line) currentRowIndex = rowIndex;
      if (cell.side === targetSide) candidates.push({ target: { side: cell.side, line: cell.lineNumber }, rowIndex });
    }
  });

  if (candidates.length === 0) return null;
  if (currentRowIndex < 0) return candidates[0]!.target;

  let previousCandidate: { target: ReviewLineTarget; rowIndex: number } | null = null;
  for (const candidate of candidates) {
    if (candidate.rowIndex <= currentRowIndex) previousCandidate = candidate;
  }
  return (previousCandidate ?? candidates[0]!).target;
}

export function getSideBySidePairedLineTarget(diff: StructuredDiff, target: ReviewLineTarget): ReviewLineTarget | null {
  const targetSide = target.side === "deleted" ? "added" : "deleted";
  return getSideBySideColumnTarget(buildSideBySideDisplayRows(diff), target, targetSide);
}

export function formatSelectedLineTargetLabel(target: ReviewLineTarget | null): string {
  if (target == null) return "no line selected";
  const range = getLineTargetRange(target);
  const noun = range.startLine === range.endLine ? "line" : "lines";
  return `selected ${target.side} ${noun} ${formatLineRangeLabel(range.startLine, range.endLine)}`;
}

export function formatDiffViewModeLabel(mode: DiffViewMode): string {
  return mode === "side-by-side" ? "side-by-side" : "unified";
}

export function getChangedLineTargets(diff: StructuredDiff): ReviewLineTarget[] {
  return buildDisplayRows(diff).flatMap((row) => (
    (row.kind === "added" || row.kind === "removed") && row.commentLineNumber != null && row.commentSide != null
      ? [{ side: row.commentSide, line: row.commentLineNumber }]
      : []
  ));
}

function getCommentableLineTargets(diff: StructuredDiff): ReviewLineTarget[] {
  const seen = new Set<string>();
  const targets: ReviewLineTarget[] = [];

  for (const row of buildDisplayRows(diff)) {
    if (row.commentLineNumber == null || row.commentSide == null) continue;
    const key = `${row.commentSide}:${row.commentLineNumber}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ side: row.commentSide, line: row.commentLineNumber });
  }

  return targets;
}

export class ReviewApp {
  focused = false;

  private state: ReviewState;
  private files: ReviewFile[];
  private repoRoot: string;
  private currentVisibleScopes: ReviewScope[];
  private readonly frameStack: ReviewFrame[] = [];
  private openingSubmodule = false;
  private readonly cache = new Map<string, LoadedEntry>();
  private readonly entryLoads = new Map<string, Promise<void>>();
  private readonly expandedContextRows = new Map<string, Set<number>>();
  private searchMode = false;
  private searchBuffer = "";
  private searchInitialQuery = "";
  private searchPasteBuffer = "";
  private searchPasteMode = false;
  private searchPane: ReviewFocus = "navigator";
  private diffSearchQuery = "";
  private commentSearchQuery = "";
  private shortcutMode = false;
  private helpMode = false;
  private diffViewMode: DiffViewMode;
  private contextLineNavigation: boolean;
  private navigatorTreeMode: boolean;
  private navigatorFileOrder: NavigatorFileOrder;
  private readonly reviewedFileIds = new Set<string>();
  private commentsGlobal: boolean;
  private showAllLocales: boolean;
  private confirmCancel = false;
  private paneVisibility: ReviewPaneVisibility;
  private editTarget: EditTarget | null = null;
  private reanchorTarget: ReanchorTransaction | null = null;
  private editor: Editor;
  private readonly exactEditor = new ExactTextEditor();
  private message: string | null = null;
  private navigatorScroll = 0;
  private diffScroll = 0;
  private commentsScroll = 0;
  private contextPanelState: ContextPanelState = { status: "idle" };
  private repliesPanelState: RepliesPanelState = { status: "idle" };
  private replyAnalysis: ReplyAnalysisState = { status: "idle" };
  /** Only the newest replies request may write state, so an in-flight refresh cannot overwrite it. */
  private repliesRequestToken = 0;
  private analysisRequestToken = 0;
  private repliesScroll = 0;
  private repliesPageSize = 1;
  private selectedReplyIndex = 0;
  private contextScroll = 0;
  private contextLineCount = 0;
  private navigatorPageSize = 1;
  private diffPageSize = 1;
  private commentsPageSize = 1;
  private contextPageSize = 1;
  private relatedFilterAnchorFileId: string | null = null;
  private relatedFilterReturnFileId: string | null = null;
  private mousePaneLayout: MousePaneLayout | null = null;
  private lastWidth = 120;
  private pendingVimSequence: "g" | null = null;
  private readonly previousHardwareCursor: boolean;
  private sessionSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private compositionTimer: ReturnType<typeof setTimeout> | null = null;
  private compositionOrigin: ReviewComposition | null = null;
  private recoveredFrom: string | null = null;
  private compositionDirty = false;
  private recoveryEditor = false;
  private recoveryOnly = false;
  private recoveringComposition = false;
  private compositionConflictPending = false;
  private conflictCopyId: string | null = null;
  private commentPaste: string | null = null;
  private commentPastePrefix = "";
  private disposed = false;
  private readonly syntaxLineCache = new Map<string, string>();
  private readonly diffLayoutCache = new Map<string, DiffLayout>();

  constructor(
    private readonly tui: any,
    private readonly theme: Theme,
    private readonly done: (value: ReviewResult) => void,
    private readonly options: ReviewAppOptions,
  ) {
    this.files = options.files;
    this.repoRoot = options.repoRoot;
    const preferences = loadReviewPreferences();
    this.diffViewMode = options.initialSession?.diffViewMode ?? preferences.diffViewMode;
    this.contextLineNavigation = options.initialSession?.contextLineNavigation ?? preferences.contextLineNavigation;
    this.navigatorTreeMode = options.initialSession?.navigatorTreeMode ?? preferences.navigatorTreeMode;
    this.navigatorFileOrder = preferences.navigatorFileOrder;
    this.commentsGlobal = options.initialSession?.commentsGlobal ?? preferences.commentsGlobal;
    this.paneVisibility = { ...preferences.paneVisibility };
    this.showAllLocales = options.initialSession?.showAllLocales ?? false;
    this.message = options.initialBanner ?? null;
    this.currentVisibleScopes = options.visibleScopes?.filter((scope) => SEARCHABLE_SCOPES.includes(scope)) ?? [];
    if (this.currentVisibleScopes.length === 0) this.currentVisibleScopes = DEFAULT_VISIBLE_SCOPES;
    this.state = ensureActiveFile(createInitialReviewState(options.files), options.files);
    if (options.initialSession != null) {
      this.state = ensureActiveFile(options.initialSession.state, options.files);
      this.navigatorScroll = Math.max(0, options.initialSession.navigatorScroll);
      this.diffScroll = Math.max(0, options.initialSession.diffScroll);
      this.commentsScroll = Math.max(0, options.initialSession.commentsScroll);
      for (const fileId of options.initialSession.reviewedFileIds) this.reviewedFileIds.add(fileId);
    }
    if (!this.visibleScopes().includes(this.state.activeScope)) {
      this.state = setScope(this.state, options.files, this.visibleScopes()[0]!);
    }
    if (options.seedComments != null && options.seedComments.length > 0) {
      this.state = applyResolvedSeedComments(this.state, options.seedComments);
    }
    this.ensureActiveNavigatorFile(options.initialSession == null);
    this.ensureVisibleFocus();
    this.searchBuffer = this.state.searchQuery;

    const editorTheme: EditorTheme = {
      borderColor: (text) => this.theme.fg("accent", text),
      selectList: {
        selectedPrefix: (text) => this.theme.fg("accent", text),
        selectedText: (text) => this.theme.fg("accent", text),
        description: (text) => this.theme.fg("muted", text),
        scrollInfo: (text) => this.theme.fg("dim", text),
        noMatch: (text) => this.theme.fg("warning", text),
      },
    };
    this.editor = new Editor(this.tui, editorTheme);
    this.editor.disableSubmit = true;
    this.previousHardwareCursor = typeof this.tui.getShowHardwareCursor === "function"
      ? this.tui.getShowHardwareCursor()
      : false;
    this.syncCursorMode();

    this.recoveringComposition = options.initialComposition != null;
    queueMicrotask(() => {
      if (this.disposed) return;
      if (options.initialComposition != null) void this.recoverComposition(options.initialComposition);
      else this.ensureActiveEntry();
      this.ensureContextPanel();
      this.requestRender();
    });
  }

  dispose(): void {
    this.disposed = true;
    this.flushComposition();
    if (this.sessionSaveTimer != null) {
      clearTimeout(this.sessionSaveTimer);
      this.sessionSaveTimer = null;
      this.persistSession();
    }
    if (typeof this.tui.setShowHardwareCursor === "function") {
      this.tui.setShowHardwareCursor(this.previousHardwareCursor);
    }
  }

  invalidate(): void {
    this.syntaxLineCache.clear();
    this.diffLayoutCache.clear();
    this.message = this.message;
  }

  private syncCursorMode(): void {
    if (typeof this.tui.setShowHardwareCursor === "function") {
      this.tui.setShowHardwareCursor(this.editTarget != null || this.previousHardwareCursor);
    }
    this.editor.focused = this.editTarget != null && !this.usesExactEditor();
  }

  private getSessionData(): ReviewSessionData {
    return {
      state: this.state,
      diffViewMode: this.diffViewMode,
      navigatorTreeMode: this.navigatorTreeMode,
      contextLineNavigation: this.contextLineNavigation,
      commentsGlobal: this.commentsGlobal,
      showAllLocales: this.showAllLocales,
      reviewedFileIds: [...this.reviewedFileIds],
      navigatorScroll: this.navigatorScroll,
      diffScroll: this.diffScroll,
      commentsScroll: this.commentsScroll,
    };
  }

  private persistSession(): boolean {
    if (this.sessionSaveTimer != null) clearTimeout(this.sessionSaveTimer);
    this.sessionSaveTimer = null;
    return this.options.onSessionChange?.(this.getSessionData()) !== false;
  }

  private requestRender(persist = true): void {
    if (this.disposed) return;
    if (typeof this.tui.requestRender === "function") this.tui.requestRender();
    if (!persist || this.options.onSessionChange == null) return;
    if (this.editTarget != null) {
      if (this.sessionSaveTimer != null) clearTimeout(this.sessionSaveTimer);
      this.sessionSaveTimer = null;
      return;
    }
    if (this.sessionSaveTimer != null) clearTimeout(this.sessionSaveTimer);
    this.sessionSaveTimer = setTimeout(() => {
      this.sessionSaveTimer = null;
      this.persistSession();
    }, 100);
  }

  private ensureContextPanel(): void {
    const source = this.options.contextPanelSource;
    if (source == null || !this.paneVisibility.context || this.contextPanelState.status !== "idle") return;

    this.contextPanelState = { status: "loading" };
    this.requestRender();
    void source.load().then((text) => {
      this.contextPanelState = { status: "ready", text };
      this.contextScroll = 0;
      this.requestRender();
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.contextPanelState = { status: "error", error: sanitizeTerminalText(message) };
      this.contextScroll = 0;
      this.requestRender();
    });
  }

  private ensureRepliesPanel(): void {
    if (this.options.repliesSource == null || !this.paneVisibility.replies) return;
    if (this.repliesPanelState.status !== "idle") return;
    this.loadReplies();
  }

  /**
   * Reads only the current pull request. The race token means a stale response from an earlier
   * refresh is dropped instead of replacing newer data.
   */
  private loadReplies(): void {
    const source = this.options.repliesSource;
    if (source == null) return;

    this.repliesRequestToken += 1;
    const token = this.repliesRequestToken;
    this.repliesPanelState = { status: "loading" };
    this.requestRender();
    void source.load().then((snapshot) => {
      if (token !== this.repliesRequestToken) return;
      this.repliesPanelState = { status: "ready", snapshot };
      this.repliesScroll = 0;
      this.selectedReplyIndex = Math.min(this.selectedReplyIndex, Math.max(0, snapshot.replies.length - 1));
      this.requestRender();
    }).catch((error: unknown) => {
      if (token !== this.repliesRequestToken) return;
      const message = error instanceof Error ? error.message : String(error);
      this.repliesPanelState = { status: "error", error: sanitizeTerminalText(message) };
      this.repliesScroll = 0;
      this.requestRender();
    });
  }

  private refreshReplies(): void {
    if (this.options.repliesSource == null) {
      this.setMessage("Replies are not available in this review.");
      this.requestRender();
      return;
    }
    this.replyAnalysis = { status: "idle" };
    this.analysisRequestToken += 1;
    this.loadReplies();
    this.setMessage("Refreshing replies for this PR...");
  }

  private getReplies(): ReviewReplyItem[] {
    return this.repliesPanelState.status === "ready" ? this.repliesPanelState.snapshot.replies : [];
  }

  private selectedReply(): ReviewReplyItem | null {
    const replies = this.getReplies();
    if (replies.length === 0) return null;
    return replies[Math.max(0, Math.min(this.selectedReplyIndex, replies.length - 1))] ?? null;
  }

  private moveReplySelection(delta: number): void {
    const replies = this.getReplies();
    if (replies.length === 0) {
      this.requestRender();
      return;
    }
    const next = Math.max(0, Math.min(replies.length - 1, this.selectedReplyIndex + delta));
    if (next === this.selectedReplyIndex) {
      this.requestRender();
      return;
    }
    this.selectedReplyIndex = next;
    this.requestRender();
  }

  private openSelectedReply(): void {
    const reply = this.selectedReply();
    if (reply == null) {
      this.setMessage("No reply is selected.");
      this.requestRender();
      return;
    }
    const url = reply.url;
    if (url == null || url.trim().length === 0) {
      this.setMessage("This reply has no link to open.");
      this.requestRender();
      return;
    }
    this.openUrlInBrowser(url, "reply");
  }

  /** Read-only, explicitly requested, and never posts anything back to the provider. */
  private analyzeSelectedReply(): void {
    const source = this.options.repliesSource;
    const reply = this.selectedReply();
    if (source?.analyze == null) {
      this.setMessage("Reply analysis is not available in this review.");
      this.requestRender();
      return;
    }
    if (reply == null) {
      this.setMessage("No reply is selected.");
      this.requestRender();
      return;
    }
    if (this.replyAnalysis.status === "loading") {
      this.setMessage("An analysis is already running.");
      this.requestRender();
      return;
    }

    this.analysisRequestToken += 1;
    const token = this.analysisRequestToken;
    this.replyAnalysis = { status: "loading", replyId: reply.id };
    this.requestRender();
    void source.analyze(reply).then((text) => {
      if (token !== this.analysisRequestToken) return;
      this.replyAnalysis = { status: "ready", replyId: reply.id, text: sanitizeTerminalText(text) };
      this.requestRender();
    }).catch((error: unknown) => {
      if (token !== this.analysisRequestToken) return;
      const message = error instanceof Error ? error.message : String(error);
      this.replyAnalysis = { status: "error", replyId: reply.id, error: sanitizeTerminalText(message) };
      this.requestRender();
    });
  }

  private effectivePaneVisibility(): ReviewPaneVisibility {
    return {
      ...this.paneVisibility,
      context: this.paneVisibility.context && this.options.contextPanelSource != null,
      replies: this.paneVisibility.replies && this.options.repliesSource != null,
    };
  }

  private getPaneAtMousePosition(col: number, row: number): PaneName | null {
    const layout = this.mousePaneLayout;
    if (layout == null) return null;

    const zeroCol = col - 1;
    const zeroRow = row - 1;
    const contains = (bounds: MousePaneBounds | null): boolean => bounds != null
      && zeroRow >= bounds.top
      && zeroRow <= bounds.bottom
      && zeroCol >= bounds.left
      && zeroCol <= bounds.right;

    if (contains(layout.navigator)) return "navigator";
    if (contains(layout.diff)) return "diff";
    if (contains(layout.comments)) return "comments";
    if (contains(layout.context)) return "context";
    if (contains(layout.replies)) return "replies";
    return null;
  }

  private getCachedHighlightedCode(tone: DiffTone, text: string, language: string | undefined): string {
    const key = `${language ?? ""}\u001f${tone}\u001f${text}`;
    const cached = this.syntaxLineCache.get(key);
    if (cached != null) {
      setBoundedMapEntry(this.syntaxLineCache, key, cached, MAX_SYNTAX_LINE_ENTRIES);
      return cached;
    }

    const highlighted = highlightCodeLine(this.theme, tone, text, language);
    setBoundedMapEntry(this.syntaxLineCache, key, highlighted, MAX_SYNTAX_LINE_ENTRIES);
    return highlighted;
  }

  private buildUnifiedRowLines(
    row: DisplayRow,
    width: number,
    language: string | undefined,
    isSelected: boolean,
    isCurrent: boolean,
    isSearchMatch: boolean,
    lineComment: DiffReviewComment | undefined,
  ): string[] {
    let contentText: string;
    let tone: DiffTone = "context";
    if (row.kind === "gap") {
      contentText = this.theme.fg("muted", centerText(row.codeText, Math.max(row.codeText.length + 2, 10)));
    } else {
      tone = row.kind === "added" ? "added" : row.kind === "removed" ? "removed" : "context";
      const lineLabel = row.displayLineNumber == null ? "    " : String(row.displayLineNumber).padStart(4, " ");
      const gutterLine = this.theme.fg("borderMuted", lineLabel);
      const gutterSign = row.sign === "+"
        ? this.theme.fg("success", row.sign)
        : row.sign === "-"
          ? this.theme.fg("error", row.sign)
          : this.theme.fg("toolDiffContext", row.sign);
      const commentIndicator = lineComment == null ? " " : getCommentIndicator(this.theme, lineComment.intent);
      const highlightedCode = this.getCachedHighlightedCode(tone, row.codeText, language);
      contentText = `${gutterLine} ${gutterSign} ${commentIndicator} ${highlightedCode}`;
    }

    const wrapped = wrapAnsiText(contentText, Math.max(1, width - 2), this.state.wrapLines);
    return wrapped.map((line) => {
      const paddedLine = padLine(line, Math.max(1, width - 2));
      if (isCurrent) return this.theme.bg("selectedBg", this.theme.fg("accent", paddedLine));
      if (isSelected) return this.theme.bg("selectedBg", paddedLine);
      if (isSearchMatch) return this.theme.bg("toolPendingBg", paddedLine);
      if (row.kind === "added" || row.kind === "removed") return applyLineBackground(this.theme, paddedLine, tone);
      return paddedLine;
    });
  }

  private setMessage(message: string): void {
    this.message = sanitizeStatusText(message);
  }

  private copyText(text: string, label: string): void {
    void copyToClipboard(text).then(() => {
      this.setMessage(`Copied ${label}.`);
      this.requestRender();
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.setMessage(`Could not copy ${label}: ${message}`);
      this.requestRender();
    });
  }

  private copySelection(format: SelectionClipboardFormat): void {
    if (format === "source" && this.state.focus === "comments") {
      const items = getCommentPanelItems(this.state, this.state.activeFileId, this.state.activeScope, this.commentsGlobal);
      const item = items[this.state.selectedCommentIndex];
      if (item == null) {
        this.setMessage("No selected comment to copy.");
        this.requestRender();
        return;
      }
      this.copyText(item.kind === "all" ? item.body : item.comment.body, "comment");
      return;
    }

    const file = this.activeFile();
    const target = getSelectedLineTarget(this.state, file?.id ?? null, this.state.activeScope);
    if (file == null || target == null) {
      this.setMessage("No selected source range to copy.");
      this.requestRender();
      return;
    }
    const range = getLineTargetRange(target);
    const sourceText = this.getSourceLinesText(file.id, this.state.activeScope, target.side, range.startLine, range.endLine);
    const comment = getLineComment(this.state, file.id, this.state.activeScope, target.side, target.line);
    const path = getScopeDisplayPath(file, this.state.activeScope);
    const text = buildSelectionClipboardText(format, path, target, sourceText, comment);
    const label = format === "source" ? "source" : format === "location" ? "location" : format;
    this.copyText(text, label);
  }

  private visibleScopes(): ReviewScope[] {
    return this.currentVisibleScopes;
  }

  private activeFile(): ReviewFile | null {
    return this.files.find((file) => file.id === this.state.activeFileId) ?? null;
  }

  private activeSubmodule(): { file: ReviewFile; submodule: ReviewSubmoduleInfo } | null {
    const file = this.activeFile();
    const submodule = getSubmoduleInfo(file, this.state.activeScope);
    return file == null || submodule == null ? null : { file, submodule };
  }

  private async openActiveSubmodule(): Promise<boolean> {
    const active = this.activeSubmodule();
    if (active == null) return false;
    if (this.openingSubmodule) return true;
    if (!active.submodule.available) {
      this.setMessage(active.submodule.unavailableReason ?? `Submodule ${active.file.path} is not available locally.`);
      this.requestRender();
      return true;
    }
    if (this.options.loadSubmoduleReviewData == null) {
      this.setMessage("Nested submodule review is not configured.");
      this.requestRender();
      return true;
    }

    this.openingSubmodule = true;
    this.setMessage(`Opening submodule ${active.file.path}…`);
    this.requestRender();
    try {
      const data = await this.options.loadSubmoduleReviewData(active.submodule);
      if (data.files.length === 0) {
        this.setMessage(`No reviewable files found inside submodule ${active.file.path}.`);
        return true;
      }
      const pathPrefix = joinReviewPath(active.file.pathPrefix, active.file.path);
      const nestedFiles = data.files.map((file) => ({
        ...file,
        id: `${pathPrefix}::${file.id}`,
        pathPrefix,
      }));
      for (const file of nestedFiles) {
        if (!this.options.files.some((candidate) => candidate.id === file.id)) this.options.files.push(file);
      }
      this.frameStack.push({
        files: this.files,
        repoRoot: this.repoRoot,
        visibleScopes: this.currentVisibleScopes,
        state: this.state,
        navigatorScroll: this.navigatorScroll,
        diffScroll: this.diffScroll,
        commentsScroll: this.commentsScroll,
      });
      const draft = this.state.draft;
      this.files = nestedFiles;
      this.repoRoot = data.repoRoot;
      this.currentVisibleScopes = data.visibleScopes.length > 0 ? data.visibleScopes : ["all-files"];
      this.state = ensureActiveFile(createInitialReviewState(nestedFiles), nestedFiles);
      if (!this.currentVisibleScopes.includes(this.state.activeScope)) {
        this.state = setScope(this.state, nestedFiles, this.currentVisibleScopes[0]!);
      }
      this.state = { ...this.state, draft };
      this.ensureActiveNavigatorFile(true);
      this.navigatorScroll = 0;
      this.diffScroll = 0;
      this.commentsScroll = 0;
      this.relatedFilterAnchorFileId = null;
      this.relatedFilterReturnFileId = null;
      this.setMessage(`Reviewing ${pathPrefix}. Press b to return to the parent review.`);
      void this.ensureActiveEntry();
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setMessage(`Could not open submodule ${active.file.path}: ${message}`);
      return true;
    } finally {
      this.openingSubmodule = false;
      this.requestRender();
    }
  }

  private navigateBackFromSubmodule(): boolean {
    const frame = this.frameStack.pop();
    if (frame == null) return false;
    const draft = this.state.draft;
    this.files = frame.files;
    this.repoRoot = frame.repoRoot;
    this.currentVisibleScopes = frame.visibleScopes;
    this.state = { ...frame.state, draft };
    this.navigatorScroll = frame.navigatorScroll;
    this.diffScroll = frame.diffScroll;
    this.commentsScroll = frame.commentsScroll;
    this.relatedFilterAnchorFileId = null;
    this.relatedFilterReturnFileId = null;
    this.setMessage("Returned to the parent review.");
    void this.ensureActiveEntry();
    this.requestRender();
    return true;
  }

  private cacheKey(fileId: string, scope: ReviewScope): string {
    return `${scope}::${fileId}`;
  }

  private getEntry(fileId: string | null, scope: ReviewScope): LoadedEntry | undefined {
    if (fileId == null) return undefined;
    const key = this.cacheKey(fileId, scope);
    const entry = this.cache.get(key);
    if (entry != null) setBoundedMapEntry(this.cache, key, entry, MAX_LOADED_FILE_ENTRIES);
    return entry;
  }

  private invalidateEntry(fileId: string, scope: ReviewScope): void {
    const key = this.cacheKey(fileId, scope);
    this.cache.delete(key);
    this.expandedContextRows.delete(key);
    this.syntaxLineCache.clear();
    this.diffLayoutCache.clear();
  }

  private getDiffLayout(fileId: string | null, scope: ReviewScope): DiffLayout | null {
    if (fileId == null) return null;
    const entry = this.getEntry(fileId, scope);
    if (entry?.status !== "ready") return null;
    const key = `${scope}\u001f${fileId}\u001f${this.state.hideUnchanged ? 1 : 0}`;
    const cached = this.diffLayoutCache.get(key);
    if (cached != null) {
      setBoundedMapEntry(this.diffLayoutCache, key, cached, MAX_DIFF_LAYOUT_ENTRIES);
      return cached;
    }

    const contextAdjustedDiff = scope === "all-files"
      ? entry.baseDiff
      : adjustStructuredDiffContext(entry.baseDiff, this.state.hideUnchanged ? 0 : DEFAULT_CONTEXT_LINES);
    const expandedRows = this.expandedContextRows.get(this.cacheKey(fileId, scope));
    const displayDiff = expandedRows == null || expandedRows.size === 0
      ? contextAdjustedDiff
      : revealStructuredDiffRows(contextAdjustedDiff, expandedRows);
    const unifiedRows = buildDisplayRows(displayDiff);
    const sideBySideRows = buildSideBySideDisplayRows(displayDiff);

    const seen = new Set<string>();
    const commentableTargets: ReviewLineTarget[] = [];
    const unifiedTargetRowIndexes = new Map<string, number>();
    unifiedRows.forEach((row, rowIndex) => {
      if (row.commentLineNumber == null || row.commentSide == null) return;
      const targetKey = `${row.commentSide}:${row.commentLineNumber}`;
      if (!unifiedTargetRowIndexes.has(targetKey)) unifiedTargetRowIndexes.set(targetKey, rowIndex);
      if (seen.has(targetKey)) return;
      seen.add(targetKey);
      commentableTargets.push({ side: row.commentSide, line: row.commentLineNumber });
    });
    const sideBySideTargetRowIndexes = new Map<string, number>();
    sideBySideRows.forEach((row, rowIndex) => {
      if (row.kind === "gap") return;
      if (row.oldCell != null) sideBySideTargetRowIndexes.set(`${row.oldCell.side}:${row.oldCell.lineNumber}`, rowIndex);
      if (row.newCell != null) sideBySideTargetRowIndexes.set(`${row.newCell.side}:${row.newCell.lineNumber}`, rowIndex);
    });

    const layout: DiffLayout = {
      displayDiff,
      unifiedRows,
      sideBySideRows,
      commentableTargets,
      sideBySideCommentableTargets: getSideBySideLineTargets(sideBySideRows),
      unifiedTargetRowIndexes,
      sideBySideTargetRowIndexes,
      rowRenderCache: new Map(),
      sideBySideRowRenderCache: new Map(),
      unifiedRowHeights: new Map(),
      unifiedRowOffsets: new Map(),
      sideBySideRowHeights: new Map(),
      sideBySideRowOffsets: new Map(),
    };
    setBoundedMapEntry(this.diffLayoutCache, key, layout, MAX_DIFF_LAYOUT_ENTRIES);
    return layout;
  }

  private getDisplayDiff(fileId: string | null, scope: ReviewScope): StructuredDiff | null {
    return this.getDiffLayout(fileId, scope)?.displayDiff ?? null;
  }

  private getVisibleLineTargets(fileId: string | null, scope: ReviewScope): ReviewLineTarget[] {
    const layout = this.getDiffLayout(fileId, scope);
    if (layout == null) return [];
    if (this.diffViewMode === "side-by-side") return layout.sideBySideCommentableTargets;
    return layout.commentableTargets;
  }

  private getDiffMovementTargets(fileId: string, scope: ReviewScope): ReviewLineTarget[] {
    const layout = this.getDiffLayout(fileId, scope);
    const visibleTargets = this.getVisibleLineTargets(fileId, scope);
    const changedTargets = layout == null
      ? []
      : this.diffViewMode === "side-by-side"
        ? layout.sideBySideRows.flatMap((row) => row.kind === "gap"
            ? []
            : [row.oldCell, row.newCell]
                .filter((cell): cell is SideBySideCell => cell != null && cell.tone !== "context")
                .map((cell) => ({ side: cell.side, line: cell.lineNumber })))
        : layout.unifiedRows.flatMap((row) => (
            (row.kind === "added" || row.kind === "removed") && row.commentLineNumber != null && row.commentSide != null
              ? [{ side: row.commentSide, line: row.commentLineNumber }]
              : []
          ));
    const movementTargets = this.contextLineNavigation || changedTargets.length === 0 ? visibleTargets : changedTargets;
    if (this.diffViewMode !== "side-by-side") return movementTargets;

    const selectedTarget = getSelectedLineTarget(this.state, fileId, scope);
    const selectedSide = selectedTarget?.side ?? movementTargets[0]?.side;
    if (selectedSide == null) return movementTargets;
    const sideTargets = movementTargets.filter((target) => target.side === selectedSide);
    return sideTargets.length > 0 ? sideTargets : movementTargets;
  }

  private relatedFilterAnchorFile(): ReviewFile | null {
    if (this.relatedFilterAnchorFileId == null || this.state.activeScope !== "all-files") return null;
    return this.files.find((file) => file.id === this.relatedFilterAnchorFileId) ?? null;
  }

  private getNavigatorCandidateFiles(): ReviewFile[] {
    let files = getScopedFiles(this.files, this.state.activeScope);
    const anchor = this.relatedFilterAnchorFile();

    if (anchor != null) {
      const relatedPaths = getRelatedFilePaths(anchor);
      files = files
        .filter((file) => file.id === anchor.id || relatedPaths.has(file.path))
        .sort((a, b) => {
          if (a.id === anchor.id) return -1;
          if (b.id === anchor.id) return 1;
          return 0;
        });
    }

    return files;
  }

  private getNavigatorFiles(): ReviewFile[] {
    const anchor = this.relatedFilterAnchorFile();
    const localeFiltered = filterReviewFilesByLocale(this.getNavigatorCandidateFiles(), this.showAllLocales);
    const filtered = filterFilesBySearch(localeFiltered, this.state.searchQuery);
    if (anchor != null) return filtered;
    return orderNavigatorFiles(filtered, {
      mode: this.navigatorFileOrder,
      scope: this.state.activeScope,
      treeMode: this.navigatorTreeMode,
      groupOf: getNavigatorGroup,
      signals: this.options.orderSignals,
    });
  }

  private getHiddenLocaleFileCount(): number {
    const candidates = this.getNavigatorCandidateFiles();
    return candidates.length - filterReviewFilesByLocale(candidates, false).length;
  }

  private ensureActiveNavigatorFile(selectFirst = false): void {
    const files = this.getNavigatorFiles();
    const activeIsVisible = files.some((file) => file.id === this.state.activeFileId);
    if (files.length === 0) {
      this.state = { ...this.state, activeFileId: null, selectedCommentIndex: 0 };
    } else if (selectFirst || !activeIsVisible) {
      this.state = { ...this.state, activeFileId: files[0]!.id, selectedCommentIndex: 0 };
    }
  }

  private ensureLineSelection(): void {
    const file = this.activeFile();
    if (file == null) return;
    const movementTargets = this.getDiffMovementTargets(file.id, this.state.activeScope);
    this.state = clampSelectedLineTarget(this.state, file.id, this.state.activeScope, movementTargets);
  }

  private revalidateDraftAnchors(fileId: string, scope: ReviewScope, contents: ReviewFileContents): void {
    const file = this.files.find((candidate) => candidate.id === fileId);
    let newlyStaleCount = 0;
    const comments = this.state.draft.comments.map((comment) => {
      if (comment.fileId !== fileId || comment.scope !== scope || comment.side === "file") return comment;
      const anchorStatus = validateReviewDraftAnchor(comment, file, contents);
      if (comment.anchorStatus !== "stale" && anchorStatus === "stale") newlyStaleCount += 1;
      return { ...comment, anchorStatus };
    });
    if (newlyStaleCount > 0) this.message = `${newlyStaleCount} review draft location${newlyStaleCount === 1 ? " is" : "s are"} stale; use a in Comments to reanchor.`;
    this.state = { ...this.state, draft: { ...this.state.draft, comments } };
  }

  private ensureActiveEntry(): Promise<void> {
    const file = this.activeFile();
    const scope = this.state.activeScope;
    if (file == null || getSubmoduleInfo(file, scope) != null) return Promise.resolve();
    const key = this.cacheKey(file.id, scope);
    const existingLoad = this.entryLoads.get(key);
    if (existingLoad != null) return existingLoad;
    if (this.cache.has(key)) {
      this.ensureLineSelection();
      return Promise.resolve();
    }

    setBoundedMapEntry(this.cache, key, { status: "loading" }, MAX_LOADED_FILE_ENTRIES);
    this.requestRender();

    const load = (async () => {
      try {
        const contents = await this.options.loadFileContents(this.repoRoot, file, scope);
        const baseDiff = buildStructuredDiff(contents.originalContent, contents.modifiedContent, DEFAULT_CONTEXT_LINES);
        setBoundedMapEntry(this.cache, key, { status: "ready", contents, baseDiff }, MAX_LOADED_FILE_ENTRIES);
        this.revalidateDraftAnchors(file.id, scope, contents);
        this.ensureLineSelection();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setBoundedMapEntry(this.cache, key, { status: "error", error: message }, MAX_LOADED_FILE_ENTRIES);
      } finally {
        this.entryLoads.delete(key);
        this.requestRender();
      }
    })();
    this.entryLoads.set(key, load);
    return load;
  }

  private setScope(scope: ReviewScope): void {
    this.relatedFilterAnchorFileId = null;
    this.relatedFilterReturnFileId = null;
    this.state = setScope(this.state, this.files, scope);
    this.ensureActiveNavigatorFile();
    this.diffScroll = 0;
    this.navigatorScroll = 0;
    this.commentsScroll = 0;
    void this.ensureActiveEntry();
    this.requestRender();
  }

  private getSearchQueryForPane(pane: ReviewFocus): string {
    if (pane === "navigator") return this.state.searchQuery;
    if (pane === "diff") return this.diffSearchQuery;
    if (pane === "context" || pane === "replies") return "";
    return this.commentSearchQuery;
  }

  private setSearchQueryForPane(pane: ReviewFocus, query: string): void {
    if (pane === "context" || pane === "replies") return;
    this.message = null;
    if (pane === "navigator") {
      this.relatedFilterAnchorFileId = null;
      this.relatedFilterReturnFileId = null;
      this.state = setSearchQuery(this.state, this.files, query);
      this.ensureActiveNavigatorFile();
      void this.ensureActiveEntry();
      return;
    }

    if (pane === "diff") {
      this.diffSearchQuery = query;
      if (query.trim().length > 0) this.jumpDiffSearch(1, true);
      return;
    }

    this.commentSearchQuery = query;
    if (query.trim().length > 0) this.jumpCommentSearch(1, true);
  }

  private openSearch(): void {
    if (this.state.focus === "context" || this.state.focus === "replies") {
      this.setMessage(`Search is not available in the ${this.state.focus === "context" ? "PR context" : "Replies"} pane.`);
      this.requestRender();
      return;
    }
    this.searchPane = this.state.focus;
    this.searchBuffer = this.getSearchQueryForPane(this.searchPane);
    this.searchInitialQuery = this.searchBuffer;
    this.searchMode = true;
    this.confirmCancel = false;
    this.requestRender();
  }

  private closeSearch(apply: boolean): void {
    if (!apply) {
      this.searchBuffer = this.searchInitialQuery;
      this.setSearchQueryForPane(this.searchPane, this.searchInitialQuery);
    }
    this.searchMode = false;
    this.requestRender();
  }

  private usesExactEditor(target = this.editTarget): boolean {
    return this.recoveryEditor || (target?.kind === "line" && target.intent === "modify");
  }

  private captureComposition(): ReviewComposition | null {
    if (this.editTarget == null || this.compositionOrigin == null) return null;
    const view = this.usesExactEditor() ? this.exactEditor.getView() : null;
    return {
      ...this.compositionOrigin, target: structuredClone(this.editTarget), text: this.getEditText(),
      cursor: view == null ? this.editor.getCursor() : { line: view.cursorLine, col: view.cursorColumn },
    };
  }

  private compositionChanged(): void {
    if (this.options.onCompositionSave == null || this.editTarget == null) return;
    this.compositionDirty = true;
    // First-change deadline, not a debounce: continuous typing cannot postpone this write.
    if (this.compositionTimer == null) this.compositionTimer = setTimeout(() => {
      this.compositionTimer = null;
      if (!this.flushComposition()) this.compositionChanged();
    }, COMPOSITION_FLUSH_MS);
  }

  private flushComposition(): boolean {
    if (this.compositionTimer != null) clearTimeout(this.compositionTimer);
    this.compositionTimer = null;
    if (!this.compositionDirty) return true;
    const composition = this.captureComposition();
    if (composition == null) return true;
    if (this.options.onCompositionSave?.(composition) === false) {
      this.setMessage("Recovery could not be saved. Keep this editor open; retry or copy the text before leaving.");
      this.requestRender(false);
      return false;
    }
    this.compositionDirty = false;
    return true;
  }

  private async recoverComposition(composition: ReviewComposition): Promise<void> {
    const target = structuredClone(composition.target);
    const file = target.kind === "all" ? undefined : this.files.find((candidate) => candidate.id === target.fileId);
    this.recoveryOnly = composition.repoRoot !== this.repoRoot || (target.kind !== "all" && (file == null
      || !this.visibleScopes().includes(target.scope) || !getScopedFiles([file], target.scope).length
      || (composition.path != null && composition.path !== joinReviewPath(file.pathPrefix, file.path))));
    if (target.kind === "all") await this.ensureActiveEntry();
    if (!this.recoveryOnly && file != null && target.kind !== "all") {
      this.state = setScope(this.state, this.files, target.scope);
      this.state = setActiveFileId(this.state, this.files, file.id);
      await this.ensureActiveEntry();
      if (target.kind === "line") {
        const entry = this.getEntry(file.id, target.scope);
        target.anchorStatus = validateReviewDraftAnchor({ ...target, id: "recovery", body: composition.text }, file, entry?.status === "ready" ? entry.contents : undefined);
        this.state = setSelectedLineTarget(this.state, file.id, target.scope, composition.selection ?? { side: target.side, line: target.endLine, endLine: target.startLine });
      }
    }
    if (this.disposed) return;
    this.recoveryEditor = true;
    this.recoveredFrom = composition.id;
    this.openEditor(target, composition);
    this.exactEditor.setText(composition.text);
    this.exactEditor.restoreCursor(composition.cursor);
    this.recoveringComposition = false;
    this.compositionChanged();
    // Fork before editing; another explicit resume may consume the source copy.
    if (!this.flushComposition()) { this.compositionChanged(); return; }
    this.setMessage(this.recoveryOnly
      ? "Recovered text: original target unavailable. Copy/manual-reanchor; Ctrl+C parks without applying."
      : "Recovered editable text; nothing submitted. Enter saves; Ctrl+C parks the buffer.");
    this.requestRender();
  }

  private currentEditComment(target: EditTarget): DiffReviewComment | undefined {
    if (target.kind === "all") return undefined;
    if (target.kind === "file") return getFileComment(this.state, target.fileId, target.scope, target.fileTarget);
    return (target.existingComment == null ? undefined : this.state.draft.comments.find((comment) => comment.id === target.existingComment?.id))
      ?? getLineComment(this.state, target.fileId, target.scope, target.side, target.startLine);
  }

  private currentEditBody(target: EditTarget): string {
    return target.kind === "all" ? this.state.draft.allComment : this.currentEditComment(target)?.body ?? "";
  }

  private captureCurrentVersion(copy: ReviewComposition, body: string): ReviewComposition {
    let target = copy.target;
    const comment = this.currentEditComment(target);
    if (target.kind === "all") target = { ...target, intent: this.state.draft.allIntent };
    else if (comment != null) {
      if (target.kind === "file") target = { ...target, intent: comment.intent };
      else target = { ...target, ...comment, kind: "line", side: comment.side === "file" ? target.side : comment.side,
        startLine: comment.startLine ?? target.startLine, endLine: comment.endLine ?? target.endLine,
        anchorStatus: comment.startLine == null || comment.endLine == null ? "stale" : comment.anchorStatus,
        initialBody: body, existingComment: structuredClone(comment) };
    }
    const file = target.kind === "all" ? undefined : this.files.find((file) => file.id === comment?.fileId);
    return { ...copy, target, text: body, baseBody: copy.text, cursor: { line: 0, col: 0 },
      path: file == null ? copy.path : joinReviewPath(file.pathPrefix, file.path), selection: undefined };
  }

  /** Public insertion avoids Pi's opaque collapsed-paste markers, so getCursor indexes persisted text. */
  private handleEditorTextInput(data: string): void {
    const start = "\u001b[200~";
    const end = "\u001b[201~";
    data = this.commentPastePrefix + data;
    this.commentPastePrefix = "";
    if (this.commentPaste == null && data.length > 1 && start.startsWith(data)) {
      this.commentPastePrefix = data;
      return;
    }
    const input = (text: string) => this.usesExactEditor() ? this.exactEditor.handleInput(text) : this.editor.handleInput(text);
    if (this.commentPaste == null && data.includes(start)) {
      const offset = data.indexOf(start);
      if (offset > 0) input(data.slice(0, offset));
      this.commentPaste = data.slice(offset + start.length);
    } else if (this.commentPaste != null) this.commentPaste += data;
    else { input(data); return; }
    const offset = this.commentPaste.indexOf(end);
    if (offset < 0) return;
    const text = this.commentPaste.slice(0, offset);
    if (this.usesExactEditor()) this.exactEditor.handleInput(start + text + end);
    else this.editor.insertTextAtCursor(text);
    const remaining = this.commentPaste.slice(offset + end.length);
    this.commentPaste = null;
    if (remaining.length > 0) this.handleEditorTextInput(remaining);
  }

  private getEditText(): string {
    return this.usesExactEditor() ? this.exactEditor.getText() : this.editor.getExpandedText();
  }

  private openEditor(target: EditTarget, recovered?: ReviewComposition): void {
    // Establish discoverable snapshot membership once, not on every typed character.
    if (this.options.onCompositionSave != null) this.persistSession();
    const fileId = target.kind === "all" ? undefined : target.fileId;
    const file = this.files.find((candidate) => candidate.id === fileId);
    if (target.kind === "line" && recovered == null && target.captureHash == null) {
      const entry = this.getEntry(target.fileId, target.scope);
      const source = this.getSourceContent(target.fileId, target.scope, target.side);
      target = { ...target, captureHash: hashTargetSlice(source, target),
        originalText: target.originalText ?? getSourceLineRangeText(source, target.startLine, target.endLine),
        anchorStatus: entry?.status === "ready" && (target.side === "added" ? entry.contents.modifiedAvailable : entry.contents.originalAvailable) !== false ? "mapped" : "stale" };
    }
    this.compositionOrigin = { id: createReviewInstanceId(), repoRoot: recovered?.repoRoot ?? this.repoRoot,
      path: recovered?.path ?? (file == null ? undefined : joinReviewPath(file.pathPrefix, file.path)),
      selection: recovered?.selection ?? (target.kind === "line" ? getSelectedLineTarget(this.state, target.fileId, target.scope) ?? undefined : undefined),
      target, baseBody: recovered?.baseBody ?? this.currentEditBody(target), text: target.initialBody, cursor: { line: 0, col: 0 } };
    this.commentPaste = null;
    this.commentPastePrefix = "";
    this.conflictCopyId = null;
    this.paneVisibility = { ...this.paneVisibility, diff: true };
    this.state = setFocus(this.state, "diff");
    this.editTarget = target;
    if (target.kind !== "line") this.diffScroll = 0;
    if (this.usesExactEditor(target)) {
      this.exactEditor.setText(target.initialBody, true);
    } else {
      this.editor.setText(target.initialBody);
    }
    this.syncCursorMode();
    this.compositionChanged();
    this.requestRender();
  }

  private setEditIntent(intent: CommentIntent): void {
    const target = this.editTarget;
    if (target == null || (target.kind !== "line" && intent === "modify")) return;
    const currentText = this.getEditText();
    if (this.recoveryEditor) {
      this.editTarget = { ...target, intent };
      this.compositionChanged();
      this.requestRender();
      return;
    }
    if (intent === "modify" && target.kind === "line") {
      const sourceText = target.originalText
        ?? (target.anchorStatus === "stale" ? "" : this.getSourceLinesText(target.fileId, target.scope, target.side, target.startLine, target.endLine));
      const nextText = currentText.length > 0 ? currentText : sourceText;
      this.exactEditor.setText(nextText, nextText === sourceText);
    } else if (target.intent === "modify") {
      this.editor.setText(this.exactEditor.isSelectionArmed() ? "" : currentText);
    }
    this.editTarget = { ...target, intent };
    this.syncCursorMode();
    this.compositionChanged();
    this.requestRender();
  }

  private toggleEditIntent(): void {
    if (this.editTarget == null) return;
    const order: CommentIntent[] = this.editTarget.kind === "line"
      ? ["discuss", "comment", "modify"]
      : ["discuss", "comment"];
    const next = order[(order.indexOf(this.editTarget.intent) + 1) % order.length]!;
    this.setEditIntent(next);
  }

  private saveEditor(replaceConflict = false): void {
    const target = this.editTarget;
    if (target == null || !this.flushComposition()) return;
    if (this.recoveryOnly) {
      this.setMessage("Original target unavailable. Copy the recovered text and manually reanchor; Ctrl+C parks it.");
      this.requestRender();
      return;
    }
    const value = this.getEditText();
    if (this.recoveredFrom != null && target.kind === "line"
      && target.anchorStatus !== "stale" && target.existingComment?.anchorStatus !== "stale") {
      const currentId = this.currentEditComment(target)?.id;
      // upsertLineComment removes every overlap; the single-comment archive cannot protect extras.
      const replacesOtherComments = this.state.draft.comments.some((comment) => comment.id !== currentId
        && comment.fileId === target.fileId && comment.scope === target.scope && comment.side === target.side
        && comment.startLine != null && comment.startLine <= target.endLine
        && target.startLine <= (comment.endLine ?? comment.startLine));
      if (replacesOtherComments) {
        this.setMessage("Recovered range overlaps other feedback. Merge manually; current comments and editor retained.");
        this.requestRender(false);
        return;
      }
    }
    const current = this.currentEditBody(target);
    if (this.recoveredFrom != null && current !== this.compositionOrigin?.baseBody && current !== value) {
      if (!replaceConflict) {
        this.compositionConflictPending = true;
        this.requestRender(false);
        return;
      }
      const copy = this.captureComposition()!;
      this.conflictCopyId ??= createReviewInstanceId();
      if (this.options.onCompositionSave?.(this.captureCurrentVersion({ ...copy, id: this.conflictCopyId }, current)) === false) {
        this.setMessage("Could not preserve current text. No replacement saved; keep this editor open.");
        this.requestRender(false);
        return;
      }
    }
    const previousState = this.state;
    if (target.kind === "line" && target.intent === "modify" && isUnchangedModify(target.originalText, value)) {
      this.setMessage("No code change to save. Type or paste a replacement, or press Esc to cancel.");
      this.requestRender();
      return;
    }

    if (target.kind === "all") {
      this.state = setAllComment(this.state, value, target.intent);
    } else if (target.kind === "file") {
      this.state = upsertFileComment(this.state, target.fileId, target.scope, value, target.intent, target.fileTarget);
    } else if (target.anchorStatus === "stale" || target.existingComment?.anchorStatus === "stale") {
      const original: DiffReviewComment = {
        fileId: target.fileId, scope: target.scope, side: target.side,
        intent: target.intent, body: "", startLine: target.startLine, endLine: target.endLine,
        captureHash: target.captureHash, originalText: target.originalText, anchorStatus: "stale",
        ...target.existingComment,
        id: this.currentEditComment(target)?.id ?? target.existingComment?.id ?? this.compositionOrigin!.id,
      };
      const storedBody = target.intent === "modify" ? value : value.trim();
      const hasContent = target.intent === "modify"
        ? storedBody !== original.originalText && (storedBody.length > 0 || (original.originalText?.length ?? 0) > 0)
        : storedBody.length > 0;
      this.state = hasContent
        ? {
            ...this.state,
            draft: {
              ...this.state.draft,
              comments: this.state.draft.comments.some((comment) => comment.id === original.id)
                ? this.state.draft.comments.map((comment) => comment.id === original.id ? { ...original, intent: target.intent, body: storedBody, anchorStatus: "stale" as const } : comment)
                : [...this.state.draft.comments, { ...original, intent: target.intent, body: storedBody, anchorStatus: "stale" as const }],
            },
          }
        : deleteComment(this.state, original.id);
    } else {
      this.state = upsertLineComment(
        this.state,
        target.fileId,
        target.scope,
        target.side,
        target.startLine,
        value,
        target.intent,
        target.endLine,
        target.intent === "modify" ? target.originalText : undefined,
        target.captureHash,
        "mapped",
      );
    }

    if (!this.persistSession()) {
      this.state = previousState;
      this.setMessage("Could not commit feedback. Editor and recovery retained; retry when storage is available.");
      this.requestRender(false);
      return;
    }
    // The generation-checked snapshot is committed before any recovery copy is consumed.
    if (!this.removeCompositionCopies()) {
      this.setMessage("Feedback saved, but recovery cleanup failed. The editor remains open; retry cleanup.");
      this.requestRender(false);
      return;
    }
    this.closeEditor();
    this.requestRender(false);
  }

  private removeCompositionCopies(): boolean {
    for (const id of [this.compositionOrigin?.id, this.recoveredFrom]) {
      if (id != null && this.options.onCompositionRemove?.(id) === false) return false;
    }
    return true;
  }

  private closeEditor(): void {
    if (this.compositionTimer != null) clearTimeout(this.compositionTimer);
    this.compositionTimer = null;
    this.compositionDirty = false;
    this.compositionOrigin = null;
    this.recoveredFrom = null;
    this.recoveryEditor = false;
    this.recoveryOnly = false;
    this.commentPaste = null;
    this.commentPastePrefix = "";
    this.editTarget = null;
    this.syncCursorMode();
  }

  private cancelEditor(): void {
    if (this.recoveredFrom != null ? !this.flushComposition() : !this.removeCompositionCopies()) return;
    this.closeEditor();
    this.requestRender();
  }

  private getSourceContent(fileId: string, scope: ReviewScope, side: ReviewLineTarget["side"]): string {
    const entry = this.getEntry(fileId, scope);
    if (entry?.status !== "ready") return "";
    return side === "deleted" ? entry.contents.originalContent : entry.contents.modifiedContent;
  }

  private getSourceLinesText(fileId: string, scope: ReviewScope, side: ReviewLineTarget["side"], startLine: number, endLine: number): string {
    return getSourceLineRangeText(this.getSourceContent(fileId, scope, side), startLine, endLine);
  }

  private editLineCommentWithIntent(defaultIntent: CommentIntent): void {
    const file = this.activeFile();
    if (file == null) return;
    const target = getSelectedLineTarget(this.state, file.id, this.state.activeScope);
    if (target == null) {
      this.setMessage("No selectable diff line in view.");
      this.requestRender();
      return;
    }
    const range = getLineTargetRange(target);
    const existing = getLineComment(this.state, file.id, this.state.activeScope, target.side, target.line);
    const startLine = existing?.startLine ?? range.startLine;
    const endLine = existing?.endLine ?? range.endLine;
    const editingStale = existing?.anchorStatus === "stale";
    const sourceText = defaultIntent === "modify" && !editingStale
      ? this.getSourceLinesText(file.id, this.state.activeScope, target.side, startLine, endLine)
      : existing?.originalText ?? "";
    const initialBody = existing != null && (existing.intent === defaultIntent || editingStale)
      ? existing.body
      : defaultIntent === "modify"
        ? sourceText
        : existing?.body ?? "";
    this.openEditor({
      kind: "line",
      fileId: file.id,
      scope: this.state.activeScope,
      side: target.side,
      startLine,
      endLine,
      initialBody,
      intent: defaultIntent,
      originalText: existing?.originalText ?? (defaultIntent === "modify" && sourceText.length > 0 ? sourceText : undefined),
      captureHash: existing?.captureHash,
      anchorStatus: existing?.anchorStatus,
      existingComment: existing,
    });
  }

  private editLineComment(): void {
    const file = this.activeFile();
    if (file == null) return;
    const target = getSelectedLineTarget(this.state, file.id, this.state.activeScope);
    if (target == null) {
      this.setMessage("No selectable diff line in view.");
      this.requestRender();
      return;
    }
    const range = getLineTargetRange(target);
    const existing = getLineComment(this.state, file.id, this.state.activeScope, target.side, target.line);
    const startLine = existing?.startLine ?? range.startLine;
    const endLine = existing?.endLine ?? range.endLine;
    const sourceText = this.getSourceLinesText(file.id, this.state.activeScope, target.side, startLine, endLine);
    this.openEditor({
      kind: "line",
      fileId: file.id,
      scope: this.state.activeScope,
      side: target.side,
      startLine,
      endLine,
      initialBody: existing?.body ?? "",
      intent: existing?.intent ?? "discuss",
      originalText: existing?.originalText ?? (sourceText.length > 0 ? sourceText : undefined),
      captureHash: existing?.captureHash,
      anchorStatus: existing?.anchorStatus,
      existingComment: existing,
    });
  }

  private editFileComment(): void {
    const file = this.activeFile();
    if (file == null) return;
    const existing = getFileComment(this.state, file.id, this.state.activeScope, "file");
    this.openEditor({
      kind: "file",
      fileId: file.id,
      scope: this.state.activeScope,
      initialBody: existing?.body ?? "",
      intent: existing?.intent ?? "comment",
      fileTarget: "file",
    });
  }

  private editReviewWideNote(): void {
    this.openEditor({ kind: "all", initialBody: this.state.draft.allComment, intent: this.state.draft.allIntent });
  }

  private editAllLinesComment(): void {
    const file = this.activeFile();
    if (file == null) return;
    const existing = getFileComment(this.state, file.id, this.state.activeScope, "all-lines");
    this.openEditor({
      kind: "file",
      fileId: file.id,
      scope: this.state.activeScope,
      initialBody: existing?.body ?? "",
      intent: existing?.intent ?? "comment",
      fileTarget: "all-lines",
      label: "All lines in current file",
    });
  }

  private editCurrentLineComment(): void {
    const file = this.activeFile();
    if (file == null) return;
    const target = getSelectedLineTarget(this.state, file.id, this.state.activeScope);
    if (target == null) return;
    const existing = getLineComment(this.state, file.id, this.state.activeScope, target.side, target.line);
    if (existing == null) {
      this.setMessage("No line comment on selected line.");
      this.requestRender();
      return;
    }
    this.editLineComment();
  }

  private deleteCurrentLineComment(): void {
    const file = this.activeFile();
    if (file == null) return;
    const target = getSelectedLineTarget(this.state, file.id, this.state.activeScope);
    if (target == null) return;
    const existing = getLineComment(this.state, file.id, this.state.activeScope, target.side, target.line);
    if (existing == null) return;
    this.state = deleteComment(this.state, existing.id);
    this.requestRender();
  }

  private deleteSelectedComment(): void {
    const file = this.activeFile();
    const items = getCommentPanelItems(this.state, file?.id ?? null, this.state.activeScope, this.commentsGlobal);
    const item = items[this.state.selectedCommentIndex];
    if (item == null) return;
    if (item.kind === "all") {
      this.state = setAllComment(this.state, "", this.state.draft.allIntent);
    } else {
      this.state = deleteComment(this.state, item.comment.id);
    }
    this.requestRender();
  }

  private editSelectedComment(): void {
    const file = this.activeFile();
    const items = getCommentPanelItems(this.state, file?.id ?? null, this.state.activeScope, this.commentsGlobal);
    const item = items[this.state.selectedCommentIndex];
    if (item == null) return;
    if (item.kind === "all") {
      this.editReviewWideNote();
      return;
    }
    const commentFile = this.files.find((candidate) => candidate.id === item.comment.fileId);
    if (commentFile == null || !this.visibleScopes().includes(item.comment.scope)) {
      this.setMessage("Open the comment's repository frame before editing it.");
      this.requestRender();
      return;
    }
    if (this.state.activeScope !== item.comment.scope) this.state = setScope(this.state, this.files, item.comment.scope);
    this.state = setActiveFileId(this.state, this.files, commentFile.id);
    void this.ensureActiveEntry();
    if (item.comment.side === "file") {
      if (item.comment.fileTarget === "all-lines") this.editAllLinesComment();
      else this.editFileComment();
      return;
    }
    this.state = setSelectedLineTarget(this.state, item.comment.fileId, item.comment.scope, {
      side: item.comment.side,
      line: item.comment.endLine ?? item.comment.startLine ?? 1,
      endLine: item.comment.startLine != null && item.comment.endLine != null && item.comment.endLine !== item.comment.startLine
        ? item.comment.startLine
        : undefined,
    });
    this.editLineComment();
  }

  private openSelectedLineInCode(): void {
    const file = this.activeFile();
    if (this.state.activeScope !== "git-diff") {
      this.setMessage("Open in /code is available only for the local working-tree review.");
      this.requestRender();
      return;
    }
    if (file == null) {
      this.setMessage("No current file is selected.");
      this.requestRender();
      return;
    }
    const target = getSelectedLineTarget(this.state, file.id, this.state.activeScope);
    if (target == null) {
      this.setMessage("No current diff line is selected.");
      this.requestRender();
      return;
    }
    if (target.side !== "added") {
      this.setMessage("Deleted/old-side lines have no writable current-side /code target.");
      this.requestRender();
      return;
    }
    if (!file.hasWorkingTreeFile) {
      this.setMessage("The selected file does not exist in the writable working tree.");
      this.requestRender();
      return;
    }
    const entry = this.getEntry(file.id, "git-diff");
    if (entry?.status !== "ready") {
      this.setMessage("Diff is still loading; try again in a moment.");
      this.requestRender();
      return;
    }
    const range = getLineTargetRange(target);
    const changedCurrentLines = new Set(buildStructuredDiff(entry.contents.originalContent, entry.contents.modifiedContent, 0).rows
      .filter((row) => (row.kind === "insert" || row.kind === "replace") && row.newLineNumber != null)
      .map((row) => row.newLineNumber!));
    if (Array.from({ length: range.endLine - range.startLine + 1 }, (_, index) => range.startLine + index).some((line) => !changedCurrentLines.has(line))) {
      this.setMessage("Open in /code requires a current-side changed diff range.");
      this.requestRender();
      return;
    }
    const anchor = hashTargetSlice(entry.contents.modifiedContent, range);
    const contextBefore = 3;
    const contextAfter = 3;
    const lineCount = logicalLineCount(entry.contents.modifiedContent);
    const context = {
      before: contextBefore,
      after: contextAfter,
      hash: hashTargetSlice(entry.contents.modifiedContent, {
        startLine: Math.max(1, range.startLine - contextBefore),
        endLine: Math.min(lineCount, range.endLine + contextAfter),
      }),
    };
    const path = joinReviewPath(file.pathPrefix, file.gitDiff?.newPath ?? file.path);
    if (!this.persistSession()) {
      this.setMessage("Could not save the full review draft. The review remains open; retry before opening /code.");
      this.requestRender();
      return;
    }
    this.done({
      type: "open-code",
      target: { path, range, anchor },
      resume: {
        version: 2,
        repository: this.repoRoot,
        sessionId: this.options.reviewSessionId ?? "current",
        identity: this.options.reviewIdentity ?? `${this.repoRoot}|working|worktree|local`,
        scope: "git-diff",
        scopeFingerprint: this.options.reviewScopeFingerprint,
        path,
        side: "added",
        range,
        focus: { pane: this.state.focus, fileIndex: this.files.findIndex((candidate) => candidate.id === file.id), navigatorScroll: this.navigatorScroll, diffScroll: this.diffScroll, commentsScroll: this.commentsScroll },
        contextHash: anchor,
        selectedHash: anchor,
        context,
      },
    });
  }

  private openSelectedLineInEditor(): void {
    const file = this.activeFile();
    if (file == null) {
      this.setMessage("No file selected.");
      this.requestRender();
      return;
    }

    if (this.state.activeScope !== "git-diff") {
      this.setMessage("Open in $EDITOR is available only for the local working-tree review.");
      this.requestRender();
      return;
    }

    const target = getSelectedLineTarget(this.state, file.id, this.state.activeScope);
    if (target == null) {
      this.setMessage("No selectable diff line to open in $EDITOR.");
      this.requestRender();
      return;
    }
    if (target.side !== "added") {
      this.setMessage("Deleted/old-side lines have no writable current-side $EDITOR target.");
      this.requestRender();
      return;
    }

    if (!file.hasWorkingTreeFile) {
      this.setMessage("Cannot open this file in $EDITOR because it does not exist in the working tree.");
      this.requestRender();
      return;
    }

    const entry = this.getEntry(file.id, "git-diff");
    if (entry?.status !== "ready") {
      this.setMessage("Diff is still loading; try again in a moment.");
      this.requestRender();
      return;
    }
    if (entry.contents.modifiedAvailable === false) {
      this.setMessage("Current working-tree content is unavailable for $EDITOR.");
      this.requestRender();
      return;
    }
    const range = getLineTargetRange(target);
    const changedCurrentLines = new Set(buildStructuredDiff(entry.contents.originalContent, entry.contents.modifiedContent, 0).rows
      .filter((row) => (row.kind === "insert" || row.kind === "replace") && row.newLineNumber != null)
      .map((row) => row.newLineNumber!));
    if (Array.from({ length: range.endLine - range.startLine + 1 }, (_, index) => range.startLine + index).some((line) => !changedCurrentLines.has(line))) {
      this.setMessage("Open in $EDITOR requires a current-side changed diff range.");
      this.requestRender();
      return;
    }

    const filePath = resolve(this.repoRoot, file.path);
    const relativePath = relative(resolve(this.repoRoot), filePath);
    if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      this.setMessage("Cannot open a file outside the repository in $EDITOR.");
      this.requestRender();
      return;
    }

    const diff = this.getDisplayDiff(file.id, this.state.activeScope);
    if (diff == null) {
      this.setMessage("Diff is still loading; try again in a moment.");
      this.requestRender();
      return;
    }

    const editorLine = getEditorLineForTarget(diff, target);
    const editorCommand = (process.env.EDITOR || process.env.VISUAL || "vi").trim() || "vi";
    let launch: { command: string; args: string[] };
    try {
      launch = buildEditorLaunchArgs(editorCommand, filePath, editorLine);
    } catch (error) {
      this.setMessage(error instanceof Error ? error.message : String(error));
      this.requestRender();
      return;
    }

    let resume: ReviewResumeReference | undefined;
    if (this.state.activeScope === "git-diff") {
      const range = { startLine: editorLine, endLine: editorLine };
      const anchor = hashTargetSlice(entry.contents.modifiedContent, range);
      const contextBefore = 3;
      const contextAfter = 3;
      const lineCount = logicalLineCount(entry.contents.modifiedContent);
      resume = {
        version: 2,
        repository: this.repoRoot,
        sessionId: this.options.reviewSessionId ?? "current",
        identity: this.options.reviewIdentity ?? `${this.repoRoot}|working|worktree|local`,
        scope: "git-diff",
        scopeFingerprint: this.options.reviewScopeFingerprint,
        path: joinReviewPath(file.pathPrefix, file.gitDiff?.newPath ?? file.path),
        side: "added",
        range,
        focus: { pane: this.state.focus, fileIndex: this.files.findIndex((candidate) => candidate.id === file.id), navigatorScroll: this.navigatorScroll, diffScroll: this.diffScroll, commentsScroll: this.commentsScroll },
        contextHash: anchor,
        selectedHash: anchor,
        context: {
          before: contextBefore,
          after: contextAfter,
          hash: hashTargetSlice(entry.contents.modifiedContent, {
            startLine: Math.max(1, editorLine - contextBefore),
            endLine: Math.min(lineCount, editorLine + contextAfter),
          }),
        },
      };
    }

    if (!this.persistSession()) {
      this.setMessage("Could not save the full review draft. The review remains open; retry before opening $EDITOR.");
      this.requestRender();
      return;
    }
    this.done({
      type: "open-editor",
      command: launch.command,
      args: launch.args,
      filePath,
      line: editorLine,
      ...(resume == null ? {} : { resume }),
    });
  }

  private hasModifiedScopeSource(file: ReviewFile, scope: ReviewScope): boolean {
    const comparison = getScopeComparison(file, scope);
    return comparison?.hasModified === true
      || (scope === "all-files" && comparison == null && file.inAllFiles && file.hasWorkingTreeFile);
  }

  private snapshotReanchorComment(comment: DiffReviewComment): Readonly<DiffReviewComment> {
    return Object.freeze({
      ...comment,
      ...(comment.captureHash == null ? {} : { captureHash: Object.freeze({ ...comment.captureHash }) }),
    });
  }

  private activateReanchor(transaction: Extract<ReanchorTransaction, { phase: "loading" }>, file: ReviewFile): void {
    if (this.reanchorTarget !== transaction) return;
    if (this.state.activeScope !== transaction.scope || this.state.activeFileId !== file.id) {
      this.reanchorTarget = null;
      this.setMessage("Reanchor stopped because its file or scope changed before loading completed.");
      this.requestRender();
      return;
    }
    const entry = this.getEntry(file.id, transaction.scope);
    if (entry?.status !== "ready") {
      this.reanchorTarget = null;
      this.setMessage(entry?.status === "error"
        ? `Could not load modified comparison bytes for reanchor: ${entry.error}`
        : "Could not load modified comparison bytes for reanchor.");
      this.requestRender();
      return;
    }
    if (entry.contents.modifiedAvailable === false) {
      this.reanchorTarget = null;
      this.setMessage("This stale draft cannot be reanchored because its modified comparison bytes are unavailable.");
      this.requestRender();
      return;
    }
    const addedTargets = this.getVisibleLineTargets(file.id, transaction.scope).filter((target) => target.side === "added");
    if (addedTargets.length === 0) {
      this.reanchorTarget = null;
      this.setMessage("This stale draft has loaded modified bytes but no modified/current-side range to reanchor.");
      this.requestRender();
      return;
    }
    const current = getSelectedLineTarget(this.state, file.id, transaction.scope);
    if (current == null || current.side !== "added") {
      this.state = setSelectedLineTarget(this.state, file.id, transaction.scope, addedTargets[0]!);
    }
    this.reanchorTarget = { ...transaction, phase: "selecting" };
    this.setMessage("Reanchor: choose a current range with Up/Down or Shift+Up/Down, Enter to confirm, Esc to cancel.");
    this.requestRender();
  }

  private beginReanchorSelectedComment(): void {
    const items = getCommentPanelItems(this.state, this.state.activeFileId, this.state.activeScope, this.commentsGlobal);
    const item = items[this.state.selectedCommentIndex];
    if (item?.kind !== "comment" || item.comment.side === "file" || item.comment.anchorStatus !== "stale") {
      this.setMessage("Select a stale line draft to reanchor.");
      this.requestRender();
      return;
    }
    const file = this.files.find((candidate) => candidate.id === item.comment.fileId);
    if (file == null
      || !this.visibleScopes().includes(item.comment.scope)
      || !this.hasModifiedScopeSource(file, item.comment.scope)
      || getSubmoduleInfo(file, item.comment.scope) != null) {
      this.setMessage("This stale draft has no available modified/current-side comparison to reanchor.");
      this.requestRender();
      return;
    }
    const transaction: Extract<ReanchorTransaction, { phase: "loading" }> = {
      phase: "loading",
      commentId: item.comment.id,
      fileId: file.id,
      scope: item.comment.scope,
      originalComment: this.snapshotReanchorComment(item.comment),
    };
    this.reanchorTarget = transaction;
    this.state = setScope(this.state, this.files, item.comment.scope);
    this.state = setActiveFileId(this.state, this.files, file.id);
    this.state = setFocus(this.state, "diff");
    const entry = this.getEntry(file.id, item.comment.scope);
    if (entry?.status === "ready" || entry?.status === "error") {
      this.activateReanchor(transaction, file);
      return;
    }
    this.setMessage("Loading the draft's modified comparison before reanchor…");
    void this.ensureActiveEntry().then(() => this.activateReanchor(transaction, file));
    this.requestRender();
  }

  private moveReanchorSelection(delta: number, extend: boolean): void {
    const pending = this.reanchorTarget;
    if (pending?.phase !== "selecting") return;
    const targets = this.getVisibleLineTargets(pending.fileId, pending.scope).filter((target) => target.side === "added");
    if (!extend) {
      this.state = moveSelectedLineTarget(this.state, pending.fileId, pending.scope, targets, delta);
      this.requestRender();
      return;
    }
    const current = getSelectedLineTarget(this.state, pending.fileId, pending.scope);
    if (current == null || current.side !== "added") return;
    const currentIndex = targets.findIndex((target) => target.line === current.line);
    const next = targets[currentIndex + Math.sign(delta)];
    if (next == null || next.line !== current.line + Math.sign(delta)) return;
    this.state = extendSelectedLineTarget(this.state, pending.fileId, pending.scope, targets, delta);
    this.requestRender();
  }

  private applyReanchorCandidate(transaction: ReanchorTransactionBase, candidate: Readonly<ReanchorCandidate>, proposedReplacement?: string): void {
    const original = transaction.originalComment;
    this.state = {
      ...this.state,
      draft: {
        ...this.state.draft,
        comments: this.state.draft.comments.map((comment) => comment.id === transaction.commentId ? {
          ...original,
          fileId: candidate.fileId,
          scope: candidate.scope,
          side: "added" as const,
          startLine: candidate.range.startLine,
          endLine: candidate.range.endLine,
          captureHash: candidate.captureHash,
          anchorStatus: "mapped" as const,
          ...(original.intent === "modify"
            ? { body: proposedReplacement ?? original.body, originalText: candidate.originalText }
            : {}),
        } : comment),
      },
    };
    this.reanchorTarget = null;
    this.setMessage("Review draft reanchored.");
    this.requestRender();
  }

  private confirmReanchor(): void {
    const pending = this.reanchorTarget;
    if (pending?.phase === "confirm-modify") {
      this.applyReanchorCandidate(pending, pending.candidate, pending.proposedReplacement);
      return;
    }
    if (pending?.phase !== "selecting") return;
    const file = this.files.find((candidate) => candidate.id === pending.fileId) ?? null;
    const target = file == null ? null : getSelectedLineTarget(this.state, file.id, pending.scope);
    const commentExists = this.state.draft.comments.some((comment) => comment.id === pending.commentId);
    const entry = file == null ? undefined : this.getEntry(file.id, pending.scope);
    if (file == null
      || this.state.activeScope !== pending.scope
      || this.state.activeFileId !== pending.fileId
      || target == null
      || target.side !== "added"
      || !commentExists
      || entry?.status !== "ready"
      || entry.contents.modifiedAvailable === false
      || !this.hasModifiedScopeSource(file, pending.scope)) {
      this.setMessage("Choose an available modified/current-side range before confirming the reanchor.");
      this.requestRender();
      return;
    }
    const range = getLineTargetRange(target);
    const lastLine = logicalLineCount(entry.contents.modifiedContent);
    const availableLines = new Set(this.getVisibleLineTargets(file.id, pending.scope)
      .filter((candidate) => candidate.side === "added")
      .map((candidate) => candidate.line));
    let rangeIsAvailable = range.startLine >= 1 && range.endLine >= range.startLine && range.endLine <= lastLine;
    for (let line = range.startLine; rangeIsAvailable && line <= range.endLine; line += 1) {
      rangeIsAvailable = availableLines.has(line);
    }
    if (!rangeIsAvailable) {
      this.setMessage("Choose a loaded modified/current-side range fully within the available file bounds.");
      this.requestRender();
      return;
    }
    const captureHash = Object.freeze(hashTargetSlice(entry.contents.modifiedContent, range));
    const candidate: Readonly<ReanchorCandidate> = Object.freeze({
      fileId: file.id,
      scope: pending.scope,
      range: Object.freeze({ ...range }),
      captureHash,
      originalText: getSourceLineRangeText(entry.contents.modifiedContent, range.startLine, range.endLine),
    });
    if (pending.originalComment.intent === "modify") {
      const proposedReplacement = pending.originalComment.body;
      this.reanchorTarget = { ...pending, phase: "confirm-modify", candidate, proposedReplacement };
      const preview = sanitizeStatusText(proposedReplacement);
      this.setMessage(`MODIFY reanchor frozen. Proposed replacement: ${preview} • Enter applies this exact candidate; Esc cancels.`);
      this.requestRender();
      return;
    }
    this.applyReanchorCandidate(pending, candidate);
  }

  private cancelReanchor(): void {
    this.reanchorTarget = null;
    this.setMessage("Reanchor cancelled; the draft remains stale and unchanged.");
    this.requestRender();
  }

  private handleReanchorInput(data: string): void {
    const pending = this.reanchorTarget;
    if (pending == null) return;
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.cancelReanchor();
      return;
    }
    if (pending.phase === "loading") return;
    if (pending.phase === "confirm-modify") {
      if (matchesKey(data, Key.enter)) this.confirmReanchor();
      return;
    }
    if (matchesKey(data, Key.shift("down"))) { this.moveReanchorSelection(1, true); return; }
    if (matchesKey(data, Key.shift("up"))) { this.moveReanchorSelection(-1, true); return; }
    if (matchesKey(data, Key.down)) { this.moveReanchorSelection(1, false); return; }
    if (matchesKey(data, Key.up)) { this.moveReanchorSelection(-1, false); return; }
    if (matchesKey(data, Key.enter)) this.confirmReanchor();
  }

  private submit(): void {
    if (!hasSubmittableDraftContent(this.state)) {
      if (hasDraftContent(this.state)) {
        this.setMessage("This draft contains only unresolved or stale items. Reanchor or remove them before submitting.");
        this.requestRender();
        return;
      }
      if (this.options.allowEmptySubmit !== true) {
        this.setMessage("Add at least one line comment, file/all-lines comment, or review-wide note before submitting.");
        this.requestRender();
        return;
      }
    }
    if (!this.persistSession()) {
      this.setMessage("Could not save the full review draft. The review remains open; retry submission after persistence recovers.");
      this.requestRender();
      return;
    }
    this.done({
      type: "submit",
      ...this.state.draft,
      comments: this.state.draft.comments.filter(isSubmittableComment),
    });
  }

  private cancel(disposition: ReviewExitDisposition): void {
    if (this.sessionSaveTimer != null) {
      clearTimeout(this.sessionSaveTimer);
      this.sessionSaveTimer = null;
    }
    if (disposition === "park" && !this.persistSession()) {
      this.setMessage("Could not save the full review draft. The review remains open; retry before parking it.");
      this.requestRender();
      return;
    }
    this.done({ type: "cancel", disposition });
  }

  private requestCancel(): void {
    if (getCancelAction(this.state, this.reviewedFileIds.size) === "cancel") {
      this.cancel("discard");
      return;
    }

    this.confirmCancel = true;
    this.helpMode = false;
    this.shortcutMode = false;
    this.requestRender();
  }

  private keepReviewing(): void {
    this.confirmCancel = false;
    this.requestRender();
  }

  private handleCancelConfirmationInput(data: string): void {
    if (data.toLowerCase() === "d") {
      this.cancel("discard");
      return;
    }

    if (data.toLowerCase() === "p") {
      this.cancel("park");
      return;
    }

    if (matchesKey(data, Key.enter) || matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.keepReviewing();
    }
  }

  private moveHunk(delta: number): void {
    const file = this.activeFile();
    const diff = this.getDisplayDiff(file?.id ?? null, this.state.activeScope);
    if (file == null || diff == null || diff.hunks.length === 0) return;

    const visibleTargets = this.getDiffMovementTargets(file.id, this.state.activeScope);
    const current = getSelectedLineTarget(this.state, file.id, this.state.activeScope) ?? visibleTargets[0] ?? null;
    const targets = diff.hunks
      .map((hunk) => visibleTargets.find((target) => {
        const start = target.side === "deleted"
          ? (hunk.oldStartLine ?? hunk.newStartLine ?? target.line)
          : (hunk.newStartLine ?? hunk.oldStartLine ?? target.line);
        const end = target.side === "deleted"
          ? (hunk.oldEndLine ?? hunk.newEndLine ?? target.line)
          : (hunk.newEndLine ?? hunk.oldEndLine ?? target.line);
        return start <= target.line && target.line <= end;
      }))
      .filter((target): target is ReviewLineTarget => target != null);
    if (targets.length === 0 || current == null) return;

    let index = 0;
    for (let i = 0; i < targets.length; i += 1) {
      const target = targets[i]!;
      if (target.line < current.line || (target.line === current.line && target.side === current.side)) index = i;
    }
    const nextIndex = Math.max(0, Math.min(targets.length - 1, index + delta));
    this.state = setSelectedLineTarget(this.state, file.id, this.state.activeScope, targets[nextIndex]!);
    this.requestRender();
  }

  private expandContextFromSelectedLine(direction: ContextExpansionDirection): void {
    const file = this.activeFile();
    const target = getSelectedLineTarget(this.state, file?.id ?? null, this.state.activeScope);
    const layout = this.getDiffLayout(file?.id ?? null, this.state.activeScope);
    if (file == null || target == null || layout == null) {
      this.setMessage("No selected diff line to expand from.");
      this.requestRender();
      return;
    }

    const rowIndex = layout.displayDiff.rows.findIndex((row) => (
      target.side === "added" ? row.newLineNumber === target.line : row.oldLineNumber === target.line
    ));
    const expansion = getContextExpansionRowIndexes(layout.displayDiff, rowIndex, direction, CONTEXT_EXPANSION_LINES);
    if (expansion.length === 0) {
      this.setMessage(`No hidden lines ${direction} the selected line.`);
      this.requestRender();
      return;
    }

    const key = this.cacheKey(file.id, this.state.activeScope);
    const expandedRows = new Set(this.expandedContextRows.get(key) ?? []);
    for (const expandedRow of expansion) expandedRows.add(expandedRow);
    this.expandedContextRows.set(key, expandedRows);
    this.diffLayoutCache.clear();
    this.setMessage(`Expanded ${expansion.length} line${expansion.length === 1 ? "" : "s"} ${direction}.`);
    this.requestRender();
  }

  private getAvailableShortcuts(): CommentShortcut[] {
    const file = this.activeFile();
    const target = getSelectedLineTarget(this.state, file?.id ?? null, this.state.activeScope);
    if (file == null || target == null) return [];
    return getShortcutsForSide(this.options.commentShortcuts, target.side);
  }

  private openShortcutMode(): void {
    if (this.state.activeScope === "all-files") {
      this.setMessage("Template shortcuts are only available in git diff and last commit scopes.");
      this.requestRender();
      return;
    }
    const shortcuts = this.getAvailableShortcuts();
    if (shortcuts.length === 0) {
      this.setMessage("No template shortcuts available for the selected line.");
      this.requestRender();
      return;
    }
    this.paneVisibility = { ...this.paneVisibility, diff: true, comments: true };
    this.helpMode = false;
    this.confirmCancel = false;
    this.shortcutMode = true;
    this.requestRender();
  }

  private closeShortcutMode(): void {
    this.shortcutMode = false;
    this.requestRender();
  }

  private toggleHelpMode(): void {
    this.helpMode = !this.helpMode;
    if (this.helpMode) this.paneVisibility = { ...this.paneVisibility, comments: true };
    this.requestRender();
  }

  private toggleDiffViewMode(): void {
    this.diffViewMode = this.diffViewMode === "unified" ? "side-by-side" : "unified";
    saveReviewPreference({ diffViewMode: this.diffViewMode });
    this.requestRender();
  }

  private selectSideBySideColumn(targetSide: ReviewLineTarget["side"]): boolean {
    if (this.diffViewMode !== "side-by-side" || this.state.focus !== "diff") return false;
    const file = this.activeFile();
    const layout = this.getDiffLayout(file?.id ?? null, this.state.activeScope);
    const current = getSelectedLineTarget(this.state, file?.id ?? null, this.state.activeScope);
    if (file == null || layout == null || current == null || current.side === targetSide) return false;

    const target = getSideBySideColumnTarget(layout.sideBySideRows, current, targetSide);
    if (target == null) return false;
    this.state = setSelectedLineTarget(this.state, file.id, this.state.activeScope, target);
    this.requestRender();
    return true;
  }

  private moveFocusHorizontally(direction: -1 | 1): void {
    if (direction < 0 && this.selectSideBySideColumn("deleted")) return;
    if (direction > 0 && this.selectSideBySideColumn("added")) return;
    this.cycleVisibleFocus(direction < 0);
  }

  private ensureVisibleFocus(): void {
    const visibility = this.effectivePaneVisibility();
    if (visibility[this.state.focus]) return;

    const currentIndex = FOCUSABLE_PANE_ORDER.indexOf(this.state.focus);
    for (let offset = 1; offset <= FOCUSABLE_PANE_ORDER.length; offset += 1) {
      const pane = FOCUSABLE_PANE_ORDER[(currentIndex + offset) % FOCUSABLE_PANE_ORDER.length]!;
      if (visibility[pane]) {
        this.state = setFocus(this.state, pane);
        return;
      }
    }
  }

  private toggleReviewPane(pane: ReviewPaneName): void {
    if (pane === "context" && this.options.contextPanelSource == null) {
      this.setMessage("PR context is not available in this review.");
      this.requestRender();
      return;
    }
    if (pane === "replies" && this.options.repliesSource == null) {
      this.setMessage("Replies are not available in this review.");
      this.requestRender();
      return;
    }

    const visible = !this.paneVisibility[pane];
    this.paneVisibility = { ...this.paneVisibility, [pane]: visible };
    if (pane === "comments" && !visible) {
      this.helpMode = false;
      this.shortcutMode = false;
    }
    if (pane === "context" && visible) this.ensureContextPanel();
    if (pane === "replies" && visible) this.ensureRepliesPanel();
    this.ensureVisibleFocus();
    saveReviewPreference({ paneVisibility: this.paneVisibility });
    this.setMessage(`${REVIEW_PANE_LABELS[pane]} ${visible ? "shown" : "hidden"}.`);
    this.requestRender();
  }

  private toggleCommentsPane(): void {
    this.toggleReviewPane("comments");
  }

  private cycleVisibleFocus(backward = false): void {
    const visibility = this.effectivePaneVisibility();
    const visiblePanes = FOCUSABLE_PANE_ORDER.filter((pane) => visibility[pane]);
    if (visiblePanes.length === 0) {
      this.setMessage("No focusable pane is visible. Press 1, 2, 3, 4, or 5 to show one.");
      this.requestRender();
      return;
    }

    const currentIndex = visiblePanes.indexOf(this.state.focus);
    const step = backward ? -1 : 1;
    const nextIndex = currentIndex < 0
      ? 0
      : (currentIndex + step + visiblePanes.length) % visiblePanes.length;
    this.state = setFocus(this.state, visiblePanes[nextIndex]!);
    this.requestRender();
  }

  private toggleRelatedFilter(): void {
    if (this.relatedFilterAnchorFileId != null) {
      const returnFileId = this.relatedFilterReturnFileId;
      this.relatedFilterAnchorFileId = null;
      this.relatedFilterReturnFileId = null;
      if (returnFileId != null) {
        this.state = setActiveFileId(this.state, this.files, returnFileId);
        void this.ensureActiveEntry();
      }
      this.navigatorScroll = 0;
      this.setMessage("Showing all files.");
      this.requestRender();
      return;
    }

    if (this.state.activeScope !== "all-files") {
      this.setMessage("Related filter is only available in the all files scope.");
      this.requestRender();
      return;
    }

    const file = this.activeFile();
    const relatedPaths = getRelatedFilePaths(file);
    if (file == null || relatedPaths.size === 0) {
      this.setMessage("No related files for the active file.");
      this.requestRender();
      return;
    }

    this.relatedFilterAnchorFileId = file.id;
    this.relatedFilterReturnFileId = file.id;
    this.navigatorScroll = 0;
    this.setMessage(`Showing files related to ${file.path}. Press r to show all files.`);
    this.requestRender();
  }

  private toggleLocaleFiles(): void {
    this.showAllLocales = !this.showAllLocales;
    this.navigatorScroll = 0;
    this.ensureActiveNavigatorFile();
    const hiddenCount = this.getHiddenLocaleFileCount();
    this.setMessage(this.showAllLocales
      ? `Showing all locale files. Press L to hide ${hiddenCount} non-English/non-pt-BR locale file${hiddenCount === 1 ? "" : "s"}.`
      : `Hid ${hiddenCount} non-English/non-pt-BR locale file${hiddenCount === 1 ? "" : "s"}. Press L to show them.`);
    void this.ensureActiveEntry();
    this.requestRender();
  }

  private toggleReviewedFile(): void {
    const file = this.activeFile();
    if (file == null) return;
    if (this.reviewedFileIds.has(file.id)) {
      this.reviewedFileIds.delete(file.id);
      this.setMessage(`Marked ${file.path} as unreviewed.`);
    } else {
      this.reviewedFileIds.add(file.id);
      this.setMessage(`Marked ${file.path} as reviewed.`);
    }
    this.requestRender();
  }

  private moveToUnreviewedFile(direction: 1 | -1): void {
    const files = this.getNavigatorFiles();
    if (files.length === 0) return;
    const currentIndex = Math.max(0, files.findIndex((file) => file.id === this.state.activeFileId));
    for (let step = 1; step <= files.length; step += 1) {
      const index = (currentIndex + direction * step + files.length) % files.length;
      const file = files[index]!;
      if (this.reviewedFileIds.has(file.id)) continue;
      this.state = setActiveFileId(this.state, this.files, file.id);
      void this.ensureActiveEntry();
      this.requestRender();
      return;
    }
    this.setMessage("Every file in this view is marked reviewed.");
    this.requestRender();
  }

  private moveNavigatorSelection(delta: number): void {
    const files = this.getNavigatorFiles();
    if (files.length === 0) {
      this.state = setActiveFileId(this.state, this.files, null);
      this.requestRender();
      return;
    }

    const index = files.findIndex((file) => file.id === this.state.activeFileId);
    const nextIndex = getNavigatorMoveIndex(index, files.length, delta);
    this.state = setActiveFileId(this.state, this.files, files[nextIndex]!.id);
    void this.ensureActiveEntry();
    this.requestRender();
  }

  private moveDiffSelection(delta: number): void {
    const file = this.activeFile();
    if (file == null) return;
    const visibleTargets = this.getDiffMovementTargets(file.id, this.state.activeScope);
    this.state = moveSelectedLineTarget(this.state, file.id, this.state.activeScope, visibleTargets, delta);
    this.requestRender();
  }

  private extendDiffSelection(delta: number): void {
    const file = this.activeFile();
    if (file == null) return;
    const visibleTargets = this.getDiffMovementTargets(file.id, this.state.activeScope);
    this.state = extendSelectedLineTarget(this.state, file.id, this.state.activeScope, visibleTargets, delta);
    this.requestRender();
  }

  private moveCommentSelection(delta: number): void {
    const items = getCommentPanelItems(this.state, this.state.activeFileId, this.state.activeScope, this.commentsGlobal);
    this.state = moveSelectedCommentIndex(this.state, items.length, delta);
    this.requestRender();
  }

  private maxContextScroll(): number {
    return Math.max(0, this.contextLineCount - this.contextPageSize);
  }

  private scrollContextPanel(delta: number): void {
    const next = Math.max(0, Math.min(this.maxContextScroll(), this.contextScroll + delta));
    if (next === this.contextScroll) {
      this.requestRender();
      return;
    }
    this.contextScroll = next;
    this.requestRender();
  }

  private focusedPageSize(): number {
    if (this.state.focus === "navigator") return this.navigatorPageSize;
    if (this.state.focus === "diff") return this.diffPageSize;
    if (this.state.focus === "context") return this.contextPageSize;
    if (this.state.focus === "replies") return this.repliesPageSize;
    return this.commentsPageSize;
  }

  private openUrlInBrowser(url: string, label: string): void {
    const open = this.options.openUrl ?? ((target: string) => openExternalUrl(target));
    void open(url).then((result) => {
      if (result.status === "opened") {
        this.setMessage(`Opened ${result.url} in your browser.`);
        this.requestRender();
        return;
      }
      if (result.status === "invalid") {
        this.setMessage(`${label} URL is not a valid http(s) address.`);
        this.requestRender();
        return;
      }
      void copyToClipboard(result.url).then(() => {
        this.setMessage(`Could not open a browser (${result.error}); copied ${result.url} to the clipboard.`);
        this.requestRender();
      }).catch(() => {
        this.setMessage(`Could not open ${result.url}: ${result.error}`);
        this.requestRender();
      });
    });
  }

  private openPullRequestUrl(): void {
    const url = this.options.contextPanelSource?.url;
    if (url == null || url.trim().length === 0) {
      this.setMessage("No PR URL is available for this review.");
      this.requestRender();
      return;
    }

    this.openUrlInBrowser(url, "PR");
  }

  private moveFocusedSelection(delta: number): void {
    if (this.state.focus === "navigator") {
      this.moveNavigatorSelection(delta);
      return;
    }
    if (this.state.focus === "diff") {
      this.moveDiffSelection(delta);
      return;
    }
    if (this.state.focus === "context") {
      this.scrollContextPanel(delta);
      return;
    }
    if (this.state.focus === "replies") {
      this.moveReplySelection(delta);
      return;
    }
    this.moveCommentSelection(delta);
  }

  private jumpNavigatorSearch(direction: 1 | -1): boolean {
    if (this.state.searchQuery.trim().length === 0) return false;
    const files = this.getNavigatorFiles();
    if (files.length === 0) {
      this.setMessage("No file search matches.");
      this.requestRender();
      return true;
    }
    this.message = null;
    const index = files.findIndex((file) => file.id === this.state.activeFileId);
    const nextIndex = getNextSearchIndex(index, files.length, direction);
    this.state = setActiveFileId(this.state, this.files, files[nextIndex]!.id);
    void this.ensureActiveEntry();
    this.requestRender();
    return true;
  }

  private jumpDiffSearch(direction: 1 | -1, allowCurrent = false): boolean {
    if (this.diffSearchQuery.trim().length === 0) return false;
    const file = this.activeFile();
    if (file == null) return true;
    const rows = this.getDiffLayout(file.id, this.state.activeScope)?.unifiedRows ?? [];
    const matches = getMatchingDiffLineTargets(rows, this.diffSearchQuery);
    if (matches.length === 0) {
      this.setMessage("No code search matches.");
      this.requestRender();
      return true;
    }

    this.message = null;
    const current = getSelectedLineTarget(this.state, file.id, this.state.activeScope);
    let index = current == null ? -1 : matches.findIndex((match) => match.side === current.side && match.line === current.line);
    if (allowCurrent && index >= 0) {
      // Keep the live-search cursor on the current match while typing.
    } else {
      index = getNextSearchIndex(index, matches.length, direction);
    }
    this.state = setSelectedLineTarget(this.state, file.id, this.state.activeScope, matches[index]!);
    this.requestRender();
    return true;
  }

  private getCommentSearchText(item: CommentPanelItem): string {
    if (item.kind === "all") return `all note ${formatIntentLabel(item.intent)} ${item.body}`;
    const comment = item.comment;
    const location = comment.side === "file"
      ? "file"
      : `${comment.side} ${formatLineRangeLabel(comment.startLine ?? 0, comment.endLine ?? comment.startLine ?? 0)}`;
    return `${formatIntentLabel(comment.intent)} ${location} ${comment.body}`;
  }

  private jumpCommentSearch(direction: 1 | -1, allowCurrent = false): boolean {
    const query = this.commentSearchQuery.trim().toLowerCase();
    if (query.length === 0) return false;
    const items = getCommentPanelItems(this.state, this.state.activeFileId, this.state.activeScope, this.commentsGlobal);
    const matches = items
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => this.getCommentSearchText(item).toLowerCase().includes(query));
    if (matches.length === 0) {
      this.setMessage("No comment search matches.");
      this.requestRender();
      return true;
    }

    this.message = null;
    let index = matches.findIndex((match) => match.index === this.state.selectedCommentIndex);
    if (allowCurrent && index >= 0) {
      // Keep the live-search cursor on the current match while typing.
    } else {
      index = getNextSearchIndex(index, matches.length, direction);
    }
    this.state = moveSelectedCommentIndex(this.state, items.length, matches[index]!.index - this.state.selectedCommentIndex);
    this.requestRender();
    return true;
  }

  private jumpSearch(direction: 1 | -1): boolean {
    if (this.state.focus === "navigator") return this.jumpNavigatorSearch(direction);
    if (this.state.focus === "diff") return this.jumpDiffSearch(direction);
    if (this.state.focus === "context" || this.state.focus === "replies") return false;
    return this.jumpCommentSearch(direction);
  }

  private jumpToBoundary(direction: "start" | "end"): void {
    if (this.state.focus === "navigator") {
      const files = this.getNavigatorFiles();
      if (files.length === 0) return;
      const file = direction === "start" ? files[0]! : files[files.length - 1]!;
      this.state = setActiveFileId(this.state, this.files, file.id);
      void this.ensureActiveEntry();
      this.requestRender();
      return;
    }

    if (this.state.focus === "diff") {
      const file = this.activeFile();
      if (file == null) return;
      const visibleTargets = this.getDiffMovementTargets(file.id, this.state.activeScope);
      if (visibleTargets.length === 0) return;
      const target = direction === "start" ? visibleTargets[0]! : visibleTargets[visibleTargets.length - 1]!;
      this.state = setSelectedLineTarget(this.state, file.id, this.state.activeScope, target);
      this.requestRender();
      return;
    }

    if (this.state.focus === "context") {
      this.contextScroll = direction === "start" ? 0 : this.maxContextScroll();
      this.requestRender();
      return;
    }

    if (this.state.focus === "replies") {
      const replies = this.getReplies();
      if (replies.length === 0) return;
      this.selectedReplyIndex = direction === "start" ? 0 : replies.length - 1;
      this.requestRender();
      return;
    }

    const items = getCommentPanelItems(this.state, this.state.activeFileId, this.state.activeScope, this.commentsGlobal);
    if (items.length === 0) return;
    const delta = direction === "start" ? -Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;
    this.state = moveSelectedCommentIndex(this.state, items.length, delta);
    this.requestRender();
  }

  private handleMouseWheel(data: string): boolean {
    const event = parseMouseWheelInput(data);
    if (event == null) return false;

    const pane = this.getPaneAtMousePosition(event.col, event.row);
    if (pane == null) return true;

    const delta = event.direction === "down" ? 1 : -1;
    if (pane === "navigator") {
      this.state = setFocus(this.state, "navigator");
      this.moveNavigatorSelection(delta);
      return true;
    }
    if (pane === "diff") {
      this.state = setFocus(this.state, "diff");
      this.moveDiffSelection(delta);
      return true;
    }
    if (pane === "comments") {
      this.state = setFocus(this.state, "comments");
      this.moveCommentSelection(delta);
      return true;
    }
    if (pane === "context") {
      this.state = setFocus(this.state, "context");
      this.scrollContextPanel(delta);
      return true;
    }
    if (pane === "replies") {
      this.state = setFocus(this.state, "replies");
      this.moveReplySelection(delta);
      return true;
    }

    return true;
  }

  private applyShortcutByKey(key: string): void {
    const file = this.activeFile();
    const target = getSelectedLineTarget(this.state, file?.id ?? null, this.state.activeScope);
    if (file == null || target == null) {
      this.shortcutMode = false;
      this.requestRender();
      return;
    }

    const shortcut = this.getAvailableShortcuts().find((item) => item.key === key.toLowerCase());
    if (shortcut == null) {
      this.setMessage(`No template shortcut for '${key}'.`);
      this.shortcutMode = false;
      this.requestRender();
      return;
    }

    const range = getLineTargetRange(target);
    this.state = upsertLineComment(this.state, file.id, this.state.activeScope, target.side, range.startLine, shortcut.text, shortcut.intent, range.endLine);
    this.shortcutMode = false;
    this.requestRender();
  }

  private appendSearchText(text: string): void {
    const normalized = text.replace(/\r\n|\n|\r/g, " ");
    if (normalized.length === 0 || [...normalized].some((character) => character < " ")) return;
    this.searchBuffer += normalized;
    this.setSearchQueryForPane(this.searchPane, this.searchBuffer);
    this.requestRender();
  }

  private handleSearchInput(data: string): void {
    const pasteStart = "\u001b[200~";
    const pasteEnd = "\u001b[201~";
    if (!this.searchPasteMode && data.includes(pasteStart)) {
      this.searchPasteMode = true;
      this.searchPasteBuffer = data.slice(data.indexOf(pasteStart) + pasteStart.length);
    } else if (this.searchPasteMode) {
      this.searchPasteBuffer += data;
    }
    if (this.searchPasteMode) {
      const endIndex = this.searchPasteBuffer.indexOf(pasteEnd);
      if (endIndex < 0) return;
      const pastedText = this.searchPasteBuffer.slice(0, endIndex);
      const remaining = this.searchPasteBuffer.slice(endIndex + pasteEnd.length);
      this.searchPasteBuffer = "";
      this.searchPasteMode = false;
      this.appendSearchText(pastedText);
      if (remaining.length > 0) this.handleSearchInput(remaining);
      return;
    }

    if (matchesKey(data, Key.escape)) {
      this.searchBuffer = "";
      this.setSearchQueryForPane(this.searchPane, "");
      this.closeSearch(true);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.closeSearch(true);
      return;
    }
    if (matchesKey(data, Key.backspace)) {
      this.searchBuffer = this.searchBuffer.slice(0, -1);
      this.setSearchQueryForPane(this.searchPane, this.searchBuffer);
      this.requestRender();
      return;
    }
    this.appendSearchText(data);
  }

  handleInput(data: string): void {
    if (this.recoveringComposition) return;
    if (this.compositionConflictPending) {
      this.compositionConflictPending = false;
      if (data === "k") this.saveEditor(true);
      else this.requestRender(false);
      return;
    }
    if (this.reanchorTarget != null) {
      this.handleReanchorInput(data);
      return;
    }
    if (this.editTarget == null && this.handleMouseWheel(data)) return;

    if (this.editTarget != null) {
      if (matchesKey(data, Key.ctrl("c"))) {
        if (this.flushComposition()) this.cancel("park");
        return;
      }
      if (matchesKey(data, Key.escape)) {
        this.cancelEditor();
        return;
      }
      if (this.commentPaste != null || this.commentPastePrefix.length > 0) {
        this.handleEditorTextInput(data);
        this.compositionChanged();
        this.requestRender();
        return;
      }
      if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.tab)) {
        this.toggleEditIntent();
        return;
      }
      if (matchesKey(data, Key.shift("enter"))) {
        this.handleEditorTextInput("\n");
        this.compositionChanged();
        this.requestRender();
        return;
      }
      if (matchesKey(data, Key.enter)) {
        this.saveEditor();
        return;
      }
      this.handleEditorTextInput(data);
      this.compositionChanged();
      this.requestRender();
      return;
    }

    if (this.searchMode) {
      this.handleSearchInput(data);
      return;
    }

    if (this.shortcutMode) {
      if (matchesKey(data, Key.escape)) {
        this.closeShortcutMode();
        return;
      }
      if (data.length === 1 && data >= " ") {
        this.applyShortcutByKey(data);
        return;
      }
      return;
    }

    if (this.confirmCancel) {
      this.handleCancelConfirmationInput(data);
      return;
    }

    if (this.pendingVimSequence === "g") {
      this.pendingVimSequence = null;
      if (data === "g") {
        this.jumpToBoundary("start");
        return;
      }
    }

    if (matchesReviewAction("help", data)) { this.toggleHelpMode(); return; }
    if (this.helpMode && matchesKey(data, Key.escape)) { this.helpMode = false; this.requestRender(); return; }

    if (matchesReviewAction("parent", data) && this.navigateBackFromSubmodule()) return;
    if ((this.state.focus === "navigator" || this.state.focus === "diff")
      && this.activeSubmodule() != null
      && (matchesKey(data, Key.enter) || matchesKey(data, Key.right))) {
      void this.openActiveSubmodule();
      return;
    }

    if (/^[1-5]$/.test(data)) {
      this.toggleReviewPane(REVIEW_PANE_ORDER[Number.parseInt(data, 10) - 1]!);
      return;
    }
    const scopeIndex = SCOPE_KEYS.findIndex((key) => matchesKey(data, key));
    const scopes = this.visibleScopes();
    if (scopeIndex >= 0 && scopes.length > 1 && scopeIndex < scopes.length) {
      this.setScope(scopes[scopeIndex]!);
      return;
    }
    if (matchesKey(data, Key.shift("tab"))) { this.cycleVisibleFocus(true); return; }
    if (matchesKey(data, Key.tab)) { this.cycleVisibleFocus(); return; }
    if (matchesKey(data, Key.left)) { this.moveFocusHorizontally(-1); return; }
    if (matchesKey(data, Key.right)) { this.moveFocusHorizontally(1); return; }
    if (data === "g") { this.pendingVimSequence = "g"; return; }
    if (data === "G") { this.jumpToBoundary("end"); return; }
    if (data === "/") { this.openSearch(); return; }
    if (matchesKey(data, Key.ctrl("f"))) { this.moveFocusedSelection(this.focusedPageSize()); return; }
    if (matchesKey(data, Key.ctrl("b"))) { this.moveFocusedSelection(-this.focusedPageSize()); return; }
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) { this.requestCancel(); return; }

    if (this.state.focus === "replies") {
      if (matchesKey(data, Key.down) || data === "j") {
        this.moveReplySelection(1);
        return;
      }
      if (matchesKey(data, Key.up) || data === "k") {
        this.moveReplySelection(-1);
        return;
      }
      if (matchesKey(data, Key.ctrl("d"))) {
        this.moveReplySelection(getHalfPageStep(this.repliesPageSize));
        return;
      }
      if (matchesKey(data, Key.ctrl("u"))) {
        this.moveReplySelection(-getHalfPageStep(this.repliesPageSize));
        return;
      }
      if (matchesKey(data, Key.pageDown)) {
        this.moveReplySelection(this.repliesPageSize);
        return;
      }
      if (matchesKey(data, Key.pageUp)) {
        this.moveReplySelection(-this.repliesPageSize);
        return;
      }
      if (matchesKey(data, Key.enter)) {
        this.openSelectedReply();
        return;
      }
      if (data === "r") {
        this.refreshReplies();
        return;
      }
      if (data === "A") {
        this.analyzeSelectedReply();
        return;
      }
      return;
    }

    if (matchesReviewAction("commentsPane", data)) { this.toggleCommentsPane(); return; }
    if (matchesReviewAction("wrap", data)) { this.state = setWrapLines(this.state, !this.state.wrapLines); this.requestRender(); return; }
    if (matchesReviewAction("view", data)) { this.toggleDiffViewMode(); return; }
    if (matchesReviewAction("unchanged", data)) { this.state = toggleHideUnchanged(this.state); this.ensureLineSelection(); this.requestRender(); return; }
    if (matchesReviewAction("contextNavigation", data)) {
      this.contextLineNavigation = !this.contextLineNavigation;
      saveReviewPreference({ contextLineNavigation: this.contextLineNavigation });
      this.setMessage(this.contextLineNavigation ? "Up/Down includes unchanged context lines." : "Up/Down moves through changed lines only.");
      this.requestRender();
      return;
    }
    if (matchesReviewAction("tree", data)) {
      this.navigatorTreeMode = !this.navigatorTreeMode;
      saveReviewPreference({ navigatorTreeMode: this.navigatorTreeMode });
      this.navigatorScroll = 0;
      this.setMessage(this.navigatorTreeMode ? "Navigator grouped by package." : "Navigator using flat review order.");
      this.requestRender();
      return;
    }
    if (matchesReviewAction("order", data)) {
      this.navigatorFileOrder = this.navigatorFileOrder === "risk" ? "alphabetical" : "risk";
      saveReviewPreference({ navigatorFileOrder: this.navigatorFileOrder });
      this.navigatorScroll = 0;
      this.setMessage(this.navigatorFileOrder === "risk" ? "Navigator ordered by review risk." : "Navigator ordered alphabetically.");
      this.requestRender();
      return;
    }
    if (matchesReviewAction("locales", data)) { this.toggleLocaleFiles(); return; }
    if (matchesReviewAction("reviewed", data)) { this.toggleReviewedFile(); return; }
    if (matchesReviewAction("globalComments", data)) {
      this.commentsGlobal = !this.commentsGlobal;
      saveReviewPreference({ commentsGlobal: this.commentsGlobal });
      this.state = { ...this.state, selectedCommentIndex: 0 };
      this.commentsScroll = 0;
      this.setMessage(this.commentsGlobal ? "Comments shows feedback across all files." : "Comments scoped to the active file.");
      this.requestRender();
      return;
    }
    if (data === "]") { this.moveToUnreviewedFile(1); return; }
    if (data === "[") { this.moveToUnreviewedFile(-1); return; }
    if (data === "y") { this.copySelection("source"); return; }
    if (data === "Y") { this.copySelection("location"); return; }
    if (data === "P") { this.copySelection("patch"); return; }
    if (data === "S") { this.copySelection("suggestion"); return; }
    if (matchesReviewAction("submit", data)) { this.submit(); return; }
    if (matchesReviewAction("fileComment", data)) { this.editFileComment(); return; }
    if (this.state.focus === "diff" && matchesReviewAction("allLines", data)) { this.editAllLinesComment(); return; }
    if (data === "n" && this.jumpSearch(1)) { return; }
    if (data === "N" && this.jumpSearch(-1)) { return; }
    if (data === "n") { this.moveHunk(1); return; }
    if (data === "p") { this.moveHunk(-1); return; }

    if (this.state.focus === "navigator") {
      if (matchesKey(data, Key.down) || data === "j") {
        this.moveNavigatorSelection(1);
        return;
      }
      if (matchesKey(data, Key.up) || data === "k") {
        this.moveNavigatorSelection(-1);
        return;
      }
      if (matchesKey(data, Key.ctrl("d"))) {
        this.moveNavigatorSelection(getHalfPageStep(this.navigatorPageSize));
        return;
      }
      if (matchesKey(data, Key.ctrl("u"))) {
        this.moveNavigatorSelection(-getHalfPageStep(this.navigatorPageSize));
        return;
      }
      if (matchesKey(data, Key.pageDown)) {
        this.moveNavigatorSelection(this.navigatorPageSize);
        return;
      }
      if (matchesKey(data, Key.pageUp)) {
        this.moveNavigatorSelection(-this.navigatorPageSize);
        return;
      }
      if (data === "r") {
        this.toggleRelatedFilter();
        return;
      }
      if (matchesKey(data, Key.enter)) {
        this.state = setFocus(this.state, "diff");
        this.requestRender();
      }
      return;
    }

    if (this.state.focus === "diff") {
      if (matchesReviewAction("expandAbove", data)) {
        this.expandContextFromSelectedLine("above");
        return;
      }
      if (matchesReviewAction("expandBelow", data)) {
        this.expandContextFromSelectedLine("below");
        return;
      }
      if (data === "t") {
        this.openShortcutMode();
        return;
      }
      const file = this.activeFile();
      if (file != null) {
        if (matchesKey(data, Key.shift("down"))) {
          this.extendDiffSelection(1);
          return;
        }
        if (matchesKey(data, Key.shift("up"))) {
          this.extendDiffSelection(-1);
          return;
        }
        if (matchesKey(data, Key.down)) {
          this.moveDiffSelection(1);
          return;
        }
        if (matchesKey(data, Key.up)) {
          this.moveDiffSelection(-1);
          return;
        }
        if (matchesKey(data, Key.ctrl("d"))) {
          this.moveDiffSelection(getHalfPageStep(this.diffPageSize));
          return;
        }
        if (matchesKey(data, Key.ctrl("u"))) {
          this.moveDiffSelection(-getHalfPageStep(this.diffPageSize));
          return;
        }
        if (matchesKey(data, Key.pageDown)) {
          this.moveDiffSelection(this.diffPageSize);
          return;
        }
        if (matchesKey(data, Key.pageUp)) {
          this.moveDiffSelection(-this.diffPageSize);
          return;
        }
        if (data === "o") {
          this.openSelectedLineInCode();
          return;
        }
        if (data === "e") {
          this.openSelectedLineInEditor();
          return;
        }
        if (data === "m" || data === "M" || matchesKey(data, Key.enter)) {
          this.editLineCommentWithIntent("modify");
          return;
        }
        if (data === "d") {
          this.editLineCommentWithIntent("discuss");
          return;
        }
        if (data === "c") {
          this.editLineCommentWithIntent("comment");
          return;
        }
        if (data === "x") {
          this.deleteCurrentLineComment();
          return;
        }
      }
      return;
    }

    if (this.state.focus === "comments") {
      const items = getCommentPanelItems(this.state, this.state.activeFileId, this.state.activeScope, this.commentsGlobal);
      if (matchesKey(data, Key.down) || data === "j") {
        this.moveCommentSelection(1);
        return;
      }
      if (matchesKey(data, Key.up) || data === "k") {
        this.moveCommentSelection(-1);
        return;
      }
      if (matchesKey(data, Key.ctrl("d"))) {
        this.moveCommentSelection(getHalfPageStep(this.commentsPageSize));
        return;
      }
      if (matchesKey(data, Key.ctrl("u"))) {
        this.moveCommentSelection(-getHalfPageStep(this.commentsPageSize));
        return;
      }
      if (matchesKey(data, Key.pageDown)) {
        this.moveCommentSelection(this.commentsPageSize);
        return;
      }
      if (matchesKey(data, Key.pageUp)) {
        this.moveCommentSelection(-this.commentsPageSize);
        return;
      }
      if (data === "a") {
        this.beginReanchorSelectedComment();
        return;
      }
      if (data === "e" || matchesKey(data, Key.enter)) {
        this.editSelectedComment();
        return;
      }
      if (matchesReviewAction("commentDelete", data)) {
        this.deleteSelectedComment();
        return;
      }
    }

    if (this.state.focus === "context") {
      if (matchesKey(data, Key.down) || data === "j") {
        this.scrollContextPanel(1);
        return;
      }
      if (matchesKey(data, Key.up) || data === "k") {
        this.scrollContextPanel(-1);
        return;
      }
      if (matchesKey(data, Key.ctrl("d"))) {
        this.scrollContextPanel(getHalfPageStep(this.contextPageSize));
        return;
      }
      if (matchesKey(data, Key.ctrl("u"))) {
        this.scrollContextPanel(-getHalfPageStep(this.contextPageSize));
        return;
      }
      if (matchesKey(data, Key.pageDown)) {
        this.scrollContextPanel(this.contextPageSize);
        return;
      }
      if (matchesKey(data, Key.pageUp)) {
        this.scrollContextPanel(-this.contextPageSize);
        return;
      }
      if (matchesKey(data, Key.enter)) {
        this.openPullRequestUrl();
        return;
      }
    }
  }

  private renderNavigator(width: number, height: number): string[] {
    const files = this.getNavigatorFiles();
    const lines: string[] = [];
    const relatedAnchor = this.relatedFilterAnchorFile();
    const relatedSuffix = relatedAnchor == null ? "" : ` • related to ${shortenNavigatorPath(relatedAnchor.path, 24)}`;
    const titleSuffix = this.searchMode && this.searchPane === "navigator"
      ? ` (${this.searchBuffer || "…"})`
      : this.state.searchQuery
        ? ` (${this.state.searchQuery})`
        : "";
    const reviewedCount = files.filter((file) => this.reviewedFileIds.has(file.id)).length;
    const hiddenLocaleCount = this.getHiddenLocaleFileCount();
    const localeSuffix = hiddenLocaleCount === 0
      ? ""
      : this.showAllLocales
        ? ` • all locales • L hide ${hiddenLocaleCount}`
        : ` • ${hiddenLocaleCount} locale${hiddenLocaleCount === 1 ? "" : "s"} hidden • L show`;
    const orderSuffix = relatedAnchor != null ? "" : this.navigatorFileOrder === "risk" ? " • risk order • O a-z" : " • a-z order • O risk";
    lines.push(this.theme.fg("muted", `${files.length} file${files.length === 1 ? "" : "s"} • ${reviewedCount} reviewed${orderSuffix}${localeSuffix}${titleSuffix}${relatedSuffix}`));
    lines.push("");

    if (files.length === 0) {
      lines.push(this.theme.fg("warning", "No files in this scope."));
      lines.push(this.theme.fg("dim", "Try another scope or clear search."));
      return renderBox("Navigator", width, height, this.theme, lines, this.state.focus === "navigator");
    }

    const entries: Array<{ kind: "group"; group: string } | { kind: "file"; file: ReviewFile; group: string }> = [];
    let previousGroup: string | null = null;
    for (const file of files) {
      const group = getNavigatorGroup(file);
      if (this.navigatorTreeMode && group !== previousGroup) entries.push({ kind: "group", group });
      entries.push({ kind: "file", file, group });
      previousGroup = group;
    }

    const maxBody = Math.max(1, height - 4);
    this.navigatorPageSize = maxBody;
    const activeIndex = Math.max(0, entries.findIndex((entry) => entry.kind === "file" && entry.file.id === this.state.activeFileId));
    if (activeIndex < this.navigatorScroll) this.navigatorScroll = activeIndex;
    if (activeIndex >= this.navigatorScroll + maxBody) this.navigatorScroll = activeIndex - maxBody + 1;
    const visible = entries.slice(this.navigatorScroll, this.navigatorScroll + maxBody);
    for (const entry of visible) {
      if (entry.kind === "group") {
        lines.push(this.theme.fg("muted", `  ${entry.group}/`));
        continue;
      }
      const { file, group } = entry;
      const active = file.id === this.state.activeFileId;
      const prefix = active ? this.theme.fg("accent", "›") : " ";
      const status = this.theme.fg(active ? "accent" : "muted", getStatusLabel(file, this.state.activeScope));
      const count = getFileCommentCount(this.state, file.id, this.state.activeScope);
      const changeMarker = getChangeCountLabel(this.theme, file, this.state.activeScope);
      const commentMarker = count > 0 ? this.theme.fg("success", ` ${count}●`) : this.theme.fg("dim", "  ·");
      const submoduleMarker = getSubmoduleInfo(file, this.state.activeScope) == null ? "" : this.theme.fg(active ? "accent" : "muted", " ↗");
      const reviewedMarker = this.reviewedFileIds.has(file.id) ? this.theme.fg("success", " done") : "";
      const prefixText = `${prefix} ${status} `;
      const pathWidth = Math.max(1, width - 2 - visibleWidth(prefixText) - visibleWidth(changeMarker) - visibleWidth(commentMarker) - visibleWidth(submoduleMarker) - visibleWidth(reviewedMarker));
      const displayPath = getReviewFileDisplayPath(file, this.state.activeScope);
      const groupedPath = this.navigatorTreeMode && group !== "root" && displayPath.startsWith(`${group}/`)
        ? displayPath.slice(group.length + 1)
        : displayPath;
      const shortenedPath = shortenNavigatorPath(sanitizeTerminalText(groupedPath), pathWidth);
      const searchMatched = this.state.searchQuery.trim().length > 0;
      const pathText = active
        ? this.theme.fg("accent", shortenedPath)
        : searchMatched
          ? this.theme.fg("success", shortenedPath)
          : this.theme.fg("text", shortenedPath);
      const rowText = `${prefixText}${pathText}${submoduleMarker}${reviewedMarker}${changeMarker}${commentMarker}`;
      lines.push(searchMatched ? this.theme.bg("toolPendingBg", rowText) : rowText);
    }

    return renderBox("Navigator", width, height, this.theme, lines, this.state.focus === "navigator");
  }

  private renderSideBySideCellLines(cell: SideBySideCell | null, width: number, language: string | undefined, selected: boolean, current: boolean, searchMatched: boolean, lineComments: Map<string, DiffReviewComment>): string[] {
    if (cell == null) return [" ".repeat(Math.max(1, width))];

    const lineComment = lineComments.get(`${cell.side}:${cell.lineNumber}`);
    const lineLabel = String(cell.lineNumber).padStart(4, " ");
    const gutterLine = this.theme.fg("borderMuted", lineLabel);
    const gutterSign = cell.sign === "+"
      ? this.theme.fg("success", cell.sign)
      : cell.sign === "-"
        ? this.theme.fg("error", cell.sign)
        : this.theme.fg("toolDiffContext", cell.sign);
    const commentIndicator = lineComment == null ? " " : getCommentIndicator(this.theme, lineComment.intent);
    const highlightedCode = this.getCachedHighlightedCode(cell.tone, cell.text, language);
    const contentText = `${gutterLine} ${gutterSign} ${commentIndicator} ${highlightedCode}`;

    return wrapAnsiText(contentText, Math.max(1, width), this.state.wrapLines).map((line) => {
      const paddedLine = padLine(line, Math.max(1, width));
      if (current) return this.theme.bg("selectedBg", this.theme.fg("accent", paddedLine));
      if (selected) return this.theme.bg("selectedBg", paddedLine);
      if (searchMatched) return this.theme.bg("toolPendingBg", paddedLine);
      if (cell.tone === "added" || cell.tone === "removed") return applyLineBackground(this.theme, paddedLine, cell.tone);
      return paddedLine;
    });
  }

  private renderSideBySideDiff(diff: StructuredDiff, width: number, fileId: string, language: string | undefined, selectedTarget: ReviewLineTarget | null, lineComments: Map<string, DiffReviewComment>, viewportHeight: number): { lines: string[]; selectedIndex: number; selectedEndIndex: number; renderedStartOffset: number } {
    const innerWidth = Math.max(1, width - 2);
    const separator = this.theme.fg("borderMuted", " │ ");
    const separatorWidth = visibleWidth(separator);
    const oldWidth = Math.max(8, Math.floor((innerWidth - separatorWidth) / 2));
    const newWidth = Math.max(8, innerWidth - separatorWidth - oldWidth);
    const selectedRange = selectedTarget == null ? null : getLineTargetRange(selectedTarget);
    const layout = this.getDiffLayout(fileId, this.state.activeScope);
    const rows = layout?.sideBySideRows ?? buildSideBySideDisplayRows(diff);
    const heightKey = `${oldWidth}:${newWidth}:${this.state.wrapLines ? 1 : 0}`;
    let rowHeights = layout?.sideBySideRowHeights.get(heightKey);
    if (rowHeights == null) {
      rowHeights = [1, ...rows.map((row) => {
        if (row.kind === "gap") return 1;
        const oldLines = this.renderSideBySideCellLines(row.oldCell, oldWidth, language, false, false, false, lineComments);
        const newLines = this.renderSideBySideCellLines(row.newCell, newWidth, language, false, false, false, lineComments);
        return Math.max(oldLines.length, newLines.length);
      })];
      layout?.sideBySideRowHeights.set(heightKey, rowHeights);
    }
    let rowOffsets = layout?.sideBySideRowOffsets.get(heightKey);
    if (rowOffsets == null) {
      rowOffsets = getRowOffsets(rowHeights);
      layout?.sideBySideRowOffsets.set(heightKey, rowOffsets);
    }

    const initialRange = getVirtualRowRange(rowHeights, this.diffScroll, viewportHeight, 20, rowOffsets);
    const selectedRowIndex = selectedTarget == null
      ? -1
      : layout?.sideBySideTargetRowIndexes.get(`${selectedTarget.side}:${selectedTarget.line}`) ?? -1;
    let selectedIndex = selectedRowIndex < 0 ? 0 : initialRange.offsets[selectedRowIndex + 1] ?? 0;
    let selectedEndIndex = selectedRowIndex < 0 ? 0 : initialRange.offsets[selectedRowIndex + 2] ?? selectedIndex + 1;
    if (selectedRowIndex >= 0) {
      this.diffScroll = getStableDiffScroll(this.diffScroll, viewportHeight, selectedIndex, selectedEndIndex);
    }
    const virtualRange = getVirtualRowRange(rowHeights, this.diffScroll, viewportHeight, 20, rowOffsets);
    const lines: string[] = [];
    const oldHeaderActive = selectedTarget?.side === "deleted";
    const newHeaderActive = selectedTarget?.side === "added";

    for (let itemIndex = virtualRange.startRow; itemIndex < virtualRange.endRow; itemIndex += 1) {
      if (itemIndex === 0) {
        lines.push(`${padLine(this.theme.fg(oldHeaderActive ? "accent" : "muted", "Deleted / Old"), oldWidth)}${separator}${padLine(this.theme.fg(newHeaderActive ? "accent" : "muted", "Added / New"), newWidth)}`);
        continue;
      }
      const rowIndex = itemIndex - 1;
      const row = rows[rowIndex]!;
      if (row.kind === "gap") {
        lines.push(this.theme.fg("muted", centerText(row.label, innerWidth)));
        continue;
      }

      const oldSelected = row.oldCell != null
        && selectedTarget?.side === row.oldCell.side
        && selectedRange != null
        && selectedRange.startLine <= row.oldCell.lineNumber
        && row.oldCell.lineNumber <= selectedRange.endLine;
      const newSelected = row.newCell != null
        && selectedTarget?.side === row.newCell.side
        && selectedRange != null
        && selectedRange.startLine <= row.newCell.lineNumber
        && row.newCell.lineNumber <= selectedRange.endLine;
      const oldCurrent = row.oldCell != null && selectedTarget?.side === row.oldCell.side && selectedTarget.line === row.oldCell.lineNumber;
      const newCurrent = row.newCell != null && selectedTarget?.side === row.newCell.side && selectedTarget.line === row.newCell.lineNumber;
      const oldSearchMatched = row.oldCell != null && diffTextMatchesSearch(row.oldCell.text, this.diffSearchQuery);
      const newSearchMatched = row.newCell != null && diffTextMatchesSearch(row.newCell.text, this.diffSearchQuery);
      const oldIntent = row.oldCell == null ? "-" : lineComments.get(`${row.oldCell.side}:${row.oldCell.lineNumber}`)?.intent ?? "-";
      const newIntent = row.newCell == null ? "-" : lineComments.get(`${row.newCell.side}:${row.newCell.lineNumber}`)?.intent ?? "-";
      const cacheKey = `${oldWidth}:${newWidth}:${this.state.wrapLines ? 1 : 0}:${oldSelected ? 1 : 0}:${newSelected ? 1 : 0}:${oldCurrent ? 1 : 0}:${newCurrent ? 1 : 0}:${oldSearchMatched ? 1 : 0}:${newSearchMatched ? 1 : 0}:${oldIntent}:${newIntent}`;
      let rowCache = layout?.sideBySideRowRenderCache.get(row);
      if (rowCache == null) {
        rowCache = new Map();
        layout?.sideBySideRowRenderCache.set(row, rowCache);
      }
      let cachedLines = rowCache.get(cacheKey);
      if (cachedLines == null) {
        cachedLines = {
          oldLines: this.renderSideBySideCellLines(row.oldCell, oldWidth, language, oldSelected, oldCurrent, oldSearchMatched, lineComments),
          newLines: this.renderSideBySideCellLines(row.newCell, newWidth, language, newSelected, newCurrent, newSearchMatched, lineComments),
        };
        rowCache.set(cacheKey, cachedLines);
      }
      const rowHeight = Math.max(cachedLines.oldLines.length, cachedLines.newLines.length);
      for (let index = 0; index < rowHeight; index += 1) {
        lines.push(`${cachedLines.oldLines[index] ?? " ".repeat(oldWidth)}${separator}${cachedLines.newLines[index] ?? " ".repeat(newWidth)}`);
      }
      if (oldCurrent || newCurrent) {
        selectedIndex = virtualRange.offsets[itemIndex] ?? selectedIndex;
        selectedEndIndex = virtualRange.offsets[itemIndex + 1] ?? selectedIndex + rowHeight;
      }
    }

    return { lines, selectedIndex, selectedEndIndex, renderedStartOffset: virtualRange.startOffset };
  }

  private renderExactEditor(width: number, height?: number): string[] {
    const safeWidth = Math.max(1, width);
    const view = this.exactEditor.getView();
    const count = Math.max(1, height ?? view.lines.length);
    const first = Math.max(0, Math.min(view.cursorLine - Math.floor(count / 2), view.lines.length - count));
    return view.lines.slice(first, first + count).map((rawLine, offset) => {
      const index = first + offset;
      const renderText = (text: string) => sanitizeTerminalText(text).replace(/\t/g, "    ");
      if (view.selectionArmed) {
        const selectedLine = padLine(this.theme.fg("text", renderText(rawLine)), safeWidth);
        return this.theme.bg("selectedBg", selectedLine);
      }

      const rawCursorColumn = index === view.cursorLine ? view.cursorColumn : -1;
      const prefix = rawCursorColumn < 0 ? rawLine : rawLine.slice(0, rawCursorColumn);
      const suffix = rawCursorColumn < 0 ? "" : rawLine.slice(rawCursorColumn);
      const cursorMarker = rawCursorColumn < 0 ? "" : CURSOR_MARKER;
      const before = renderText(prefix);
      const visiblePrefix = rawCursorColumn < 0 ? before : sliceAnsiByColumn(before, Math.max(0, visibleWidth(before) - safeWidth + 2), visibleWidth(before));
      const rendered = this.theme.fg("text", `${visiblePrefix}${cursorMarker}${renderText(suffix)}`);
      return padLine(truncateToWidth(rendered, safeWidth, "…", false), safeWidth);
    });
  }

  private buildInlineEditorBlock(width: number, height?: number): string[] {
    const target = this.editTarget;
    if (target == null) return [];
    const label = target.kind === "all"
      ? "All note"
      : target.kind === "file"
        ? target.label ?? "File comment"
        : `${formatLineSideLabel(target.side)} line ${formatLineRangeLabel(target.startLine, target.endLine)}`;
    const bar = this.theme.fg("accent", "\u258c");
    const header = `${bar} ${getIntentBadge(this.theme, target.intent)} ${this.theme.fg("muted", label)}`;
    const selectionHint = this.usesExactEditor() && this.exactEditor.isSelectionArmed()
      ? " • Type/paste replaces highlighted code"
      : "";
    const hints = `${bar} ${this.theme.fg("dim", `Tab intent • Enter save • Shift+Enter newline • Esc cancel${selectionHint}`)}`;
    const preview = (height == null || height >= 10) && target.kind === "line" && target.intent === "modify" && this.usesExactEditor(target)
      && !this.exactEditor.isSelectionArmed()
      && target.originalText != null
      && target.originalText !== this.exactEditor.getText()
      ? buildModifyPreviewLines(target.originalText, this.exactEditor.getText(), 6).map((line) => {
          const color = line.startsWith("-") ? "error" : "success";
          return `${bar} ${this.theme.fg(color, truncateToWidth(sanitizeTerminalText(line).replace(/\t/g, "    "), Math.max(10, width - 4), "…", false))}`;
        })
      : [];
    const conflict = this.compositionConflictPending ? [
      "Replace with recovered text; keep current text as recovery?", "k replace and preserve current • Esc back",
    ].map((line) => `${bar} ${this.theme.fg("warning", line)}`) : [];
    const editorLines = this.usesExactEditor()
      ? this.renderExactEditor(Math.max(10, width - 4), height == null ? undefined : height - 2 - preview.length - conflict.length)
      : this.editor.render(Math.max(10, width - 4));
    return [header, hints, ...conflict, ...preview, ...editorLines.map((line) => `${bar} ${line}`)];
  }

  private renderDiff(width: number, height: number): string[] {
    const file = this.activeFile();
    const lines: string[] = [];
    if (this.editTarget != null && (this.recoveryEditor || file == null || this.getEntry(file.id, this.state.activeScope)?.status === "error")) {
      return renderBox("Recovered editor · original target unchanged", width, height, this.theme, this.buildInlineEditorBlock(width, height - 2), true);
    }
    if (file == null) {
      lines.push(this.theme.fg("warning", "No file selected."));
      return renderBox("Diff", width, height, this.theme, lines, this.state.focus === "diff");
    }

    const entry = this.getEntry(file.id, this.state.activeScope);
    const diffSearchLabel = this.searchMode && this.searchPane === "diff"
      ? ` • search ${this.searchBuffer || "…"}`
      : this.diffSearchQuery
        ? ` • search ${this.diffSearchQuery}`
        : "";
    lines.push(this.theme.fg("muted", getScopeDisplayPath(file, this.state.activeScope)));
    lines.push(this.theme.fg("dim", `${formatScopeLabel(this.state.activeScope)} • view ${formatDiffViewModeLabel(this.diffViewMode)} • wrap ${this.state.wrapLines ? "on" : "off"}${this.state.activeScope === "all-files" ? "" : ` • unchanged ${this.state.hideUnchanged ? "hidden" : "shown"}`}${diffSearchLabel}`));
    lines.push(buildDiffActionHintLine(this.theme, width));

    const submodule = getSubmoduleInfo(file, this.state.activeScope);
    if (submodule != null) {
      lines.push(this.theme.fg("accent", `Submodule pointer: ${sanitizeTerminalText(file.path)}`));
      lines.push(this.theme.fg("muted", `${submodule.oldSha ?? "new"} → ${submodule.newSha ?? "deleted"}`));
      if (!submodule.available) {
        lines.push(this.theme.fg("warning", submodule.unavailableReason ?? "Nested review is unavailable."));
      } else if (hasExactSubmoduleRange(submodule)) {
        lines.push(this.theme.fg("dim", "Press Enter or Right to review the exact nested commit range."));
      } else {
        lines.push(this.theme.fg("dim", "Press Enter or Right to review the nested working tree."));
      }
      if (this.frameStack.length > 0) lines.push(this.theme.fg("dim", "Press b to return to the parent review."));
      if (this.editTarget?.kind === "file" && this.editTarget.fileId === file.id) {
        lines.push(...this.buildInlineEditorBlock(width));
      }
      return renderBox("Diff", width, height, this.theme, lines, this.state.focus === "diff");
    }

    if (entry == null || entry.status === "loading") {
      lines.push(this.theme.fg("muted", "Loading file contents…"));
      return renderBox("Diff", width, height, this.theme, lines, this.state.focus === "diff");
    }
    if (entry.status === "error") {
      lines.push(this.theme.fg("error", "Could not load file contents."));
      lines.push(this.theme.fg("muted", entry.error));
      return renderBox("Diff", width, height, this.theme, lines, this.state.focus === "diff");
    }

    const layout = this.getDiffLayout(file.id, this.state.activeScope)!;
    const diff = layout.displayDiff;
    const visibleTargets = this.getVisibleLineTargets(file.id, this.state.activeScope);
    const language = detectPiLanguage(file.path);
    this.state = clampSelectedLineTarget(this.state, file.id, this.state.activeScope, visibleTargets);
    const selectedTarget = getSelectedLineTarget(this.state, file.id, this.state.activeScope);
    const lineComments = getLineCommentIndex(this.state, file.id, this.state.activeScope);
    lines[1] = this.theme.fg("dim", `${formatScopeLabel(this.state.activeScope)} • view ${formatDiffViewModeLabel(this.diffViewMode)} • ${formatSelectedLineTargetLabel(selectedTarget)} • nav ${this.contextLineNavigation ? "all lines" : "changes"} • wrap ${this.state.wrapLines ? "on" : "off"}${this.state.activeScope === "all-files" ? "" : ` • unchanged ${this.state.hideUnchanged ? "hidden" : "shown"}`}${diffSearchLabel}`);
    const maxBody = Math.max(1, height - 5);
    let rendered: string[];
    let renderedStartOffset = 0;
    let selectedIndex = 0;
    let selectedEndIndex = 0;
    if (this.diffViewMode === "side-by-side") {
      const sideBySide = this.renderSideBySideDiff(diff, width, file.id, language, selectedTarget, lineComments, maxBody);
      rendered = sideBySide.lines;
      renderedStartOffset = sideBySide.renderedStartOffset;
      selectedIndex = sideBySide.selectedIndex;
      selectedEndIndex = sideBySide.selectedEndIndex;
    } else {
      const displayRows = layout.unifiedRows;
      const rowRenderCache = layout.rowRenderCache;
      rendered = [];
      const selectedRange = selectedTarget == null ? null : getLineTargetRange(selectedTarget);
      const selectedSide = selectedTarget?.side ?? null;
      const wrapFlag = this.state.wrapLines ? 1 : 0;
      const heightKey = `${width}:${wrapFlag}`;
      let rowHeights = layout.unifiedRowHeights.get(heightKey);
      if (rowHeights == null) {
        rowHeights = displayRows.map((row) => this.buildUnifiedRowLines(row, width, language, false, false, false, undefined).length);
        layout.unifiedRowHeights.set(heightKey, rowHeights);
      }
      let rowOffsets = layout.unifiedRowOffsets.get(heightKey);
      if (rowOffsets == null) {
        rowOffsets = getRowOffsets(rowHeights);
        layout.unifiedRowOffsets.set(heightKey, rowOffsets);
      }
      const initialRange = getVirtualRowRange(rowHeights, this.diffScroll, maxBody, 20, rowOffsets);
      const selectedRowIndex = selectedTarget == null
        ? -1
        : layout.unifiedTargetRowIndexes.get(`${selectedTarget.side}:${selectedTarget.line}`) ?? -1;
      if (selectedRowIndex >= 0) {
        selectedIndex = initialRange.offsets[selectedRowIndex] ?? 0;
        selectedEndIndex = initialRange.offsets[selectedRowIndex + 1] ?? selectedIndex + 1;
        this.diffScroll = getStableDiffScroll(this.diffScroll, maxBody, selectedIndex, selectedEndIndex);
      }
      const virtualRange = getVirtualRowRange(rowHeights, this.diffScroll, maxBody, 20, rowOffsets);
      renderedStartOffset = virtualRange.startOffset;

      for (let rowIndex = virtualRange.startRow; rowIndex < virtualRange.endRow; rowIndex += 1) {
        const row = displayRows[rowIndex]!;
        const isCurrentTarget = row.commentLineNumber != null
          && row.commentSide != null
          && selectedTarget?.line === row.commentLineNumber
          && selectedSide === row.commentSide;
        const isSelected = row.commentLineNumber != null
          && row.commentSide != null
          && selectedRange != null
          && selectedSide === row.commentSide
          && selectedRange.startLine <= row.commentLineNumber
          && row.commentLineNumber <= selectedRange.endLine;
        const lineComment = row.commentLineNumber != null && row.commentSide != null
          ? lineComments.get(`${row.commentSide}:${row.commentLineNumber}`)
          : undefined;
        const isSearchMatch = diffTextMatchesSearch(row.codeText, this.diffSearchQuery);

        const memoKey = `${width}\u001f${wrapFlag}\u001f${isSelected ? 1 : 0}\u001f${isCurrentTarget ? 1 : 0}\u001f${isSearchMatch ? 1 : 0}\u001f${lineComment?.intent ?? "-"}`;
        let memo = rowRenderCache.get(row);
        if (memo == null) {
          memo = new Map();
          rowRenderCache.set(row, memo);
        }
        let renderedLines = memo.get(memoKey);
        if (renderedLines == null) {
          renderedLines = this.buildUnifiedRowLines(row, width, language, isSelected, isCurrentTarget, isSearchMatch, lineComment);
          memo.set(memoKey, renderedLines);
        }

        if (isCurrentTarget) selectedIndex = virtualRange.offsets[rowIndex] ?? selectedIndex;
        rendered.push(...renderedLines);
        if (isCurrentTarget) selectedEndIndex = virtualRange.offsets[rowIndex + 1] ?? selectedIndex + renderedLines.length;
      }
    }

    let editorStart = -1;
    let editorEnd = -1;
    if (this.editTarget != null) {
      const matchesLine = this.editTarget.kind === "line"
        && this.editTarget.fileId === file.id
        && this.editTarget.scope === this.state.activeScope;
      const absoluteInsertIndex = matchesLine ? selectedEndIndex : 0;
      const insertIndex = Math.max(0, absoluteInsertIndex - renderedStartOffset);
      const block = this.buildInlineEditorBlock(width);
      if (block.length > 0) {
        rendered.splice(insertIndex, 0, ...block);
        editorStart = absoluteInsertIndex;
        editorEnd = absoluteInsertIndex + block.length - 1;
      }
    }

    this.diffPageSize = maxBody;
    if (editorStart >= 0) {
      const anchorTop = Math.max(0, editorStart - 1);
      if (editorEnd >= this.diffScroll + maxBody) this.diffScroll = editorEnd - maxBody + 1;
      if (anchorTop < this.diffScroll && editorEnd - anchorTop < maxBody) this.diffScroll = anchorTop;
    } else {
      this.diffScroll = getStableDiffScroll(this.diffScroll, maxBody, selectedIndex, selectedEndIndex);
    }
    this.diffScroll = Math.max(0, this.diffScroll);
    const visibleStart = Math.max(0, this.diffScroll - renderedStartOffset);
    lines.push(...rendered.slice(visibleStart, visibleStart + maxBody));

    return renderBox(`Diff ${diff.hunks.length > 0 ? `(${diff.hunks.length} hunk${diff.hunks.length === 1 ? "" : "s"})` : ""}`.trim(), width, height, this.theme, lines, this.state.focus === "diff");
  }

  private renderHelpPanel(width: number, height: number): string[] {
    return renderBox("Help", width, height, this.theme, buildHelpPanelLines(this.theme, width, this.getAvailableShortcuts(), getShortcutConfigPath()), true);
  }

  private renderCancelConfirmation(): string[] {
    const count = getDraftCommentCount(this.state);
    const noun = count === 1 ? "draft item" : "draft items";
    const lines = [
      this.theme.fg("warning", `Leave review with ${count} ${noun}?`),
      "",
      this.theme.fg("muted", "p park review and exit (resume later)"),
      this.theme.fg("muted", "d discard review and delete the saved session"),
      this.theme.fg("muted", "Enter keep reviewing"),
      this.theme.fg("muted", "Esc keep reviewing • Ctrl+C keep reviewing"),
    ];
    return renderBox("Park or discard review", 54, 8, this.theme, lines, true)
      .map((line) => this.theme.bg("toolPendingBg", line));
  }

  private renderContextPanel(width: number, height: number): string[] {
    const source = this.options.contextPanelSource;
    const focused = this.state.focus === "context";
    const lines: string[] = [];
    if (source == null) {
      this.contextLineCount = 0;
      this.contextPageSize = 1;
      this.contextScroll = 0;
      return renderBox("PR context", width, height, this.theme, lines, false);
    }

    if (this.contextPanelState.status === "idle" || this.contextPanelState.status === "loading") {
      lines.push(this.theme.fg("muted", source.loadingText));
    } else if (this.contextPanelState.status === "error") {
      lines.push(this.theme.fg("error", "Could not load PR context."));
      pushWrappedText(lines, this.theme, this.contextPanelState.error, Math.max(1, width - 2), "muted");
    } else {
      lines.push(...buildContextPanelLines(this.theme, width, this.contextPanelState.text));
    }

    const bodyHeight = Math.max(1, Math.floor(height) - 2);
    this.contextLineCount = lines.length;
    this.contextPageSize = bodyHeight;
    this.contextScroll = Math.max(0, Math.min(this.contextScroll, this.maxContextScroll()));
    return renderBox(source.title, width, height, this.theme, lines.slice(this.contextScroll, this.contextScroll + bodyHeight), focused);
  }

  private renderRepliesPanel(width: number, height: number): string[] {
    const source = this.options.repliesSource;
    const focused = this.state.focus === "replies";
    const lines: string[] = [];
    const contentWidth = Math.max(1, width - 2);
    const bodyHeight = Math.max(1, Math.floor(height) - 2);

    if (source == null) {
      this.repliesScroll = 0;
      this.repliesPageSize = 1;
      return renderBox("Replies", width, height, this.theme, lines, false);
    }

    if (this.repliesPanelState.status === "idle" || this.repliesPanelState.status === "loading") {
      pushWrappedText(lines, this.theme, source.loadingText, contentWidth);
      this.repliesScroll = 0;
      this.repliesPageSize = bodyHeight;
      return renderBox(sanitizeTerminalText(source.title), width, height, this.theme, lines, focused);
    }

    if (this.repliesPanelState.status === "error") {
      lines.push(this.theme.fg("error", "Could not load replies."));
      pushWrappedText(lines, this.theme, this.repliesPanelState.error, contentWidth, "muted");
      this.repliesScroll = 0;
      this.repliesPageSize = bodyHeight;
      return renderBox(sanitizeTerminalText(source.title), width, height, this.theme, lines, focused);
    }

    const replies = this.repliesPanelState.snapshot.replies;
    this.selectedReplyIndex = Math.max(0, Math.min(this.selectedReplyIndex, Math.max(0, replies.length - 1)));
    lines.push(this.theme.fg("muted", `${replies.length} repl${replies.length === 1 ? "y" : "ies"}`));
    lines.push(this.theme.fg("dim", "↑↓ select • Enter open • r refresh • A analyze"));
    lines.push("");

    if (replies.length === 0) {
      lines.push(this.theme.fg("dim", "No replies to review."));
      this.repliesScroll = 0;
      this.repliesPageSize = 1;
      return renderBox(sanitizeTerminalText(source.title), width, height, this.theme, lines, focused);
    }

    const itemBlocks = replies.map((reply, index) => {
      const selected = index === this.selectedReplyIndex;
      const block: string[] = [];
      const prefix = selected ? this.theme.fg("accent", "› ") : "  ";
      const author = sanitizeTerminalText(reply.author);
      pushWrappedAnsiText(block, this.theme.fg(selected ? "accent" : "text", author), contentWidth, prefix);
      const location = reply.path == null || reply.path.length === 0
        ? "Pull request"
        : `${sanitizeTerminalText(reply.path)}${reply.line == null ? "" : `:${reply.line}`}`;
      const resolution = reply.resolved ? "resolved" : "unresolved";
      pushWrappedText(block, this.theme, `${location} • ${resolution}`, contentWidth, "dim", "   ");
      block.push(...buildCommentPanelTextLines(this.theme, width, reply.body, "muted", "   ", 4));

      const analysis = this.replyAnalysis;
      if (selected && analysis.status !== "idle" && analysis.replyId === reply.id) {
        if (analysis.status === "loading") {
          pushWrappedText(block, this.theme, "Analyzing reply…", contentWidth, "dim", "   ");
        } else if (analysis.status === "error") {
          block.push(...buildCommentPanelTextLines(this.theme, width, `Analysis failed: ${analysis.error}`, "muted", "   ", 5));
        } else {
          block.push(...buildCommentPanelTextLines(this.theme, width, `Analysis: ${analysis.text}`, "muted", "   ", 5));
        }
      }
      block.push("");
      return block;
    });

    const itemViewportHeight = Math.max(1, bodyHeight - lines.length);
    const page = getMeasuredPageRange(itemBlocks.map((block) => block.length), this.selectedReplyIndex, this.repliesScroll, itemViewportHeight);
    this.repliesScroll = page.start;
    this.repliesPageSize = Math.max(1, page.end - page.start);
    for (const block of itemBlocks.slice(page.start, page.end)) lines.push(...block);

    return renderBox(sanitizeTerminalText(source.title), width, height, this.theme, lines, focused);
  }

  private renderComments(width: number, height: number): string[] {
    const file = this.activeFile();
    const lines: string[] = [];
    const contentWidth = Math.max(1, width - 2);
    const fileId = file?.id ?? null;
    const items = getCommentPanelItems(this.state, fileId, this.state.activeScope, this.commentsGlobal);
    this.state = moveSelectedCommentIndex(this.state, items.length, 0);

    if (this.shortcutMode) {
      const shortcuts = this.getAvailableShortcuts();
      pushWrappedText(lines, this.theme, "Press a key to apply a templated comment.", contentWidth, "muted");
      pushWrappedText(lines, this.theme, "Esc cancel", contentWidth, "dim");
      lines.push("");

      if (shortcuts.length === 0) {
        lines.push(this.theme.fg("warning", "No template shortcuts available."));
        return renderBox("Template shortcuts", width, height, this.theme, lines, true);
      }

      const groups = [
        { intent: "modify" as const, header: this.theme.fg("accent", "MODIFY") },
        { intent: "comment" as const, header: this.theme.fg("success", "COMMENT") },
        { intent: "discuss" as const, header: this.theme.fg("warning", "DISCUSS") },
      ];

      groups.forEach((group, groupIndex) => {
        const groupShortcuts = shortcuts.filter((shortcut) => shortcut.intent === group.intent);
        if (groupShortcuts.length === 0) return;
        if (groupIndex > 0 && lines[lines.length - 1] !== "") lines.push("");
        lines.push(truncateToWidth(group.header, contentWidth, "", false));
        lines.push("");

        for (const shortcut of groupShortcuts) {
          pushWrappedAnsiText(lines, `${this.theme.fg("accent", shortcut.key)} ${this.theme.fg("text", shortcut.label)}`, contentWidth);
          for (const line of buildCommentPanelTextLines(this.theme, width, shortcut.text, "muted", "  ", 3)) {
            lines.push(line);
          }
          lines.push("");
        }
      });

      return renderBox("Template shortcuts", width, height, this.theme, lines, true);
    }

    if (this.helpMode) {
      return this.renderHelpPanel(width, height);
    }

    if (this.editTarget != null && this.activeFile() == null) {
      lines.push(this.theme.fg("muted", this.editTarget.kind === "all"
        ? "All note"
        : this.editTarget.kind === "file"
          ? this.editTarget.label ?? "File comment"
          : `${formatLineSideLabel(this.editTarget.side)} line ${formatLineRangeLabel(this.editTarget.startLine, this.editTarget.endLine)}`));
      lines.push(`${getIntentBadge(this.theme, this.editTarget.intent)} ${this.theme.fg("dim", "Tab toggle")}`);
      lines.push(this.theme.fg("dim", "Enter save • Shift+Enter newline"));
      lines.push(this.theme.fg("dim", "Esc cancel"));
      lines.push("");
      const editorLines = this.editor.render(Math.max(10, width - 4));
      lines.push(...editorLines.map((line) => ` ${line}`));
      return renderBox("Edit comment", width, height, this.theme, lines, true);
    }

    const commentSearchLabel = this.searchMode && this.searchPane === "comments"
      ? ` • search ${this.searchBuffer || "…"}`
      : this.commentSearchQuery
        ? ` • search ${this.commentSearchQuery}`
        : "";
    lines.push(this.theme.fg("muted", `${this.state.draft.comments.length} ${this.commentsGlobal ? "total" : "scoped"} comment${this.state.draft.comments.length === 1 ? "" : "s"}${commentSearchLabel}`));
    if (this.state.draft.allComment) {
      lines.push(this.theme.fg("dim", `review-wide note set • ${formatIntentLabel(this.state.draft.allIntent).toLowerCase()}`));
    }
    lines.push("");

    if (file != null && !this.commentsGlobal) {
      const fileComment = getFileComment(this.state, file.id, this.state.activeScope, "file");
      const allLinesComment = getFileComment(this.state, file.id, this.state.activeScope, "all-lines");
      const selectedTarget = getSelectedLineTarget(this.state, file.id, this.state.activeScope);
      const lineComment = selectedTarget == null
        ? undefined
        : getLineComment(this.state, file.id, this.state.activeScope, selectedTarget.side, selectedTarget.line);
      lines.push(this.theme.fg("muted", `file: ${fileComment ? "commented" : "none"} • all lines: ${allLinesComment ? "commented" : "none"}`));
      lines.push(this.theme.fg("muted", selectedTarget == null
        ? "line —: none"
        : `${formatLineSideLabel(selectedTarget.side).toLowerCase()} ${formatLineRangeLabel(getLineTargetRange(selectedTarget).startLine, getLineTargetRange(selectedTarget).endLine)}: ${lineComment ? "commented" : "none"}`));
      lines.push("");

      const relatedLines = buildRelatedFilePanelLines(this.theme, width, file, this.state.activeScope);
      if (relatedLines.length > 0) {
        lines.push(...relatedLines);
        lines.push("");
      }
    }

    if (items.length === 0) {
      lines.push(...buildCommentPanelEmptyStateLines(this.theme, width));
      return renderBox("Comments", width, height, this.theme, lines, this.state.focus === "comments");
    }

    const maxBody = Math.max(1, height - 5);
    const activeIndex = Math.max(0, this.state.selectedCommentIndex);
    const itemBlocks = items.map((item, absoluteIndex) => {
      const block: string[] = [];
      const selected = absoluteIndex === activeIndex;
      const searchMatched = this.commentSearchQuery.trim().length > 0 && this.getCommentSearchText(item).toLowerCase().includes(this.commentSearchQuery.trim().toLowerCase());
      const prefix = selected ? this.theme.fg("accent", "› ") : "  ";
      const commentFile = item.kind === "comment" ? this.options.files.find((candidate) => candidate.id === item.comment.fileId) : undefined;
      const itemPath = item.kind === "comment" ? getReviewFileDisplayPath(commentFile, item.comment.scope) : "";
      const baseLabel = getPanelItemLabel(this.theme, item);
      const staleLabel = item.kind === "comment" && item.comment.anchorStatus === "stale" ? " • STALE (a reanchor)" : "";
      const label = `${this.commentsGlobal && itemPath.length > 0 ? `${itemPath} • ${baseLabel}` : baseLabel}${staleLabel}`;
      const labelText = selected
        ? this.theme.fg("accent", label)
        : searchMatched
          ? this.theme.fg("success", label)
          : label;
      pushWrappedAnsiText(block, labelText, contentWidth, prefix);
      const body = item.kind === "all" ? item.body : item.comment.body;
      block.push(...buildCommentPanelTextLines(this.theme, width, body, "muted", "   ", 3));
      if (item.kind === "comment" && item.comment.side !== "file") {
        const locationFile = this.options.files.find((candidate) => candidate.id === item.comment.fileId);
        pushWrappedText(block, this.theme, `${getReviewFileDisplayPath(locationFile, item.comment.scope)}:${formatLineRangeLabel(item.comment.startLine ?? 0, item.comment.endLine ?? item.comment.startLine ?? 0)} (${item.comment.side})`, contentWidth, "dim", "   ");
      }
      block.push("");
      return block;
    });
    const page = getMeasuredPageRange(itemBlocks.map((block) => block.length), activeIndex, this.commentsScroll, maxBody);
    this.commentsScroll = page.start;
    this.commentsPageSize = Math.max(1, page.end - page.start);
    for (const block of itemBlocks.slice(page.start, page.end)) lines.push(...block);

    return renderBox("Comments", width, height, this.theme, lines, this.state.focus === "comments");
  }

  private renderReviewPane(pane: ReviewPaneName, width: number, height: number): string[] {
    if (pane === "navigator") return this.renderNavigator(width, height);
    if (pane === "diff") return this.renderDiff(width, height);
    if (pane === "comments") return this.renderComments(width, height);
    if (pane === "context") return this.renderContextPanel(width, height);
    this.ensureRepliesPanel();
    return this.renderRepliesPanel(width, height);
  }

  render(width: number): string[] {
    this.lastWidth = Math.max(40, width);
    const terminalRows = this.tui?.terminal?.rows ?? 28;
    const totalHeight = Math.max(20, terminalRows - 4);
    const frameColor = "accent" as const;
    const frameInnerWidth = Math.max(20, this.lastWidth - 2 - MODAL_INNER_PADDING_X * 2);
    const frameInnerHeight = Math.max(10, totalHeight - 2 - MODAL_INNER_PADDING_Y * 2);
    const visibility = this.effectivePaneVisibility();
    const visiblePanes = REVIEW_PANE_ORDER.filter((pane) => visibility[pane]);
    const stackPanes = visiblePanes.length > 1 && shouldStackPanesForVisibility(frameInnerWidth, visibility);
    const terminalCols = this.tui?.terminal?.columns ?? this.lastWidth;
    const overlayOriginCol = Math.max(0, Math.floor((terminalCols - this.lastWidth) / 2));
    const overlayOriginRow = Math.max(0, Math.floor((terminalRows - totalHeight) / 2));
    const contentLeft = overlayOriginCol + 1 + MODAL_INNER_PADDING_X;

    const visibleScopes = this.visibleScopes();
    const scopeHint = visibleScopes.length > 1 ? `Alt+${visibleScopes.map((_, index) => index + 1).join("/")} scopes • ` : "";
    const headerLines: string[] = [];
    if (this.options.reviewHeader != null) {
      const scopedFiles = getScopedFiles(this.files, this.state.activeScope);
      headerLines.push(buildReviewHeaderLine(this.theme, frameInnerWidth, this.options.reviewHeader, {
        files: scopedFiles.length,
        reviewed: scopedFiles.filter((file) => this.reviewedFileIds.has(file.id)).length,
        comments: getDraftCommentCount(this.state),
      }));
    }
    if (visibleScopes.length > 1) {
      headerLines.push(truncateToWidth(visibleScopes.map((scope, index) => {
        const active = this.state.activeScope === scope;
        const count = getScopedFiles(this.files, scope).length;
        const text = `Alt+${index + 1}:${formatScopeLabel(scope)}(${count})`;
        return active ? this.theme.bg("selectedBg", this.theme.fg("text", ` ${text} `)) : this.theme.fg("muted", ` ${text} `);
      }).join(" "), frameInnerWidth, "", false));
    }

    const bodyTop = overlayOriginRow + 1 + MODAL_INNER_PADDING_Y + headerLines.length;
    const layoutStatus = stackPanes ? "stacked layout • " : "";
    const allPanesHiddenStatus = visiblePanes.length === 0 ? "All panes hidden • 1 Navigator • 2 Diff • 3 Comments • 4 PR context • 5 Replies" : null;
    const promptStatus = sanitizeStatusText(this.shortcutMode
      ? "Template shortcuts • choose from the comments panel • Esc cancel"
      : this.helpMode
        ? "Help open • ? toggle • Esc close"
        : allPanesHiddenStatus ?? this.message ?? (this.searchMode
          ? `Search ${formatFocusStatus(this.searchPane).replace("Focus: ", "")}: ${this.searchBuffer}`
          : this.editTarget != null
            ? `Editing ${formatIntentLabel(this.editTarget.intent).toLowerCase()} comment`
            : `${formatFocusStatus(this.state.focus)} • ${layoutStatus}Tab/←/→ focus • / search • t templates • v diff view • ? help • ${scopeHint}1/2/3/4/5 panes • o open in /code • e open in $EDITOR • s submit${this.frameStack.length > 0 ? " • b parent" : ""} • Esc exit • Ctrl+C exit`));
    const verticalLayout = getReviewVerticalLayout(
      this.theme,
      frameInnerHeight,
      headerLines.length,
      visiblePanes.length,
      stackPanes,
      buildFooterLines(this.theme, promptStatus, frameInnerWidth),
      frameInnerWidth,
    );
    const footer = verticalLayout.footerLines;
    const bodyHeight = verticalLayout.bodyHeight;

    const body: string[] = [];
    const mouseBounds: Partial<Record<PaneName, MousePaneBounds>> = {};

    if (visiblePanes.length === 0) {
      body.push(padLine(centerText("All panes are hidden. Press 1, 2, 3, 4, or 5 to show one.", frameInnerWidth), frameInnerWidth));
      while (body.length < bodyHeight) body.push(" ".repeat(frameInnerWidth));
    } else if (stackPanes) {
      const layout = getStackedPaneLayoutForVisibility(bodyHeight, visibility, verticalLayout.stackedPaneMinimumHeight);
      let paneTop = bodyTop;
      for (const pane of visiblePanes) {
        const paneHeight = layout[`${pane}Height`];
        mouseBounds[pane] = {
          top: paneTop,
          bottom: paneTop + paneHeight - 1,
          left: contentLeft,
          right: contentLeft + frameInnerWidth - 1,
        };
        body.push(...this.renderReviewPane(pane, frameInnerWidth, paneHeight));
        paneTop += paneHeight;
      }
    } else {
      const layout = getPaneLayoutForVisibility(frameInnerWidth, visibility);
      const renderedPanes: Array<{ pane: ReviewPaneName; lines: string[] }> = [];
      let paneLeft = contentLeft;
      for (const pane of visiblePanes) {
        const paneWidth = layout[`${pane}Width`];
        mouseBounds[pane] = {
          top: bodyTop,
          bottom: bodyTop + bodyHeight - 1,
          left: paneLeft,
          right: paneLeft + paneWidth - 1,
        };
        renderedPanes.push({ pane, lines: this.renderReviewPane(pane, paneWidth, bodyHeight) });
        paneLeft += paneWidth + 1;
      }
      for (let index = 0; index < bodyHeight; index += 1) {
        body.push(renderedPanes.map(({ lines }) => lines[index] ?? "").join(" "));
      }
    }

    this.mousePaneLayout = {
      navigator: mouseBounds.navigator ?? null,
      diff: mouseBounds.diff ?? null,
      comments: mouseBounds.comments ?? null,
      context: mouseBounds.context ?? null,
      replies: mouseBounds.replies ?? null,
    };

    const rendered = renderOuterFrame(this.lastWidth, totalHeight, this.theme, "code-diff", [...headerLines, ...body, ...footer], frameColor);
    if (!this.confirmCancel) return rendered;
    return renderCenteredOverlay(rendered, this.renderCancelConfirmation(), this.lastWidth, totalHeight);
  }
}

export async function runReviewApp(
  ctx: ExtensionContext,
  options: Omit<ReviewAppOptions, "notify">,
): Promise<ReviewResult> {
  return ctx.ui.custom<ReviewResult>(
    (tui, theme, _kb, done) => new ReviewApp(tui, theme, done, { ...options, notify: ctx.ui.notify.bind(ctx.ui) }),
    fullScreenOverlayOptions,
  );
}
