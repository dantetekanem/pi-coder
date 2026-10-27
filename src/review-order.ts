import type { PullRequestHandoff } from "./pr-handoff.js";
import { compareAllFilesForReview } from "./state.js";
import type { ReviewFile, ReviewScope } from "./types.js";
import { joinReviewPath } from "./types.js";

export type NavigatorFileOrder = "risk" | "alphabetical";

export interface ReviewOrderSignals {
  /** Caller-supplied review order, most important first. */
  priorityPaths: string[];
  /** Unresolved, non-outdated review threads per path. */
  unresolvedThreadsByPath: Record<string, number>;
}

export interface ReviewThreadCounts {
  open: number;
  awaitingReply: number;
}

const PRIORITY_STEP = 10000;
const THREAD_WEIGHT = 1000;
const MAX_SCORED_THREADS = 5;
const REFERENCE_WEIGHT = 20;
const MAX_SCORED_REFERENCES = 10;
const SIZE_WEIGHT = 25;
const STATUS_WEIGHT = 10;
const TEST_DIRECTORIES = new Set(["test", "tests", "spec", "specs", "__tests__"]);
const SOURCE_DIRECTORIES = new Set(["app", "lib", "src"]);
const TEST_NAME_SUFFIX = /(?:[._](?:test|spec)|_tests)$/;

export function normalizeOrderPath(path: string): string {
  return path.replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/+$/, "");
}

function scopeComparison(file: ReviewFile, scope: ReviewScope) {
  return scope === "git-diff" ? file.gitDiff : scope === "last-commit" ? file.lastCommit : file.allFiles;
}

export function getReviewFilePathKeys(file: ReviewFile, scope: ReviewScope): string[] {
  const comparison = scopeComparison(file, scope);
  const paths = [file.path, comparison?.displayPath, comparison?.newPath, comparison?.oldPath]
    .filter((path): path is string => path != null && path.length > 0);
  const keys = new Set<string>();
  for (const path of paths) {
    keys.add(normalizeOrderPath(path));
    keys.add(normalizeOrderPath(joinReviewPath(file.pathPrefix, path)));
  }
  return [...keys];
}

function priorityScore(file: ReviewFile, scope: ReviewScope, priorityPaths: string[]): number {
  if (priorityPaths.length === 0) return 0;
  const keys = getReviewFilePathKeys(file, scope);
  const index = priorityPaths.findIndex((path) => keys.includes(path));
  return index === -1 ? 0 : (priorityPaths.length - index) * PRIORITY_STEP;
}

function unresolvedThreadCount(file: ReviewFile, scope: ReviewScope, threadsByPath: Record<string, number>): number {
  let total = 0;
  for (const key of getReviewFilePathKeys(file, scope)) total = Math.max(total, threadsByPath[key] ?? 0);
  return total;
}

function referenceCount(file: ReviewFile): number {
  const incoming = file.allFilesIncomingReferences?.length ?? 0;
  return Math.max(incoming, file.allFilesReferenceCount ?? 0);
}

function churnBucket(file: ReviewFile, scope: ReviewScope): number {
  const comparison = scopeComparison(file, scope);
  const churn = (comparison?.additions ?? 0) + (comparison?.deletions ?? 0);
  if (churn === 0) return 0;
  if (churn < 10) return 1;
  if (churn < 50) return 2;
  if (churn < 200) return 3;
  return 4;
}

function statusScore(file: ReviewFile, scope: ReviewScope): number {
  const status = scopeComparison(file, scope)?.status ?? file.worktreeStatus;
  if (status === "modified" || status === "renamed") return 2;
  if (status === "deleted") return 1;
  return 0;
}

/**
 * Higher scores are reviewed first, in strict tiers: caller priority (>= 10000) beats
 * unresolved threads (<= 5000), which beat blast radius, change size, and status
 * (<= 320 combined). The tiers never overlap, so each signal is explainable on its own.
 */
export function getReviewFileRiskScore(file: ReviewFile, scope: ReviewScope, signals?: ReviewOrderSignals): number {
  const priority = priorityScore(file, scope, signals?.priorityPaths ?? []);
  const threads = Math.min(unresolvedThreadCount(file, scope, signals?.unresolvedThreadsByPath ?? {}), MAX_SCORED_THREADS) * THREAD_WEIGHT;
  const references = Math.min(referenceCount(file), MAX_SCORED_REFERENCES) * REFERENCE_WEIGHT;
  return priority + threads + references + churnBucket(file, scope) * SIZE_WEIGHT + statusScore(file, scope) * STATUS_WEIGHT;
}

export function compareReviewFilesByRisk(scope: ReviewScope, signals?: ReviewOrderSignals): (left: ReviewFile, right: ReviewFile) => number {
  return (left, right) => {
    const delta = getReviewFileRiskScore(right, scope, signals) - getReviewFileRiskScore(left, scope, signals);
    if (delta !== 0) return delta;
    if (scope === "all-files") return compareAllFilesForReview(left, right);
    return left.path.localeCompare(right.path);
  };
}

export interface NavigatorOrderOptions {
  mode: NavigatorFileOrder;
  scope: ReviewScope;
  treeMode: boolean;
  groupOf: (file: ReviewFile) => string;
  signals?: ReviewOrderSignals;
}

function testSubjectName(name: string): string | null {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const subject = stem.replace(TEST_NAME_SUFFIX, "");
  return subject.length === 0 || subject === stem ? null : `${subject}${name.slice(stem.length)}`;
}

function testPairingKey(pathPrefix: string | undefined, directories: string[], name: string): string {
  const kept = directories.filter((directory) => !TEST_DIRECTORIES.has(directory) && !SOURCE_DIRECTORIES.has(directory));
  return `${pathPrefix ?? ""}\u0000${[...kept, name].join("/")}`;
}

/**
 * Maps each changed test file to the changed file it tests, when their paths match after dropping
 * test and source root folders: `test/models/user_test.rb` tests `app/models/user.rb`, and
 * `src/ui/button.test.tsx` tests `src/ui/button.tsx`.
 */
export function pairTestFiles(files: ReviewFile[]): Map<string, ReviewFile> {
  const implementations = new Map<string, ReviewFile>();
  const subjects: Array<{ test: ReviewFile; key: string }> = [];
  const byPath = [...files].sort((left, right) => joinReviewPath(left.pathPrefix, left.path).localeCompare(joinReviewPath(right.pathPrefix, right.path)));
  for (const file of byPath) {
    const directories = file.path.split("/").filter((part) => part.length > 0);
    const name = directories.pop() ?? file.path;
    const key = testPairingKey(file.pathPrefix, directories, name);
    if (!implementations.has(key)) implementations.set(key, file);
    const subject = testSubjectName(name);
    if (subject != null) subjects.push({ test: file, key: testPairingKey(file.pathPrefix, directories, subject) });
  }

  const pairs = new Map<string, ReviewFile>();
  for (const { test, key } of subjects) {
    const implementation = implementations.get(key);
    if (implementation != null && implementation.id !== test.id) pairs.set(test.id, implementation);
  }
  for (const [testId, implementation] of pairs) {
    if (pairs.has(implementation.id)) pairs.delete(testId);
  }
  return pairs;
}

function placeTestsAfterImplementations(files: ReviewFile[], implementations: Map<string, ReviewFile>): ReviewFile[] {
  const testsByImplementation = new Map<string, ReviewFile[]>();
  for (const file of files) {
    const implementation = implementations.get(file.id);
    if (implementation != null) testsByImplementation.set(implementation.id, [...testsByImplementation.get(implementation.id) ?? [], file]);
  }

  const placed = new Set<string>();
  return files.flatMap((file) => {
    const implementation = implementations.get(file.id) ?? file;
    if (placed.has(implementation.id)) return [];
    placed.add(implementation.id);
    return [implementation, ...testsByImplementation.get(implementation.id) ?? []];
  });
}

/** A paired test sits right after the file it tests, in that file's group, wherever either would rank first. */
export function orderNavigatorFiles(files: ReviewFile[], options: NavigatorOrderOptions): ReviewFile[] {
  const implementations = pairTestFiles(files);
  const groupOf = (file: ReviewFile) => options.groupOf(implementations.get(file.id) ?? file);
  const compareFiles = options.mode === "alphabetical"
    ? (left: ReviewFile, right: ReviewFile) => left.path.localeCompare(right.path)
    : compareReviewFilesByRisk(options.scope, options.signals);

  if (!options.treeMode) return placeTestsAfterImplementations([...files].sort(compareFiles), implementations);

  const groupRank = new Map<string, number>();
  if (options.mode === "risk") {
    for (const file of files) {
      const group = groupOf(file);
      const score = getReviewFileRiskScore(file, options.scope, options.signals);
      groupRank.set(group, Math.max(groupRank.get(group) ?? Number.NEGATIVE_INFINITY, score));
    }
  }

  return placeTestsAfterImplementations([...files].sort((left, right) => {
    const leftGroup = groupOf(left);
    const rightGroup = groupOf(right);
    if (leftGroup !== rightGroup) {
      const rankDelta = (groupRank.get(rightGroup) ?? 0) - (groupRank.get(leftGroup) ?? 0);
      if (rankDelta !== 0) return rankDelta;
      return leftGroup.localeCompare(rightGroup);
    }
    return compareFiles(left, right);
  }), implementations);
}

export function buildReviewOrderSignals(handoff: PullRequestHandoff | undefined): ReviewOrderSignals | undefined {
  if (handoff == null) return undefined;

  const priorityPaths = (handoff.filePriority ?? []).map((entry) => normalizeOrderPath(entry.path)).filter((path) => path.length > 0);
  const unresolvedThreadsByPath: Record<string, number> = {};
  for (const thread of handoff.threads ?? []) {
    if (thread.path == null || thread.resolved === true || thread.outdated === true) continue;
    const key = normalizeOrderPath(thread.path);
    if (key.length === 0) continue;
    unresolvedThreadsByPath[key] = (unresolvedThreadsByPath[key] ?? 0) + 1;
  }

  if (priorityPaths.length === 0 && Object.keys(unresolvedThreadsByPath).length === 0) return undefined;
  return { priorityPaths, unresolvedThreadsByPath };
}

export function countHandoffThreads(handoff: PullRequestHandoff | undefined): ReviewThreadCounts | undefined {
  if (handoff?.threads == null) return undefined;

  let open = 0;
  let awaitingReply = 0;
  for (const thread of handoff.threads) {
    if (thread.resolved === true || thread.outdated === true) continue;
    open += 1;
    const last = thread.comments[thread.comments.length - 1];
    if (last != null && last.author === handoff.authorLogin) awaitingReply += 1;
  }
  return { open, awaitingReply };
}
