import { buildStructuredDiff, type StructuredDiffRow } from "../diff.js";
import type { StoryAnchor, StorySide, StorySnapshot, StorySnapshotFile } from "../diff-story/plan.js";
import type { StoryUnit } from "../diff-story/units.js";

export type UnitAnchor = Omit<StoryAnchor, "hash">;

export interface NumberedLine {
  line: number;
  text: string;
}

export interface UnitChange {
  added: NumberedLine[];
  deleted: NumberedLine[];
}

export function splitLines(text: string): string[] {
  if (!text) return [];
  const result = text.split(/\r\n|\r|\n/);
  if (result.at(-1) === "") result.pop();
  return result;
}

/** Lowercase words of every identifier, split on snake_case and camelCase. */
export function identifierWords(text: string): string[] {
  const words: string[] = [];
  for (const token of text.match(/[A-Za-z][A-Za-z0-9]*/g) ?? []) {
    const parts = token.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").split(" ");
    for (const part of parts) if (part.length > 0) words.push(part.toLowerCase());
  }
  return words;
}

/** Same identifier shape the story preparation uses for local reference matches. */
export function identifiers(text: string): Set<string> {
  return new Set(text.match(/[A-Za-z_$][\w$!?]*/g));
}

export function fileStem(path: string): string {
  return path.split("/").at(-1)!.replace(/\.[^.]+$/, "");
}

const RUBY_FILE = /\.(?:rb|rake|gemspec|ru)$/;
const SCRIPT_FILE = /\.[cm]?[jt]sx?$/;
const PYTHON_FILE = /\.pyi?$/;

/**
 * 1-based numbers of the lines inside literals that span lines: Ruby heredocs, JS/TS template
 * literals and Python triple-quoted strings. The line that opens the literal is not inside it;
 * the line that closes it is. Nested `${}` templates are approximate.
 */
export function multilineLiteralLines(lines: readonly string[], path: string): Set<number> {
  const inside = new Set<number>();
  const ruby = RUBY_FILE.test(path);
  const script = SCRIPT_FILE.test(path);
  const python = PYTHON_FILE.test(path);
  if (!ruby && !script && !python) return inside;
  const terminators: string[] = [];
  let mode: "code" | "template" | "block" | "triple" = "code";
  let triple = "";
  lines.forEach((text, index) => {
    if (terminators.length > 0) {
      inside.add(index + 1);
      if (text.trim() === terminators[0]) terminators.shift();
      return;
    }
    if (mode === "template" || mode === "triple") inside.add(index + 1);
    let column = 0;
    while (column < text.length) {
      const char = text[column]!;
      if (mode === "template") {
        if (char === "\\") column += 1;
        else if (char === "`") mode = "code";
      } else if (mode === "triple") {
        if (char === "\\") column += 1;
        else if (text.startsWith(triple, column)) {
          mode = "code";
          column += 2;
        }
      } else if (mode === "block") {
        if (text.startsWith("*/", column)) {
          mode = "code";
          column += 1;
        }
      } else if (script && text.startsWith("//", column)) {
        break;
      } else if (script && text.startsWith("/*", column)) {
        mode = "block";
        column += 1;
      } else if ((ruby || python) && char === "#") {
        break;
      } else if (script && char === "`") {
        mode = "template";
      } else if (python && (char === '"' || char === "'") && text.startsWith(char.repeat(3), column)) {
        mode = "triple";
        triple = char.repeat(3);
        column += 2;
      } else if (char === '"' || char === "'") {
        column += 1;
        while (column < text.length && text[column] !== char) column += text[column] === "\\" ? 2 : 1;
      } else if (ruby && char === "<") {
        const heredoc = /^<<([~-]?)(?:(["'`])(\w+)\2|(\w+))/.exec(text.slice(column));
        const id = heredoc?.[3] ?? heredoc?.[4];
        if (heredoc != null && id != null && (heredoc[1] !== "" || heredoc[3] != null || /^[A-Z_]\w*$/.test(id))) {
          terminators.push(id);
          column += heredoc[0].length - 1;
        }
      }
      column += 1;
    }
  });
  return inside;
}

export function singleLine(value: string, limit: number): string {
  const clean = value.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ").replace(/\s+/g, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

/** Cached per-file lines, changed-line sets and diff rows for one captured snapshot. */
export class SnapshotIndex {
  private readonly files: Map<string, StorySnapshotFile>;
  private readonly lineCache = new Map<string, string[]>();
  private readonly changedCache = new Map<string, Set<number>>();
  private readonly rowCache = new Map<string, StructuredDiffRow[]>();
  private readonly literalCache = new Map<string, Set<number>>();

  constructor(readonly snapshot: StorySnapshot) {
    this.files = new Map(snapshot.files.map((file) => [file.fileId, file]));
  }

  file(fileId: string): StorySnapshotFile | undefined {
    return this.files.get(fileId);
  }

  lines(fileId: string, side: StorySide): string[] {
    const key = `${side}\u001f${fileId}`;
    let cached = this.lineCache.get(key);
    if (cached == null) {
      const file = this.files.get(fileId);
      cached = file == null ? [] : splitLines(side === "added" ? file.contents.modifiedContent : file.contents.originalContent);
      this.lineCache.set(key, cached);
    }
    return cached;
  }

  /** Lines of one file side that sit inside a literal spanning several lines. */
  literalLines(fileId: string, side: StorySide): Set<number> {
    const key = `${side}\u001f${fileId}`;
    let cached = this.literalCache.get(key);
    if (cached == null) {
      cached = multilineLiteralLines(this.lines(fileId, side), this.files.get(fileId)?.path ?? "");
      this.literalCache.set(key, cached);
    }
    return cached;
  }

  changedLines(fileId: string, side: StorySide): Set<number> {
    const key = `${side}\u001f${fileId}`;
    let cached = this.changedCache.get(key);
    if (cached == null) {
      cached = new Set();
      for (const change of this.snapshot.changes) {
        if (change.fileId !== fileId || change.side !== side) continue;
        for (let line = change.startLine; line <= change.endLine; line += 1) cached.add(line);
      }
      this.changedCache.set(key, cached);
    }
    return cached;
  }

  rows(fileId: string): StructuredDiffRow[] {
    let cached = this.rowCache.get(fileId);
    if (cached == null) {
      const file = this.files.get(fileId);
      cached = file == null ? [] : buildStructuredDiff(file.contents.originalContent, file.contents.modifiedContent, 0).rows;
      this.rowCache.set(fileId, cached);
    }
    return cached;
  }

  anchorLines(anchor: UnitAnchor): NumberedLine[] {
    const source = this.lines(anchor.fileId, anchor.side);
    const result: NumberedLine[] = [];
    for (let line = anchor.startLine; line <= Math.min(anchor.endLine, source.length); line += 1) {
      result.push({ line, text: source[line - 1]! });
    }
    return result;
  }

  /** Lines on each side of a unit that the captured diff actually changed. */
  unitChange(unit: Pick<StoryUnit, "anchors">): UnitChange {
    const change: UnitChange = { added: [], deleted: [] };
    for (const anchor of unit.anchors) {
      const changed = this.changedLines(anchor.fileId, anchor.side);
      for (const line of this.anchorLines(anchor)) {
        if (changed.has(line.line)) change[anchor.side].push(line);
      }
    }
    return change;
  }

  /** A compact unified excerpt of one unit: its first line, changed rows and two rows of context. */
  unitExcerpt(unit: Pick<StoryUnit, "anchors">, maxLines: number): string {
    const fileId = unit.anchors[0]?.fileId;
    if (fileId == null) return "";
    const covers = (side: StorySide, line: number | undefined) => line != null
      && unit.anchors.some((anchor) => anchor.side === side && anchor.startLine <= line && line <= anchor.endLine);
    const rows = this.rows(fileId);
    const owned: number[] = [];
    rows.forEach((row, index) => {
      if (covers("added", row.newLineNumber) || covers("deleted", row.oldLineNumber)) owned.push(index);
    });
    if (owned.length === 0) return "";
    const changed = owned.filter((index) => rows[index]!.kind !== "equal");
    const visible = new Set<number>([owned[0]!]);
    for (const index of changed) {
      for (let offset = -2; offset <= 2; offset += 1) visible.add(index + offset);
    }
    const ownedSet = new Set(owned);
    const output: string[] = [];
    let previous: number | undefined;
    for (const index of [...visible].filter((value) => ownedSet.has(value)).sort((a, b) => a - b)) {
      if (previous != null && index > previous + 1) output.push("      …");
      previous = index;
      const row = rows[index]!;
      const label = (value: number | undefined) => String(value ?? "").padStart(5);
      if (row.kind === "equal") output.push(` ${label(row.newLineNumber)} ${row.newText}`);
      if ((row.kind === "delete" || row.kind === "replace") && covers("deleted", row.oldLineNumber)) output.push(`-${label(row.oldLineNumber)} ${row.oldText}`);
      if ((row.kind === "insert" || row.kind === "replace") && covers("added", row.newLineNumber)) output.push(`+${label(row.newLineNumber)} ${row.newText}`);
    }
    if (output.length <= maxLines) return output.join("\n");
    return [...output.slice(0, maxLines), `      … ${output.length - maxLines} more lines`].join("\n");
  }
}
