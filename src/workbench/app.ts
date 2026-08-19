import type {
  DirtyChoice,
  DirtyChoiceResult,
  ExitRequestResult,
  OpenFileResult,
  PendingWorkbenchAction,
  SaveTextResult,
  CodeTarget,
  LineRange,
  TargetOpenResult,
  Workbench,
  WorkbenchRepository,
  BufferEditDelta,
} from "./contracts.js";
import { plainSourceLines } from "./contracts.js";
import { filterRepositoryFiles, isRepositoryRelativePath, parseGitFileList } from "./navigator.js";
import { createRepositoryTree, type RepositoryTree } from "./tree.js";
import { clampLineRange, hashTargetSlice } from "./target.js";
import { projectHighlightedSourceLineDelta, projectHighlightedSourceLines, validateHighlightedSourceLines } from "./highlight.js";

const INVALID_BUFFER_DELTA = "Invalid buffer delta batch.";

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\r") { if (text[index + 1] === "\n") index += 1; starts.push(index + 1); }
    else if (text[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function splitsProtectedBoundary(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return false;
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return (before === 13 && after === 10) || (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff);
}

function validInteger(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= minimum && value <= maximum;
}

function createWarmedTree(paths: readonly string[]): RepositoryTree {
  const tree = createRepositoryTree(paths);
  tree.rows();
  return tree;
}

function lineCount(text: string): number {
  return text.split(/\r\n|\r|\n/).length;
}

class CodeWorkbench implements Workbench {
  private allFiles: string[] = [];
  private filteredFiles: string[] = [];
  private tree: RepositoryTree = createWarmedTree([]);
  private currentPath: string | null = null;
  private currentText: string | null = null;
  private savedText: string | null = null;
  private currentRevision: string | null = null;
  private currentLine: number | null = null;
  private currentRange: LineRange | null = null;
  private currentSourceLines: readonly string[] | null = null;
  private currentPlainLines: readonly string[] | null = null;
  private currentHighlightedLines: readonly string[] | null = null;
  /** Starts are updated from each splice; validating a batch never re-splits its buffer. */
  private currentLineStarts: readonly number[] | null = null;
  private bufferVersion = 0;
  private openVersion = 0;
  private readonly savedPaths = new Set<string>();
  private pending: PendingWorkbenchAction | null = null;
  private disposed = false;

  constructor(private readonly repository: WorkbenchRepository) {}

  get files(): readonly string[] { return this.allFiles; }
  get repositoryTree(): RepositoryTree { return this.tree; }
  get visibleFiles(): readonly string[] { return this.filteredFiles; }
  get selectedPath(): string | null { return this.currentPath; }
  get selectedText(): string | null { return this.currentText; }
  get bufferText(): string | null { return this.currentText; }
  get selectedRevision(): string | null { return this.currentRevision; }
  get selectedLine(): number | null { return this.currentLine; }
  get selectedRange(): LineRange | null { return this.currentRange == null ? null : { ...this.currentRange }; }
  get highlightedLines(): readonly string[] | null { return this.currentHighlightedLines; }
  get supportsSourceHighlighting(): boolean { return this.repository.sourceHighlighter != null; }
  get isDirty(): boolean { return this.currentText != null && this.savedText != null && this.currentText !== this.savedText; }
  get changedPaths(): readonly string[] { return [...this.savedPaths]; }
  get pendingAction(): PendingWorkbenchAction | null { return this.pending == null ? null : { ...this.pending }; }
  async start(signal?: AbortSignal): Promise<void> {
    this.ensureActive();
    const files = parseGitFileList(await this.repository.listFiles(signal));
    const tree = createWarmedTree(files);
    this.ensureActive();
    this.allFiles = files;
    this.filteredFiles = [...files];
    this.tree = tree;
  }

  setFilter(query: string): void {
    this.ensureActive();
    this.filteredFiles = filterRepositoryFiles(this.allFiles, query);
  }

  setSelectedLine(line: number, knownLineCount?: number): void {
    this.ensureActive();
    if (this.currentText == null) throw new Error("No source buffer is open.");
    const count = knownLineCount == null ? lineCount(this.currentText) : Math.max(1, Math.floor(knownLineCount));
    this.currentLine = Math.max(1, Math.min(count, Math.floor(line)));
    this.currentRange = { startLine: this.currentLine, endLine: this.currentLine };
  }

  setSelectedRange(range: LineRange, activeLine = range.endLine): void {
    this.ensureActive();
    if (this.currentText == null) throw new Error("No source buffer is open.");
    const clamped = clampLineRange(range, this.currentText);
    this.currentRange = clamped;
    this.currentLine = Math.max(clamped.startLine, Math.min(clamped.endLine, Math.floor(activeLine)));
  }

  replaceBuffer(text: string, selectedLine = this.currentLine ?? 1): void {
    this.ensureActive();
    if (this.currentPath == null || this.currentText == null) throw new Error("No source buffer is open.");
    if (this.currentText === text) return;
    const previousText = this.currentText;
    const previousHighlights = this.currentHighlightedLines;
    this.currentText = text;
    this.currentSourceLines = text.split(/\r\n|\r|\n/);
    this.currentLineStarts = lineStarts(text);
    this.currentPlainLines = plainSourceLines(text);
    this.currentHighlightedLines = previousHighlights == null ? this.currentPlainLines : projectHighlightedSourceLines(previousText, previousHighlights, text);
    this.bufferVersion += 1;
    this.setSelectedLine(selectedLine, this.currentSourceLines.length);
  }

  applyBufferDeltas(deltas: readonly BufferEditDelta[], selectedLine = this.currentLine ?? 1): void {
    this.ensureActive();
    if (this.currentPath == null || this.currentText == null || this.currentSourceLines == null || this.currentPlainLines == null || this.currentHighlightedLines == null || this.currentLineStarts == null || deltas.length === 0) throw new Error(INVALID_BUFFER_DELTA);
    let text = this.currentText;
    let sourceLines = this.currentSourceLines;
    let plainLines = this.currentPlainLines;
    let highlightedLines = this.currentHighlightedLines;
    let starts = this.currentLineStarts;
    try {
      for (const delta of deltas) {
        const deletionEnd = delta.startOffset + delta.deletedText.length;
        if (!validInteger(delta.startOffset, 0, text.length) || !validInteger(delta.oldLineCount, 1, Number.MAX_SAFE_INTEGER) || !validInteger(delta.newLineCount, 1, Number.MAX_SAFE_INTEGER)
          || !validInteger(delta.oldStart?.line, 0, sourceLines.length - 1) || !validInteger(delta.oldEnd?.line, 0, sourceLines.length - 1)
          || !validInteger(delta.oldStart?.column, 0, Number.MAX_SAFE_INTEGER) || !validInteger(delta.oldEnd?.column, 0, Number.MAX_SAFE_INTEGER)
          || !validInteger(delta.newStart?.line, 0, Number.MAX_SAFE_INTEGER) || !validInteger(delta.newEnd?.line, 0, Number.MAX_SAFE_INTEGER)
          || !validInteger(delta.newStart?.column, 0, Number.MAX_SAFE_INTEGER) || !validInteger(delta.newEnd?.column, 0, Number.MAX_SAFE_INTEGER)
          || typeof delta.deletedText !== "string" || typeof delta.insertedText !== "string" || deletionEnd > text.length || splitsProtectedBoundary(text, delta.startOffset) || splitsProtectedBoundary(text, deletionEnd)
          || delta.oldLineCount !== sourceLines.length || delta.startOffset !== starts[delta.oldStart.line]! + delta.oldStart.column || deletionEnd !== starts[delta.oldEnd.line]! + delta.oldEnd.column
          || delta.oldEnd.line < delta.oldStart.line || delta.oldStart.column > sourceLines[delta.oldStart.line]!.length || delta.oldEnd.column > sourceLines[delta.oldEnd.line]!.length
          || text.slice(delta.startOffset, deletionEnd) !== delta.deletedText) throw new Error(INVALID_BUFFER_DELTA);
        const nextText = text.slice(0, delta.startOffset) + delta.insertedText + text.slice(deletionEnd);
        const projected = projectHighlightedSourceLineDelta(sourceLines, plainLines, highlightedLines, delta);
        if (projected == null || projected.sourceLines.length !== delta.newLineCount || projected.plainLines.length !== delta.newLineCount || projected.highlightedLines.length !== delta.newLineCount) throw new Error(INVALID_BUFFER_DELTA);
        const inserted = delta.insertedText.split(/\r\n|\r|\n/);
        const affected = delta.oldEnd.line - delta.oldStart.line + 1;
        const expected = inserted.length === 1 ? [`${sourceLines[delta.oldStart.line]!.slice(0, delta.oldStart.column)}${inserted[0]}${sourceLines[delta.oldEnd.line]!.slice(delta.oldEnd.column)}`] : [`${sourceLines[delta.oldStart.line]!.slice(0, delta.oldStart.column)}${inserted[0]}`, ...inserted.slice(1, -1), `${inserted.at(-1)}${sourceLines[delta.oldEnd.line]!.slice(delta.oldEnd.column)}`];
        if (projected.sourceLines.slice(delta.oldStart.line, delta.oldStart.line + expected.length).join("\n") !== expected.join("\n")) throw new Error(INVALID_BUFFER_DELTA);
        const nextStarts = starts.slice();
        const replacementStarts = [starts[delta.oldStart.line]!];
        for (const match of delta.insertedText.matchAll(/\r\n|\r|\n/g)) replacementStarts.push(delta.startOffset + match.index! + match[0].length);
        nextStarts.splice(delta.oldStart.line, affected, ...replacementStarts);
        const shift = nextText.length - text.length;
        for (let index = delta.oldStart.line + expected.length; index < nextStarts.length; index += 1) nextStarts[index] = nextStarts[index]! + shift;
        text = nextText; sourceLines = projected.sourceLines; plainLines = projected.plainLines; highlightedLines = projected.highlightedLines; starts = nextStarts;
      }
    } catch { throw new Error(INVALID_BUFFER_DELTA); }
    this.currentText = text; this.currentSourceLines = sourceLines; this.currentPlainLines = plainLines; this.currentHighlightedLines = highlightedLines; this.currentLineStarts = starts;
    this.bufferVersion += 1;
    this.setSelectedLine(selectedLine, sourceLines.length);
  }

  async refreshHighlight(): Promise<void> {
    const { currentPath: path, currentText: text } = this;
    const version = this.bufferVersion;
    if (path == null || text == null || this.repository.sourceHighlighter == null) return;
    try {
      const lines = await this.repository.sourceHighlighter.highlight(path, text);
      if (!this.disposed && version === this.bufferVersion && path === this.currentPath && text === this.currentText) {
        this.currentHighlightedLines = validateHighlightedSourceLines(text, lines) ?? this.currentPlainLines ?? plainSourceLines(text);
      }
    } catch {
      // The projected or plain, sanitized current source remains visible.
    }
  }

  async save(): Promise<SaveTextResult> {
    this.ensureActive();
    if (this.currentPath == null || this.currentText == null || this.currentRevision == null) {
      return { status: "error", message: "No source buffer is open." };
    }
    const path = this.currentPath;
    const text = this.currentText;
    const revision = this.currentRevision;
    let result: SaveTextResult;
    try {
      result = await this.repository.saveText(path, text, revision);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { status: "error", message: `Could not save ${path}: ${message}` };
    }
    if (result.status === "success") {
      if (this.currentPath === path) {
        this.currentRevision = result.revision;
        this.savedText = text;
        if (result.effect === "saved") this.savedPaths.add(path);
        await this.refreshHighlight();
      }
    }
    return result;
  }

  async selectVisibleFile(index: number): Promise<OpenFileResult> {
    const path = this.filteredFiles[index];
    if (path == null) throw new Error("No file is selected.");
    return this.selectFile(path);
  }

  async openTarget(target: CodeTarget): Promise<TargetOpenResult> {
    this.ensureActive();
    if (!this.allFiles.includes(target.path)) return { status: "missing", path: target.path, message: "Target file is not available in this repository." };
    try {
      const opened = await this.selectFile(target.path, target.range.startLine);
      if (opened.status !== "opened" || this.currentText == null) return { status: "unreadable", path: target.path, message: "Target could not be opened while changes require a decision." };
      const range = clampLineRange(target.range, this.currentText);
      const clamped = range.startLine !== target.range.startLine || range.endLine !== target.range.endLine;
      const stale = clamped || (target.anchor != null && hashTargetSlice(this.currentText, range).value !== target.anchor.value);
      this.setSelectedRange(range, range.startLine);
      return {
        status: "opened", path: target.path, range, stale,
        ...(clamped ? { message: "Target range was clamped to the current file." } : target.anchor != null && stale ? { message: "Target anchor no longer matches this file." } : {}),
      };
    } catch (error) {
      return { status: "unreadable", path: target.path, message: error instanceof Error ? error.message : String(error) };
    }
  }

  async selectFile(path: string, line = 1): Promise<OpenFileResult> {
    this.ensureActive();
    this.validateListedPath(path);
    if (path === this.currentPath) {
      this.setSelectedLine(line);
      return { status: "opened", path, line: this.currentLine ?? 1 };
    }
    if (this.isDirty) {
      this.pending = { action: "switch", targetPath: path, targetLine: line };
      return { status: "confirmation-required", action: "switch", targetPath: path };
    }
    return this.openFile(path, line);
  }

  requestExit(): ExitRequestResult {
    this.ensureActive();
    if (this.isDirty) {
      this.pending = { action: "exit" };
      return { status: "confirmation-required", action: "exit" };
    }
    return { status: "closed", changedPaths: this.changedPaths };
  }

  async resolveDirtyChoice(choice: DirtyChoice): Promise<DirtyChoiceResult> {
    this.ensureActive();
    const pending = this.pending;
    if (pending == null) throw new Error("No dirty-buffer action is pending.");
    if (choice === "cancel") {
      this.pending = null;
      return { status: "cancelled", action: pending.action, changedPaths: this.changedPaths };
    }
    let warning: string | undefined;
    if (choice === "save") {
      const save = await this.save();
      if (save.status !== "success") {
        return { status: "save-failed", action: pending.action, save, changedPaths: this.changedPaths };
      }
      warning = save.warning;
    } else {
      this.currentText = this.savedText;
      this.bufferVersion += 1;
      this.currentSourceLines = this.currentText == null ? null : this.currentText.split(/\r\n|\r|\n/);
      this.currentLineStarts = this.currentText == null ? null : lineStarts(this.currentText);
      this.currentPlainLines = this.currentText == null ? null : plainSourceLines(this.currentText);
      this.currentHighlightedLines = this.currentPlainLines;
      await this.refreshHighlight();
    }
    this.pending = null;
    if (pending.action === "exit") {
      if (warning != null) return { status: "warning", action: "exit", warning, changedPaths: this.changedPaths };
      return { status: "closed", changedPaths: this.changedPaths };
    }
    const opened = await this.openFile(pending.targetPath, pending.targetLine);
    return warning == null ? { ...opened, changedPaths: this.changedPaths } : { ...opened, changedPaths: this.changedPaths, warning };
  }

  dispose(): void {
    if (this.isDirty) throw new Error("Cannot dispose a dirty workbench; request a safe exit first.");
    this.disposed = true;
    this.allFiles = [];
    this.filteredFiles = [];
    this.tree = createWarmedTree([]);
    this.currentPath = null;
    this.currentText = null;
    this.savedText = null;
    this.currentRevision = null;
    this.currentLine = null;
    this.currentRange = null;
    this.currentSourceLines = null;
    this.currentLineStarts = null;
    this.currentPlainLines = null;
    this.currentHighlightedLines = null;
    this.bufferVersion += 1;
    this.openVersion += 1;
    this.pending = null;
  }

  private async openFile(path: string, line: number): Promise<Extract<OpenFileResult, { status: "opened" }>> {
    const openVersion = ++this.openVersion;
    if (this.repository.canReadFile != null && !await this.repository.canReadFile(path)) throw new Error("Selected file is not readable within host limits.");
    const snapshot = await this.repository.readText(path, this.repository.maxReadBytes);
    if (openVersion !== this.openVersion) return { status: "opened", path, line: Math.max(1, Math.floor(line)) };
    this.currentText = snapshot.text;
    this.savedText = snapshot.text;
    this.currentRevision = snapshot.revision;
    this.currentPath = path;
    this.currentLine = Math.max(1, Math.floor(line));
    this.currentRange = { startLine: this.currentLine, endLine: this.currentLine };
    this.bufferVersion += 1;
    this.currentSourceLines = snapshot.text.split(/\r\n|\r|\n/);
    this.currentLineStarts = lineStarts(snapshot.text);
    this.currentPlainLines = plainSourceLines(snapshot.text);
    this.currentHighlightedLines = this.currentPlainLines;
    await this.refreshHighlight();
    return { status: "opened", path, line: this.currentLine };
  }

  private validateListedPath(path: string): void {
    if (!this.allFiles.includes(path)) throw new Error("File is not in the repository listing.");
    if (!isRepositoryRelativePath(path)) throw new Error("Selected file is outside the repository.");
  }

  private ensureActive(): void {
    if (this.disposed) throw new Error("Workbench has been disposed.");
  }
}

export function createWorkbench(repository: WorkbenchRepository): Workbench {
  return new CodeWorkbench(repository);
}
