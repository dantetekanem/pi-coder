import type { StorySnapshot } from "../diff-story/plan.js";
import { attachUnpairedTests, pairStoryTests, prepareStoryUnits, type StoryUnit } from "../diff-story/units.js";
import type { ReviewScope } from "../types.js";
import { unitFamilies, type UnitFamilies } from "./families.js";
import { classifyUnitRisk, comparePriority, higherPriority, MINOR_REASONS, type RiskCategory, type UnitRisk, type ValidationPriority } from "./priority.js";
import { fileStem, identifierWords, identifiers, singleLine, SnapshotIndex, type UnitAnchor } from "./source.js";
import { changedCodeIndex, profileTest, sharedSetupDoubles, type TestDouble, type TestProfile } from "./tests.js";

export interface GuidePullRequest {
  number: string;
  repo?: string;
  url?: string;
  title: string;
  author: string;
  state: string;
  headRefOid: string;
  baseRefName: string;
}

export interface GuideTarget {
  kind: "working" | "range" | "remote";
  label: string;
  repoRoot: string;
  scope: ReviewScope;
  base?: string;
  head?: string;
  pullRequest?: GuidePullRequest;
}

export interface GuideUnit {
  id: string;
  path: string;
  symbol: string;
  test: boolean;
  status: "added" | "modified" | "removed";
  additions: number;
  deletions: number;
  anchors: UnitAnchor[];
  /** The enclosing declaration when this unit is nested inside another changed unit. */
  root?: string;
  /** A declaration too long to read as one behavior, such as an extension factory. */
  container?: true;
  risk?: UnitRisk;
}

export interface GuideStep {
  id: string;
  title: string;
  priority: ValidationPriority;
  reasons: string[];
  ordering: boolean;
  /** One sentence of what must hold after this step's change; written by the guideline model. */
  property?: string;
  checks: string[];
  units: string[];
  tests: string[];
  gaps: string[];
}

export interface DescriptionClaim {
  id: string;
  text: string;
  units: string[];
  steps: string[];
}

export interface GuideRefinement {
  status: "applied" | "skipped" | "failed";
  model?: string;
  message?: string;
  warnings?: string[];
}

export interface FormalValidationGuide {
  version: 1;
  /** Fingerprint of the captured bytes; the same capture in /diff-story has the same value. */
  snapshot: string;
  createdAt: string;
  target: GuideTarget;
  stats: {
    files: number;
    additions: number;
    deletions: number;
    units: number;
    tests: number;
    hiddenLocales: number;
    skipped: Array<{ path: string; reason: string }>;
  };
  summary?: string;
  steps: GuideStep[];
  /** Mechanical implementation units outside every step: docs, lockfiles, comment, import and whitespace edits. */
  minimized: string[];
  units: Record<string, GuideUnit>;
  tests: Record<string, TestProfile>;
  claims: DescriptionClaim[];
  /** Verification steps the author listed under a testing heading. */
  authorChecks: string[];
  gaps: string[];
  refinement: GuideRefinement;
}

export interface GuideInput {
  snapshot: StorySnapshot;
  target: GuideTarget;
  description?: string;
  hiddenLocales?: number;
  skipped?: Array<{ path: string; reason: string }>;
  now?: Date;
}

/** The guide plus the prepared units the refinement pass reads. */
export interface PreparedGuide {
  guide: FormalValidationGuide;
  units: StoryUnit[];
  index: SnapshotIndex;
  pairs: Map<string, string>;
  families: UnitFamilies;
}

const MAX_UNITS_PER_STEP = 8;

const CATEGORY_CHECKS: Partial<Record<RiskCategory, readonly string[]>> = {
  ordering: [
    "List what can run this at the same time: two requests, a retry of the same job, a job and a user.",
    "For each read followed by a write, ask whether another actor can write in between; check what a retry or a crash between two writes leaves behind.",
  ],
  migration: [
    "Run it up and down on a copy of real data; confirm it reverses or is meant not to.",
    "Check lock time on the biggest table it touches, and code that reads rows before any backfill finishes.",
  ],
  security: [
    "Confirm the check runs on the server for every caller, not only in the UI.",
    "Try the denied case: a caller without access is refused, and secrets never reach logs, errors or responses.",
  ],
  money: [
    "Work out one expected amount by hand and compare it with what the code and the test produce.",
    "Check rounding, currency, zero and negative amounts, and that a retry cannot charge or refund twice.",
  ],
  destructive: [
    "Confirm the delete or bulk write reaches only the intended records (owner, shop, tenant).",
    "Check whether skipped callbacks or validations are intended.",
  ],
  escaping: ["Check every place this value reaches a terminal, page or log still escapes it."],
  contract: ["Check existing callers still work: removed or renamed fields, new required arguments, changed defaults."],
  flag: ["Check the behavior with the flag off as well as on."],
  dependency: ["Check each new or upgraded package: why it is needed, its license, and any install scripts."],
  instructions: ["Read the instructions as the model will, and name the output that changes."],
};

const CHECK_ORDER: readonly RiskCategory[] = ["migration", "security", "money", "destructive", "escaping", "contract", "flag", "dependency", "instructions"];

const DEFAULT_CHECKS = [
  "Read the change against the description: it does what the description says, and nothing else.",
  "Check empty, missing and error inputs.",
];

const TEST_STEP_CHECKS = [
  "Confirm each changed test still checks the behavior its name promises.",
  "Look for removed assertions or cases: name what stopped being verified.",
];

const TEMPLATE_SECTION = /^(?:checklist|screenshots?|demo|videos?|related|links?|references?|reviewers?|notes? for reviewers|deploy(?:ment)?|rollback|ci|has this been approved)\b/i;
const TESTING_SECTION = /^(?:how\b.*\b(?:test|tested|testing|verify|verified|tophat)|testing|tests|test plan|tophat(?:ting)?|verification|qa|manual test(?:ing)?)\b/i;

function quote(text: string): string {
  return `"${singleLine(text, 80)}"`;
}

function unique<T>(values: Iterable<T>): T[] {
  return [...new Set(values)];
}

/** Splits a PR description into claims and the author's own verification steps. */
export function readDescription(body: string): { claims: string[]; checks: string[] } {
  const text = body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ");
  const claims: string[] = [];
  const checks: string[] = [];
  let section: "claims" | "testing" | "skip" = "claims";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const heading = /^#{1,6}\s+(.*)$/.exec(line) ?? /^\*\*([^*]+)\*\*:?$/.exec(line);
    if (heading != null) {
      const title = heading[1]!.trim();
      section = TESTING_SECTION.test(title) ? "testing" : TEMPLATE_SECTION.test(title) ? "skip" : "claims";
      continue;
    }
    if (section === "skip") continue;
    const bullet = /^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(line);
    const items = bullet != null ? [bullet[1]!] : line.split(/(?<=[.!?])\s+(?=[A-Z`])/);
    for (const item of items) {
      const clean = singleLine(item.replace(/\*\*|__/g, ""), 240);
      if (clean.length < 12 || /^(?:n\/a|none|todo|tbd)\.?$/i.test(clean) || /^https?:\/\/\S+$/.test(clean)) continue;
      (section === "testing" ? checks : claims).push(clean);
    }
  }
  return { claims: unique(claims).slice(0, 15), checks: unique(checks).slice(0, 10) };
}

function singular(word: string): string {
  return word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word;
}

/** Links a claim to implementation units it names by symbol, path, file stem or every word of a compound symbol. */
export function linkClaim(text: string, units: readonly GuideUnit[]): string[] {
  const tokens = new Set<string>();
  for (const match of text.matchAll(/`([^`]+)`/g)) tokens.add(match[1]!.trim());
  for (const match of text.matchAll(/[A-Za-z_]\w*(?:(?:::|#|\.)[A-Za-z_][\w!?]*)+[!?]?|\b[a-z]\w*_\w+[!?]?|\b[a-z]+[A-Z]\w*/g)) tokens.add(match[0]);
  const words = new Set(identifierWords(text).map(singular));
  return units.filter((unit) => {
    if (unit.test) return false;
    const symbol = unit.symbol.replace(/[!?=]$/, "");
    const stem = fileStem(unit.path);
    for (const token of tokens) {
      const bare = token.replace(/\(\)$/, "").replace(/[!?=]$/, "");
      const last = bare.split(/::|#|\./).at(-1);
      if (bare === symbol || last === symbol || bare === stem || token === unit.path || unit.path.endsWith(`/${token}`)) return true;
    }
    if (unit.symbol.startsWith("lines ")) return false;
    const symbolWords = identifierWords(symbol).map(singular);
    return symbolWords.length >= 2 && symbolWords.every((word) => words.has(word));
  }).map((unit) => unit.id);
}

/** A container reads better by the lines that changed inside it than by its name alone. */
export function unitLabel(unit: GuideUnit): string {
  if (unit.container !== true) return unit.symbol;
  const lines = unit.anchors.filter((anchor) => anchor.side === (unit.status === "removed" ? "deleted" : "added"));
  if (lines.length === 0) return unit.symbol;
  return `${unit.symbol} lines ${Math.min(...lines.map((anchor) => anchor.startLine))}–${Math.max(...lines.map((anchor) => anchor.endLine))}`;
}

function unitTitle(units: readonly GuideUnit[]): string {
  const path = units[0]!.path;
  const symbols = units.map(unitLabel);
  const shown = symbols.slice(0, 3).join(", ");
  return `${path} · ${shown}${symbols.length > 3 ? ` and ${symbols.length - 3} more` : ""}`;
}

export function deterministicChecks(units: readonly GuideUnit[], tests: readonly TestProfile[], ordering: boolean): string[] {
  if (units.length === 0) return [...TEST_STEP_CHECKS];
  const categories = new Set(units.flatMap((unit) => unit.risk?.categories ?? []));
  const checks: string[] = [];
  if (ordering) checks.push(...CATEGORY_CHECKS.ordering!);
  for (const category of CHECK_ORDER) if (categories.has(category)) checks.push(...CATEGORY_CHECKS[category]!);
  if (checks.length === 0) checks.push(...DEFAULT_CHECKS);
  const proof = tests.find((test) => test.kind === "test" && test.quality === "strong") ?? tests.find((test) => test.kind === "test" && test.status !== "removed");
  if (proof != null) checks.push(`Read ${quote(proof.name)}: it should fail if this step's change were reverted.`);
  return unique(checks).slice(0, 6);
}

export function stepGaps(step: Pick<GuideStep, "units" | "priority">, tests: readonly TestProfile[]): string[] {
  const active = tests.filter((test) => test.kind === "test" && test.status !== "removed");
  const gaps: string[] = [];
  if (step.units.length > 0 && active.length === 0) gaps.push("No changed test covers this step; look for an existing one or ask for one.");
  if (active.length > 0 && step.priority !== "minor" && !active.some((test) => test.negative)) {
    gaps.push("Changed tests cover only the success path; check the failure, empty or denied path.");
  }
  for (const test of tests) {
    if (test.kind === "test" && test.status === "removed") gaps.push(`Removed test ${quote(test.name)}; confirm the behavior is still covered.`);
  }
  for (const test of active) {
    const weak = test.flags.find((flag) => flag.severity === "weak");
    if (weak != null) gaps.push(`Weak test ${quote(test.name)}: ${weak.message}`);
  }
  return gaps;
}

function orderSteps(steps: readonly GuideStep[], references: ReadonlyMap<string, ReadonlySet<string>>): GuideStep[] {
  const ordered: GuideStep[] = [];
  for (const priority of ["critical", "needed", "minor"] as const) {
    const tier = steps.filter((step) => step.priority === priority);
    const incoming = new Map(tier.map((step) => [step.id, 0]));
    for (const step of tier) {
      for (const target of references.get(step.id) ?? []) if (incoming.has(target)) incoming.set(target, incoming.get(target)! + 1);
    }
    const remaining = [...tier];
    while (remaining.length > 0) {
      // An entry point reads before what it calls; a cycle falls back to source order.
      const ready = remaining.findIndex((step) => incoming.get(step.id) === 0);
      const [next] = remaining.splice(Math.max(0, ready), 1);
      ordered.push(next!);
      for (const target of references.get(next!.id) ?? []) if (incoming.has(target)) incoming.set(target, incoming.get(target)! - 1);
    }
  }
  return ordered;
}

/** Host-only guide: every changed unit ranked, every changed test profiled and placed beside the code it pairs with. */
export function buildGuide(input: GuideInput): PreparedGuide {
  const { snapshot, target } = input;
  const index = new SnapshotIndex(snapshot);
  const units = prepareStoryUnits(snapshot);
  const pairs = pairStoryTests(units);
  attachUnpairedTests(units, pairs);
  const unitById = new Map(units.map((unit) => [unit.id, unit]));

  const families = unitFamilies(units, index);
  const guideUnits: Record<string, GuideUnit> = {};
  for (const unit of units) {
    const change = index.unitChange(unit);
    const sides = new Set(unit.anchors.map((anchor) => anchor.side));
    const root = families.root.get(unit.id)!;
    guideUnits[unit.id] = {
      id: unit.id,
      path: unit.path,
      symbol: unit.symbol,
      test: unit.test,
      status: sides.has("added") && sides.has("deleted") ? "modified" : sides.has("added") ? "added" : "removed",
      additions: change.added.length,
      deletions: change.deleted.length,
      anchors: unit.anchors.map((anchor) => ({ ...anchor })),
      ...(root === unit.id ? {} : { root }),
      ...(families.containers.has(unit.id) ? { container: true as const } : {}),
      ...(unit.test ? {} : { risk: classifyUnitRisk(unit, change.added.map((line) => line.text), change.deleted.map((line) => line.text)) }),
    };
  }
  const roots = [...families.members.keys()].map((id) => guideUnits[id]!);
  const membersOf = (id: string) => families.members.get(id)!.map((member) => guideUnits[member]!);
  const rootOf = (id: string) => families.root.get(id) ?? id;

  const changed = changedCodeIndex(units);
  const setupDoubles = new Map<string, TestDouble[]>();
  const profiles: Record<string, TestProfile> = {};
  const familyPair = new Map<string, string>();
  for (const root of roots) {
    const ids = families.members.get(root.id)!;
    const owner = ids.map((id) => pairs.get(id)).find((id): id is string => id != null);
    if (owner != null) familyPair.set(root.id, rootOf(owner));
    if (!root.test) continue;
    if (!setupDoubles.has(root.path)) {
      const file = snapshot.files.find((entry) => entry.path === root.path);
      setupDoubles.set(root.path, file == null ? [] : sharedSetupDoubles(file.contents.modifiedContent, changed));
    }
    const enclosing = families.enclosing.get(root.id);
    const statuses = new Set(membersOf(root.id).map((member) => member.status));
    const status = enclosing != null || statuses.size !== 1 ? "modified" : [...statuses][0]!;
    const side = enclosing?.side ?? (status === "removed" ? "deleted" : "added");
    const lines = new Map<number, string>();
    if (enclosing != null) {
      const source = index.lines(enclosing.fileId, enclosing.side);
      for (let line = enclosing.startLine; line <= enclosing.endLine; line += 1) lines.set(line, source[line - 1]!);
    }
    for (const id of ids) {
      for (const anchor of unitById.get(id)!.anchors) {
        if (anchor.side !== side) continue;
        for (const line of index.anchorLines(anchor)) lines.set(line.line, line.text);
      }
    }
    profiles[root.id] = profileTest({
      unit: unitById.get(root.id)!,
      ...(families.names.has(root.id) ? { name: families.names.get(root.id)! } : {}),
      members: ids,
      isCase: families.cases.has(root.id),
      lines: [...lines].sort(([a], [b]) => a - b).map(([line, text]) => ({ line, text })),
      status,
      changed,
      ...(owner == null ? {} : { pairedWith: rootOf(owner) }),
      setupDoubles: setupDoubles.get(root.path),
    });
    profiles[root.id]!.targets = unique(profiles[root.id]!.targets.map(rootOf));
  }

  const familyRisk = new Map<string, UnitRisk>();
  const pairedOwners = new Set(familyPair.values());
  for (const root of roots) {
    if (root.test) continue;
    const risks = membersOf(root.id).map((member) => member.risk!);
    let priority = risks.reduce<ValidationPriority>((best, risk) => higherPriority(best, risk.priority), "minor");
    const reasons = unique(risks.flatMap((risk) => risk.reasons));
    if (priority === "minor" && pairedOwners.has(root.id)) {
      priority = "needed";
      reasons.push("has changed tests");
    }
    const risk: UnitRisk = {
      priority,
      categories: unique(risks.flatMap((entry) => entry.categories)),
      reasons: priority === "minor" ? reasons : reasons.filter((reason) => !MINOR_REASONS.has(reason)),
      ordering: risks.some((entry) => entry.ordering),
    };
    familyRisk.set(root.id, risk);
    root.risk = risk;
  }

  const implementation = Object.values(guideUnits).filter((unit) => !unit.test);
  const implementationRoots = roots.filter((root) => !root.test);
  const minimized = implementationRoots.filter((root) => familyRisk.get(root.id)!.priority === "minor").flatMap((root) => families.members.get(root.id)!);
  const groups = new Map<string, GuideUnit[]>();
  for (const root of implementationRoots) {
    const risk = familyRisk.get(root.id)!;
    if (risk.priority === "minor") continue;
    const key = `${risk.priority}\u001f${root.path}`;
    groups.set(key, [...groups.get(key) ?? [], root]);
  }
  const draft: GuideStep[] = [];
  const stepOfUnit = new Map<string, string>();
  for (const members of groups.values()) {
    for (let start = 0; start < members.length; start += MAX_UNITS_PER_STEP) {
      const chunk = members.slice(start, start + MAX_UNITS_PER_STEP);
      const id = `draft-${draft.length + 1}`;
      const unitIds = chunk.flatMap((root) => families.members.get(root.id)!);
      for (const unitId of unitIds) stepOfUnit.set(unitId, id);
      const risks = chunk.map((root) => familyRisk.get(root.id)!);
      draft.push({
        id,
        title: unitTitle(chunk),
        priority: risks[0]!.priority,
        reasons: unique(risks.flatMap((risk) => risk.reasons)).slice(0, 4),
        ordering: risks.some((risk) => risk.ordering),
        checks: [],
        units: unitIds,
        tests: [],
        gaps: [],
      });
    }
  }
  const testOnly = new Map<string, GuideStep>();
  for (const unit of roots.filter((root) => root.test)) {
    const owner = familyPair.get(unit.id);
    const step = owner == null ? undefined : draft.find((entry) => entry.id === stepOfUnit.get(owner));
    if (step != null) {
      step.tests.push(unit.id);
      continue;
    }
    let shared = testOnly.get(unit.path);
    if (shared == null) {
      shared = {
        id: `draft-${draft.length + testOnly.size + 1}`,
        title: `${unit.path} · changed tests`,
        priority: "needed",
        reasons: ["tests changed without paired code"],
        ordering: false,
        checks: [],
        units: [],
        tests: [],
        gaps: [],
      };
      testOnly.set(unit.path, shared);
    }
    shared.tests.push(unit.id);
  }
  draft.push(...testOnly.values());

  const references = new Map<string, Set<string>>();
  const symbols = implementation.filter((unit) => !unit.symbol.startsWith("lines "));
  for (const step of draft) {
    const targets = new Set<string>();
    for (const unitId of step.units) {
      const named = identifiers(unitById.get(unitId)!.code);
      for (const other of symbols) {
        const owner = stepOfUnit.get(other.id);
        if (other.id !== unitId && owner != null && owner !== step.id && named.has(other.symbol)) targets.add(owner);
      }
    }
    references.set(step.id, targets);
  }

  const steps = orderSteps(draft, references).map((step, position) => {
    const tests = step.tests.map((id) => profiles[id]!);
    const members = step.units.map((id) => guideUnits[id]!);
    return {
      ...step,
      id: `s${position + 1}`,
      checks: deterministicChecks(members, tests, step.ordering),
      gaps: stepGaps(step, tests),
    };
  });
  const stepByUnit = new Map(steps.flatMap((step) => step.units.map((unit) => [unit, step.id] as const)));

  const description = input.description?.trim() ?? "";
  const read = readDescription(description);
  const claims: DescriptionClaim[] = read.claims.map((text, position) => {
    const linked = linkClaim(text, implementation);
    return { id: `c${position + 1}`, text, units: linked, steps: unique(linked.map((unit) => stepByUnit.get(unit)).filter((id): id is string => id != null)) };
  });

  const gaps: string[] = [];
  if (target.kind === "remote" && target.pullRequest != null && description.length === 0) {
    gaps.push("The PR has no description; the guide infers intent from the code alone.");
  }
  if (claims.length > 0) {
    const claimed = new Set(claims.flatMap((claim) => claim.units));
    const unclaimed = implementationRoots.filter((root) => root.risk?.priority === "critical" && !families.members.get(root.id)!.some((id) => claimed.has(id)));
    for (const unit of unclaimed.slice(0, 5)) gaps.push(`Critical change the description does not mention: ${unit.path} · ${unit.symbol}.`);
  }
  const skipped = input.skipped ?? [];
  if (skipped.length > 0) gaps.push(`${skipped.length} file${skipped.length === 1 ? "" : "s"} could not be read and are not in this guide: ${skipped.slice(0, 5).map((entry) => entry.path).join(", ")}.`);

  const guide: FormalValidationGuide = {
    version: 1,
    snapshot: snapshot.fingerprint,
    createdAt: (input.now ?? new Date()).toISOString(),
    target,
    stats: {
      files: snapshot.files.length,
      additions: snapshot.additions,
      deletions: snapshot.deletions,
      units: implementationRoots.length,
      tests: Object.values(profiles).filter((profile) => profile.kind === "test").length,
      hiddenLocales: input.hiddenLocales ?? 0,
      skipped,
    },
    steps,
    minimized,
    units: guideUnits,
    tests: profiles,
    claims,
    authorChecks: read.checks,
    gaps,
    refinement: { status: "skipped" },
  };
  return { guide, units, index, pairs, families };
}

/** Sorts steps critical first, keeping the given order inside each priority. */
export function sortStepsByPriority<T extends { priority: ValidationPriority }>(steps: readonly T[]): T[] {
  return steps.map((step, position) => ({ step, position }))
    .sort((a, b) => comparePriority(a.step.priority, b.step.priority) || a.position - b.position)
    .map(({ step }) => step);
}
