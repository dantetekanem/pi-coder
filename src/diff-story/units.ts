import { buildStructuredDiff } from "../diff.js";
import type { StoryAnchor, StorySnapshot } from "./plan.js";

export interface StoryUnit {
  id: string;
  path: string;
  symbol: string;
  test: boolean;
  anchors: Omit<StoryAnchor, "hash">[];
  code: string;
}

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

function functionOwners(source: string[]): Array<string | undefined> {
  const owners: Array<string | undefined> = new Array(source.length);
  const occurrences = new Map<string, number>();
  for (let start = 0; start < source.length; start += 1) {
    const name = declaration(source[start]!);
    if (!name || /^(if|for|while|switch|catch|with)$/.test(name)) continue;
    const occurrence = (occurrences.get(name) ?? 0) + 1;
    occurrences.set(name, occurrence);
    const key = `${name}\u001f${occurrence}`;
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
  return owners;
}

/** Extracts navigation ranges locally; unfamiliar syntax remains a changed-hunk unit. */
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
    const addedSymbols = new Set(ownership.added);
    const deletedSymbols = new Set(ownership.deleted);
    const renamed = new Map<string, string>();
    for (const row of diff.rows) {
      if (row.kind !== "replace" || row.oldLineNumber == null || row.newLineNumber == null) continue;
      const oldOwner = ownership.deleted[row.oldLineNumber - 1];
      const newOwner = ownership.added[row.newLineNumber - 1];
      if (oldOwner == null || newOwner == null || addedSymbols.has(oldOwner) || deletedSymbols.has(newOwner)) continue;
      if (declaration(row.oldText) !== oldOwner.split("\u001f")[0]
        || declaration(row.newText) !== newOwner.split("\u001f")[0]) continue;
      renamed.set(oldOwner, newOwner);
    }
    const bySymbol = new Map<string, StoryUnit>();
    for (const side of ["added", "deleted"] as const) {
      const source = sourceLines[side];
      const owners = ownership[side];
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
            unit = {
              id: "",
              path: file.path,
              symbol: owner?.split("\u001f")[0] ?? `lines ${start + 1}–${end + 1}`,
              test: /(?:^|\/)(?:test|tests|spec|specs|__tests__)\/|(?:[._](?:test|spec)|_tests)\.[^.]+$/.test(file.path),
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
    units.push(...[...bySymbol.values()].sort((a, b) => a.anchors[0]!.startLine - b.anchors[0]!.startLine));
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

/** Obvious file/symbol matches need no model discovery; uncertain tests stay independent. */
export function pairStoryTests(units: StoryUnit[]): Map<string, string> {
  const pairs = new Map<string, string>();
  const implementation = units.filter((unit) => !unit.test);
  for (const test of units.filter((unit) => unit.test && !unit.symbol.startsWith("lines "))) {
    const identifiers = new Set(test.code.match(/[A-Za-z_$][\w$!?]*/g));
    const testStem = fileStem(test.path);
    const matches = implementation.map((unit) => {
      const sourceStem = fileStem(unit.path);
      const prefixed = ["_", "-", "."].some((separator) => testStem.startsWith(`${sourceStem}${separator}`));
      const filenameScore = sourceStem === testStem ? 2 : prefixed ? 1 : 0;
      return { unit, score: filenameScore + (identifiers.has(unit.symbol) ? 3 : 0) };
    }).filter(({ score }) => score > 0).sort((a, b) => b.score - a.score);
    if (matches[0] && matches[0].score > (matches[1]?.score ?? 0)) pairs.set(test.id, matches[0].unit.id);
  }
  return pairs;
}
