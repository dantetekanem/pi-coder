import {
  MultiClickCounter,
  characterCodeRange,
  characterScreenRange,
  clampToRect,
  describeCopiedText,
  extendCodeRange,
  extendScreenRange,
  extractCodeText,
  extractScreenText,
  granularityForClicks,
  highlightColumns,
  hitCodeLine,
  rectContains,
  screenRowColumns,
  screenWordRange,
  selectedColumns,
  stripTerminalSequences,
  wordRangeAt,
  type CodeHit,
  type CodeLine,
  type CodeRange,
  type CodeRowText,
  type ScreenPoint,
  type ScreenRange,
  type ScreenRect,
  type SelectionGranularity,
} from "./mouse-selection.js";

const EDGE_SCROLL_INTERVAL_MS = 50;

export type CodeSelectionSide = "unified" | "deleted" | "added";

export interface DiffSurfaceLine {
  rowIndex: number;
  visual: number;
}

/** Screen geometry of the code rows visible in one rendered diff pane. */
export interface DiffSurface {
  /** Surfaces with the same key and rows array show the same code rows. */
  key: string;
  rows: object;
  mode: "unified" | "side-by-side";
  top: number;
  left: number;
  width: number;
  oldWidth: number;
  newWidth: number;
  newLeft: number;
  lines: Array<DiffSurfaceLine | null>;
  scrollable: boolean;
}

export interface CodeRowModel {
  text: string;
  lines: CodeLine[];
}

export interface SelectionPane {
  box: ScreenRect;
  inner: ScreenRect;
}

export interface MouseSelectionHost<S extends DiffSurface> {
  codeRow(surface: S, rowIndex: number, side: CodeSelectionSide): CodeRowModel | null;
  rowText(surface: S, rowIndex: number, side: CodeSelectionSide): string | null;
  /** Returns a reader of each row's diff text and, when known, its file line, used once per copy. */
  copyRows(surface: S, side: CodeSelectionSide): (rowIndex: number) => CodeRowText | null;
  copy(text: string, label: string): void;
  /** Looks up where a Ctrl+clicked code word is defined. */
  openSymbol(symbol: string): void;
  render(): void;
  /** Scrolls the diff pane by one line; false when it cannot move further. */
  scrollDiff(delta: -1 | 1): boolean;
}

interface CodeSelection<S> {
  kind: "code";
  surface: S;
  side: CodeSelectionSide;
  granularity: SelectionGranularity;
  anchorRow: number;
  anchor: CodeHit;
  initial: CodeRange | null;
  range: CodeRange | null;
}

interface ScreenSelection {
  kind: "screen";
  bounds: ScreenRect;
  granularity: SelectionGranularity;
  anchor: ScreenPoint;
  initial: ScreenRange | null;
  range: ScreenRange | null;
}

interface CodeTarget {
  row: number;
  hit: CodeHit;
}

export function innerRect(box: ScreenRect): ScreenRect {
  return { top: box.top + 1, bottom: Math.max(box.top + 1, box.bottom - 1), left: box.left + 1, right: Math.max(box.left + 1, box.right - 1) };
}

/**
 * Mouse text selection for the review UI. A drag that starts on a diff code row copies source text
 * from that pane and side; any other drag copies the screen text of the pane it started in.
 */
export class MouseSelectionController<S extends DiffSurface> {
  private selection: CodeSelection<S> | ScreenSelection | null = null;
  private selecting = false;
  private surfaces: S[] = [];
  private panes: SelectionPane[] = [];
  private frame: { pane: SelectionPane; top: number; left: number; lines: string[] } | null = null;
  private readonly clicks = new MultiClickCounter();
  private edge: -1 | 0 | 1 = 0;
  private edgeTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly host: MouseSelectionHost<S>) {}

  get dragging(): boolean {
    return this.selecting;
  }

  beginFrame(): void {
    this.surfaces = [];
  }

  /** Registers a rendered diff pane and highlights its selected code in `lines`. */
  addSurface(surface: S, lines: string[]): void {
    this.surfaces.push(surface);
    this.followEdge(surface);
    this.highlightCode(surface, lines);
  }

  /** Records the composed frame for pane selections and returns it with their highlight applied. */
  finishFrame(lines: string[], box: ScreenRect, panes: SelectionPane[], covered: boolean): string[] {
    if (covered) this.surfaces = [];
    this.panes = covered ? [] : panes;
    this.frame = { pane: { box, inner: innerRect(box) }, top: box.top, left: box.left, lines };
    const selection = this.selection;
    if (selection?.kind !== "screen" || selection.range == null) return lines;
    const range = selection.range;
    return lines.map((line, index) => {
      const row = box.top + index;
      if (row < range.start.row || row > range.end.row) return line;
      const columns = screenRowColumns(range, selection.bounds, row, this.plainRow(row));
      return columns == null ? line : highlightColumns(line, columns.start - box.left, columns.end - box.left);
    });
  }

  press(point: ScreenPoint, ctrl = false): boolean {
    this.clear();
    const clicks = this.clicks.next(point);
    const surface = this.surfaceAt(point);
    if (surface != null) {
      const { side, col } = this.sideAt(surface, point.col);
      const target = this.hitLine(surface, point.row - surface.top, side, col);
      if (target != null && ctrl) {
        const text = this.host.rowText(surface, target.row, side);
        const word = text == null || target.hit.start === target.hit.end ? null : wordRangeAt(text, target.hit.start);
        if (text != null && word != null) this.host.openSymbol(text.slice(word.start, word.end));
        return true;
      }
      if (target != null) {
        this.beginCode(surface, side, target, clicks);
        return true;
      }
    }
    const pane = this.paneAt(point);
    if (pane == null) return false;
    this.beginScreen(pane.inner, clampToRect(pane.inner, point), clicks);
    return true;
  }

  drag(point: ScreenPoint): void {
    if (!this.selecting) return;
    this.clicks.reset();
    this.update(point);
  }

  release(point: ScreenPoint): void {
    if (!this.selecting) return;
    this.update(point);
    this.selecting = false;
    this.stopEdgeScroll();
    const text = this.selectedText();
    if (text == null || text.length === 0) {
      this.selection = null;
      this.host.render();
      return;
    }
    this.host.copy(text, describeCopiedText(text));
  }

  clear(): void {
    this.stopEdgeScroll();
    this.selecting = false;
    if (this.selection == null) return;
    this.selection = null;
    this.host.render();
  }

  clearScreenSelection(): void {
    if (this.selection?.kind === "screen") this.clear();
  }

  dispose(): void {
    this.stopEdgeScroll();
  }

  private update(point: ScreenPoint): void {
    const selection = this.selection;
    if (selection == null) return;
    if (selection.kind === "screen") {
      selection.range = this.screenRange(selection, clampToRect(selection.bounds, point));
    } else {
      const surface = this.surfaces.find((candidate) => this.showsSelection(selection, candidate));
      if (surface == null || surface.lines.length === 0) return;
      const edge = point.row < surface.top ? -1 : point.row >= surface.top + surface.lines.length ? 1 : 0;
      this.setEdge(surface.scrollable ? edge : 0);
      const lineIndex = Math.max(0, Math.min(surface.lines.length - 1, point.row - surface.top));
      const focus = this.focusAt(surface, selection.side, lineIndex, point.col, edge);
      if (focus != null) selection.range = this.codeRange(selection, focus);
    }
    this.host.render();
  }

  private beginCode(surface: S, side: CodeSelectionSide, target: CodeTarget, clicks: number): void {
    const { row, hit } = target;
    const text = this.host.rowText(surface, row, side);
    let granularity = granularityForClicks(clicks);
    let initial: CodeRange | null = null;
    if (granularity === "word") {
      const word = text == null || hit.start === hit.end ? null : wordRangeAt(text, hit.start);
      if (word != null) initial = { start: { row, offset: word.start }, end: { row, offset: word.end } };
    } else if (granularity === "line" && text != null) {
      initial = { start: { row, offset: 0 }, end: { row, offset: text.length } };
    }
    if (initial == null) granularity = "character";
    this.selection = { kind: "code", surface, side, granularity, anchorRow: row, anchor: hit, initial, range: initial };
    this.selecting = true;
    this.host.render();
  }

  private beginScreen(bounds: ScreenRect, point: ScreenPoint, clicks: number): void {
    let granularity = granularityForClicks(clicks);
    let initial: ScreenRange | null = null;
    if (granularity === "word") initial = screenWordRange(this.plainRow(point.row), bounds, point);
    else if (granularity === "line") initial = { start: { row: point.row, col: bounds.left }, end: { row: point.row, col: bounds.right } };
    if (initial == null) granularity = "character";
    this.selection = { kind: "screen", bounds, granularity, anchor: point, initial, range: initial };
    this.selecting = true;
    this.host.render();
  }

  private selectedText(): string | null {
    const selection = this.selection;
    if (selection?.range == null) return null;
    if (selection.kind === "screen") return extractScreenText(selection.range, selection.bounds, (row) => this.plainRow(row));
    return extractCodeText(selection.range, this.host.copyRows(selection.surface, selection.side));
  }

  private screenRange(selection: ScreenSelection, focus: ScreenPoint): ScreenRange | null {
    if (selection.initial == null || selection.granularity === "character") return characterScreenRange(selection.anchor, focus);
    const target = selection.granularity === "line"
      ? { start: { row: focus.row, col: selection.bounds.left }, end: { row: focus.row, col: selection.bounds.right } }
      : screenWordRange(this.plainRow(focus.row), selection.bounds, focus) ?? { start: focus, end: focus };
    return extendScreenRange(selection.initial, target);
  }

  private codeRange(selection: CodeSelection<S>, focus: CodeTarget): CodeRange | null {
    const { row, hit } = focus;
    if (selection.initial == null || selection.granularity === "character") return characterCodeRange(selection.anchorRow, selection.anchor, row, hit);
    const text = this.host.rowText(selection.surface, row, selection.side) ?? "";
    const word = selection.granularity === "word" ? wordRangeAt(text, hit.start) : null;
    const target: CodeRange = selection.granularity === "line"
      ? { start: { row, offset: 0 }, end: { row, offset: text.length } }
      : word == null
        ? { start: { row, offset: hit.start }, end: { row, offset: hit.end } }
        : { start: { row, offset: word.start }, end: { row, offset: word.end } };
    return extendCodeRange(selection.initial, target);
  }

  private showsSelection(selection: CodeSelection<S>, surface: S): boolean {
    return selection.surface.key === surface.key && selection.surface.rows === surface.rows;
  }

  private surfaceAt(point: ScreenPoint): S | null {
    return this.surfaces.find((surface) => point.row >= surface.top && point.row < surface.top + surface.lines.length
      && point.col >= surface.left && point.col < surface.left + surface.width) ?? null;
  }

  private sideAt(surface: S, col: number, side?: CodeSelectionSide): { side: CodeSelectionSide; col: number } {
    const local = col - surface.left;
    if (surface.mode === "unified") return { side: "unified", col: local };
    const resolved = side ?? (local <= surface.oldWidth ? "deleted" : "added");
    return { side: resolved, col: resolved === "added" ? local - surface.newLeft : local };
  }

  private hitLine(surface: S, lineIndex: number, side: CodeSelectionSide, col: number): CodeTarget | null {
    const meta = surface.lines[lineIndex];
    if (meta == null) return null;
    const model = this.host.codeRow(surface, meta.rowIndex, side);
    if (model == null) return { row: meta.rowIndex, hit: { start: 0, end: 0 } };
    const line = model.lines[meta.visual];
    const end = model.text.length;
    return { row: meta.rowIndex, hit: line == null ? { start: end, end } : hitCodeLine(line, col) };
  }

  private focusAt(surface: S, side: CodeSelectionSide, lineIndex: number, col: number, edge: -1 | 0 | 1): CodeTarget | null {
    if (edge !== 0) {
      const index = this.nearestCodeLine(surface, edge < 0 ? 0 : surface.lines.length - 1, edge < 0 ? 1 : -1);
      return index == null ? null : this.lineBoundary(surface, side, index, edge < 0 ? "start" : "end");
    }
    if (surface.lines[lineIndex] != null) return this.hitLine(surface, lineIndex, side, this.sideAt(surface, col, side).col);
    const before = this.nearestCodeLine(surface, lineIndex, -1);
    if (before != null) return this.lineBoundary(surface, side, before, "end");
    const after = this.nearestCodeLine(surface, lineIndex, 1);
    return after == null ? null : this.lineBoundary(surface, side, after, "start");
  }

  private nearestCodeLine(surface: S, from: number, step: 1 | -1): number | null {
    for (let index = from; index >= 0 && index < surface.lines.length; index += step) {
      if (surface.lines[index] != null) return index;
    }
    return null;
  }

  private lineBoundary(surface: S, side: CodeSelectionSide, lineIndex: number, edge: "start" | "end"): CodeTarget | null {
    const meta = surface.lines[lineIndex];
    if (meta == null) return null;
    const model = this.host.codeRow(surface, meta.rowIndex, side);
    const line = model?.lines[meta.visual];
    const offset = line == null ? model?.text.length ?? 0 : edge === "start" ? line.start : line.end;
    return { row: meta.rowIndex, hit: { start: offset, end: offset } };
  }

  private highlightCode(surface: S, lines: string[]): void {
    const selection = this.selection;
    if (selection?.kind !== "code" || selection.range == null || !this.showsSelection(selection, surface)) return;
    const { start, end } = selection.range;
    const offset = selection.side === "added" ? surface.newLeft : 0;
    const width = surface.mode === "unified" ? surface.width : selection.side === "deleted" ? surface.oldWidth : surface.newWidth;
    surface.lines.forEach((meta, index) => {
      if (meta == null || meta.rowIndex < start.row || meta.rowIndex > end.row) return;
      const model = this.host.codeRow(surface, meta.rowIndex, selection.side);
      const line = model?.lines[meta.visual];
      if (model == null || line == null) return;
      const from = meta.rowIndex === start.row ? start.offset : 0;
      const to = meta.rowIndex === end.row ? end.offset : model.text.length;
      let columns = selectedColumns(line, from, to);
      if (meta.rowIndex < end.row && meta.visual === model.lines.length - 1 && line.endCol < width) {
        columns = { start: columns?.start ?? line.endCol, end: line.endCol + 1 };
      }
      if (columns != null) lines[index] = highlightColumns(lines[index]!, offset + columns.start, offset + columns.end);
    });
  }

  private setEdge(edge: -1 | 0 | 1): void {
    this.edge = edge;
    if (edge === 0) {
      this.stopEdgeScroll();
      return;
    }
    if (this.edgeTimer != null) return;
    this.edgeTimer = setInterval(() => this.scrollAtEdge(), EDGE_SCROLL_INTERVAL_MS);
    this.edgeTimer.unref?.();
  }

  private scrollAtEdge(): void {
    if (!this.selecting || this.edge === 0 || !this.host.scrollDiff(this.edge)) {
      this.stopEdgeScroll();
      return;
    }
    this.host.render();
  }

  private stopEdgeScroll(): void {
    if (this.edgeTimer != null) clearInterval(this.edgeTimer);
    this.edgeTimer = null;
    this.edge = 0;
  }

  /** While the pointer rests past an edge, the scrolled-in line at that edge becomes the focus. */
  private followEdge(surface: S): void {
    const selection = this.selection;
    if (!this.selecting || this.edge === 0 || selection?.kind !== "code" || !this.showsSelection(selection, surface)) return;
    const focus = this.focusAt(surface, selection.side, 0, 0, this.edge);
    if (focus != null) selection.range = this.codeRange(selection, focus);
  }

  private paneAt(point: ScreenPoint): SelectionPane | null {
    const pane = this.panes.find((candidate) => rectContains(candidate.box, point));
    if (pane != null) return pane;
    const frame = this.frame?.pane;
    return frame != null && rectContains(frame.box, point) ? frame : null;
  }

  private plainRow(row: number): string {
    const frame = this.frame;
    if (frame == null) return "";
    return " ".repeat(frame.left) + stripTerminalSequences(frame.lines[row - frame.top] ?? "");
  }
}
