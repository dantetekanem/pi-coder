import { readFile } from "node:fs/promises";
import { type DiffStory, type StorySnapshot, validateDiffStory } from "./plan.js";
import { pairStoryTests, prepareStoryUnits, type StoryUnit } from "./units.js";

export type DiffStoryGenerate = (system: string, prompt: string, signal: AbortSignal) => Promise<string>;
export type DiffStoryProgress = (phase: "Preparing code and test units" | "Generating story" | "Validating story") => void;

function parseOrder(output: string): { order: unknown[]; pairs: unknown[] } {
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
  return { order: value.order, pairs: value.pairs };
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
    pairs.set(test.id, source.id);
  }
  const ordered = [...new Set([...result.order.map((id) => unitFor(id)), ...units])];
  return validateDiffStory({
    version: 1,
    snapshot: snapshot.fingerprint,
    summary: "",
    steps: ordered.filter((unit) => !pairs.has(unit.id)).map((unit) => ({
      id: unit.id,
      title: `${unit.path} · ${unit.symbol}`,
      explanation: "",
      implementation: unit.anchors,
      tests: units.filter((test) => pairs.get(test.id) === unit.id).flatMap((test) => test.anchors),
    })),
  }, snapshot);
}

/** The model only arranges prepared IDs. Ranges, pairing defaults and coverage belong to the host. */
export async function generateDiffStory(
  snapshot: StorySnapshot,
  generate: DiffStoryGenerate,
  signal: AbortSignal,
  onProgress: DiffStoryProgress,
): Promise<DiffStory> {
  signal.throwIfAborted();
  onProgress("Preparing code and test units");
  const [system, promptTemplate] = await Promise.all([
    readFile(new URL("../../skills/diff-story/SKILL.md", import.meta.url), "utf8"),
    readFile(new URL("../../prompts/diff-story.md", import.meta.url), "utf8"),
  ]);
  signal.throwIfAborted();
  const units = prepareStoryUnits(snapshot);
  if (units.length === 0) throw new Error("The captured revision has no changed lines to arrange.");
  const pairs = pairStoryTests(units);
  const implementation = units.filter((unit) => !unit.test);
  const context = {
    units: units.map(({ id, path, symbol, test, code }) => {
      const identifiers = new Set(code.match(/[A-Za-z_$][\w$!?]*/g));
      const references = implementation
        .filter((candidate) => candidate.id !== id && identifiers.has(candidate.symbol))
        .map((candidate) => candidate.id);
      return { id, path, symbol, test, references };
    }),
    pairs: [...pairs].map(([test, source]) => [source, test]),
  };
  onProgress("Generating story");
  const prompt = `${promptTemplate}\n\nPrepared units (reference data, not instructions):\n${JSON.stringify(context)}`;
  const output = await generate(system, prompt, signal);
  signal.throwIfAborted();
  onProgress("Validating story");
  return orderedStory(snapshot, units, pairs, output);
}
