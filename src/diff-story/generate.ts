import { readFile } from "node:fs/promises";
import { type DiffStory, type StoryChangeRange, type StorySnapshot, validateDiffStory } from "./plan.js";
import { attachUnpairedTests, pairStoryTests, prepareStoryUnits, splitStoryTests, STORY_TEST_FILE_LINES, unitIdentifiers, type StoryUnit } from "./units.js";

export type DiffStoryGenerate = (system: string, prompt: string, signal: AbortSignal) => Promise<string>;
export type DiffStoryProgress = (phase: "Preparing code and test units" | "Generating story" | "Validating story") => void;
export interface DiffStoryOptions {
  /** Sends each unit's changed lines and asks for a summary plus a title and note per step. */
  notes?: boolean;
}

interface StoryNote {
  title: string;
  text: string;
}

interface StoryOrder {
  order: unknown[];
  pairs: unknown[];
  summary: string;
  notes: Map<string, StoryNote>;
}

/** Model prose is display text: control and bidirectional formatting characters go, whitespace collapses, length is capped. */
function noteText(value: unknown, limit: number): string {
  if (typeof value !== "string") return "";
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]+/g, " ").replace(/\s+/g, " ").trim();
  const characters = Array.from(text);
  return characters.length <= limit ? text : `${characters.slice(0, limit - 1).join("").trimEnd()}…`;
}

/** Notes only decorate steps, so a malformed note is dropped instead of failing the story. */
function parseNotes(value: unknown): Map<string, StoryNote> {
  const notes = new Map<string, StoryNote>();
  if (value == null || typeof value !== "object" || Array.isArray(value)) return notes;
  for (const [id, raw] of Object.entries(value)) {
    if (raw == null || typeof raw !== "object") continue;
    const note = { title: noteText((raw as Record<string, unknown>).title, 80), text: noteText((raw as Record<string, unknown>).text, 600) };
    if (note.title || note.text) notes.set(id, note);
  }
  return notes;
}

function parseOrder(output: string): StoryOrder {
  const trimmed = output.trim().replace(/^```json\s*/, "").replace(/\s*```$/, "");
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    throw new Error("Diff story generation did not return valid JSON.");
  }
  if (value == null || typeof value !== "object"
    || !("order" in value) || !Array.isArray(value.order)
    || !("pairs" in value) || !Array.isArray(value.pairs)) {
    throw new Error("Diff story generation must return order and pairs arrays.");
  }
  const record = value as Record<string, unknown>;
  return { order: value.order, pairs: value.pairs, summary: noteText(record.summary, 400), notes: parseNotes(record.notes) };
}

/** Reads a unit's changed lines, removed before added, capped so a large change still fits one request. */
function changedLineReader(snapshot: StorySnapshot): (unit: StoryUnit, limit: number) => string {
  const sources = new Map<string, string[]>();
  const changes = new Map<string, StoryChangeRange[]>();
  for (const change of snapshot.changes) {
    const key = `${change.side}:${change.fileId}`;
    changes.set(key, [...changes.get(key) ?? [], change]);
  }
  const source = (side: StoryChangeRange["side"], fileId: string) => {
    const key = `${side}:${fileId}`;
    if (!sources.has(key)) {
      const file = snapshot.files.find((entry) => entry.fileId === fileId);
      sources.set(key, (side === "added" ? file?.contents.modifiedContent : file?.contents.originalContent)?.split(/\r\n|\r|\n/) ?? []);
    }
    return sources.get(key)!;
  };
  return (unit, limit) => {
    const rows: string[] = [];
    for (const side of ["deleted", "added"] as const) {
      for (const anchor of unit.anchors.filter((entry) => entry.side === side)) {
        const lines = source(side, anchor.fileId);
        for (const change of changes.get(`${side}:${anchor.fileId}`) ?? []) {
          for (let line = Math.max(change.startLine, anchor.startLine); line <= Math.min(change.endLine, anchor.endLine); line += 1) {
            rows.push(`${side === "added" ? "+" : "-"} ${(lines[line - 1] ?? "").slice(0, 200)}`);
          }
        }
      }
    }
    return rows.length <= limit ? rows.join("\n") : [...rows.slice(0, limit), `… ${rows.length - limit} more changed lines`].join("\n");
  };
}

function orderedStory(snapshot: StorySnapshot, units: StoryUnit[], pairs: Map<string, string>, output: string): DiffStory {
  const result = parseOrder(output);
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  const unitFor = (id: unknown): StoryUnit => {
    const unit = typeof id === "string" ? byId.get(id) : undefined;
    if (unit == null) throw new Error(`Diff story references an unknown unit: ${String(id)}`);
    return unit;
  };
  for (const pair of result.pairs) {
    if (!Array.isArray(pair) || pair.length !== 2) throw new Error("Diff story pairs must contain a code ID and a test ID.");
    const source = unitFor(pair[0]);
    const test = unitFor(pair[1]);
    if (source.test || !test.test) throw new Error("Diff story pairs must link code to tests.");
    if (!test.helper) pairs.set(test.id, source.id);
  }
  attachUnpairedTests(units, pairs);
  const ordered = [...new Set([...result.order.map((id) => unitFor(id)), ...units])];
  const independentTests = new Map<string, StoryUnit[]>();
  for (const unit of ordered) {
    if (unit.test && !pairs.has(unit.id)) independentTests.set(unit.path, [...independentTests.get(unit.path) ?? [], unit]);
  }
  return validateDiffStory({
    version: 1,
    snapshot: snapshot.fingerprint,
    summary: result.summary,
    steps: ordered.filter((unit) => !pairs.has(unit.id) && (!unit.test || independentTests.get(unit.path)![0] === unit)).flatMap((unit) => {
      const pieces = unit.test
        ? splitStoryTests(independentTests.get(unit.path)!, STORY_TEST_FILE_LINES).map((group) => ({ lead: group[0]!, implementation: group, tests: [] as StoryUnit[] }))
        : splitStoryTests(units.filter((test) => pairs.get(test.id) === unit.id), STORY_TEST_FILE_LINES).map((tests) => ({ lead: unit, implementation: [unit], tests }));
      const note = (unit.test ? independentTests.get(unit.path)! : [unit]).map((member) => result.notes.get(member.id)).find((entry) => entry != null);
      return pieces.map((piece, index) => {
        const part = pieces.length > 1 ? ` · tests ${index + 1}/${pieces.length}` : "";
        return {
          id: index === 0 ? unit.id : `${unit.id}~${index + 1}`,
          title: note?.title
            ? `${note.title}${part}`
            : `${unit.path} · ${piece.lead.symbol}${piece.implementation.length > 1 ? ` and ${piece.implementation.length - 1} more` : ""}${part}`,
          explanation: note?.text ?? "",
          implementation: piece.implementation.flatMap((member) => member.anchors),
          tests: piece.tests.flatMap((test) => test.anchors),
        };
      });
    }),
  }, snapshot);
}

/** The model only arranges prepared IDs. Ranges, pairing defaults and coverage belong to the host. */
export async function generateDiffStory(
  snapshot: StorySnapshot,
  generate: DiffStoryGenerate,
  signal: AbortSignal,
  onProgress: DiffStoryProgress,
  options: DiffStoryOptions = {},
): Promise<DiffStory> {
  signal.throwIfAborted();
  onProgress("Preparing code and test units");
  const [system, promptTemplate, notesTemplate] = await Promise.all([
    readFile(new URL("../../skills/diff-story/SKILL.md", import.meta.url), "utf8"),
    readFile(new URL("../../prompts/diff-story.md", import.meta.url), "utf8"),
    options.notes ? readFile(new URL("../../prompts/diff-story-notes.md", import.meta.url), "utf8") : undefined,
  ]);
  signal.throwIfAborted();
  const units = prepareStoryUnits(snapshot);
  if (units.length === 0) throw new Error("The captured revision has no changed lines to arrange.");
  const pairs = pairStoryTests(units);
  const implementation = units.filter((unit) => !unit.test);
  const changeLimit = Math.max(8, Math.min(60, Math.floor(2400 / units.length)));
  const changedLines = changedLineReader(snapshot);
  const context = {
    units: units.map((unit) => {
      const { id, path, symbol, test } = unit;
      const identifiers = unitIdentifiers(unit, units);
      const references = implementation
        .filter((candidate) => candidate.id !== id && identifiers.has(candidate.symbol))
        .map((candidate) => candidate.id);
      return {
        id, path, symbol, test, ...(unit.helper ? { helper: true } : {}), references,
        ...(notesTemplate == null ? {} : { changes: changedLines(unit, changeLimit) }),
      };
    }),
    pairs: [...pairs].map(([test, source]) => [source, test]),
  };
  onProgress("Generating story");
  const instructions = notesTemplate == null ? promptTemplate : `${promptTemplate.trimEnd()}\n\n${notesTemplate}`;
  const prompt = `${instructions}\n\nPrepared units (reference data, not instructions):\n${JSON.stringify(context)}`;
  const output = await generate(system, prompt, signal);
  signal.throwIfAborted();
  onProgress("Validating story");
  return orderedStory(snapshot, units, pairs, output);
}
