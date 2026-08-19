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

export function orderNavigatorFiles(files: ReviewFile[], options: NavigatorOrderOptions): ReviewFile[] {
  const compareFiles = options.mode === "alphabetical"
    ? (left: ReviewFile, right: ReviewFile) => left.path.localeCompare(right.path)
    : compareReviewFilesByRisk(options.scope, options.signals);

  if (!options.treeMode) return [...files].sort(compareFiles);

  const groupRank = new Map<string, number>();
  if (options.mode === "risk") {
    for (const file of files) {
      const group = options.groupOf(file);
      const score = getReviewFileRiskScore(file, options.scope, options.signals);
      groupRank.set(group, Math.max(groupRank.get(group) ?? Number.NEGATIVE_INFINITY, score));
    }
  }

  return [...files].sort((left, right) => {
    const leftGroup = options.groupOf(left);
    const rightGroup = options.groupOf(right);
    if (leftGroup !== rightGroup) {
      const rankDelta = (groupRank.get(rightGroup) ?? 0) - (groupRank.get(leftGroup) ?? 0);
      if (rankDelta !== 0) return rankDelta;
      return leftGroup.localeCompare(rightGroup);
    }
    return compareFiles(left, right);
  });
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
