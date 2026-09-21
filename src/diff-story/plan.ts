import { createHash } from "node:crypto";
import { buildStructuredDiff } from "../diff.js";
import type { ReviewFileContents, ReviewScope } from "../types.js";
import { hashTargetSlice } from "../workbench/target.js";
import { prepareStoryUnits } from "./units.js";

export type StorySide = "added" | "deleted";

export interface StoryFile {
  fileId: string;
  path: string;
  scope: ReviewScope;
  contents: ReviewFileContents;
  /** Logical endpoint presence. Required when an unavailable side would otherwise be ambiguous. */
  hasOriginal?: boolean;
  /** Logical endpoint presence. Required when an unavailable side would otherwise be ambiguous. */
  hasModified?: boolean;
}

export interface StorySnapshotFile extends StoryFile {
  hasOriginal: boolean;
  hasModified: boolean;
}

export interface StoryChangeRange {
  fileId: string;
  path: string;
  side: StorySide;
  startLine: number;
  endLine: number;
}

export interface StorySnapshot {
  fingerprint: string;
  files: readonly StorySnapshotFile[];
  additions: number;
  deletions: number;
  changes: readonly StoryChangeRange[];
}

export interface StoryAnchor {
  /** Both endpoints of one locally extracted unit share its navigation identity. */
  unitId?: string;
  fileId: string;
  side: StorySide;
  startLine: number;
  endLine: number;
  hash: string;
}

export interface StoryStep {
  id: string;
  title: string;
  explanation: string;
  implementation: StoryAnchor[];
  tests: StoryAnchor[];
}

export interface DiffStory {
  version: 1;
  snapshot: string;
  summary: string;
  steps: StoryStep[];
}

interface RawAnchor {
  unitId?: unknown;
  fileId?: unknown;
  side?: unknown;
  startLine?: unknown;
  endLine?: unknown;
  hash?: unknown;
}

function fail(message: string): never {
  throw new Error(`Invalid diff story: ${message}`);
}

function digest(value: string): string {
  return createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex");
}

function isScope(value: unknown): value is ReviewScope {
  return value === "git-diff" || value === "last-commit" || value === "all-files";
}

function isSafePath(path: string): boolean {
  return path.length > 0
    && !path.startsWith("/")
    && !path.includes("\\")
    && path.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function hasUnsafeControl(value: string): boolean {
  return /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") fail(`${label} must be a string.`);
  if (hasUnsafeControl(value)) fail(`${label} contains a control character.`);
  return value;
}

function requireIdentifier(value: unknown, label: string): string {
  const identifier = requireString(value, label);
  if (identifier.length === 0) fail(`${label} must not be empty.`);
  return identifier;
}

function requireLine(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail(`${label} must be a positive integer.`);
  return value as number;
}

function sideText(file: StorySnapshotFile, side: StorySide): string {
  return side === "added" ? file.contents.modifiedContent : file.contents.originalContent;
}

function endpointAvailable(file: StorySnapshotFile, side: StorySide): boolean {
  return side === "added" ? file.hasModified && file.contents.modifiedAvailable !== false : file.hasOriginal && file.contents.originalAvailable !== false;
}

function endpointPresent(file: StoryFile, side: "original" | "modified"): boolean {
  const hasEndpoint = side === "original" ? file.hasOriginal : file.hasModified;
  const available = side === "original" ? file.contents.originalAvailable : file.contents.modifiedAvailable;
  if (hasEndpoint == null && available === false) {
    fail(`${file.path} has an unavailable ${side} side without logical endpoint metadata.`);
  }
  return hasEndpoint ?? true;
}

function normalizedFile(file: StoryFile): StorySnapshotFile {
  if (typeof file !== "object" || file == null) fail("files must contain objects.");
  const fileId = requireIdentifier(file.fileId, "fileId");
  const path = requireString(file.path, "path");
  if (!isSafePath(path)) fail(`path ${JSON.stringify(path)} must be repository-relative.`);
  if (!isScope(file.scope)) fail("scope is unsupported.");
  if (typeof file.contents !== "object" || file.contents == null) fail(`${path} must include contents.`);
  const originalContent = requireString(file.contents.originalContent, `${path} original content`);
  const modifiedContent = requireString(file.contents.modifiedContent, `${path} modified content`);
  const hasOriginal = endpointPresent(file, "original");
  const hasModified = endpointPresent(file, "modified");
  const originalAvailable = file.contents.originalAvailable !== false;
  const modifiedAvailable = file.contents.modifiedAvailable !== false;

  if (!hasOriginal && originalContent.length > 0) fail(`${path} has original bytes but no original endpoint.`);
  if (!hasModified && modifiedContent.length > 0) fail(`${path} has modified bytes but no modified endpoint.`);
  if (hasOriginal && !originalAvailable) fail(`${path} original side is unreadable.`);
  if (hasModified && !modifiedAvailable) fail(`${path} modified side is unreadable.`);

  return Object.freeze({
    fileId,
    path,
    scope: file.scope,
    hasOriginal,
    hasModified,
    contents: Object.freeze({ originalContent, modifiedContent, originalAvailable, modifiedAvailable }),
  });
}

function appendChange(changes: StoryChangeRange[], change: StoryChangeRange): void {
  const previous = changes[changes.length - 1];
  if (previous != null && previous.fileId === change.fileId && previous.side === change.side && previous.endLine + 1 === change.startLine) {
    previous.endLine = change.endLine;
    return;
  }
  changes.push(change);
}

function changedRanges(file: StorySnapshotFile): { additions: number; deletions: number; changes: StoryChangeRange[] } {
  const diff = buildStructuredDiff(file.contents.originalContent, file.contents.modifiedContent, 0);
  const changes: StoryChangeRange[] = [];
  for (const row of diff.rows) {
    if ((row.kind === "delete" || row.kind === "replace") && row.oldLineNumber != null) {
      appendChange(changes, { fileId: file.fileId, path: file.path, side: "deleted", startLine: row.oldLineNumber, endLine: row.oldLineNumber });
    }
    if ((row.kind === "insert" || row.kind === "replace") && row.newLineNumber != null) {
      appendChange(changes, { fileId: file.fileId, path: file.path, side: "added", startLine: row.newLineNumber, endLine: row.newLineNumber });
    }
  }
  return { additions: diff.additions, deletions: diff.deletions, changes };
}

/** Captures complete selected revision bytes before any model call. */
export function createStorySnapshot(files: readonly StoryFile[]): StorySnapshot {
  if (!Array.isArray(files) || files.length === 0) fail("at least one selected file is required.");
  const ids = new Set<string>();
  const normalized = files.map((file) => {
    const result = normalizedFile(file);
    if (ids.has(result.fileId)) fail(`fileId ${JSON.stringify(result.fileId)} is repeated.`);
    ids.add(result.fileId);
    return result;
  });

  let additions = 0;
  let deletions = 0;
  const changes: StoryChangeRange[] = [];
  for (const file of normalized) {
    const changed = changedRanges(file);
    additions += changed.additions;
    deletions += changed.deletions;
    changes.push(...changed.changes);
  }
  const fingerprint = digest(JSON.stringify(normalized.map((file) => ({
    fileId: file.fileId,
    path: file.path,
    scope: file.scope,
    hasOriginal: file.hasOriginal,
    hasModified: file.hasModified,
    originalContent: file.contents.originalContent,
    modifiedContent: file.contents.modifiedContent,
  }))));
  return Object.freeze({
    fingerprint,
    files: Object.freeze(normalized),
    additions,
    deletions,
    changes: Object.freeze(changes.map((change) => Object.freeze(change))),
  });
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) fail(`${label} must be an array.`);
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) fail(`${label} must not be sparse.`);
  }
  return value;
}

function validateAnchor(raw: unknown, snapshot: StorySnapshot, label: string, requireHash: boolean): StoryAnchor {
  if (typeof raw !== "object" || raw == null) fail(`${label} must be an object.`);
  const candidate = raw as RawAnchor;
  const fileId = requireIdentifier(candidate.fileId, `${label}.fileId`);
  const side = candidate.side;
  if (side !== "added" && side !== "deleted") fail(`${label}.side must be added or deleted.`);
  const startLine = requireLine(candidate.startLine, `${label}.startLine`);
  const endLine = requireLine(candidate.endLine, `${label}.endLine`);
  if (endLine < startLine) fail(`${label} must use an ordered line range.`);
  const file = snapshot.files.find((entry) => entry.fileId === fileId);
  if (file == null) fail(`${label} references an unknown fileId.`);
  if (!endpointAvailable(file, side)) fail(`${label} references an unavailable ${side} endpoint.`);
  const text = sideText(file, side);
  const lineCount = text.length === 0 ? 0 : text.split(/\r\n|\r|\n/).length - (/\r?\n$/.test(text) ? 1 : 0);
  if (endLine > lineCount) fail(`${label} is outside the captured ${side} bytes.`);

  const trustedHash = hashTargetSlice(sideText(file, side), { startLine, endLine }).value;
  if (candidate.hash === undefined) {
    if (requireHash) fail(`${label}.hash is required for a saved story.`);
  } else if (typeof candidate.hash !== "string" || !/^[0-9a-f]{64}$/.test(candidate.hash)) {
    fail(`${label}.hash must be a lowercase SHA-256 hash.`);
  } else if (candidate.hash !== trustedHash) {
    fail(`${label}.hash does not match captured bytes.`);
  }
  const unitId = candidate.unitId == null ? undefined : requireIdentifier(candidate.unitId, `${label}.unitId`);
  return Object.freeze({ fileId, side, startLine, endLine, hash: trustedHash, ...(unitId == null ? {} : { unitId }) });
}

function validateStory(value: unknown, snapshot: StorySnapshot, requireHashes: boolean): DiffStory {
  if (typeof value !== "object" || value == null || Array.isArray(value)) fail("story must be an object.");
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1) fail("version must be 1.");
  if (raw.snapshot !== snapshot.fingerprint) fail("snapshot does not match captured bytes.");
  const summary = requireString(raw.summary, "summary");
  const rawSteps = requireArray(raw.steps, "steps");
  if (rawSteps.length === 0) fail("at least one code step is required.");
  const ids = new Set<string>();
  const steps: StoryStep[] = rawSteps.map((rawStep, stepIndex) => {
    if (typeof rawStep !== "object" || rawStep == null || Array.isArray(rawStep)) fail(`steps[${stepIndex}] must be an object.`);
    const step = rawStep as Record<string, unknown>;
    const id = requireIdentifier(step.id, `steps[${stepIndex}].id`);
    if (ids.has(id)) fail("step IDs must be unique.");
    ids.add(id);
    const title = requireString(step.title, `steps[${stepIndex}].title`);
    if (title.length === 0) fail(`steps[${stepIndex}].title must not be empty.`);
    const explanation = requireString(step.explanation, `steps[${stepIndex}].explanation`);
    const implementation = requireArray(step.implementation, `steps[${stepIndex}].implementation`)
      .map((anchor, anchorIndex) => validateAnchor(anchor, snapshot, `steps[${stepIndex}].implementation[${anchorIndex}]`, requireHashes));
    const tests = requireArray(step.tests, `steps[${stepIndex}].tests`)
      .map((anchor, anchorIndex) => validateAnchor(anchor, snapshot, `steps[${stepIndex}].tests[${anchorIndex}]`, requireHashes));
    return { id, title, explanation, implementation, tests };
  });
  return { version: 1, snapshot: snapshot.fingerprint, summary, steps };
}

/** Accepts model anchors without hashes and derives hashes from the trusted snapshot. */
export function validateDiffStory(value: unknown, snapshot: StorySnapshot): DiffStory {
  return validateStory(value, snapshot, false);
}

/** Validates persisted anchors without silently remapping them to new captured bytes. */
export function validateSavedDiffStory(value: unknown, snapshot: StorySnapshot): DiffStory {
  return validateStory(value, snapshot, true);
}

/** Completes legacy partial plans while giving each changed test one review location. */
export function completeDiffStory(story: DiffStory, snapshot: StorySnapshot): DiffStory {
  const units = prepareStoryUnits(snapshot);
  const testUnits = units.filter((unit) => unit.test && !unit.symbol.startsWith("lines "));
  const overlaps = (a: Omit<StoryAnchor, "hash">, b: Omit<StoryAnchor, "hash">) => a.fileId === b.fileId
    && a.side === b.side && a.startLine <= b.endLine && b.startLine <= a.endLine;
  const paired = new Set<string>();
  const steps = story.steps.map((step) => ({
    ...step,
    tests: step.tests.flatMap((anchor) => {
      const matching = testUnits.filter((unit) => unit.anchors.some((range) => overlaps(range, anchor)));
      if (matching.length === 0) return [anchor];
      return matching.flatMap((unit) => {
        if (paired.has(unit.id)) return [];
        paired.add(unit.id);
        return unit.anchors.map((range) => validateAnchor(range, snapshot, "paired test", false));
      });
    }),
  })).map((step) => ({
    ...step,
    implementation: step.implementation.filter((anchor) => !testUnits.some((unit) =>
      paired.has(unit.id) && unit.anchors.some((range) => overlaps(range, anchor)))),
  })).filter((step) => step.implementation.length > 0 || step.tests.length > 0);
  const uncovered = uncoveredStoryChanges({ ...story, steps }, snapshot);
  const ids = new Set(steps.map((step) => step.id));
  for (const unit of units) {
    const implementation = unit.anchors.flatMap((anchor) => uncovered.filter((change) => overlaps(anchor, change))
      .map((change) => validateAnchor({
        ...anchor, startLine: Math.max(anchor.startLine, change.startLine), endLine: Math.min(anchor.endLine, change.endLine),
      }, snapshot, "remaining change", false)));
    if (implementation.length === 0) continue;
    let id = `captured-unit:${unit.id}`;
    while (ids.has(id)) id += ":remaining";
    ids.add(id);
    steps.push({ id, title: `${unit.path} · ${unit.symbol}`, explanation: "", implementation, tests: [] });
  }
  return { ...story, steps };
}

/** Returns changed lines that no source or test anchor narrates. It does not infer test status or coverage. */
export function uncoveredStoryChanges(story: DiffStory, snapshot: StorySnapshot): StoryChangeRange[] {
  if (story.snapshot !== snapshot.fingerprint) fail("story snapshot does not match captured bytes.");
  const anchors = story.steps.flatMap((step) => [...step.implementation, ...step.tests]);
  const uncovered: StoryChangeRange[] = [];
  for (const change of snapshot.changes) {
    const coveredLines = new Set<number>();
    for (const anchor of anchors) {
      if (anchor.fileId !== change.fileId || anchor.side !== change.side) continue;
      const start = Math.max(change.startLine, anchor.startLine);
      const end = Math.min(change.endLine, anchor.endLine);
      for (let line = start; line <= end; line += 1) coveredLines.add(line);
    }
    let startLine: number | undefined;
    for (let line = change.startLine; line <= change.endLine; line += 1) {
      if (!coveredLines.has(line)) {
        startLine ??= line;
        continue;
      }
      if (startLine != null) {
        uncovered.push({ ...change, startLine, endLine: line - 1 });
        startLine = undefined;
      }
    }
    if (startLine != null) uncovered.push({ ...change, startLine, endLine: change.endLine });
  }
  return uncovered;
}
