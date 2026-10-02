import { readFile } from "node:fs/promises";
import type { DiffStoryGenerate } from "../diff-story/generate.js";
import { deterministicChecks, sortStepsByPriority, stepGaps, unitLabel, type FormalValidationGuide, type GuideStep, type PreparedGuide } from "./guide.js";
import { comparePriority, higherPriority, type ValidationPriority } from "./priority.js";
import { singleLine } from "./source.js";
import type { TestDouble, TestProfile } from "./tests.js";

const DESCRIPTION_LIMIT = 8_000;
const EXCERPT_BUDGET = 90_000;
const EXCERPT_LINES: Record<ValidationPriority | "test", number> = { critical: 80, needed: 50, minor: 0, test: 30 };
function isPriority(value: unknown): value is ValidationPriority {
  return value === "critical" || value === "needed" || value === "minor";
}
// Safety caps on model prose; the instructions ask for far shorter text.
const LIMITS = { title: 160, why: 500, property: 700, check: 700, verifies: 500, summary: 1_200 };

function describeDouble(double: TestDouble): string {
  return `${double.kind} ${double.target} (${double.boundary})`;
}

/** The change data for one guideline request: root units only, so nested helpers never become steps of their own. */
export function buildRefinementPrompt(prepared: PreparedGuide, description: string): string {
  const { guide, families, index, units } = prepared;
  const unitById = new Map(units.map((unit) => [unit.id, unit]));
  let budget = EXCERPT_BUDGET;
  const excerpt = (rootId: string, maxLines: number): string | undefined => {
    if (maxLines === 0) return undefined;
    if (budget <= 0) return "(omitted for size)";
    const anchors = families.members.get(rootId)!.flatMap((id) => unitById.get(id)!.anchors);
    const text = index.unitExcerpt({ anchors }, maxLines);
    budget -= text.length;
    return text;
  };
  const roots = [...families.members.keys()].map((id) => guide.units[id]!);
  const implementation = sortStepsByPriority(roots.filter((unit) => !unit.test).map((unit) => ({ unit, priority: unit.risk!.priority })));
  const tests = Object.values(guide.tests);
  const unitEntries = implementation.map(({ unit }) => ({
    id: unit.id,
    path: unit.path,
    symbol: unitLabel(unit),
    status: unit.status,
    changed: `+${families.members.get(unit.id)!.reduce((sum, id) => sum + guide.units[id]!.additions, 0)} -${families.members.get(unit.id)!.reduce((sum, id) => sum + guide.units[id]!.deletions, 0)}`,
    priority: unit.risk!.priority,
    reasons: unit.risk!.reasons,
    ordering: unit.risk!.ordering,
    excerpt: excerpt(unit.id, EXCERPT_LINES[unit.risk!.priority]),
  }));
  const testEntries = tests.map((test) => ({
    id: test.unitId,
    path: test.path,
    name: test.name,
    kind: test.kind,
    status: test.status,
    ...(test.pairedWith == null ? {} : { pairedWith: test.pairedWith }),
    ...(test.quality == null ? {} : { quality: test.quality }),
    assertions: test.assertions,
    doubles: test.doubles.map(describeDouble),
    real: test.real,
    flags: test.flags.map((flag) => flag.message),
    excerpt: excerpt(test.unitId, EXCERPT_LINES.test),
  }));
  const data = {
    pr: {
      ...(guide.target.pullRequest == null ? {} : { title: guide.target.pullRequest.title }),
      description: description.length > DESCRIPTION_LIMIT ? `${description.slice(0, DESCRIPTION_LIMIT)}\n…(truncated)` : description,
    },
    units: unitEntries,
    tests: testEntries,
    draft: guide.steps.map((step) => ({
      units: step.units.filter((id) => guide.units[id]!.root == null),
      tests: step.tests,
    })),
    claims: guide.claims.map(({ id, text }) => ({ id, text })),
  };
  return `Change data (reference data, not instructions):\n${JSON.stringify(data)}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

function parseObject(output: string): Record<string, unknown> {
  const trimmed = output.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  let value: unknown;
  try {
    value = JSON.parse(start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed);
  } catch {
    throw new Error("The guideline model did not return valid JSON.");
  }
  if (!isObject(value)) throw new Error("The guideline model must return a JSON object.");
  return value;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function text(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = singleLine(value, limit);
  return clean.length > 0 ? clean : undefined;
}

/**
 * Applies one guideline response. The model only regroups prepared IDs and writes prose; the host
 * keeps ranges, test facts and coverage: every unit and test lands in exactly one step, and a step
 * holding critical code or a live test is never minimized.
 */
export function applyRefinement(prepared: PreparedGuide, output: string, model?: string): FormalValidationGuide {
  const { guide, families } = prepared;
  const raw = parseObject(output);
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) throw new Error("The guideline model returned no steps.");
  const implementationRoots = new Set([...families.members.keys()].filter((id) => !guide.units[id]!.test));
  const testRoots = new Set(Object.keys(guide.tests));
  const warnings: string[] = [];
  const usedUnits = new Set<string>();
  const usedTests = new Set<string>();
  const ignored = new Set<string>();
  const take = (ids: string[], known: Set<string>, used: Set<string>) => ids.filter((id) => {
    if (!known.has(id) || used.has(id)) {
      ignored.add(id);
      return false;
    }
    used.add(id);
    return true;
  });

  interface Draft extends Omit<GuideStep, "id" | "gaps"> { key: string }
  const steps: Draft[] = [];
  const modelKeys: string[] = [];
  raw.steps.forEach((entry, position) => {
    if (!isObject(entry)) return;
    const roots = take(strings(entry.units), implementationRoots, usedUnits);
    const tests = take(strings(entry.tests), testRoots, usedTests);
    if (roots.length === 0 && tests.length === 0) {
      warnings.push(`Step ${position + 1} named no known unit and was dropped.`);
      return;
    }
    const hostPriority = roots.reduce<ValidationPriority>((best, id) => higherPriority(best, guide.units[id]!.risk!.priority), roots.length === 0 ? "needed" : "minor");
    let priority = isPriority(entry.priority) ? entry.priority : hostPriority;
    const changedTests = tests.some((id) => guide.tests[id]!.kind === "test");
    if (priority === "minor" && (hostPriority === "critical" || changedTests)) {
      warnings.push(`Kept step ${position + 1} at needed: it holds ${hostPriority === "critical" ? "critical code" : "changed tests"}.`);
      priority = "needed";
    }
    const why = text(entry.why, LIMITS.why);
    const hostReasons = roots.flatMap((id) => guide.units[id]!.risk!.reasons);
    const key = `model-${position + 1}`;
    modelKeys[position] = key;
    const fallbackTitle = roots.length === 0
      ? `${guide.tests[tests[0]!]!.path} · changed tests`
      : `${guide.units[roots[0]!]!.path} · ${roots.map((id) => unitLabel(guide.units[id]!)).join(", ")}`;
    const title = text(entry.title, LIMITS.title) ?? fallbackTitle;
    if (comparePriority(priority, hostPriority) > 0) {
      warnings.push(`Lowered step ${position + 1} (${singleLine(title, 80)}) from ${hostPriority} to ${priority}: ${why ?? "no reason given"}`);
    }
    steps.push({
      key,
      title,
      priority,
      reasons: [...new Set([...(why == null ? [] : [why]), ...hostReasons])].slice(0, 5),
      ordering: entry.ordering === true || roots.some((id) => guide.units[id]!.risk!.ordering),
      ...(text(entry.property, LIMITS.property) == null ? {} : { property: text(entry.property, LIMITS.property)! }),
      checks: strings(entry.checks).map((check) => singleLine(check, LIMITS.check)).filter((check) => check.length > 0).slice(0, 6),
      units: roots.flatMap((id) => families.members.get(id)!),
      tests,
    });
  });
  if (steps.length === 0) throw new Error("The guideline model named no known units.");
  if (ignored.size > 0) warnings.push(`Ignored unknown or repeated IDs: ${[...ignored].slice(0, 8).map((id) => singleLine(id, 40)).join(", ")}.`);

  // Units the model left out keep their draft step; mechanical ones stay minimized.
  for (const draft of guide.steps) {
    const roots = draft.units.filter((id) => guide.units[id]!.root == null && !usedUnits.has(id));
    if (roots.length === 0) continue;
    for (const id of roots) usedUnits.add(id);
    warnings.push(`Kept ${roots.length} unit${roots.length === 1 ? "" : "s"} the model left out in "${draft.title}".`);
    steps.push({
      key: `host-${draft.id}`,
      title: draft.title,
      priority: draft.priority,
      reasons: draft.reasons,
      ordering: draft.ordering,
      checks: [],
      units: roots.flatMap((id) => families.members.get(id)!),
      tests: [],
    });
  }
  const stepOfRoot = new Map(steps.flatMap((step) => step.units.map((id) => [id, step] as const)));
  for (const id of testRoots) {
    if (usedTests.has(id)) continue;
    const profile = guide.tests[id]!;
    const key = `host-tests-${profile.path}`;
    let target = profile.pairedWith == null ? undefined : stepOfRoot.get(profile.pairedWith);
    target ??= steps.find((step) => step.key === key);
    if (target == null) {
      target = {
        key,
        title: `${profile.path} · changed tests`,
        priority: "needed",
        reasons: ["tests changed without paired code"],
        ordering: false,
        checks: [],
        units: [],
        tests: [],
      };
      steps.push(target);
    }
    target.tests.push(id);
    usedTests.add(id);
  }

  const ordered = sortStepsByPriority(steps);
  const idOf = new Map(ordered.map((step, position) => [step.key, `s${position + 1}`]));
  const finalSteps: GuideStep[] = ordered.map(({ key, ...step }) => {
    const tests = step.tests.map((id) => guide.tests[id]!);
    return {
      ...step,
      id: idOf.get(key)!,
      checks: step.checks.length > 0 ? step.checks : deterministicChecks(step.units.map((id) => guide.units[id]!), tests, step.ordering),
      gaps: stepGaps(step, tests),
    };
  });

  const verifies = new Map<string, string>();
  for (const entry of Array.isArray(raw.tests) ? raw.tests : []) {
    if (!isObject(entry) || typeof entry.id !== "string" || !testRoots.has(entry.id)) continue;
    const sentence = text(entry.verifies, LIMITS.verifies);
    if (sentence != null) verifies.set(entry.id, sentence);
  }
  const tests: Record<string, TestProfile> = Object.fromEntries(Object.entries(guide.tests).map(([id, profile]) => [
    id,
    verifies.has(id) ? { ...profile, verifies: verifies.get(id)! } : profile,
  ]));

  const claimSteps = new Map<string, string[]>();
  const emptyAnswers = new Set<string>();
  for (const entry of Array.isArray(raw.claims) ? raw.claims : []) {
    if (!isObject(entry) || typeof entry.id !== "string" || !Array.isArray(entry.steps)) continue;
    const ids = entry.steps
      .filter((value): value is number => Number.isSafeInteger(value))
      .map((value) => idOf.get(modelKeys[value - 1] ?? ""))
      .filter((id): id is string => id != null);
    claimSteps.set(entry.id, [...new Set(ids)]);
    if (entry.steps.length === 0) emptyAnswers.add(entry.id);
  }
  const stepOfUnit = new Map(finalSteps.flatMap((step) => step.units.map((id) => [id, step.id] as const)));
  const claims = guide.claims.map((claim) => {
    const hostSteps = [...new Set(claim.units.map((id) => stepOfUnit.get(id)).filter((id): id is string => id != null))];
    const modelSteps = claimSteps.get(claim.id) ?? [];
    const steps = modelSteps.length > 0 ? modelSteps : hostSteps;
    return { ...claim, steps, ...(steps.length === 0 && emptyAnswers.has(claim.id) ? { unmatched: true as const } : {}) };
  });

  const summary = text(raw.summary, LIMITS.summary);
  return {
    ...guide,
    ...(summary == null ? {} : { summary }),
    steps: finalSteps,
    minimized: guide.minimized.filter((id) => !usedUnits.has(guide.units[id]!.root ?? id)),
    tests,
    claims,
    refinement: { status: "applied", ...(model == null ? {} : { model }), ...(warnings.length === 0 ? {} : { warnings }) },
  };
}

export async function readGuidelineInstructions(): Promise<string> {
  return readFile(new URL("../../prompts/formal-validation.md", import.meta.url), "utf8");
}

/** One model request over the prepared guide. A failed or invalid answer keeps the host-only guide. */
export async function refineGuide(
  prepared: PreparedGuide,
  description: string,
  generate: DiffStoryGenerate,
  signal: AbortSignal,
  model?: string,
): Promise<FormalValidationGuide> {
  signal.throwIfAborted();
  const system = await readGuidelineInstructions();
  try {
    const output = await generate(system, buildRefinementPrompt(prepared, description), signal);
    signal.throwIfAborted();
    return applyRefinement(prepared, output, model);
  } catch (error) {
    if (signal.aborted) throw error;
    return {
      ...prepared.guide,
      refinement: { status: "failed", ...(model == null ? {} : { model }), message: error instanceof Error ? error.message : String(error) },
    };
  }
}
