import { CURSOR_MARKER, Key, decodeKittyPrintable, matchesKey, type Component, type Focusable } from "@earendil-works/pi-tui";
import type { BufferEditDelta, BufferEditPosition } from "../contracts.js";
import { sourceLineStyles } from "../highlight.js";

/** Host-neutral, lossless whole-buffer editor state. */
export interface BufferCursor {
  /** UTF-16 offset in the raw buffer. */
  offset: number;
  /** Zero-based logical line containing the cursor. */
  line: number;
  /** UTF-16 column within the logical line content. */
  column: number;
}

export interface BufferSelection {
  /** Ordered UTF-16 offsets in the raw buffer. */
  start: number;
  end: number;
  /** Exact raw source bytes represented as a JavaScript string. */
  text: string;
}

export interface BufferEditorInputResult {
  handled: boolean;
  textChanged: boolean;
  cursorChanged: boolean;
  /** Exact ordered UTF-16 splices performed by this input event. */
  deltas?: readonly BufferEditDelta[];
}

export interface BufferEditorRenderRow {
  text: string;
  /** One-based logical source line. */
  logicalLine: number;
  continuation: boolean;
  hasCursor: boolean;
  /** Zero-based terminal column of the rendered cursor cell, when present. */
  cursorColumn?: number;
}

export interface BufferEditorOptions {
  selectedLine?: number;
  tabWidth?: number;
  undoLimit?: number;
  /** Optional UTF-8 byte ceiling for atomic inserts and bracketed paste. */
  maxBytes?: number;
}

/** Observable bounded-layout diagnostic for focused tests and profiling. */
export interface BufferEditorRenderStats { constructedRows: number; }

interface LogicalLine { start: number; end: number; terminatorEnd: number; }
interface Snapshot { text: string; cursor: number; selectionAnchor: number | null; byteCount: number; inverse: BufferEditDelta; }
interface Token { text: string; width: number; rawLength: number; style: string; }
interface VisualLocation { row: number; column: number; }

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const unsafeControls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

function segments(text: string): Intl.SegmentData[] { return [...segmenter.segment(text)]; }
function previousGrapheme(text: string, offset: number): number {
  const last = segments(text.slice(0, offset)).at(-1);
  return last == null ? 0 : offset - last.segment.length;
}
function nextGrapheme(text: string, offset: number): number {
  const next = segmenter.segment(text.slice(offset))[Symbol.iterator]().next().value as Intl.SegmentData | undefined;
  return next == null ? text.length : offset + next.segment.length;
}
function graphemeWidth(text: string): number {
  if (/^[\u0300-\u036f\ufe00-\ufe0f\u200d]$/u.test(text)) return 0;
  if (/\p{Extended_Pictographic}|[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\uff01-\uff60\uffe0-\uffe6]/u.test(text)) return 2;
  return 1;
}
function keyResult(handled: boolean, textChanged: boolean, cursorChanged: boolean, deltas?: readonly BufferEditDelta[]): BufferEditorInputResult {
  return { handled, textChanged, cursorChanged, ...(deltas == null || deltas.length === 0 ? {} : { deltas }) };
}

/**
 * Lossless editor state plus a viewport-bounded pi-tui component. The two-argument
 * render overload retains source-row metadata for the workbench source renderer.
 */
export class WorkbenchBufferEditor implements Component, Focusable {
  private text: string;
  private cursor: number;
  private selectionAnchor: number | null = null;
  private byteCount: number;
  private preferredVisualColumn: number | undefined;
  private readonly tabWidth: number;
  private readonly undoLimit: number;
  private readonly maxBytes: number | undefined;
  private readonly undo: Snapshot[] = [];
  private logicalLines: LogicalLine[] = [];
  private lastRenderWidth: number | undefined;
  private lastRenderStats: BufferEditorRenderStats = { constructedRows: 0 };
  private pasteBuffer = "";
  private isPasting = false;
  focused = false;

  constructor(text: string, options: BufferEditorOptions = {}) {
    this.text = text;
    this.byteCount = Buffer.byteLength(text, "utf8");
    this.tabWidth = Math.max(1, Math.floor(options.tabWidth ?? 4));
    this.undoLimit = Math.max(1, Math.floor(options.undoLimit ?? 100));
    this.maxBytes = options.maxBytes == null || !Number.isFinite(options.maxBytes) ? undefined : Math.max(0, Math.floor(options.maxBytes));
    this.reindexLines();
    const line = Math.max(1, Math.min(options.selectedLine ?? this.logicalLines.length, this.logicalLines.length));
    this.cursor = this.logicalLines[line - 1]!.end;
  }

  getText(): string { return this.text; }
  getByteCount(): number { return this.byteCount; }
  getLineCount(): number { return this.logicalLines.length; }
  getCursor(): BufferCursor {
    const [line, index] = this.lineAtCursor();
    return { offset: this.cursor, line: index, column: this.cursor - line.start };
  }
  getSelection(): BufferSelection | null {
    const selection = this.selectionOffsets();
    return selection == null ? null : { ...selection, text: this.text.slice(selection.start, selection.end) };
  }
  insertText(value: string): BufferEditorInputResult { return this.insert(value); }
  deleteSelection(): BufferEditorInputResult {
    return this.replaceSelection() ?? keyResult(true, false, false);
  }
  selectAll(): BufferEditorInputResult {
    const old = this.cursor;
    this.selectionAnchor = 0;
    this.cursor = this.text.length;
    this.preferredVisualColumn = undefined;
    return keyResult(true, false, old !== this.cursor);
  }

  invalidate(): void {}
  getLastRenderStats(): BufferEditorRenderStats { return { ...this.lastRenderStats }; }

  handleInput(data: string): BufferEditorInputResult {
    if (data.includes("\x1b[200~")) {
      this.isPasting = true;
      this.pasteBuffer = "";
      data = data.slice(data.indexOf("\x1b[200~") + 6);
    }
    if (this.isPasting) {
      this.pasteBuffer += data;
      const end = this.pasteBuffer.indexOf("\x1b[201~");
      if (end < 0) return keyResult(true, false, false);
      const pasted = this.pasteBuffer.slice(0, end).replace(unsafeControls, "");
      const remaining = this.pasteBuffer.slice(end + 6);
      this.pasteBuffer = "";
      this.isPasting = false;
      const result = this.insert(pasted);
      if (remaining.length === 0) return result;
      const next = this.handleInput(remaining);
      return keyResult(
        true,
        result.textChanged || next.textChanged,
        result.cursorChanged || next.cursorChanged,
        [...(result.deltas ?? []), ...(next.deltas ?? [])],
      );
    }

    if (matchesKey(data, Key.super("a"))) return this.selectAll();
    if (matchesKey(data, Key.tab)) return this.insert("\t");
    // Treat a batched legacy CR/LF pair as one Enter event, preserving local EOL form.
    if (data === "\r\n" || data === "\n\r") return this.insert(this.localEol());
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.shift("enter"))) return this.insert(this.localEol());
    if (matchesKey(data, Key.shiftAlt(Key.left)) || matchesKey(data, Key.shiftAlt("b"))) return this.moveWord(-1, true);
    if (matchesKey(data, Key.shiftAlt(Key.right)) || matchesKey(data, Key.shiftAlt("f"))) return this.moveWord(1, true);
    if (matchesKey(data, Key.shift(Key.left))) return this.moveLeft(true);
    if (matchesKey(data, Key.shift(Key.right))) return this.moveRight(true);
    if (matchesKey(data, Key.shift(Key.up))) return this.moveVertical(-1, true);
    if (matchesKey(data, Key.shift(Key.down))) return this.moveVertical(1, true);
    if (matchesKey(data, Key.shift(Key.home))) return this.moveHome(true);
    if (matchesKey(data, Key.shift(Key.end))) return this.moveEnd(true);
    if (matchesKey(data, Key.alt(Key.left)) || matchesKey(data, Key.alt("b"))) return this.moveWord(-1);
    if (matchesKey(data, Key.alt(Key.right)) || matchesKey(data, Key.alt("f"))) return this.moveWord(1);
    if (matchesKey(data, Key.left)) return this.moveLeft();
    if (matchesKey(data, Key.right)) return this.moveRight();
    if (matchesKey(data, Key.up)) return this.moveVertical(-1);
    if (matchesKey(data, Key.down)) return this.moveVertical(1);
    if (matchesKey(data, Key.home) || matchesKey(data, Key.ctrl("a"))) return this.moveHome();
    if (matchesKey(data, Key.end)) return this.moveEnd();
    if (matchesKey(data, Key.backspace) || matchesKey(data, Key.shift("backspace"))) return this.deleteBackward();
    if (matchesKey(data, Key.delete)) return this.deleteForward();
    if (matchesKey(data, Key.ctrl("w")) || matchesKey(data, Key.alt(Key.backspace))) return this.deleteWordBackward();
    if (matchesKey(data, Key.alt(Key.delete))) return this.deleteWordForward();
    if (matchesKey(data, Key.ctrl("z"))) return this.restoreUndo();

    const printable = decodeKittyPrintable(data) ?? data;
    if (printable.length > 0 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(printable)) return this.insert(printable);
    return keyResult(false, false, false);
  }

  render(width: number): string[];
  render(width: number, maxRows: number, highlightedLines?: readonly string[]): BufferEditorRenderRow[];
  render(width: number, maxRows?: number, highlightedLines?: readonly string[]): string[] | BufferEditorRenderRow[] {
    const rows = this.renderRows(width, maxRows ?? 50, highlightedLines);
    return maxRows == null ? rows.map((row) => row.text) : rows;
  }

  /** Bounded row seam for callers/tests which need source metadata. */
  renderRows(width: number, maxRows: number, highlightedLines?: readonly string[]): BufferEditorRenderRow[] {
    const safeWidth = Math.max(0, Math.floor(width));
    const limit = Math.max(0, Math.floor(maxRows));
    this.lastRenderStats = { constructedRows: 0 };
    if (safeWidth === 0 || limit === 0) return [];
    this.lastRenderWidth = safeWidth;
    const [, cursorLine] = this.lineAtCursor();
    const cursorLocation = this.visualLocation(cursorLine, safeWidth, this.cursor);
    const beforeBudget = Math.floor((limit - 1) / 2);
    const afterBudget = limit - beforeBudget - 1;
    const result: BufferEditorRenderRow[] = [];

    // Only retain rows in the viewport. Counting a line's wraps may scan it, but
    // no full-file visual-row list is ever allocated.
    let needed = beforeBudget;
    for (let line = cursorLine - 1; line >= 0 && needed > 0; line -= 1) {
      const count = this.visualRowCount(line, safeWidth);
      const take = Math.min(needed, count);
      result.unshift(...this.buildLineRows(line, safeWidth, count - take, count, highlightedLines?.[line]));
      needed -= take;
    }
    const currentStart = Math.max(0, cursorLocation.row - needed);
    const currentEnd = Math.min(this.visualRowCount(cursorLine, safeWidth), cursorLocation.row + afterBudget + 1);
    result.push(...this.buildLineRows(cursorLine, safeWidth, currentStart, currentEnd, highlightedLines?.[cursorLine]));

    let neededAfter = limit - result.length;
    for (let line = cursorLine + 1; line < this.logicalLines.length && neededAfter > 0; line += 1) {
      const take = Math.min(neededAfter, this.visualRowCount(line, safeWidth));
      result.push(...this.buildLineRows(line, safeWidth, 0, take, highlightedLines?.[line]));
      neededAfter -= take;
    }
    return result.slice(0, limit);
  }

  private reindexLines(): void {
    const result: LogicalLine[] = [];
    let start = 0;
    for (let offset = 0; offset < this.text.length;) {
      if (this.text[offset] === "\r" || this.text[offset] === "\n") {
        const end = offset;
        offset += this.text[offset] === "\r" && this.text[offset + 1] === "\n" ? 2 : 1;
        result.push({ start, end, terminatorEnd: offset });
        start = offset;
      } else offset += 1;
    }
    result.push({ start, end: this.text.length, terminatorEnd: this.text.length });
    this.logicalLines = result;
  }

  private displayTokens(text: string, highlightedLine?: string): Token[] {
    let column = 0;
    let rawOffset = 0;
    const styles = highlightedLine == null ? null : sourceLineStyles(text, highlightedLine);
    return segments(text).map(({ segment }) => {
      const style = styles?.[rawOffset] ?? "";
      rawOffset += segment.length;
      if (segment === "\t") {
        const width = this.tabWidth - (column % this.tabWidth);
        column += width;
        return { text: " ".repeat(width), width, rawLength: 1, style };
      }
      const safe = segment.replace(unsafeControls, "�");
      const width = graphemeWidth(safe);
      column += width;
      return { text: safe, width, rawLength: segment.length, style };
    });
  }

  private visualRowCount(lineIndex: number, width: number): number {
    const line = this.logicalLines[lineIndex]!;
    let count = 0;
    let rowWidth = 0;
    let hasContent = false;
    for (const original of this.displayTokens(this.text.slice(line.start, line.end))) {
      const token = original.width > width ? { ...original, width: 1 } : original;
      if (token.width > 0 && rowWidth > 0 && rowWidth + token.width > width) { count += 1; rowWidth = 0; }
      rowWidth += token.width;
      hasContent = true;
      if (rowWidth >= width) { count += 1; rowWidth = 0; }
    }
    if (rowWidth > 0 || !hasContent) count += 1;
    // A cursor immediately after a full row occupies an additional empty cell.
    if (this.cursor === line.end && hasContent && rowWidth === 0) count += 1;
    return count;
  }

  private visualLocation(lineIndex: number, width: number, offset: number): VisualLocation {
    const line = this.logicalLines[lineIndex]!;
    let row = 0;
    let column = 0;
    let sourceOffset = line.start;
    for (const original of this.displayTokens(this.text.slice(line.start, line.end))) {
      const token = original.width > width ? { ...original, text: "�", width: 1 } : original;
      if (offset === sourceOffset) return { row, column };
      if (token.width > 0 && column > 0 && column + token.width > width) { row += 1; column = 0; }
      column += token.width;
      sourceOffset += token.rawLength;
      if (column >= width) { row += 1; column = 0; }
    }
    return { row, column };
  }

  private buildLineRows(lineIndex: number, width: number, wantedStart: number, wantedEnd: number, highlightedLine?: string): BufferEditorRenderRow[] {
    const line = this.logicalLines[lineIndex]!;
    const rows: BufferEditorRenderRow[] = [];
    let rowIndex = 0;
    let row = "";
    let rowWidth = 0;
    let continuation = false;
    let hasCursor = false;
    let cursorColumn: number | undefined;
    let sourceOffset = line.start;
    const containsCursor = this.cursor >= line.start && this.cursor <= line.end;
    const selection = this.selectionOffsets();
    const push = () => {
      if (rowIndex >= wantedStart && rowIndex < wantedEnd) {
        this.lastRenderStats.constructedRows += 1;
        rows.push({
        text: `${row}${" ".repeat(Math.max(0, width - rowWidth))}`,
        logicalLine: lineIndex + 1,
        continuation,
        hasCursor,
        ...(cursorColumn == null ? {} : { cursorColumn }),
        });
      }
      rowIndex += 1;
      row = ""; rowWidth = 0; continuation = true; hasCursor = false; cursorColumn = undefined;
    };
    for (const original of this.displayTokens(this.text.slice(line.start, line.end), highlightedLine)) {
      const token = original.width > width ? { ...original, text: "�", width: 1 } : original;
      if (containsCursor && this.cursor === sourceOffset && rowWidth === width) push();
      if (token.width > 0 && rowWidth > 0 && rowWidth + token.width > width) push();
      const atCursor = containsCursor && this.cursor === sourceOffset;
      const selected = selection != null && sourceOffset < selection.end && sourceOffset + token.rawLength > selection.start;
      if (atCursor || selected) {
        if (atCursor) {
          hasCursor = true;
          cursorColumn = rowWidth;
        }
        row += `${atCursor && this.focused ? CURSOR_MARKER : ""}${token.style}\u001b[7m${token.text}\u001b[27m${token.style === "" ? "" : "\u001b[0m"}`;
      } else row += token.style === "" ? token.text : `${token.style}${token.text}\u001b[0m`;
      rowWidth += token.width;
      sourceOffset += token.rawLength;
      if (rowWidth >= width) push();
    }
    if (containsCursor && this.cursor === line.end) {
      if (rowWidth >= width) push();
      hasCursor = true;
      cursorColumn = rowWidth;
      row += `${this.focused ? CURSOR_MARKER : ""}\u001b[7m \u001b[27m`;
      rowWidth += 1;
    }
    if (rowWidth > 0 || hasCursor || !continuation) push();
    return rows;
  }

  private positionAt(offset: number, lines = this.logicalLines): BufferEditPosition {
    let low = 0;
    let high = lines.length - 1;
    let index = 0;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (lines[middle]!.start <= offset) { index = middle; low = middle + 1; }
      else high = middle - 1;
    }
    const line = lines[index]!;
    return { line: index, column: Math.min(offset - line.start, line.end - line.start) };
  }
  private selectionOffsets(): { start: number; end: number } | null {
    if (this.selectionAnchor == null || this.selectionAnchor === this.cursor) return null;
    return { start: Math.min(this.selectionAnchor, this.cursor), end: Math.max(this.selectionAnchor, this.cursor) };
  }
  private applyEdit(from: number, to: number, value: string, cursorAfter = from + value.length): BufferEditorInputResult {
    if (from === to && value.length === 0) return keyResult(true, false, false);
    const deletedText = this.text.slice(from, to);
    const nextByteCount = this.byteCount - Buffer.byteLength(deletedText, "utf8") + Buffer.byteLength(value, "utf8");
    if (this.maxBytes != null && nextByteCount > this.maxBytes) return keyResult(true, false, false);
    const oldLines = this.logicalLines;
    const oldStart = this.positionAt(from, oldLines);
    const oldEnd = this.positionAt(to, oldLines);
    const previous = { text: this.text, cursor: this.cursor, selectionAnchor: this.selectionAnchor, byteCount: this.byteCount };
    this.text = this.text.slice(0, from) + value + this.text.slice(to);
    this.byteCount = nextByteCount;
    this.cursor = cursorAfter;
    this.selectionAnchor = null;
    this.preferredVisualColumn = undefined;
    this.reindexLines();
    const delta: BufferEditDelta = {
      startOffset: from, deletedText, insertedText: value,
      oldStart, oldEnd,
      newStart: this.positionAt(from), newEnd: this.positionAt(from + value.length),
      oldLineCount: oldLines.length, newLineCount: this.logicalLines.length,
    };
    const inverse: BufferEditDelta = {
      startOffset: from, deletedText: value, insertedText: deletedText,
      oldStart: delta.newStart, oldEnd: delta.newEnd,
      newStart: delta.oldStart, newEnd: delta.oldEnd,
      oldLineCount: delta.newLineCount, newLineCount: delta.oldLineCount,
    };
    this.undo.push({ ...previous, inverse });
    if (this.undo.length > this.undoLimit) this.undo.shift();
    return keyResult(true, true, previous.cursor !== this.cursor, [delta]);
  }
  private insert(value: string): BufferEditorInputResult {
    if (value.length === 0) return keyResult(true, false, false);
    const selection = this.selectionOffsets();
    return selection == null ? this.applyEdit(this.cursor, this.cursor, value) : this.applyEdit(selection.start, selection.end, value);
  }
  private replace(from: number, to: number): BufferEditorInputResult {
    return this.applyEdit(from, to, "", from);
  }
  private replaceSelection(): BufferEditorInputResult | null {
    const selection = this.selectionOffsets();
    return selection == null ? null : this.replace(selection.start, selection.end);
  }
  private lineAtCursor(): [LogicalLine, number] {
    const index = this.logicalLines.findIndex((line, i) => this.cursor >= line.start && (i === this.logicalLines.length - 1 || this.cursor < line.terminatorEnd));
    return [this.logicalLines[Math.max(0, index)]!, Math.max(0, index)];
  }
  private eolAt(offset: number): number { return this.text[offset] === "\r" && this.text[offset + 1] === "\n" ? 2 : /[\r\n]/.test(this.text[offset] ?? "") ? 1 : 0; }
  private finishMove(old: number, extend: boolean): BufferEditorInputResult {
    if (extend) {
      if (this.selectionAnchor == null) this.selectionAnchor = old;
    } else this.selectionAnchor = null;
    return keyResult(true, false, old !== this.cursor);
  }
  private moveLeft(extend = false): BufferEditorInputResult {
    const old = this.cursor;
    const selection = this.selectionOffsets();
    if (!extend && selection != null) this.cursor = selection.start;
    else {
      const eol = this.eolAt(this.cursor - 2) === 2 ? 2 : this.eolAt(this.cursor - 1);
      this.cursor = eol > 0 ? this.cursor - eol : previousGrapheme(this.text, this.cursor);
    }
    this.preferredVisualColumn = undefined;
    return this.finishMove(old, extend);
  }
  private moveRight(extend = false): BufferEditorInputResult {
    const old = this.cursor;
    const selection = this.selectionOffsets();
    if (!extend && selection != null) this.cursor = selection.end;
    else {
      const eol = this.eolAt(this.cursor);
      this.cursor = eol > 0 ? this.cursor + eol : nextGrapheme(this.text, this.cursor);
    }
    this.preferredVisualColumn = undefined;
    return this.finishMove(old, extend);
  }
  private moveHome(extend = false): BufferEditorInputResult { const [line] = this.lineAtCursor(); const old = this.cursor; this.cursor = line.start; this.preferredVisualColumn = undefined; return this.finishMove(old, extend); }
  private moveEnd(extend = false): BufferEditorInputResult { const [line] = this.lineAtCursor(); const old = this.cursor; this.cursor = line.end; this.preferredVisualColumn = undefined; return this.finishMove(old, extend); }
  private deleteBackward(): BufferEditorInputResult { const selected = this.replaceSelection(); if (selected != null) return selected; if (this.cursor === 0) return keyResult(true, false, false); const eol = this.eolAt(this.cursor - 2) === 2 ? 2 : this.eolAt(this.cursor - 1); return this.replace(eol > 0 ? this.cursor - eol : previousGrapheme(this.text, this.cursor), this.cursor); }
  private deleteForward(): BufferEditorInputResult { const selected = this.replaceSelection(); if (selected != null) return selected; if (this.cursor >= this.text.length) return keyResult(true, false, false); const eol = this.eolAt(this.cursor); return this.replace(this.cursor, this.cursor + (eol || nextGrapheme(this.text, this.cursor) - this.cursor)); }
  private wordOffset(direction: -1 | 1): number {
    let offset = this.cursor;
    const current = () => this.text.slice(direction < 0 ? previousGrapheme(this.text, offset) : offset, direction < 0 ? offset : nextGrapheme(this.text, offset));
    const kind = (value: string) => /\s/u.test(value) ? "space" : /[\p{L}\p{M}\p{N}_$]/u.test(value) ? "word" : "punctuation";
    const step = () => { offset = direction < 0 ? (this.eolAt(offset - 2) === 2 ? offset - 2 : this.eolAt(offset - 1) ? offset - 1 : previousGrapheme(this.text, offset)) : offset + (this.eolAt(offset) || nextGrapheme(this.text, offset) - offset); };
    while ((direction < 0 ? offset > 0 : offset < this.text.length) && kind(current()) === "space") step();
    const target = direction < 0 ? offset > 0 ? kind(current()) : null : offset < this.text.length ? kind(current()) : null;
    while (target != null && (direction < 0 ? offset > 0 : offset < this.text.length) && kind(current()) === target) step();
    return offset;
  }
  private moveWord(direction: -1 | 1, extend = false): BufferEditorInputResult {
    const old = this.cursor;
    const selection = this.selectionOffsets();
    if (!extend && selection != null) this.cursor = direction < 0 ? selection.start : selection.end;
    else this.cursor = this.wordOffset(direction);
    this.preferredVisualColumn = undefined;
    return this.finishMove(old, extend);
  }
  private deleteWordBackward(): BufferEditorInputResult { const selected = this.replaceSelection(); if (selected != null) return selected; const end = this.cursor; const start = this.wordOffset(-1); return this.replace(start, end); }
  private deleteWordForward(): BufferEditorInputResult { const selected = this.replaceSelection(); if (selected != null) return selected; const start = this.cursor; const end = this.wordOffset(1); return this.replace(start, end); }
  private moveVertical(direction: -1 | 1, extend = false): BufferEditorInputResult {
    const old = this.cursor;
    const [line, index] = this.lineAtCursor();
    const width = this.lastRenderWidth;
    if (width == null) {
      const target = this.logicalLines[index + direction];
      if (target == null) return this.finishMove(old, extend);
      const column = this.preferredVisualColumn ?? this.visualColumn(line.start, this.cursor);
      this.cursor = this.offsetAtColumn(target, column);
      this.preferredVisualColumn = column;
      return this.finishMove(old, extend);
    }
    const location = this.visualLocation(index, width, this.cursor);
    const preferred = this.preferredVisualColumn ?? location.column;
    let targetLine = index;
    let targetRow = location.row + direction;
    if (targetRow < 0) { targetLine -= 1; if (targetLine < 0) return this.finishMove(old, extend); targetRow = this.visualRowCount(targetLine, width) - 1; }
    else if (targetRow >= this.visualRowCount(index, width)) { targetLine += 1; if (targetLine >= this.logicalLines.length) return this.finishMove(old, extend); targetRow = 0; }
    this.cursor = this.offsetAtVisualRow(targetLine, targetRow, preferred, width);
    this.preferredVisualColumn = preferred;
    return this.finishMove(old, extend);
  }
  private visualColumn(start: number, end: number): number { return this.displayTokens(this.text.slice(start, end)).reduce((total, token) => total + token.width, 0); }
  private offsetAtColumn(line: LogicalLine, column: number): number { let offset = line.start; let width = 0; for (const { segment } of segments(this.text.slice(line.start, line.end))) { const next = segment === "\t" ? this.tabWidth - (width % this.tabWidth) : graphemeWidth(segment); if (width + next > column) break; width += next; offset += segment.length; } return offset; }
  private offsetAtVisualRow(lineIndex: number, targetRow: number, column: number, width: number): number {
    const line = this.logicalLines[lineIndex]!;
    let row = 0; let rowWidth = 0; let offset = line.start;
    for (const original of this.displayTokens(this.text.slice(line.start, line.end))) {
      const token = original.width > width ? { ...original, width: 1 } : original;
      if (token.width > 0 && rowWidth > 0 && rowWidth + token.width > width) { if (row === targetRow) return offset; row += 1; rowWidth = 0; }
      if (row === targetRow && rowWidth + token.width > column) return offset;
      rowWidth += token.width; offset += token.rawLength;
      if (rowWidth >= width) { if (row === targetRow) return offset; row += 1; rowWidth = 0; }
    }
    return offset;
  }
  private localEol(): string { const [line, index] = this.lineAtCursor(); const own = this.text.slice(line.end, line.terminatorEnd); return own || this.text.slice(this.logicalLines[index - 1]?.end ?? 0, this.logicalLines[index - 1]?.terminatorEnd ?? 0) || this.text.slice(this.logicalLines[index + 1]?.end ?? 0, this.logicalLines[index + 1]?.terminatorEnd ?? 0) || "\n"; }
  private restoreUndo(): BufferEditorInputResult {
    const previous = this.undo.pop();
    if (previous == null) return keyResult(true, false, false);
    const cursorChanged = this.cursor !== previous.cursor;
    this.text = previous.text;
    this.cursor = previous.cursor;
    this.selectionAnchor = previous.selectionAnchor;
    this.byteCount = previous.byteCount;
    this.preferredVisualColumn = undefined;
    this.reindexLines();
    return keyResult(true, true, cursorChanged, [previous.inverse]);
  }
}
