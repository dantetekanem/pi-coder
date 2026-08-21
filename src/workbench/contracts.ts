import type { RepositoryTree } from "./tree.js";

export const CHILD_CLOSURE_UNCONFIRMED = "CHILD_CLOSURE_UNCONFIRMED" as const;
export const CHILD_CLOSURE_UNCONFIRMED_MESSAGE = "A workbench child process did not close after forced termination.";

export interface LineRange {
  startLine: number;
  endLine: number;
}

export interface BufferEditPosition {
  /** Zero-based logical line and UTF-16 column. */
  line: number;
  column: number;
}

/** Exact ordered splice emitted by the buffer editor; CRLF is never split. */
export interface BufferEditDelta {
  /** UTF-16 offset in the old buffer. */
  startOffset: number;
  deletedText: string;
  insertedText: string;
  oldStart: BufferEditPosition;
  oldEnd: BufferEditPosition;
  newStart: BufferEditPosition;
  newEnd: BufferEditPosition;
  oldLineCount: number;
  newLineCount: number;
}

export interface TextAnchorHash {
  algorithm: "sha256";
  value: string;
}

export interface CodeTarget {
  path: string;
  range: LineRange;
  anchor?: TextAnchorHash;
}

export interface CodeStory {
  id: string;
  target: CodeTarget;
  prose: string;
}

export interface WorkbenchLaunch {
  initialTarget?: CodeTarget;
  /** Enter whole-buffer INSERT as soon as the initial target opens. */
  startInInsertMode?: boolean;
  stories?: readonly CodeStory[];
  capabilities?: { discuss: boolean };
}

export type TargetOpenResult =
  | { status: "opened"; path: string; range: LineRange; stale: boolean; message?: string }
  | { status: "missing"; path: string; message: string }
  | { status: "unreadable"; path: string; message: string };

export interface TextFileSnapshot {
  text: string;
  /** Opaque host revision captured from the exact bytes read. */
  revision: string;
}

/** Optional host service that renders exactly one selected UTF-8 source buffer. */
export interface SourceHighlighter {
  highlight(path: string, text: string): Promise<readonly string[]>;
}

/** Prevent repository text from emitting terminal control sequences; tabs remain intact. */
export function sanitizeTerminalText(text: string): string {
  return text.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "�");
}

/** Preserves source line boundaries while making plain terminal rendering safe. */
export function plainSourceLines(text: string): readonly string[] {
  return text.split(/\r\n|\r|\n/).map(sanitizeTerminalText);
}

/** Retains only SGR styling sequences from a renderer; all other controls are source text. */
export function sanitizeAnsiTerminalText(text: string): string {
  const sgr = /\u001b\[([0-9;]*)m/g;
  let safe = "";
  let cursor = 0;
  for (let match = sgr.exec(text); match != null; match = sgr.exec(text)) {
    safe += sanitizeTerminalText(text.slice(cursor, match.index));
    safe += match[0];
    cursor = match.index + match[0].length;
  }
  return safe + sanitizeTerminalText(text.slice(cursor));
}

export type SaveTextResult =
  | {
    status: "success";
    effect: "saved" | "unchanged";
    revision: string;
    /** Bytes were committed at revision despite a subsequent cleanup warning. */
    warning?: string;
  }
  | { status: "conflict"; message: string }
  | { status: "error"; message: string };

/** Host-neutral repository access used by the workbench lifecycle. */
export interface WorkbenchRepository {
  /** Canonical host-defined repository identity for process-lifetime Explorer state. */
  readonly workspaceKey?: string;
  /** Returns NUL-delimited repository-relative paths without loading file content. */
  listFiles(signal?: AbortSignal): Promise<string>;
  /** Reads a previously selected, repository-relative text file and its revision. */
  readText(path: string, maxBytes: number): Promise<TextFileSnapshot>;
  /** Atomically replaces a listed file only when expectedRevision still matches. */
  saveText(path: string, text: string, expectedRevision: string): Promise<SaveTextResult>;
  /** Confirms deferred read containment and the host's size/readability policy. */
  canReadFile?(path: string): Promise<boolean>;
  /** Maximum byte count passed to readText for a selected file. */
  maxReadBytes: number;
  /** Optional selected-buffer renderer; never used for repository listing or filtering. */
  sourceHighlighter?: SourceHighlighter;
}

export type DirtyChoice = "save" | "discard" | "cancel";

export type PendingWorkbenchAction =
  | { action: "switch"; targetPath: string; targetLine: number }
  | { action: "exit" };

export type OpenFileResult =
  | { status: "opened"; path: string; line: number }
  | { status: "confirmation-required"; action: "switch"; targetPath: string };

export type ExitRequestResult =
  | { status: "closed"; changedPaths: readonly string[] }
  | { status: "confirmation-required"; action: "exit" };

export type ClosedWorkbenchResult = Extract<ExitRequestResult, { status: "closed" }>;

export interface FailedWorkbenchResult {
  status: "failed";
  message: string;
  code?: string;
}

/** Authoritative host-neutral outcome emitted only after owned async work settles. */
export interface DiscussWorkbenchResult {
  status: "discuss";
  changedPaths: readonly string[];
  /** Final clamped selection with an anchor calculated from the current buffer. */
  target: CodeTarget;
  note?: string;
}

export type WorkbenchCompletionResult = ClosedWorkbenchResult | DiscussWorkbenchResult | FailedWorkbenchResult;

/** Error mapping for hosts whose lifecycle API represents completion failures by rejection. */
export class WorkbenchCompletionError extends Error {
  readonly code: string | undefined;

  constructor(result: FailedWorkbenchResult) {
    super(result.message);
    this.name = "WorkbenchCompletionError";
    this.code = result.code;
  }
}

export type DirtyChoiceResult =
  | { status: "opened"; path: string; line: number; changedPaths: readonly string[]; warning?: string }
  | { status: "closed"; changedPaths: readonly string[] }
  | { status: "warning"; action: "exit"; warning: string; changedPaths: readonly string[] }
  | { status: "cancelled"; action: PendingWorkbenchAction["action"]; changedPaths: readonly string[] }
  | { status: "save-failed"; action: PendingWorkbenchAction["action"]; save: Exclude<SaveTextResult, { status: "success" }>; changedPaths: readonly string[] };

export interface Workbench {
  /** Compatibility alias for the current metadata-only repository listing. */
  readonly files: readonly string[];
  /** Metadata-only tree built and initially warmed by start(), or an empty warmed tree otherwise. */
  readonly repositoryTree: RepositoryTree;
  /** Compatibility filtered view of files, set by setFilter(). */
  readonly visibleFiles: readonly string[];
  readonly selectedPath: string | null;
  /** Compatibility alias for the current editable buffer. */
  readonly selectedText: string | null;
  readonly bufferText: string | null;
  readonly selectedRevision: string | null;
  readonly selectedLine: number | null;
  /** Whole-line navigation/DISCUSS selection, independent from the editing cursor. */
  readonly selectedRange: LineRange | null;
  /** ANSI-safe rendering for the exact current buffer, or sanitized plain source. */
  readonly highlightedLines: readonly string[] | null;
  /** Whether the host can refresh syntax colors for the selected source buffer. */
  readonly supportsSourceHighlighting: boolean;
  readonly isDirty: boolean;
  readonly changedPaths: readonly string[];
  readonly pendingAction: PendingWorkbenchAction | null;
  start(signal?: AbortSignal): Promise<void>;
  setFilter(query: string): void;
  setSelectedLine(line: number, knownLineCount?: number): void;
  setSelectedRange(range: LineRange, activeLine?: number): void;
  /** Compatibility/fallback whole-buffer replacement. */
  replaceBuffer(text: string, selectedLine?: number): void;
  /** Atomically applies ordered editor splices to the current authoritative buffer. */
  applyBufferDeltas(deltas: readonly BufferEditDelta[], selectedLine?: number): void;
  /** Re-renders the exact current buffer without changing its bytes or revision. */
  refreshHighlight(): Promise<void>;
  save(): Promise<SaveTextResult>;
  selectVisibleFile(index: number): Promise<OpenFileResult>;
  selectFile(path: string, line?: number): Promise<OpenFileResult>;
  /** Opens a validated location hint after start; failures leave any current buffer intact. */
  openTarget(target: CodeTarget): Promise<TargetOpenResult>;
  requestExit(): ExitRequestResult;
  resolveDirtyChoice(choice: DirtyChoice): Promise<DirtyChoiceResult>;
  dispose(): void;
}
