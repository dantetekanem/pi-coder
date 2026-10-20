import { visibleWidth } from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "../sanitize.js";

const SGR_MOUSE_PATTERN = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;
const TERMINAL_SEQUENCE_SOURCE = String.raw`\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|_[^\x07\x1b]*(?:\x07|\x1b\\))`;
const TERMINAL_SEQUENCE_PATTERN = new RegExp(TERMINAL_SEQUENCE_SOURCE, "g");
const TERMINAL_SEQUENCE_AT = new RegExp(TERMINAL_SEQUENCE_SOURCE, "y");
const SGR_PATTERN = /\x1b\[[0-9;:]*m/g;
const ELLIPSIS = "…";
const TAB_WIDTH = 3;
const MULTI_CLICK_INTERVAL_MS = 500;
// Match Pi's fullscreen selection, which keeps paths and kebab-case tokens whole on double-click.
const WORD_JOINERS = new Set(["/", "-"]);
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });

export type SelectionGranularity = "character" | "word" | "line";

export interface SgrMouseInput {
  button: number;
  col: number;
  row: number;
  release: boolean;
}

export function parseSgrMouseInput(data: string): SgrMouseInput | null {
  const match = SGR_MOUSE_PATTERN.exec(data);
  if (match == null) return null;
  return {
    button: Number.parseInt(match[1]!, 10),
    col: Number.parseInt(match[2]!, 10) - 1,
    row: Number.parseInt(match[3]!, 10) - 1,
    release: match[4] === "m",
  };
}

export function stripTerminalSequences(text: string): string {
  return text.replace(TERMINAL_SEQUENCE_PATTERN, "");
}

function cellWidth(grapheme: string): number {
  return grapheme === "\t" ? TAB_WIDTH : visibleWidth(grapheme);
}

interface ColumnCell {
  index: number;
  length: number;
  col: number;
  width: number;
}

function columnCells(plain: string): ColumnCell[] {
  const cells: ColumnCell[] = [];
  let col = 0;
  for (const { segment, index } of graphemeSegmenter.segment(plain)) {
    const width = cellWidth(segment);
    cells.push({ index, length: segment.length, col, width });
    col += width;
  }
  return cells;
}

function sliceColumns(plain: string, start: number, end: number): string {
  let result = "";
  for (const cell of columnCells(plain)) {
    if (cell.col >= end) break;
    if (cell.col >= start) result += plain.slice(cell.index, cell.index + cell.length);
  }
  return result;
}

function snapColumnsToGraphemes(plain: string, start: number, endInclusive: number): { start: number; end: number } {
  let snappedStart = start;
  let snappedEnd = endInclusive + 1;
  for (const cell of columnCells(plain)) {
    if (start >= cell.col && start < cell.col + cell.width) snappedStart = cell.col;
    if (endInclusive >= cell.col && endInclusive < cell.col + cell.width) snappedEnd = cell.col + cell.width;
  }
  return { start: snappedStart, end: Math.max(snappedStart, snappedEnd) };
}

interface DisplayMap {
  start(index: number): number;
  end(index: number): number;
}

function mapDisplayToSource(source: string, display: string): DisplayMap {
  const clamp = (index: number) => Math.max(0, Math.min(source.length, index));
  if (display !== source && sanitizeTerminalText(source) === display) {
    const owners: number[] = [];
    for (let index = 0; index < source.length; index += 1) {
      const shown = sanitizeTerminalText(source[index]!).length;
      for (let count = 0; count < shown; count += 1) owners.push(index);
    }
    return {
      start: (index) => index >= owners.length ? source.length : owners[Math.max(0, index)]!,
      end: (index) => index <= 0 ? 0 : index > owners.length ? source.length : owners[index - 1]! + 1,
    };
  }
  return { start: clamp, end: clamp };
}

export interface CodeCell {
  col: number;
  width: number;
  start: number;
  end: number;
}

/** One rendered visual line of a code row, with each cell mapped back to source offsets. */
export interface CodeLine {
  cells: CodeCell[];
  start: number;
  end: number;
  endCol: number;
}

function findVisualLine(content: string, text: string, cursor: number): number {
  let start = cursor;
  while (start < content.length && !content.startsWith(text, start) && /\s/.test(content[start]!)) start += 1;
  return content.startsWith(text, start) ? start : content.indexOf(text, cursor);
}

/**
 * Aligns the plain text of rendered (possibly wrapped or truncated) visual lines with the row's
 * plain content, which is the gutter followed by the displayed code, and maps every code cell
 * back to an offset in the original source line.
 */
export function layoutCodeLines(visualLines: readonly string[], content: string, display: string, source: string): CodeLine[] | null {
  if (!content.endsWith(display)) return null;
  const codeStart = content.length - display.length;
  const map = mapDisplayToSource(source, display);
  const sourceStart = (contentIndex: number) => map.start(Math.max(0, contentIndex - codeStart));
  const sourceEnd = (contentIndex: number) => map.end(Math.max(0, contentIndex - codeStart));
  const lines: CodeLine[] = [];
  let cursor = 0;
  for (let lineIndex = 0; lineIndex < visualLines.length; lineIndex += 1) {
    let text = visualLines[lineIndex]!;
    let start = findVisualLine(content, text, cursor);
    let truncated = false;
    if (start < 0 && text.endsWith(ELLIPSIS)) {
      text = text.slice(0, -ELLIPSIS.length);
      start = findVisualLine(content, text, cursor);
      truncated = true;
    }
    if (start < 0) return null;
    const cells: CodeCell[] = [];
    let col = 0;
    let offset = start;
    for (const { segment } of graphemeSegmenter.segment(text)) {
      const width = cellWidth(segment);
      if (offset >= codeStart) cells.push({ col, width, start: sourceStart(offset), end: sourceEnd(offset + segment.length) });
      col += width;
      offset += segment.length;
    }
    const last = truncated || lineIndex === visualLines.length - 1;
    lines.push({ cells, start: sourceStart(start), end: last ? source.length : sourceEnd(offset), endCol: col });
    if (truncated) break;
    cursor = offset;
  }
  return lines;
}

export interface CodeHit {
  start: number;
  end: number;
}

/** Returns the source cell under a column, or an empty boundary before or after the line's code. */
export function hitCodeLine(line: CodeLine, col: number): CodeHit {
  const first = line.cells[0];
  if (first == null || col < first.col) return { start: line.start, end: line.start };
  const cell = line.cells.find((candidate) => col < candidate.col + candidate.width);
  return cell == null ? { start: line.end, end: line.end } : { start: cell.start, end: cell.end };
}

export function selectedColumns(line: CodeLine, from: number, to: number): { start: number; end: number } | null {
  let start = -1;
  let end = -1;
  for (const cell of line.cells) {
    if (cell.end <= from || cell.start >= to) continue;
    if (start < 0) start = cell.col;
    end = cell.col + cell.width;
  }
  return start < 0 ? null : { start, end };
}

export interface CodePosition {
  row: number;
  offset: number;
}

export interface CodeRange {
  start: CodePosition;
  end: CodePosition;
}

function compareCodePositions(left: CodePosition, right: CodePosition): number {
  return left.row - right.row || left.offset - right.offset;
}

/** Character selection includes the cells under both the press and the pointer, like terminal selection. */
export function characterCodeRange(anchorRow: number, anchor: CodeHit, focusRow: number, focus: CodeHit): CodeRange | null {
  if (anchorRow === focusRow && anchor.start === focus.start && anchor.end === focus.end) return null;
  const focusFirst = focusRow < anchorRow || (focusRow === anchorRow && focus.start < anchor.start);
  const range = focusFirst
    ? { start: { row: focusRow, offset: focus.start }, end: { row: anchorRow, offset: anchor.end } }
    : { start: { row: anchorRow, offset: anchor.start }, end: { row: focusRow, offset: focus.end } };
  return compareCodePositions(range.start, range.end) < 0 ? range : null;
}

export function extendCodeRange(initial: CodeRange, target: CodeRange): CodeRange {
  if (compareCodePositions(target.start, initial.start) < 0) return { start: target.start, end: initial.end };
  return { start: initial.start, end: compareCodePositions(target.end, initial.end) > 0 ? target.end : initial.end };
}

export function wordRangeAt(text: string, offset: number): { start: number; end: number } | null {
  if (offset < 0 || offset >= text.length) return null;
  const segments = Array.from(wordSegmenter.segment(text), ({ segment, index, isWordLike }) => {
    const joiner = WORD_JOINERS.has(segment);
    return { start: index, end: index + segment.length, selectable: isWordLike === true || joiner, joiner };
  });
  const clicked = segments.findIndex((segment) => offset >= segment.start && offset < segment.end);
  if (clicked < 0) return null;
  const joins = (left: typeof segments[number], right: typeof segments[number]) => left.selectable && right.selectable && (left.joiner || right.joiner);
  let first = clicked;
  let last = clicked;
  while (first > 0 && joins(segments[first - 1]!, segments[first]!)) first -= 1;
  while (last < segments.length - 1 && joins(segments[last]!, segments[last + 1]!)) last += 1;
  return { start: segments[first]!.start, end: segments[last]!.end };
}

/** Maps offsets in a diff row, where tabs are expanded and a CR may remain, back to the file line. */
function mapExpandedTabs(source: string, text: string): DisplayMap | null {
  const body = text.endsWith("\r") && !source.endsWith("\r") ? text.slice(0, -1) : text;
  const tabs = source.split("\t").length - 1;
  const tabWidth = tabs === 0 ? 1 : (body.length - source.length) / tabs + 1;
  if (!Number.isInteger(tabWidth) || tabWidth < 1 || source.replaceAll("\t", " ".repeat(tabWidth)) !== body) return null;
  const owners: number[] = [];
  for (let index = 0; index < source.length; index += 1) {
    const width = source[index] === "\t" ? tabWidth : 1;
    for (let count = 0; count < width; count += 1) owners.push(index);
  }
  return {
    start: (index) => index >= owners.length ? source.length : owners[Math.max(0, index)]!,
    end: (index) => index <= 0 ? 0 : index > owners.length ? source.length : owners[index - 1]! + 1,
  };
}

export interface CodeRowText {
  text: string;
  source?: string;
}

/**
 * Joins the selected text of each row; rows without code on the selected side are skipped. Offsets
 * refer to the diff row text, and each slice is copied from the original file line when available.
 */
export function extractCodeText(range: CodeRange, rowText: (row: number) => CodeRowText | null): string {
  const parts: string[] = [];
  for (let row = range.start.row; row <= range.end.row; row += 1) {
    const entry = rowText(row);
    if (entry == null) continue;
    const from = row === range.start.row ? Math.min(range.start.offset, entry.text.length) : 0;
    const to = Math.max(from, row === range.end.row ? Math.min(range.end.offset, entry.text.length) : entry.text.length);
    const map = entry.source == null ? null : mapExpandedTabs(entry.source, entry.text);
    parts.push(map == null || entry.source == null ? entry.text.slice(from, to) : entry.source.slice(map.start(from), map.end(to)));
  }
  return parts.join("\n");
}

/** Keeps escape sequences in order and carries the style active before `start` into the slice. */
function sliceStyledColumns(line: string, start: number, end: number): string {
  let result = "";
  let pending = "";
  let col = 0;
  let index = 0;
  while (index < line.length && col < end) {
    TERMINAL_SEQUENCE_AT.lastIndex = index;
    const sequence = TERMINAL_SEQUENCE_AT.exec(line)?.[0];
    if (sequence != null) {
      if (col >= start) {
        result += pending + sequence;
        pending = "";
      } else pending += sequence;
      index += sequence.length;
      continue;
    }
    const nextEscape = line.indexOf("\x1b", index + 1);
    const textEnd = nextEscape < 0 ? line.length : nextEscape;
    for (const { segment } of graphemeSegmenter.segment(line.slice(index, textEnd))) {
      const width = cellWidth(segment);
      if (col >= start && col + width <= end) {
        result += pending + segment;
        pending = "";
      }
      col += width;
      if (col >= end) break;
    }
    index = textEnd;
  }
  return result;
}

/** Reverse-video highlight that survives the syntax colors inside the selected columns. */
export function highlightColumns(line: string, start: number, end: number): string {
  if (end <= start) return line;
  const before = sliceStyledColumns(line, 0, start);
  const selected = sliceStyledColumns(line, start, end);
  const after = sliceStyledColumns(line, end, Number.POSITIVE_INFINITY);
  return `${before}\x1b[7m${selected.replace(SGR_PATTERN, (code) => `${code}\x1b[7m`)}\x1b[27m${after}`;
}

export interface ScreenPoint {
  row: number;
  col: number;
}

/** Inclusive screen rectangle. */
export interface ScreenRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** Ordered screen range whose end cell is included. */
export interface ScreenRange {
  start: ScreenPoint;
  end: ScreenPoint;
}

export function rectContains(rect: ScreenRect, point: ScreenPoint): boolean {
  return point.row >= rect.top && point.row <= rect.bottom && point.col >= rect.left && point.col <= rect.right;
}

export function clampToRect(rect: ScreenRect, point: ScreenPoint): ScreenPoint {
  return {
    row: Math.max(rect.top, Math.min(rect.bottom, point.row)),
    col: Math.max(rect.left, Math.min(rect.right, point.col)),
  };
}

function compareScreenPoints(left: ScreenPoint, right: ScreenPoint): number {
  return left.row - right.row || left.col - right.col;
}

export function characterScreenRange(anchor: ScreenPoint, focus: ScreenPoint): ScreenRange | null {
  const order = compareScreenPoints(anchor, focus);
  if (order === 0) return null;
  return order < 0 ? { start: anchor, end: focus } : { start: focus, end: anchor };
}

export function extendScreenRange(initial: ScreenRange, target: ScreenRange): ScreenRange {
  if (compareScreenPoints(target.start, initial.start) < 0) return { start: target.start, end: initial.end };
  return { start: initial.start, end: compareScreenPoints(target.end, initial.end) > 0 ? target.end : initial.end };
}

export function screenWordRange(plain: string, rect: ScreenRect, point: ScreenPoint): ScreenRange | null {
  const text = sliceColumns(plain, rect.left, rect.right + 1);
  const cells = columnCells(text);
  const cell = cells.find((candidate) => point.col - rect.left >= candidate.col && point.col - rect.left < candidate.col + candidate.width);
  if (cell == null) return null;
  const word = wordRangeAt(text, cell.index);
  if (word == null) return null;
  const covered = cells.filter((candidate) => candidate.index >= word.start && candidate.index < word.end);
  const first = covered[0];
  const last = covered[covered.length - 1];
  if (first == null || last == null) return null;
  return {
    start: { row: point.row, col: rect.left + first.col },
    end: { row: point.row, col: rect.left + last.col + Math.max(1, last.width) - 1 },
  };
}

/** Selected columns of one screen row as a half-open range, or null when the row is outside the range. */
export function screenRowColumns(range: ScreenRange, rect: ScreenRect, row: number, plain: string): { start: number; end: number } | null {
  if (row < range.start.row || row > range.end.row || row < rect.top || row > rect.bottom) return null;
  const start = row === range.start.row ? Math.max(rect.left, range.start.col) : rect.left;
  const end = row === range.end.row ? Math.min(rect.right, range.end.col) : rect.right;
  if (end < start) return null;
  const snapped = snapColumnsToGraphemes(plain, start, end);
  return { start: Math.max(rect.left, snapped.start), end: Math.min(rect.right + 1, snapped.end) };
}

export function extractScreenText(range: ScreenRange, rect: ScreenRect, plainRow: (row: number) => string): string {
  const parts: string[] = [];
  for (let row = range.start.row; row <= range.end.row; row += 1) {
    const plain = plainRow(row);
    const columns = screenRowColumns(range, rect, row, plain);
    if (columns != null) parts.push(sliceColumns(plain, columns.start, columns.end).trimEnd());
  }
  return parts.join("\n");
}

export class MultiClickCounter {
  private previous: { time: number; row: number; col: number; count: number } | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  next(point: ScreenPoint): number {
    const time = this.now();
    const previous = this.previous;
    const count = previous != null && time - previous.time <= MULTI_CLICK_INTERVAL_MS && previous.row === point.row && previous.col === point.col
      ? (previous.count % 3) + 1
      : 1;
    this.previous = { time, row: point.row, col: point.col, count };
    return count;
  }

  reset(): void {
    this.previous = null;
  }
}

export function granularityForClicks(count: number): SelectionGranularity {
  return count === 2 ? "word" : count === 3 ? "line" : "character";
}

export function describeCopiedText(text: string): string {
  const lines = text.split("\n").length;
  if (lines > 1) return `${lines} lines`;
  const characters = Array.from(text).length;
  return `${characters} character${characters === 1 ? "" : "s"}`;
}
