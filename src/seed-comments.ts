import { getScopedFiles, upsertFileComment, upsertLineComment } from "./state.js";
import type { CommentIntent, CommentSide, ReviewFile, ReviewScope, ReviewState } from "./types.js";

export interface SeedReviewComment {
  path: string;
  body: string;
  side?: CommentSide;
  line?: number;
  startLine?: number;
  endLine?: number;
  intent?: CommentIntent;
}

export interface ResolvedSeedComment {
  fileId: string;
  scope: ReviewScope;
  side: CommentSide;
  intent: CommentIntent;
  startLine: number | null;
  endLine: number | null;
  body: string;
}

export interface SeedResolution {
  resolved: ResolvedSeedComment[];
  unresolved: SeedReviewComment[];
}

export interface SeedPartition {
  applicable: ResolvedSeedComment[];
  conflicts: ResolvedSeedComment[];
}

const FALLBACK_VISIBLE_SCOPES: ReviewScope[] = ["git-diff", "last-commit"];

function normalizePath(path: string): string {
  return path.trim().replace(/^\.\//, "");
}

function getScopeComparison(file: ReviewFile, scope: ReviewScope) {
  if (scope === "git-diff") return file.gitDiff;
  if (scope === "last-commit") return file.lastCommit;
  return file.allFiles;
}

function fileMatchesPath(file: ReviewFile, scope: ReviewScope, target: string): boolean {
  const comparison = getScopeComparison(file, scope);
  const candidates = [file.path, comparison?.newPath, comparison?.oldPath, comparison?.displayPath];
  return candidates.some((candidate) => candidate != null && normalizePath(candidate) === target);
}

function findFileScope(files: ReviewFile[], visibleScopes: ReviewScope[], target: string): { fileId: string; scope: ReviewScope } | null {
  for (const scope of visibleScopes) {
    for (const file of getScopedFiles(files, scope)) {
      if (fileMatchesPath(file, scope, target)) return { fileId: file.id, scope };
    }
  }
  return null;
}

export function resolveSeedComments(files: ReviewFile[], visibleScopes: ReviewScope[], comments: SeedReviewComment[]): SeedResolution {
  const scopes = visibleScopes.length > 0 ? visibleScopes : FALLBACK_VISIBLE_SCOPES;
  const resolved: ResolvedSeedComment[] = [];
  const unresolved: SeedReviewComment[] = [];

  for (const comment of comments) {
    const body = comment.body?.trim() ?? "";
    const target = normalizePath(comment.path ?? "");
    const match = target.length === 0 || body.length === 0 ? null : findFileScope(files, scopes, target);
    if (match == null || body.length === 0) {
      unresolved.push(comment);
      continue;
    }

    const intent = comment.intent ?? "comment";
    const side = comment.side ?? "added";
    const startLine = comment.startLine ?? comment.line ?? null;

    if (side === "file" || startLine == null) {
      resolved.push({ fileId: match.fileId, scope: match.scope, side: "file", intent, startLine: null, endLine: null, body });
      continue;
    }

    resolved.push({ fileId: match.fileId, scope: match.scope, side, intent, startLine, endLine: comment.endLine ?? startLine, body });
  }

  return { resolved, unresolved };
}

function rangesOverlap(firstStart: number, firstEnd: number, secondStart: number, secondEnd: number): boolean {
  return firstStart <= secondEnd && secondStart <= firstEnd;
}

function conflictsWithExistingComment(state: ReviewState, seed: ResolvedSeedComment): boolean {
  return state.draft.comments.some((comment) => {
    if (comment.fileId !== seed.fileId || comment.scope !== seed.scope || comment.side !== seed.side) return false;
    if (seed.side === "file" || seed.startLine == null) return comment.side === "file";
    if (comment.startLine == null) return false;
    return rangesOverlap(
      comment.startLine,
      comment.endLine ?? comment.startLine,
      seed.startLine,
      seed.endLine ?? seed.startLine,
    );
  });
}

export function partitionResolvedSeedComments(state: ReviewState, resolved: ResolvedSeedComment[]): SeedPartition {
  const applicable: ResolvedSeedComment[] = [];
  const conflicts: ResolvedSeedComment[] = [];
  for (const seed of resolved) {
    (conflictsWithExistingComment(state, seed) ? conflicts : applicable).push(seed);
  }
  return { applicable, conflicts };
}

export function applyResolvedSeedComments(state: ReviewState, resolved: ResolvedSeedComment[]): ReviewState {
  let next = state;
  for (const comment of resolved) {
    if (comment.side === "file" || comment.startLine == null) {
      next = upsertFileComment(next, comment.fileId, comment.scope, comment.body, comment.intent);
      continue;
    }
    next = upsertLineComment(next, comment.fileId, comment.scope, comment.side, comment.startLine, comment.body, comment.intent, comment.endLine ?? comment.startLine);
  }
  return next;
}
