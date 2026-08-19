import { plainSourceLines, sanitizeTerminalText, type BufferEditDelta } from "./contracts.js";

/**
 * Maximum planned UTF-16 style-array slots for one interactive edit.
 * Larger affected envelopes become plain while untouched validated colors remain.
 */
export const HIGHLIGHT_EDIT_CODE_UNIT_BUDGET = 16_384;

export interface HighlightEditStats {
  affectedOldLines: number;
  affectedNewLines: number;
  plannedStyleSlots: number;
  allocatedStyleSlots: number;
  parsedStyleCodeUnits: number;
  renderedCodeUnits: number;
  sanitizedCodeUnits: number;
  budgetExceeded: boolean;
}

export interface HighlightEditProjection {
  sourceLines: readonly string[];
  plainLines: readonly string[];
  highlightedLines: readonly string[];
  stats: HighlightEditStats;
}

const ANSI_RESET = "\u001b[0m";
const MAX_ACTIVE_STYLE_BYTES = 256;
const MAX_HIGHLIGHT_OVERHEAD = 64;
const MAX_HIGHLIGHT_EXTRA_BYTES = 4096;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
const STYLE_MODES = ["1", "3", "4"] as const;

interface ParsedStyledLine {
  text: string;
  styles: readonly string[];
}

interface ProjectionCounters {
  allocatedStyleSlots: number;
  parsedStyleCodeUnits: number;
  renderedCodeUnits: number;
}

function canonicalByte(value: string): string | null {
  if (!/^(?:0|[1-9]\d{0,2})$/.test(value)) return null;
  const number = Number(value);
  return number <= 255 ? value : null;
}

function canonicalStyle(parameters: string): string | null {
  if (parameters.length === 0) return null;
  const values = parameters.split(";");
  const modes: string[] = [];
  let index = 0;
  let previousMode = -1;
  while (index < values.length && values[index] !== "38") {
    const mode = values[index];
    const modeIndex = STYLE_MODES.indexOf(mode as typeof STYLE_MODES[number]);
    if (modeIndex < 0 || modeIndex <= previousMode) return null;
    modes.push(mode!);
    previousMode = modeIndex;
    index += 1;
  }
  let color: string | null = null;
  if (index < values.length) {
    if (values[index + 1] !== "2" || values.length !== index + 5) return null;
    const channels = values.slice(index + 2).map(canonicalByte);
    if (channels.some((channel) => channel == null)) return null;
    color = `38;2;${channels.join(";")}`;
  }
  return modes.length === 0 && color == null ? null : [...modes, color].filter((value): value is string => value != null).join(";");
}

function parseCanonicalStyledLine(highlightedLine: string, expectedText: string): string | null {
  if (highlightedLine.length > expectedText.length * MAX_HIGHLIGHT_OVERHEAD + MAX_HIGHLIGHT_EXTRA_BYTES) return null;

  let visibleText = "";
  let normalized = "";
  let cursor = 0;
  while (cursor < highlightedLine.length) {
    const styleStart = highlightedLine.indexOf("\u001b", cursor);
    if (styleStart < 0) {
      const plain = highlightedLine.slice(cursor);
      if (/\r|\n/.test(plain) || CONTROL_CHARACTERS.test(plain)) return null;
      visibleText += plain;
      normalized += plain;
      break;
    }
    const plain = highlightedLine.slice(cursor, styleStart);
    if (/\r|\n/.test(plain) || CONTROL_CHARACTERS.test(plain)) return null;
    visibleText += plain;
    normalized += plain;

    const header = /^\u001b\[([0-9;]*)m/.exec(highlightedLine.slice(styleStart));
    if (header == null) return null;
    const style = canonicalStyle(header[1] ?? "");
    if (style == null) return null;
    const contentStart = styleStart + header[0].length;
    const resetStart = highlightedLine.indexOf(ANSI_RESET, contentStart);
    if (resetStart < 0 || resetStart === contentStart) return null;
    const content = highlightedLine.slice(contentStart, resetStart);
    if (/\r|\n/.test(content) || CONTROL_CHARACTERS.test(content)) return null;
    visibleText += content;
    normalized += `\u001b[${style}m${content}${ANSI_RESET}`;
    cursor = resetStart + ANSI_RESET.length;
  }
  return visibleText === expectedText ? normalized : null;
}

/**
 * Accepts only the canonical ANSI contract emitted by tokensToAnsi. The entire
 * candidate is validated before returning so callers can publish it atomically.
 */
export function validateHighlightedSourceLines(text: string, candidate: readonly string[]): readonly string[] | null {
  if (!Array.isArray(candidate)) return null;
  const sourceLines = text.split(/\r\n|\r|\n/);
  if (candidate.length !== sourceLines.length) return null;
  const normalized: string[] = [];
  for (let index = 0; index < sourceLines.length; index += 1) {
    const line = candidate[index];
    if (typeof line !== "string") return null;
    const validated = parseCanonicalStyledLine(line, sanitizeTerminalText(sourceLines[index]!));
    if (validated == null) return null;
    normalized.push(validated);
  }
  return normalized;
}

function updateActiveStyle(active: string, sequence: string, parameters: string): string | null {
  const values = parameters === "" ? [0] : parameters.split(";").map((value) => value === "" ? 0 : Number(value));
  const next = values.includes(0)
    ? values.every((value) => value === 0) ? "" : sequence
    : `${active}${sequence}`;
  return next.length <= MAX_ACTIVE_STYLE_BYTES ? next : null;
}

function parseStyledLine(highlightedLine: string, expectedText: string, counters?: ProjectionCounters): ParsedStyledLine | null {
  // A renderer is optional and untrusted. Reject output whose control overhead is
  // disproportionate to the selected source line instead of amplifying it.
  if (highlightedLine.length > expectedText.length * 64 + 4096) return null;

  const styles: string[] = [];
  let text = "";
  let active = "";
  let cursor = 0;
  const pattern = /\u001b\[([0-9;]*)m/g;
  for (let match = pattern.exec(highlightedLine); match != null; match = pattern.exec(highlightedLine)) {
    const chunk = highlightedLine.slice(cursor, match.index);
    text += chunk;
    for (const character of chunk) {
      for (let index = 0; index < character.length; index += 1) {
        styles.push(active);
        if (counters != null) {
          counters.allocatedStyleSlots += 1;
          counters.parsedStyleCodeUnits += 1;
        }
      }
    }
    const next = updateActiveStyle(active, match[0], match[1] ?? "");
    if (next == null) return null;
    active = next;
    cursor = match.index + match[0].length;
  }
  const tail = highlightedLine.slice(cursor);
  text += tail;
  for (const character of tail) {
    for (let index = 0; index < character.length; index += 1) {
      styles.push(active);
      if (counters != null) {
        counters.allocatedStyleSlots += 1;
        counters.parsedStyleCodeUnits += 1;
      }
    }
  }
  return text === expectedText ? { text, styles } : null;
}

/** Returns the SGR style active at each UTF-16 source offset, or null on mismatch. */
export function sourceLineStyles(rawLine: string, highlightedLine: string, counters?: ProjectionCounters): readonly string[] | null {
  // Plain projected lines intentionally carry no style map. The renderer always
  // displays rawLine, so no text validation or per-code-unit slots are needed.
  if (!highlightedLine.includes("\u001b")) return null;
  return parseStyledLine(highlightedLine, sanitizeTerminalText(rawLine), counters)?.styles ?? null;
}

function bufferStyles(text: string, highlightedLines: readonly string[], counters?: ProjectionCounters): readonly string[] | null {
  const rawLines = text.split(/\r\n|\r|\n/);
  if (rawLines.length !== highlightedLines.length) return null;
  const styles = Array.from<string>({ length: text.length }).fill("");
  if (counters != null) counters.allocatedStyleSlots += text.length;
  let offset = 0;

  for (let lineIndex = 0; lineIndex < rawLines.length; lineIndex += 1) {
    const line = rawLines[lineIndex]!;
    const lineStyles = sourceLineStyles(line, highlightedLines[lineIndex]!, counters);
    if (lineStyles == null || lineStyles.length !== line.length) return null;
    for (let index = 0; index < line.length; index += 1) styles[offset + index] = lineStyles[index] ?? "";
    offset += line.length;
    if (lineIndex < rawLines.length - 1) offset += text.startsWith("\r\n", offset) ? 2 : 1;
  }
  return offset === text.length ? styles : null;
}

function splitsSurrogate(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return false;
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

function renderStyledLines(text: string, styles: readonly string[], counters?: ProjectionCounters): readonly string[] {
  const rawLines = text.split(/\r\n|\r|\n/);
  const result: string[] = [];
  let offset = 0;

  for (let lineIndex = 0; lineIndex < rawLines.length; lineIndex += 1) {
    const line = rawLines[lineIndex]!;
    let rendered = "";
    let active = "";
    for (let index = 0; index < line.length;) {
      const codePoint = line.codePointAt(index)!;
      const character = String.fromCodePoint(codePoint);
      if (counters != null) counters.renderedCodeUnits += character.length;
      const style = styles[offset + index] ?? "";
      if (style !== active) {
        if (active !== "") rendered += ANSI_RESET;
        if (style !== "") rendered += style;
        active = style;
      }
      rendered += sanitizeTerminalText(character);
      index += character.length;
    }
    if (active !== "") rendered += ANSI_RESET;
    result.push(rendered);
    offset += line.length;
    if (lineIndex < rawLines.length - 1) offset += text.startsWith("\r\n", offset) ? 2 : 1;
  }
  return result;
}

function projectChangedSourceLines(
  previousText: string,
  previousHighlightedLines: readonly string[],
  nextText: string,
  counters?: ProjectionCounters,
): readonly string[] {
  const previousStyles = bufferStyles(previousText, previousHighlightedLines, counters);
  if (previousStyles == null) return plainSourceLines(nextText);

  let prefix = 0;
  const prefixLimit = Math.min(previousText.length, nextText.length);
  while (prefix < prefixLimit && previousText[prefix] === nextText[prefix]) prefix += 1;
  if (splitsSurrogate(previousText, prefix) || splitsSurrogate(nextText, prefix)) prefix -= 1;

  let suffix = 0;
  const suffixLimit = Math.min(previousText.length - prefix, nextText.length - prefix);
  while (suffix < suffixLimit && previousText[previousText.length - suffix - 1] === nextText[nextText.length - suffix - 1]) suffix += 1;
  if (splitsSurrogate(previousText, previousText.length - suffix) || splitsSurrogate(nextText, nextText.length - suffix)) suffix -= 1;

  const nextStyles = Array.from<string>({ length: nextText.length }).fill("");
  if (counters != null) counters.allocatedStyleSlots += nextText.length;
  for (let index = 0; index < prefix; index += 1) nextStyles[index] = previousStyles[index] ?? "";

  const previousSuffixStart = previousText.length - suffix;
  const nextSuffixStart = nextText.length - suffix;
  for (let index = 0; index < suffix; index += 1) nextStyles[nextSuffixStart + index] = previousStyles[previousSuffixStart + index] ?? "";

  const before = prefix > 0 && !/[\r\n]/.test(nextText[prefix - 1] ?? "") ? previousStyles[prefix - 1] ?? "" : "";
  const after = previousSuffixStart < previousText.length && !/[\r\n]/.test(previousText[previousSuffixStart] ?? "")
    ? previousStyles[previousSuffixStart] ?? ""
    : "";
  const insertedStyle = before || after;
  for (let index = prefix; index < nextSuffixStart; index += 1) {
    nextStyles[index] = /[\r\n]/.test(nextText[index] ?? "") ? "" : insertedStyle;
  }

  return renderStyledLines(nextText, nextStyles, counters);
}

function splitInsertedLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/** Exact retained-algorithm work estimate: parse old, allocate/render new, plus joined LF slots. */
function calculatePlannedStyleSlots(oldLines: readonly string[], newLines: readonly string[]): number {
  const oldContentCodeUnits = oldLines.reduce((sum, line) => sum + line.length, 0);
  const newContentCodeUnits = newLines.reduce((sum, line) => sum + line.length, 0);
  return 2 * oldContentCodeUnits + newContentCodeUnits + Math.max(0, oldLines.length - 1) + Math.max(0, newLines.length - 1);
}

/**
 * Applies one trusted editor splice to line state without splitting or diffing a
 * whole buffer. Previous plain lines are length-preserving sanitized source.
 * Invalid structural metadata returns null so the caller can use its compatible
 * whole-buffer replacement path.
 */
export function projectHighlightedSourceLineDelta(
  previousSourceLines: readonly string[],
  previousPlainLines: readonly string[],
  previousHighlightedLines: readonly string[],
  delta: BufferEditDelta,
): HighlightEditProjection | null {
  const { oldStart, oldEnd, newStart, newEnd } = delta;
  if (
    previousSourceLines.length !== delta.oldLineCount
    || previousPlainLines.length !== delta.oldLineCount
    || previousHighlightedLines.length !== delta.oldLineCount
    || oldStart.line < 0 || oldEnd.line < oldStart.line || oldEnd.line >= delta.oldLineCount
    || oldStart.column < 0 || oldEnd.column < 0
    || newStart.line !== oldStart.line || newStart.column !== oldStart.column
  ) return null;
  const firstOld = previousSourceLines[oldStart.line]!;
  const lastOld = previousSourceLines[oldEnd.line]!;
  if (oldStart.column > firstOld.length || oldEnd.column > lastOld.length) return null;

  const insertedLines = splitInsertedLines(delta.insertedText);
  const newAffected = insertedLines.length === 1
    ? [`${firstOld.slice(0, oldStart.column)}${insertedLines[0]}${lastOld.slice(oldEnd.column)}`]
    : [
      `${firstOld.slice(0, oldStart.column)}${insertedLines[0]}`,
      ...insertedLines.slice(1, -1),
      `${insertedLines.at(-1)}${lastOld.slice(oldEnd.column)}`,
    ];
  if (
    newEnd.line !== newStart.line + insertedLines.length - 1
    || newEnd.column !== (insertedLines.length === 1 ? newStart.column + insertedLines[0]!.length : insertedLines.at(-1)!.length)
    || delta.newLineCount !== delta.oldLineCount - (oldEnd.line - oldStart.line) + insertedLines.length - 1
  ) return null;

  const firstPlain = previousPlainLines[oldStart.line]!;
  const lastPlain = previousPlainLines[oldEnd.line]!;
  let sanitizedCodeUnits = 0;
  const sanitizedInserted = insertedLines.map((line) => {
    sanitizedCodeUnits += line.length;
    return sanitizeTerminalText(line);
  });
  const newPlain = sanitizedInserted.length === 1
    ? [`${firstPlain.slice(0, oldStart.column)}${sanitizedInserted[0]}${lastPlain.slice(oldEnd.column)}`]
    : [
      `${firstPlain.slice(0, oldStart.column)}${sanitizedInserted[0]}`,
      ...sanitizedInserted.slice(1, -1),
      `${sanitizedInserted.at(-1)}${lastPlain.slice(oldEnd.column)}`,
    ];

  const oldAffected = previousSourceLines.slice(oldStart.line, oldEnd.line + 1);
  const plannedStyleSlots = calculatePlannedStyleSlots(oldAffected, newAffected);
  const budgetExceeded = plannedStyleSlots > HIGHLIGHT_EDIT_CODE_UNIT_BUDGET;
  const counters: ProjectionCounters = { allocatedStyleSlots: 0, parsedStyleCodeUnits: 0, renderedCodeUnits: 0 };
  const newHighlighted = budgetExceeded
    ? newPlain
    : projectChangedSourceLines(
      oldAffected.join("\n"),
      previousHighlightedLines.slice(oldStart.line, oldEnd.line + 1),
      newAffected.join("\n"),
      counters,
    );
  const deleteCount = oldEnd.line - oldStart.line + 1;
  const sourceLines = previousSourceLines.slice();
  const plainLines = previousPlainLines.slice();
  const highlightedLines = previousHighlightedLines.slice();
  sourceLines.splice(oldStart.line, deleteCount, ...newAffected);
  plainLines.splice(oldStart.line, deleteCount, ...newPlain);
  highlightedLines.splice(oldStart.line, deleteCount, ...newHighlighted);
  return {
    sourceLines,
    plainLines,
    highlightedLines,
    stats: {
      affectedOldLines: deleteCount,
      affectedNewLines: newAffected.length,
      plannedStyleSlots,
      allocatedStyleSlots: counters.allocatedStyleSlots,
      parsedStyleCodeUnits: counters.parsedStyleCodeUnits,
      renderedCodeUnits: counters.renderedCodeUnits,
      sanitizedCodeUnits,
      budgetExceeded,
    },
  };
}

/**
 * Keeps the last validated Shiki palette attached to unchanged source and gives
 * a small edited span its nearest style until the debounced exact refresh lands.
 * Unchanged lines are reused without reparsing, so ordinary typing stays local.
 * The returned visible text always comes from nextText, never renderer output.
 */
export function projectHighlightedSourceLines(
  previousText: string,
  previousHighlightedLines: readonly string[],
  nextText: string,
): readonly string[] {
  const previousLines = previousText.split(/\r\n|\r|\n/);
  const nextLines = nextText.split(/\r\n|\r|\n/);
  if (previousLines.length !== previousHighlightedLines.length) return plainSourceLines(nextText);

  let leading = 0;
  const leadingLimit = Math.min(previousLines.length, nextLines.length);
  while (leading < leadingLimit && previousLines[leading] === nextLines[leading]) leading += 1;

  let trailing = 0;
  const trailingLimit = Math.min(previousLines.length - leading, nextLines.length - leading);
  while (trailing < trailingLimit && previousLines[previousLines.length - trailing - 1] === nextLines[nextLines.length - trailing - 1]) trailing += 1;

  const previousMiddleEnd = previousLines.length - trailing;
  const nextMiddleEnd = nextLines.length - trailing;
  const previousMiddle = previousLines.slice(leading, previousMiddleEnd);
  const nextMiddle = nextLines.slice(leading, nextMiddleEnd);
  const middlePlan = calculatePlannedStyleSlots(previousMiddle, nextMiddle);
  const projectedMiddle = nextMiddle.length === 0
    ? []
    : previousMiddle.length === 0 || middlePlan > HIGHLIGHT_EDIT_CODE_UNIT_BUDGET
      ? nextMiddle.map((line) => sanitizeTerminalText(line))
      : projectChangedSourceLines(
      previousMiddle.join("\n"),
      previousHighlightedLines.slice(leading, previousMiddleEnd),
      nextMiddle.join("\n"),
    );

  return [
    ...previousHighlightedLines.slice(0, leading),
    ...projectedMiddle,
    ...previousHighlightedLines.slice(previousMiddleEnd),
  ];
}
