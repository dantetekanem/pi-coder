import { buildGuide, unitLabel, type FormalValidationGuide, type GuideStep, type GuideTarget, type GuideUnit, type PreparedGuide } from "../formal-validation/guide.js";
import { applyRefinement, refineGuide } from "../formal-validation/refine.js";
import type { GuideStore } from "../formal-validation/run.js";
import type { TestProfile } from "../formal-validation/tests.js";
import type { DiffStoryGenerate } from "./generate.js";
import { completeDiffStory, uncoveredStoryChanges, validateDiffStory, type DiffStory, type StoryAnchor, type StorySnapshot } from "./plan.js";

type Anchor = Omit<StoryAnchor, "hash">;

export type FormalStoryPhase = "Preparing code and test units" | "Writing the validation guide" | "Reusing the saved validation guide" | "Validating story";

export interface FormalStoryOptions {
  target: GuideTarget;
  description?: string;
  store?: GuideStore;
  model?: string;
}

export interface FormalStory {
  plan: DiffStory;
  guide: FormalValidationGuide;
}

const PRIORITY_LABEL = { critical: "Critical", needed: "Needed", minor: "Minor" } as const;
const MINOR_LIST_LIMIT = 20;

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function testLine(test: TestProfile): string {
  const label = test.kind === "support" ? "support" : test.status === "removed" ? "removed" : test.quality ?? "test";
  const note = test.flags.find((flag) => flag.severity === "weak") ?? test.flags.find((flag) => flag.severity === "fair");
  return `${label} · "${test.name}"${test.verifies == null ? "" : ` — ${test.verifies}`}${note == null ? "" : ` (${note.message})`}`;
}

/** The step text a reader sees: its first line is the rule to keep, then how to check it and what the tests prove. */
export function stepExplanation(guide: FormalValidationGuide, step: GuideStep): string {
  const why = step.reasons.length === 0 ? undefined : `Why: ${step.reasons.join("; ")}`;
  const lines = step.property != null ? [`Property: ${step.property}`, ...(why == null ? [] : [why])] : why == null ? [] : [why];
  if (step.ordering) lines.push("Order of steps matters: check concurrent callers, retries and partial failures.");
  if (step.checks.length > 0) lines.push("Verify:", ...step.checks.map((check, index) => `  ${index + 1}. ${check}`));
  const tests = step.tests.map((id) => guide.tests[id]).filter((test): test is TestProfile => test != null);
  if (tests.length > 0) lines.push(`Tests (${tests.length}):`, ...tests.map((test) => `  - ${testLine(test)}`));
  if (step.gaps.length > 0) lines.push("Gaps:", ...step.gaps.map((gap) => `  - ${gap}`));
  return lines.join("\n");
}

function storySummary(guide: FormalValidationGuide, position: ReadonlyMap<string, number>, minorPosition: number | undefined, minorCount: number): string {
  const counts = { critical: 0, needed: 0 };
  for (const step of guide.steps) if (step.priority !== "minor") counts[step.priority] += 1;
  const lines = guide.summary == null ? [] : [guide.summary];
  if (guide.refinement.status === "failed") {
    lines.push(`The guideline model failed (${guide.refinement.message ?? "no message"}), so steps follow host rules.`);
  }
  lines.push(`${counts.critical} critical and ${counts.needed} needed ${counts.critical + counts.needed === 1 ? "step" : "steps"}${minorCount === 0 ? "" : `, then ${plural(minorCount, "minor change")}`}.`);
  for (const claim of guide.claims) {
    const steps = [...new Set(claim.steps.map((id) => position.get(id) ?? minorPosition).filter((value): value is number => value != null))].sort((a, b) => a - b);
    lines.push(`Claim "${claim.text}" → ${steps.length === 0 ? "no step names it" : `step${steps.length === 1 ? "" : "s"} ${steps.join(", ")}`}`);
  }
  lines.push(...guide.gaps.map((gap) => `Gap: ${gap}`));
  return lines.join("\n");
}

/**
 * Turns a validation guide into a story: critical and needed steps keep the guide order, and
 * minimized units and minor steps become one closing step, so every changed line keeps one page.
 */
export function storyFromGuide(guide: FormalValidationGuide, snapshot: StorySnapshot): DiffStory {
  const anchorsOf = (ids: readonly string[]): Anchor[] => ids.flatMap((id) => guide.units[id]?.anchors ?? [])
    .map(({ unitId, fileId, side, startLine, endLine }) => ({ ...(unitId == null ? {} : { unitId }), fileId, side, startLine, endLine }));
  const testAnchors = (ids: readonly string[]) => anchorsOf(ids.flatMap((id) => guide.tests[id]?.members ?? [id]));
  const main = guide.steps.filter((step) => step.priority !== "minor");
  const position = new Map(main.map((step, index) => [step.id, index + 1]));
  const steps = main.map((step) => {
    const code = anchorsOf(step.units);
    const tests = testAnchors(step.tests);
    return {
      id: step.id,
      title: `${PRIORITY_LABEL[step.priority]} · ${step.title}`,
      explanation: stepExplanation(guide, step),
      // A step with only tests reads them in the main pane, as stories already do for unpaired test files.
      implementation: code.length > 0 ? code : tests,
      tests: code.length > 0 ? tests : [],
    };
  });

  const minorSteps = guide.steps.filter((step) => step.priority === "minor");
  const minorUnits = [...guide.minimized, ...minorSteps.flatMap((step) => step.units)];
  const minorTests = minorSteps.flatMap((step) => step.tests);
  const minimizedRoots = guide.minimized.map((id) => guide.units[id]).filter((unit): unit is GuideUnit => unit != null && unit.root == null);
  const minorCount = minimizedRoots.length + minorSteps.length;
  if (minorUnits.length > 0 || minorTests.length > 0) {
    const items = [
      ...minorSteps.map((step) => `  - ${step.title}${step.reasons[0] == null ? "" : ` — ${step.reasons[0]}`}`),
      ...minimizedRoots.map((unit) => `  - ${unit.path} · ${unitLabel(unit)} — ${unit.risk?.reasons[0] ?? "mechanical"}`),
    ];
    const shown = items.slice(0, MINOR_LIST_LIMIT);
    if (items.length > shown.length) shown.push(`  - … ${items.length - shown.length} more`);
    const code = anchorsOf(minorUnits);
    const tests = testAnchors(minorTests);
    steps.push({
      id: "minor-changes",
      title: `${PRIORITY_LABEL.minor} · ${plural(minorCount, "mechanical change")}`,
      explanation: ["Skim these: docs, lockfiles, comments, imports, formatting and other edits with no rule of their own.", ...shown].join("\n"),
      implementation: code.length > 0 ? code : tests,
      tests: code.length > 0 ? tests : [],
    });
  }
  const summary = storySummary(guide, position, minorCount === 0 ? undefined : steps.length, minorCount);
  const plan = validateDiffStory({ version: 1, snapshot: snapshot.fingerprint, summary, steps }, snapshot);
  return uncoveredStoryChanges(plan, snapshot).length === 0 ? plan : completeDiffStory(plan, snapshot);
}

function sameHostFacts(fresh: FormalValidationGuide, saved: FormalValidationGuide): boolean {
  const ids = Object.keys(fresh.units);
  if (ids.length !== Object.keys(saved.units ?? {}).length) return false;
  for (const id of ids) {
    const current = fresh.units[id]!;
    const previous = saved.units[id];
    if (previous == null || previous.path !== current.path || previous.symbol !== current.symbol || previous.test !== current.test
      || JSON.stringify(previous.anchors) !== JSON.stringify(current.anchors)) return false;
  }
  const tests = (guide: FormalValidationGuide) => JSON.stringify(Object.keys(guide.tests ?? {}).sort());
  return tests(fresh) === tests(saved);
}

/**
 * Re-applies a saved guide's model-written steps to fresh host facts. Host rules and test profiles
 * come from the current code; a saved guide whose units no longer match is not reused.
 */
export function reapplySavedGuide(prepared: PreparedGuide, saved: FormalValidationGuide): FormalValidationGuide | undefined {
  const fresh = prepared.guide;
  if (saved.snapshot !== fresh.snapshot || saved.refinement?.status !== "applied" || !Array.isArray(saved.steps)) return undefined;
  if (!sameHostFacts(fresh, saved)) return undefined;
  const roots = new Set(Object.values(fresh.units).filter((unit) => !unit.test && unit.root == null).map((unit) => unit.id));
  const position = new Map(saved.steps.map((step, index) => [step.id, index + 1]));
  const claims = new Map(fresh.claims.map((claim) => [claim.id, claim.text]));
  const answer = {
    ...(saved.summary == null ? {} : { summary: saved.summary }),
    steps: saved.steps.map((step) => ({
      units: step.units.filter((id) => roots.has(id)),
      tests: step.tests,
      title: step.title,
      priority: step.priority,
      ...(step.reasons[0] == null ? {} : { why: step.reasons[0] }),
      ...(step.property == null ? {} : { property: step.property }),
      ordering: step.ordering,
      checks: step.checks,
    })),
    tests: Object.values(saved.tests).flatMap((test) => test.verifies == null ? [] : [{ id: test.unitId, verifies: test.verifies }]),
    claims: (saved.claims ?? []).filter((claim) => claims.get(claim.id) === claim.text).map((claim) => ({
      id: claim.id,
      steps: claim.steps.map((id) => position.get(id)).filter((value): value is number => value != null),
    })),
  };
  try {
    return applyRefinement(prepared, JSON.stringify(answer), saved.refinement.model == null ? "a saved guide" : `${saved.refinement.model} (saved)`);
  } catch {
    return undefined;
  }
}

/** Builds the story from a validation guide of the captured bytes: a saved one for the same bytes, or one model request. */
export async function generateFormalStory(
  snapshot: StorySnapshot,
  generate: DiffStoryGenerate,
  signal: AbortSignal,
  onProgress: (phase: FormalStoryPhase) => void,
  options: FormalStoryOptions,
): Promise<FormalStory> {
  signal.throwIfAborted();
  onProgress("Preparing code and test units");
  const description = options.description?.trim() ?? "";
  const prepared = buildGuide({ snapshot, target: options.target, description });
  const saved = options.store == null ? undefined : await options.store.load(snapshot.fingerprint).catch(() => undefined);
  signal.throwIfAborted();
  let guide = saved == null ? undefined : reapplySavedGuide(prepared, saved);
  if (guide != null) {
    onProgress("Reusing the saved validation guide");
  } else {
    onProgress("Writing the validation guide");
    guide = await refineGuide(prepared, description, generate, signal, options.model);
    signal.throwIfAborted();
    // A story still opens when the guide cannot be saved; the next run asks the model again.
    await options.store?.save(guide).catch(() => undefined);
  }
  onProgress("Validating story");
  return { plan: storyFromGuide(guide, snapshot), guide };
}
