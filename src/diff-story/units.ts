import { buildStructuredDiff, type StructuredDiffRow } from "../diff.js";
import type { StoryAnchor, StorySnapshot } from "./plan.js";

export interface StoryUnit {
  id: string;
  path: string;
  symbol: string;
  test: boolean;
  /** A declaration in a test file that is not a test case, such as a private method the tests call. */
  helper?: boolean;
  anchors: Omit<StoryAnchor, "hash">[];
  code: string;
}

const TEST_CASE = /^\s*(?:(?:test|it|specify)(?:\.(?:only|skip))?\s*(?:\(\s*)?["'`]|def\s+test_)/;

function lines(text: string): string[] {
  if (!text) return [];
  const result = text.split(/\r\n|\r|\n/);
  if (result.at(-1) === "") result.pop();
  return result;
}

function declaration(line: string): string | undefined {
  return /^\s*(?:test|it|specify)(?:\.(?:only|skip))?\s*(?:\(\s*)?["'`]([^"'`]+)["'`]/.exec(line)?.[1]
    ?? /^\s*(?:private\s+|protected\s+)?def\s+(?:self\.)?([\w!?=]+)/.exec(line)?.[1]
    ?? /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([\w$]+)/.exec(line)?.[1]
    ?? /^\s*(?:export\s+)?(?:const|let)\s+([\w$]+)\s*=\s*(?:async\s*)?(?:function\b|[^;]*=>|\(\s*$)/.exec(line)?.[1]
    ?? /^\s*(?:(?:private|public|protected|static|async|override|get|set)\s+)*([\w$]+)\s*\([^;]*\)\s*(?::[^=;]+)?\s*\{/.exec(line)?.[1];
}

function functionOwners(source: string[]): { owners: Array<string | undefined>; cases: Set<string> } {
  const owners: Array<string | undefined> = new Array(source.length);
  const cases = new Set<string>();
  const occurrences = new Map<string, number>();
  for (let start = 0; start < source.length; start += 1) {
    const name = declaration(source[start]!);
    if (!name || /^(if|for|while|switch|catch|with)$/.test(name)) continue;
    const occurrence = (occurrences.get(name) ?? 0) + 1;
    occurrences.set(name, occurrence);
    const key = `${name}\u001f${occurrence}`;
    if (TEST_CASE.test(source[start]!)) cases.add(key);
    const indent = source[start]!.search(/\S/);
    let end = start;
    const inline = /\{.*\}\s*[);,]*$/.test(source[start]!) || /^\s*def\s+\S+\s*=\s+/.test(source[start]!);
    if (!inline) {
      while (end + 1 < source.length) {
        const next = source[end + 1]!;
        if (next.trim() && next.search(/\S/) <= indent) {
          if (/^\s*(?:end\b|\})/.test(next)) {
            end += 1;
            break;
          }
          if (declaration(next) != null || /^\s*(?:class|module|export)\b/.test(next)) break;
        }
        end += 1;
      }
    }
    while (end + 1 < source.length && source[end + 1]!.trim() === "") end += 1;
    // Nested declarations take ownership of their own lines on the next pass.
    for (let line = start; line <= end; line += 1) owners[line] = key;
  }
  return { owners, cases };
}

function foldLooseChanges(
  bySymbol: Map<string, StoryUnit>,
  rows: readonly StructuredDiffRow[],
  sourceLines: Record<StoryAnchor["side"], string[]>,
): StoryUnit[] {
  const rowOf = { added: new Map<number, number>(), deleted: new Map<number, number>() };
  rows.forEach((row, index) => {
    if (row.newLineNumber != null) rowOf.added.set(row.newLineNumber, index);
    if (row.oldLineNumber != null) rowOf.deleted.set(row.oldLineNumber, index);
  });
  const span = (anchor: Omit<StoryAnchor, "hash">) =>
    [rowOf[anchor.side].get(anchor.startLine) ?? 0, rowOf[anchor.side].get(anchor.endLine) ?? 0] as const;
  const declared = [...bySymbol].filter(([key]) => !key.startsWith("hunk:")).map(([, unit]) => unit);
  const loose = [...bySymbol].filter(([key]) => key.startsWith("hunk:")).map(([, unit]) => unit);
  const ownSpans = new Map(declared.map((unit) => [unit, unit.anchors.map(span)]));
  const kept = declared.length > 0 ? declared : loose.slice(0, 1);
  for (const unit of declared.length > 0 ? loose : loose.slice(1)) {
    for (const anchor of unit.anchors) {
      const [start, end] = span(anchor);
      let target = kept[0]!;
      let best = Infinity;
      for (const candidate of declared) {
        for (const [first, last] of ownSpans.get(candidate)!) {
          const distance = first > end ? first - end : Math.max(0, start - last);
          // On a tie the declaration below wins: comments and constants usually introduce what follows.
          const score = distance * 2 + (first > end ? 0 : 1);
          if (score < best) {
            best = score;
            target = candidate;
          }
        }
      }
      target.anchors.push(anchor);
      target.code += sourceLines[anchor.side].slice(anchor.startLine - 1, anchor.endLine).join("\n") + "\n";
    }
  }
  for (const unit of kept) {
    unit.anchors.sort((a, b) => span(a)[0] - span(b)[0] || Number(a.side === "deleted") - Number(b.side === "deleted"));
  }
  if (declared.length === 0 && kept[0] != null) {
    const side = kept[0].anchors[0]!.side;
    const ranges = kept[0].anchors.filter((anchor) => anchor.side === side);
    kept[0].symbol = `lines ${ranges[0]!.startLine}–${Math.max(...ranges.map((anchor) => anchor.endLine))}`;
  }
  return kept.sort((a, b) => span(a.anchors[0]!)[0] - span(b.anchors[0]!)[0]);
}

/** Extracts navigation ranges locally; changed lines outside a declaration join the nearest one in their file. */
export function prepareStoryUnits(snapshot: StorySnapshot): StoryUnit[] {
  const units: StoryUnit[] = [];
  for (const file of snapshot.files) {
    const diff = buildStructuredDiff(file.contents.originalContent, file.contents.modifiedContent, 0);
    const sourceLines = {
      added: lines(file.contents.modifiedContent),
      deleted: lines(file.contents.originalContent),
    };
    const ownership = {
      added: functionOwners(sourceLines.added),
      deleted: functionOwners(sourceLines.deleted),
    };
    const addedSymbols = new Set(ownership.added.owners);
    const deletedSymbols = new Set(ownership.deleted.owners);
    const renamed = new Map<string, string>();
    for (const row of diff.rows) {
      if (row.kind !== "replace" || row.oldLineNumber == null || row.newLineNumber == null) continue;
      const oldOwner = ownership.deleted.owners[row.oldLineNumber - 1];
      const newOwner = ownership.added.owners[row.newLineNumber - 1];
      if (oldOwner == null || newOwner == null || addedSymbols.has(oldOwner) || deletedSymbols.has(newOwner)) continue;
      if (declaration(row.oldText) !== oldOwner.split("\u001f")[0]
        || declaration(row.newText) !== newOwner.split("\u001f")[0]) continue;
      renamed.set(oldOwner, newOwner);
    }
    const bySymbol = new Map<string, StoryUnit>();
    for (const side of ["added", "deleted"] as const) {
      const source = sourceLines[side];
      const { owners, cases } = ownership[side];
      const changed = new Map<number, number>();
      for (const hunk of diff.hunks) {
        for (const row of diff.rows.slice(hunk.changeStartRow, hunk.changeEndRow + 1)) {
          const line = side === "added" ? row.newLineNumber : row.oldLineNumber;
          if (row.kind !== "equal" && line != null) changed.set(line - 1, hunk.index);
        }
      }
      for (let start = 0; start < source.length;) {
        const originalOwner = owners[start];
        const owner = side === "deleted" ? renamed.get(originalOwner ?? "") ?? originalOwner : originalOwner;
        let end = start;
        if (owner != null) {
          while (end + 1 < source.length && owners[end + 1] === originalOwner) end += 1;
        } else if (changed.has(start)) {
          while (end + 1 < source.length && owners[end + 1] == null && changed.has(end + 1)) end += 1;
        }
        const touched = Array.from({ length: end - start + 1 }, (_, offset) => start + offset).filter((line) => changed.has(line));
        if (touched.length > 0) {
          const key = owner ?? `hunk:${changed.get(touched[0]!)}`;
          let unit = bySymbol.get(key);
          if (unit == null) {
            const test = /(?:^|\/)(?:test|tests|spec|specs|__tests__)\/|(?:[._](?:test|spec)|_tests)\.[^.]+$/.test(file.path);
            unit = {
              id: "",
              path: file.path,
              symbol: owner?.split("\u001f")[0] ?? `lines ${start + 1}–${end + 1}`,
              test,
              helper: test && originalOwner != null && !cases.has(originalOwner),
              anchors: [], code: "",
            };
            bySymbol.set(key, unit);
          }
          unit.anchors.push({ fileId: file.fileId, side, startLine: start + 1, endLine: end + 1 });
          unit.code += source.slice(start, end + 1).join("\n") + "\n";
        }
        start = end + 1;
      }
    }
    units.push(...foldLooseChanges(bySymbol, diff.rows, sourceLines));
  }
  const supporting = (unit: StoryUnit) => Number(unit.test || unit.symbol.startsWith("lines "));
  units.sort((a, b) => supporting(a) - supporting(b));
  for (const [index, unit] of units.entries()) {
    unit.id = `u${index + 1}`;
    for (const anchor of unit.anchors) anchor.unitId = unit.id;
  }
  return units;
}

function fileStem(path: string): string {
  return path.replace(/\.[^.]+$/, "").replace(/[._](?:tests?|spec)$/, "").split("/").at(-1)!;
}

function filenameScore(testStem: string, path: string): number {
  const sourceStem = fileStem(path);
  if (sourceStem === testStem) return 2;
  return ["_", "-", "."].some((separator) => testStem.startsWith(`${sourceStem}${separator}`)) ? 1 : 0;
}

/** Quoted strings (test names, URLs, hash keys) and `key:` labels are data, not references. */
function codeIdentifiers(code: string): Set<string> {
  return new Set(code
    .replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\\n]|\\.)*`/g, " ")
    .replace(/\b[A-Za-z_]\w*[!?]?:(?!:)/g, " ")
    .match(/[A-Za-z_$][\w$!?]*/g));
}

/** The names a unit's code mentions. A test also reads the helpers in its file that it calls, directly or through other helpers. */
export function unitIdentifiers(unit: StoryUnit, units: readonly StoryUnit[]): Set<string> {
  const identifiers = codeIdentifiers(unit.code);
  let pending = unit.test ? units.filter((other) => other.helper && other !== unit && other.path === unit.path) : [];
  let reached = pending.filter((helper) => identifiers.has(helper.symbol));
  while (reached.length > 0) {
    pending = pending.filter((helper) => !reached.includes(helper));
    for (const helper of reached) for (const name of codeIdentifiers(helper.code)) identifiers.add(name);
    reached = pending.filter((helper) => identifiers.has(helper.symbol));
  }
  return identifiers;
}

/** Obvious file/symbol matches need no model discovery; uncertain tests stay independent. Only test cases pair, and a changed file named like the test file outranks name matches in other files. */
export function pairStoryTests(units: StoryUnit[]): Map<string, string> {
  const pairs = new Map<string, string>();
  const implementation = units.filter((unit) => !unit.test);
  for (const test of units.filter((unit) => unit.test && !unit.helper && !unit.symbol.startsWith("lines "))) {
    const identifiers = unitIdentifiers(test, units);
    const testStem = fileStem(test.path);
    const named = implementation.filter((unit) => filenameScore(testStem, unit.path) > 0);
    const matches = (named.length > 0 ? named : implementation)
      .map((unit) => ({ unit, score: filenameScore(testStem, unit.path) + (identifiers.has(unit.symbol) ? 3 : 0) }))
      .filter(({ score }) => score > 0).sort((a, b) => b.score - a.score);
    if (matches[0] && matches[0].score > (matches[1]?.score ?? 0)) pairs.set(test.id, matches[0].unit.id);
  }
  return pairs;
}

/** The most anchored lines of one test file that a single step shows. */
export const STORY_TEST_FILE_LINES = 30;

function anchoredLines(unit: StoryUnit): number {
  return unit.anchors.reduce((total, anchor) => total + anchor.endLine - anchor.startLine + 1, 0);
}

/** Splits tests in source order into chunks of whole units. A unit that would push its file past the limit starts a new chunk; one unit over the limit still gets a chunk. A helper never starts a chunk, so it stays with the tests before it. */
export function splitStoryTests(tests: readonly StoryUnit[], maxLines: number): StoryUnit[][] {
  const chunks: StoryUnit[][] = [[]];
  let used = new Map<string, number>();
  for (const test of tests) {
    const lines = anchoredLines(test);
    const inFile = used.get(test.path) ?? 0;
    if (inFile > 0 && inFile + lines > maxLines && !test.helper) {
      chunks.push([]);
      used = new Map();
    }
    chunks.at(-1)!.push(test);
    used.set(test.path, (used.get(test.path) ?? 0) + lines);
  }
  return chunks;
}

function rangeGap(left: Omit<StoryAnchor, "hash">, right: Omit<StoryAnchor, "hash">): number {
  if (left.side !== right.side) return Infinity;
  return Math.max(0, left.startLine - right.endLine, right.startLine - left.endLine);
}

/** A helper joins the step of the first test that calls it. Setup, other helpers and unpaired tests join the step that owns the nearest paired test in their file. */
export function attachUnpairedTests(units: StoryUnit[], pairs: Map<string, string>): void {
  const nearestStep = (test: StoryUnit, owners: Map<string, string>) => {
    const siblings = units.filter((unit) => unit.test && unit.path === test.path && owners.has(unit.id));
    if (siblings.length === 0) return undefined;
    const distance = (sibling: StoryUnit) => Math.min(...test.anchors.flatMap((own) => sibling.anchors.map((other) => rangeGap(own, other))));
    return owners.get(siblings.reduce((best, sibling) => distance(sibling) < distance(best) ? sibling : best).id);
  };
  const paired = new Map(pairs);
  for (const test of units) {
    if (!test.test || test.helper || paired.has(test.id)) continue;
    const step = nearestStep(test, paired);
    if (step != null) pairs.set(test.id, step);
  }
  const calls = new Map<StoryUnit, Set<string>>();
  const callsOf = (unit: StoryUnit) => {
    if (!calls.has(unit)) calls.set(unit, unitIdentifiers(unit, units));
    return calls.get(unit)!;
  };
  for (const helper of units) {
    if (!helper.helper || pairs.has(helper.id)) continue;
    const caller = units.find((unit) => unit.test && !unit.helper && unit.path === helper.path && pairs.has(unit.id)
      && callsOf(unit).has(helper.symbol));
    const step = caller == null ? nearestStep(helper, pairs) : pairs.get(caller.id);
    if (step != null) pairs.set(helper.id, step);
  }
}
