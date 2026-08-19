import { parseDiffFromFile, type FileDiffMetadata } from "@pierre/diffs";

export interface InlineRange {
  start: number;
  end: number;
}

export type StructuredDiffRowKind = "equal" | "insert" | "delete" | "replace";

export interface StructuredDiffRow {
  kind: StructuredDiffRowKind;
  oldLineNumber?: number;
  newLineNumber?: number;
  oldText: string;
  newText: string;
  oldHighlights: InlineRange[];
  newHighlights: InlineRange[];
}

export interface StructuredDiffVisibleRow {
  type: "row";
  fullRowIndex: number;
  row: StructuredDiffRow;
}

export interface StructuredDiffGap {
  type: "gap";
  beforeRowIndex: number;
  afterRowIndex: number;
  hiddenRowCount: number;
  hiddenOldLines: number;
  hiddenNewLines: number;
  label: string;
}

export type StructuredDiffVisibleItem = StructuredDiffVisibleRow | StructuredDiffGap;

export interface StructuredDiffHunk {
  index: number;
  displayStartRow: number;
  displayEndRow: number;
  changeStartRow: number;
  changeEndRow: number;
  oldStartLine?: number;
  oldEndLine?: number;
  newStartLine?: number;
  newEndLine?: number;
  additions: number;
  deletions: number;
}

export interface StructuredDiff {
  rows: StructuredDiffRow[];
  visibleItems: StructuredDiffVisibleItem[];
  hunks: StructuredDiffHunk[];
  additions: number;
  deletions: number;
  contextLines: number;
  totalOldLines: number;
  totalNewLines: number;
  firstChangedLine: number | undefined;
}

const DISPLAY_TAB = "    ";
const INLINE_HIGHLIGHT_CHAR_LIMIT = 800;

function countLogicalLines(text: string): number {
  if (text.length === 0) return 0;
  return text.split("\n").length;
}

function pluralize(word: string, count: number): string {
  return `${count.toLocaleString()} ${word}${count === 1 ? "" : "s"}`;
}

function normalizeDiffDisplayText(text: string): string {
  return text.replace(/\t/g, DISPLAY_TAB);
}

function splitDiffLines(value: string): string[] {
  if (value.length === 0) return [];
  const lines = value.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.map(normalizeDiffDisplayText);
}

function normalizePierreLine(line: string | undefined): string {
  if (line == null) return "";
  return normalizeDiffDisplayText(line.replace(/\r?\n$/, ""));
}

function charLength(text: string): number {
  return Array.from(text).length;
}

function fullHighlight(text: string): InlineRange[] {
  const length = charLength(text);
  return length > 0 ? [{ start: 0, end: length }] : [];
}

function coalesceRanges(ranges: InlineRange[]): InlineRange[] {
  if (ranges.length <= 1) return ranges;

  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: InlineRange[] = [];

  for (const range of sorted) {
    const clamped = {
      start: Math.max(0, range.start),
      end: Math.max(0, range.end),
    };
    if (clamped.end <= clamped.start) continue;

    const previous = merged[merged.length - 1];
    if (!previous || clamped.start > previous.end) {
      merged.push(clamped);
      continue;
    }

    previous.end = Math.max(previous.end, clamped.end);
  }

  return merged;
}

function computeInlineHighlights(oldText: string, newText: string): { oldHighlights: InlineRange[]; newHighlights: InlineRange[] } {
  if (oldText.length === 0) {
    return { oldHighlights: [], newHighlights: fullHighlight(newText) };
  }
  if (newText.length === 0) {
    return { oldHighlights: fullHighlight(oldText), newHighlights: [] };
  }
  if (oldText === newText) {
    return { oldHighlights: [], newHighlights: [] };
  }
  if (oldText.length + newText.length > INLINE_HIGHLIGHT_CHAR_LIMIT) {
    return { oldHighlights: fullHighlight(oldText), newHighlights: fullHighlight(newText) };
  }

  const oldChars = Array.from(oldText);
  const newChars = Array.from(newText);
  const sharedLength = Math.min(oldChars.length, newChars.length);
  let prefixLength = 0;
  while (prefixLength < sharedLength && oldChars[prefixLength] === newChars[prefixLength]) prefixLength += 1;

  let suffixLength = 0;
  while (
    suffixLength < sharedLength - prefixLength
    && oldChars[oldChars.length - suffixLength - 1] === newChars[newChars.length - suffixLength - 1]
  ) {
    suffixLength += 1;
  }

  const oldEnd = oldChars.length - suffixLength;
  const newEnd = newChars.length - suffixLength;
  return {
    oldHighlights: prefixLength < oldEnd ? [{ start: prefixLength, end: oldEnd }] : [],
    newHighlights: prefixLength < newEnd ? [{ start: prefixLength, end: newEnd }] : [],
  };
}

function createRow(
  kind: StructuredDiffRowKind,
  oldLineNumber: number | undefined,
  newLineNumber: number | undefined,
  oldText: string,
  newText: string,
): StructuredDiffRow {
  const highlights =
    kind === "replace"
      ? computeInlineHighlights(oldText, newText)
      : {
          oldHighlights: kind === "delete" ? fullHighlight(oldText) : [],
          newHighlights: kind === "insert" ? fullHighlight(newText) : [],
        };

  return {
    kind,
    oldLineNumber,
    newLineNumber,
    oldText,
    newText,
    oldHighlights: highlights.oldHighlights,
    newHighlights: highlights.newHighlights,
  };
}

function buildAlignedRows(oldContent: string, newContent: string): {
  rows: StructuredDiffRow[];
  totalOldLines: number;
  totalNewLines: number;
} {
  if (oldContent === newContent) {
    const rows = splitDiffLines(oldContent).map((line, index) => createRow("equal", index + 1, index + 1, line, line));
    const totalLines = countLogicalLines(oldContent);
    return {
      rows,
      totalOldLines: Math.max(totalLines, rows.length),
      totalNewLines: Math.max(totalLines, rows.length),
    };
  }

  const fileDiff = parseDiffFromFile(
    { name: "old", contents: oldContent },
    { name: "new", contents: newContent },
    undefined,
    true,
  );

  return buildAlignedRowsFromPierreDiff(fileDiff, oldContent, newContent);
}

function buildAlignedRowsFromPierreDiff(fileDiff: FileDiffMetadata, oldContent: string, newContent: string): {
  rows: StructuredDiffRow[];
  totalOldLines: number;
  totalNewLines: number;
} {
  const rows: StructuredDiffRow[] = [];
  let oldLineNumber = 1;
  let newLineNumber = 1;

  const pushEqualRowsUntil = (targetOldLine: number, targetNewLine: number): void => {
    while (oldLineNumber < targetOldLine && newLineNumber < targetNewLine) {
      const oldText = normalizePierreLine(fileDiff.deletionLines[oldLineNumber - 1]);
      const newText = normalizePierreLine(fileDiff.additionLines[newLineNumber - 1]);
      rows.push(createRow("equal", oldLineNumber, newLineNumber, oldText, newText));
      oldLineNumber += 1;
      newLineNumber += 1;
    }
  };

  for (const hunk of fileDiff.hunks) {
    pushEqualRowsUntil(hunk.deletionStart, hunk.additionStart);

    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        for (let i = 0; i < content.lines; i += 1) {
          const oldText = normalizePierreLine(fileDiff.deletionLines[oldLineNumber - 1]);
          const newText = normalizePierreLine(fileDiff.additionLines[newLineNumber - 1]);
          rows.push(createRow("equal", oldLineNumber, newLineNumber, oldText, newText));
          oldLineNumber += 1;
          newLineNumber += 1;
        }
        continue;
      }

      const count = Math.max(content.deletions, content.additions);
      for (let i = 0; i < count; i += 1) {
        const oldText = i < content.deletions ? normalizePierreLine(fileDiff.deletionLines[content.deletionLineIndex + i]) : undefined;
        const newText = i < content.additions ? normalizePierreLine(fileDiff.additionLines[content.additionLineIndex + i]) : undefined;

        if (oldText != null && newText != null) {
          rows.push(createRow("replace", oldLineNumber, newLineNumber, oldText, newText));
          oldLineNumber += 1;
          newLineNumber += 1;
          continue;
        }

        if (oldText != null) {
          rows.push(createRow("delete", oldLineNumber, undefined, oldText, ""));
          oldLineNumber += 1;
          continue;
        }

        if (newText != null) {
          rows.push(createRow("insert", undefined, newLineNumber, "", newText));
          newLineNumber += 1;
        }
      }
    }
  }

  pushEqualRowsUntil(fileDiff.deletionLines.length + 1, fileDiff.additionLines.length + 1);

  while (oldLineNumber <= fileDiff.deletionLines.length) {
    rows.push(createRow("delete", oldLineNumber, undefined, normalizePierreLine(fileDiff.deletionLines[oldLineNumber - 1]), ""));
    oldLineNumber += 1;
  }

  while (newLineNumber <= fileDiff.additionLines.length) {
    rows.push(createRow("insert", undefined, newLineNumber, "", normalizePierreLine(fileDiff.additionLines[newLineNumber - 1])));
    newLineNumber += 1;
  }

  return {
    rows,
    totalOldLines: Math.max(countLogicalLines(oldContent), oldLineNumber - 1),
    totalNewLines: Math.max(countLogicalLines(newContent), newLineNumber - 1),
  };
}

function createGapLabel(position: "start" | "middle" | "end", hiddenRows: number): string {
  const hiddenText = pluralize("unchanged line", hiddenRows);
  if (position === "start") return `Start of file · ${hiddenText}`;
  if (position === "end") return `End of file · ${hiddenText}`;
  return `… ${hiddenText} …`;
}

function getLineRange(
  rows: StructuredDiffRow[],
  startRow: number,
  endRow: number,
  side: "old" | "new",
): { start?: number; end?: number } {
  let startLine: number | undefined;
  let endLine: number | undefined;

  for (let i = startRow; i <= endRow; i++) {
    const row = rows[i]!;
    const lineNumber = side === "old" ? row.oldLineNumber : row.newLineNumber;
    if (lineNumber === undefined) continue;
    if (startLine === undefined) startLine = lineNumber;
    endLine = lineNumber;
  }

  return { start: startLine, end: endLine };
}

function buildStructuredDiffFromRows(
  rows: StructuredDiffRow[],
  totalOldLines: number,
  totalNewLines: number,
  contextLines: number,
): StructuredDiff {
  const additions = rows.reduce((count, row) => count + (row.kind === "insert" || row.kind === "replace" ? 1 : 0), 0);
  const deletions = rows.reduce((count, row) => count + (row.kind === "delete" || row.kind === "replace" ? 1 : 0), 0);

  type ChangeBlock = { start: number; end: number };
  const changeBlocks: ChangeBlock[] = [];
  let blockStart: number | undefined;

  for (let i = 0; i < rows.length; i++) {
    const isChange = rows[i]!.kind !== "equal";
    if (isChange) {
      blockStart ??= i;
      continue;
    }

    if (blockStart !== undefined) {
      changeBlocks.push({ start: blockStart, end: i - 1 });
      blockStart = undefined;
    }
  }

  if (blockStart !== undefined) {
    changeBlocks.push({ start: blockStart, end: rows.length - 1 });
  }

  if (changeBlocks.length === 0) {
    return {
      rows,
      visibleItems: rows.map((row, fullRowIndex) => ({ type: "row", fullRowIndex, row })),
      hunks: [],
      additions,
      deletions,
      contextLines,
      totalOldLines,
      totalNewLines,
      firstChangedLine: undefined,
    };
  }

  type HunkSeed = {
    displayStartRow: number;
    displayEndRow: number;
    changeStartRow: number;
    changeEndRow: number;
  };

  const seeds: HunkSeed[] = [];
  for (const block of changeBlocks) {
    const displayStartRow = Math.max(0, block.start - contextLines);
    const displayEndRow = Math.min(rows.length - 1, block.end + contextLines);
    const previous = seeds[seeds.length - 1];

    if (previous && displayStartRow <= previous.displayEndRow + 1) {
      previous.displayEndRow = Math.max(previous.displayEndRow, displayEndRow);
      previous.changeEndRow = block.end;
      continue;
    }

    seeds.push({
      displayStartRow,
      displayEndRow,
      changeStartRow: block.start,
      changeEndRow: block.end,
    });
  }

  const hunks: StructuredDiffHunk[] = seeds.map((seed, index) => {
    const oldRange = getLineRange(rows, seed.changeStartRow, seed.changeEndRow, "old");
    const newRange = getLineRange(rows, seed.changeStartRow, seed.changeEndRow, "new");
    let hunkAdditions = 0;
    let hunkDeletions = 0;

    for (let rowIndex = seed.changeStartRow; rowIndex <= seed.changeEndRow; rowIndex++) {
      const row = rows[rowIndex]!;
      if (row.kind === "insert" || row.kind === "replace") hunkAdditions += 1;
      if (row.kind === "delete" || row.kind === "replace") hunkDeletions += 1;
    }

    return {
      index,
      displayStartRow: seed.displayStartRow,
      displayEndRow: seed.displayEndRow,
      changeStartRow: seed.changeStartRow,
      changeEndRow: seed.changeEndRow,
      oldStartLine: oldRange.start,
      oldEndLine: oldRange.end,
      newStartLine: newRange.start,
      newEndLine: newRange.end,
      additions: hunkAdditions,
      deletions: hunkDeletions,
    };
  });

  const visibleItems: StructuredDiffVisibleItem[] = [];
  let cursor = 0;

  for (const hunk of hunks) {
    if (hunk.displayStartRow > cursor) {
      const hiddenRowCount = hunk.displayStartRow - cursor;
      visibleItems.push({
        type: "gap",
        beforeRowIndex: cursor - 1,
        afterRowIndex: hunk.displayStartRow,
        hiddenRowCount,
        hiddenOldLines: hiddenRowCount,
        hiddenNewLines: hiddenRowCount,
        label: createGapLabel(cursor === 0 ? "start" : "middle", hiddenRowCount),
      });
    }

    for (let rowIndex = hunk.displayStartRow; rowIndex <= hunk.displayEndRow; rowIndex++) {
      visibleItems.push({
        type: "row",
        fullRowIndex: rowIndex,
        row: rows[rowIndex]!,
      });
    }

    cursor = hunk.displayEndRow + 1;
  }

  if (cursor < rows.length) {
    const hiddenRowCount = rows.length - cursor;
    visibleItems.push({
      type: "gap",
      beforeRowIndex: cursor - 1,
      afterRowIndex: rows.length,
      hiddenRowCount,
      hiddenOldLines: hiddenRowCount,
      hiddenNewLines: hiddenRowCount,
      label: createGapLabel(cursor === 0 ? "start" : "end", hiddenRowCount),
    });
  }

  const firstHunk = hunks[0];
  const firstChangedLine = firstHunk ? (firstHunk.newStartLine ?? firstHunk.oldStartLine) : undefined;

  return {
    rows,
    visibleItems,
    hunks,
    additions,
    deletions,
    contextLines,
    totalOldLines,
    totalNewLines,
    firstChangedLine,
  };
}

export function buildStructuredDiff(oldContent: string, newContent: string, contextLines = 3): StructuredDiff {
  const aligned = buildAlignedRows(oldContent, newContent);
  return buildStructuredDiffFromRows(aligned.rows, aligned.totalOldLines, aligned.totalNewLines, contextLines);
}

export function adjustStructuredDiffContext(diff: StructuredDiff, contextLines: number): StructuredDiff {
  return buildStructuredDiffFromRows(diff.rows, diff.totalOldLines, diff.totalNewLines, contextLines);
}

export type ContextExpansionDirection = "above" | "below";

export function revealStructuredDiffRows(diff: StructuredDiff, rowIndexes: Iterable<number>): StructuredDiff {
  const visibleRows = new Set<number>();
  for (const item of diff.visibleItems) {
    if (item.type === "row") visibleRows.add(item.fullRowIndex);
  }
  for (const rowIndex of rowIndexes) {
    if (rowIndex >= 0 && rowIndex < diff.rows.length) visibleRows.add(rowIndex);
  }

  const visibleItems: StructuredDiffVisibleItem[] = [];
  let rowIndex = 0;
  while (rowIndex < diff.rows.length) {
    if (visibleRows.has(rowIndex)) {
      visibleItems.push({ type: "row", fullRowIndex: rowIndex, row: diff.rows[rowIndex]! });
      rowIndex += 1;
      continue;
    }

    const hiddenStart = rowIndex;
    while (rowIndex < diff.rows.length && !visibleRows.has(rowIndex)) rowIndex += 1;
    const hiddenRows = diff.rows.slice(hiddenStart, rowIndex);
    const hiddenRowCount = hiddenRows.length;
    const position = hiddenStart === 0 ? "start" : rowIndex === diff.rows.length ? "end" : "middle";
    visibleItems.push({
      type: "gap",
      beforeRowIndex: hiddenStart - 1,
      afterRowIndex: rowIndex,
      hiddenRowCount,
      hiddenOldLines: hiddenRows.filter((row) => row.oldLineNumber != null).length,
      hiddenNewLines: hiddenRows.filter((row) => row.newLineNumber != null).length,
      label: createGapLabel(position, hiddenRowCount),
    });
  }

  return { ...diff, visibleItems };
}

export function getContextExpansionRowIndexes(
  diff: StructuredDiff,
  selectedRowIndex: number,
  direction: ContextExpansionDirection,
  lineCount: number,
): number[] {
  const visibleRows = new Set(diff.visibleItems.flatMap((item) => item.type === "row" ? [item.fullRowIndex] : []));
  if (!visibleRows.has(selectedRowIndex)) return [];

  const step = direction === "above" ? -1 : 1;
  let edge = selectedRowIndex;
  while (visibleRows.has(edge + step)) edge += step;

  const expansion: number[] = [];
  let candidate = edge + step;
  while (candidate >= 0 && candidate < diff.rows.length && expansion.length < Math.max(0, lineCount)) {
    if (visibleRows.has(candidate)) break;
    expansion.push(candidate);
    candidate += step;
  }
  return expansion.sort((left, right) => left - right);
}

export function getCommentableVisibleLines(diff: StructuredDiff): number[] {
  const lines = new Set<number>();
  for (const item of diff.visibleItems) {
    if (item.type !== "row") continue;
    if (item.row.newLineNumber != null) lines.add(item.row.newLineNumber);
  }
  return [...lines].sort((a, b) => a - b);
}

export function getFirstCommentableLine(diff: StructuredDiff): number | null {
  return getCommentableVisibleLines(diff)[0] ?? null;
}
