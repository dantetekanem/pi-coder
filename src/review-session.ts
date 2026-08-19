import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { PersistedDiffViewMode } from "./preferences.js";
import { applyResolvedSeedComments, resolveSeedComments, type SeedReviewComment } from "./seed-comments.js";
import type { DiffReviewComment, ReviewFile, ReviewFileComparison, ReviewScope, ReviewState } from "./types.js";

export const REVIEW_SESSION_VERSION = 2;
export const REVIEW_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const INDEX_FILE_NAME = "index.json";
const NEEDS_ATTENTION_MARKER = /^\[needs attention[^\]\n]*\]\n?/;

export type ReviewSessionKind = "local" | "remote";

export interface ReviewSessionData {
  state: ReviewState;
  diffViewMode: PersistedDiffViewMode;
  navigatorTreeMode: boolean;
  contextLineNavigation: boolean;
  commentsGlobal: boolean;
  showAllLocales?: boolean;
  reviewedFileIds: string[];
  navigatorScroll: number;
  diffScroll: number;
  commentsScroll: number;
}

export interface ReviewSessionMeta {
  kind: ReviewSessionKind;
  label: string;
  url?: string;
  resumeArgs?: string;
  cwd?: string;
}

export interface ReviewSessionContext {
  id?: string;
  revision: string;
  fileSignatures?: Record<string, string>;
  meta?: ReviewSessionMeta;
}

export interface PersistedReviewSession extends ReviewSessionData {
  version: typeof REVIEW_SESSION_VERSION;
  id: string;
  identity: string;
  updatedAt: string;
  revision: string;
  fileSignatures: Record<string, string>;
  meta?: ReviewSessionMeta;
}

export interface ReviewSessionIndexEntry {
  id: string;
  identity: string;
  updatedAt: string;
  revision: string;
  commentCount: number;
  reviewedCount: number;
  kind: ReviewSessionKind;
  label: string;
  url?: string;
  resumeArgs?: string;
  cwd?: string;
}

function getSessionsDir(): string {
  return process.env.PI_CODE_DIFF_SESSIONS_DIR ?? join(getAgentDir(), "cache", "pi-code-diff", "sessions");
}

export function createReviewSessionId(identity: string): string {
  return createHash("sha256").update(identity).digest("hex").slice(0, 20);
}

export function getReviewSessionPathForDiagnostics(id: string): string {
  return join(getSessionsDir(), `${id.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`);
}

function getIndexPath(): string {
  return join(getSessionsDir(), INDEX_FILE_NAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isReviewState(value: unknown): value is ReviewState {
  if (!isRecord(value) || !isRecord(value.draft)) return false;
  return typeof value.activeScope === "string"
    && (typeof value.activeFileId === "string" || value.activeFileId == null)
    && typeof value.searchQuery === "string"
    && typeof value.focus === "string"
    && typeof value.wrapLines === "boolean"
    && typeof value.hideUnchanged === "boolean"
    && typeof value.selectedCommentIndex === "number"
    && isRecord(value.selectedLineTargetByScopeFile)
    && typeof value.draft.allComment === "string"
    && typeof value.draft.allIntent === "string"
    && Array.isArray(value.draft.comments);
}

function normalizeAnchors(state: ReviewState, legacy: boolean): ReviewState {
  return {
    ...state,
    draft: {
      ...state.draft,
      comments: state.draft.comments.map((comment) => {
        if (comment.side === "file") return { ...comment, anchorStatus: "mapped" as const };
        const validHash = comment.captureHash?.algorithm === "sha256" && /^[0-9a-f]{64}$/.test(comment.captureHash.value);
        return {
          ...comment,
          ...(validHash ? { captureHash: comment.captureHash } : {}),
          anchorStatus: !legacy && validHash && comment.anchorStatus === "mapped" ? "mapped" as const : "stale" as const,
        };
      }),
    },
  };
}

function readStringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const map: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") map[key] = entry;
  }
  return map;
}

function readSessionMeta(value: unknown): ReviewSessionMeta | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind !== "local" && value.kind !== "remote") return undefined;
  if (typeof value.label !== "string") return undefined;
  return {
    kind: value.kind,
    label: value.label,
    ...(typeof value.url === "string" ? { url: value.url } : {}),
    ...(typeof value.resumeArgs === "string" ? { resumeArgs: value.resumeArgs } : {}),
    ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
  };
}

/** Version 1 sessions kept the reviewed revision in the identity: `<repo>|<base>|<revision>|<remote>`. */
function readLegacyRevision(identity: string): string {
  const parts = identity.split("|");
  return parts.length >= 4 ? parts[2]! : "unknown";
}

function migrateReviewSession(value: unknown, identity: string): PersistedReviewSession | null {
  if (!isRecord(value) || value.identity !== identity) return null;
  if (value.version !== 1 && value.version !== REVIEW_SESSION_VERSION) return null;
  if (!isReviewState(value.state)) return null;
  if (value.diffViewMode !== "unified" && value.diffViewMode !== "side-by-side") return null;
  if (typeof value.id !== "string" || typeof value.updatedAt !== "string") return null;
  if (typeof value.navigatorTreeMode !== "boolean" || typeof value.contextLineNavigation !== "boolean" || typeof value.commentsGlobal !== "boolean") return null;
  if (value.showAllLocales != null && typeof value.showAllLocales !== "boolean") return null;
  if (!Array.isArray(value.reviewedFileIds) || value.reviewedFileIds.some((item) => typeof item !== "string")) return null;
  if (typeof value.navigatorScroll !== "number" || typeof value.diffScroll !== "number" || typeof value.commentsScroll !== "number") return null;

  const revision = typeof value.revision === "string" && value.revision.length > 0
    ? value.revision
    : readLegacyRevision(identity);
  const meta = readSessionMeta(value.meta);

  return {
    ...(value as unknown as ReviewSessionData),
    state: normalizeAnchors(value.state, value.version === 1),
    version: REVIEW_SESSION_VERSION,
    id: value.id,
    identity,
    updatedAt: value.updatedAt,
    revision,
    fileSignatures: readStringMap(value.fileSignatures),
    ...(meta == null ? {} : { meta }),
  };
}

export function loadReviewSession(identity: string, id = createReviewSessionId(identity)): PersistedReviewSession | null {
  const path = getReviewSessionPathForDiagnostics(id);
  if (!existsSync(path)) return null;
  try {
    return migrateReviewSession(JSON.parse(readFileSync(path, "utf8")) as unknown, identity);
  } catch {
    return null;
  }
}

function writeFileAtomic(path: string, contents: string): void {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, contents, "utf8");
    renameSync(temporaryPath, path);
  } catch (error) {
    try {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    } catch {
      // Preserve the original write failure when cleanup also fails.
    }
    throw error;
  }
}

function readIndexEntries(): ReviewSessionIndexEntry[] {
  try {
    const parsed = JSON.parse(readFileSync(getIndexPath(), "utf8")) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.sessions)) return rebuildIndexEntries();
    const entries = parsed.sessions.filter(isIndexEntry);
    return entries.length === parsed.sessions.length ? entries : rebuildIndexEntries();
  } catch {
    return rebuildIndexEntries();
  }
}

function isIndexEntry(value: unknown): value is ReviewSessionIndexEntry {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.identity === "string"
    && typeof value.updatedAt === "string"
    && typeof value.revision === "string"
    && typeof value.commentCount === "number"
    && typeof value.reviewedCount === "number"
    && (value.kind === "local" || value.kind === "remote")
    && typeof value.label === "string";
}

/** Corruption fallback: reconstruct the index from the session files that are still readable. */
function rebuildIndexEntries(): ReviewSessionIndexEntry[] {
  const directory = getSessionsDir();
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return [];
  }

  const entries: ReviewSessionIndexEntry[] = [];
  for (const name of names) {
    if (!name.endsWith(".json") || name === INDEX_FILE_NAME) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(directory, name), "utf8")) as unknown;
      if (!isRecord(parsed) || typeof parsed.identity !== "string") continue;
      const session = migrateReviewSession(parsed, parsed.identity);
      if (session == null) continue;
      entries.push(toIndexEntry(session));
    } catch {
      continue;
    }
  }
  return sortIndexEntries(entries);
}

function sortIndexEntries(entries: ReviewSessionIndexEntry[]): ReviewSessionIndexEntry[] {
  return [...entries].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function countSessionComments(data: ReviewSessionData): number {
  return data.state.draft.comments.length + (data.state.draft.allComment.trim().length > 0 ? 1 : 0);
}

function toIndexEntry(session: PersistedReviewSession): ReviewSessionIndexEntry {
  const meta = session.meta;
  return {
    id: session.id,
    identity: session.identity,
    updatedAt: session.updatedAt,
    revision: session.revision,
    commentCount: countSessionComments(session),
    reviewedCount: session.reviewedFileIds.length,
    kind: meta?.kind ?? "local",
    label: meta?.label ?? session.identity,
    ...(meta?.url == null ? {} : { url: meta.url }),
    ...(meta?.resumeArgs == null ? {} : { resumeArgs: meta.resumeArgs }),
    ...(meta?.cwd == null ? {} : { cwd: meta.cwd }),
  };
}

function isExpired(entry: ReviewSessionIndexEntry, now: number): boolean {
  const updatedAt = Date.parse(entry.updatedAt);
  return Number.isNaN(updatedAt) || now - updatedAt > REVIEW_SESSION_TTL_MS;
}

function deleteSessionFile(id: string): void {
  const path = getReviewSessionPathForDiagnostics(id);
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    return;
  }
}

function writeIndexEntries(entries: ReviewSessionIndexEntry[]): void {
  try {
    mkdirSync(getSessionsDir(), { recursive: true });
    writeFileAtomic(getIndexPath(), `${JSON.stringify({ version: REVIEW_SESSION_VERSION, sessions: entries }, null, 2)}\n`);
  } catch {
    return;
  }
}

function updateIndex(mutate: (entries: ReviewSessionIndexEntry[]) => ReviewSessionIndexEntry[], now = Date.now()): ReviewSessionIndexEntry[] {
  const current = readIndexEntries();
  const kept: ReviewSessionIndexEntry[] = [];
  for (const entry of current) {
    if (isExpired(entry, now)) {
      deleteSessionFile(entry.id);
      continue;
    }
    kept.push(entry);
  }
  const next = sortIndexEntries(mutate(kept));
  writeIndexEntries(next);
  return next;
}

export function listReviewSessions(): ReviewSessionIndexEntry[] {
  return updateIndex((entries) => entries);
}

export interface ReviewSessionSaveResult {
  id: string;
  saved: boolean;
}

type ReviewSessionSaveContext = ReviewSessionContext | string;

function normalizeSaveContext(context: ReviewSessionSaveContext): ReviewSessionContext {
  return typeof context === "string" ? { id: context, revision: "unknown" } : context;
}

export function saveReviewSessionWithStatus(
  identity: string,
  data: ReviewSessionData,
  context: ReviewSessionSaveContext = { revision: "unknown" },
): ReviewSessionSaveResult {
  const normalizedContext = normalizeSaveContext(context);
  const id = normalizedContext.id ?? createReviewSessionId(identity);
  const session: PersistedReviewSession = {
    ...data,
    state: normalizeAnchors(data.state, false),
    version: REVIEW_SESSION_VERSION,
    id,
    identity,
    updatedAt: new Date().toISOString(),
    revision: normalizedContext.revision,
    fileSignatures: normalizedContext.fileSignatures ?? {},
    ...(normalizedContext.meta == null ? {} : { meta: normalizedContext.meta }),
  };
  try {
    mkdirSync(getSessionsDir(), { recursive: true });
    writeFileAtomic(getReviewSessionPathForDiagnostics(id), `${JSON.stringify(session, null, 2)}\n`);
  } catch {
    return { id, saved: false };
  }
  updateIndex((entries) => [toIndexEntry(session), ...entries.filter((entry) => entry.id !== id)]);
  return { id, saved: true };
}

export function saveReviewSession(
  identity: string,
  data: ReviewSessionData,
  context: ReviewSessionSaveContext = { revision: "unknown" },
): string {
  return saveReviewSessionWithStatus(identity, data, context).id;
}

export function deleteReviewSession(identity: string, id = createReviewSessionId(identity)): void {
  deleteSessionFile(id);
  updateIndex((entries) => entries.filter((entry) => entry.id !== id));
}

function comparisonSignature(comparison: ReviewFileComparison | null): string | null {
  if (comparison == null) return "-";
  if (comparison.originalBlobSha === undefined || comparison.modifiedBlobSha === undefined) return null;
  return [
    comparison.status,
    comparison.displayPath,
    comparison.originalBlobSha ?? "<absent>",
    comparison.modifiedBlobSha ?? "<absent>",
  ].join(":");
}

function fileSignature(file: ReviewFile): string | null {
  const comparisons = [file.gitDiff, file.lastCommit, file.allFiles];
  if (comparisons.every((comparison) => comparison == null)) return null;
  const signatures = comparisons.map(comparisonSignature);
  return signatures.some((signature) => signature == null) ? null : signatures.join("|");
}

/**
 * Content identity per file path. Files without reliable blob identities are omitted so a resume
 * fails closed and marks their comments for attention instead of trusting diff statistics.
 */
export function buildReviewFileSignatures(files: ReviewFile[]): Record<string, string> {
  const signatures: Record<string, string> = {};
  for (const file of files) {
    const signature = fileSignature(file);
    if (signature != null) signatures[file.path] = signature;
  }
  return signatures;
}

/** Review file ids are `<path>::<flags>::<display paths>`; only the path survives a rebase. */
function commentFilePath(fileId: string): string {
  return fileId.split("::")[0] ?? fileId;
}

function stripNeedsAttention(body: string): string {
  return body.replace(NEEDS_ATTENTION_MARKER, "");
}

function shortRevision(revision: string): string {
  return /^[0-9a-f]{40}$/i.test(revision) ? revision.slice(0, 7) : revision;
}

function formatUnanchoredLine(comment: DiffReviewComment): string {
  const path = commentFilePath(comment.fileId);
  const location = comment.startLine == null
    ? path
    : `${path}:${comment.startLine}${comment.endLine != null && comment.endLine !== comment.startLine ? `-${comment.endLine}` : ""}`;
  return `- ${location}: ${stripNeedsAttention(comment.body).replace(/\n+/g, " ").trim()}`;
}

export interface ReviewSessionRebase {
  data: ReviewSessionData;
  previousRevision: string;
  reanchored: number;
  needsAttention: number;
  unanchored: number;
}

/**
 * Re-resolve a parked draft against a new head. Comments on files whose content is unchanged keep
 * their exact anchor; comments on changed files keep their line but are marked for review; comments
 * whose file left the diff are folded into the review-wide note so their intent is never dropped.
 */
export function rebaseReviewSession(
  session: PersistedReviewSession,
  files: ReviewFile[],
  visibleScopes: ReviewScope[],
  signatures: Record<string, string>,
): ReviewSessionRebase {
  const previousSignatures = session.fileSignatures;
  const marker = `[needs attention · anchored on ${shortRevision(session.revision)}]`;
  const seeds: SeedReviewComment[] = [];
  const commentBySeed = new Map<SeedReviewComment, DiffReviewComment>();
  const markedSeeds = new Set<SeedReviewComment>();
  const originalTextByKey = new Map<string, string>();

  for (const comment of session.state.draft.comments) {
    const path = commentFilePath(comment.fileId);
    const previous = previousSignatures[path];
    const current = signatures[path];
    const unchanged = previous != null && current != null && previous === current;
    const body = stripNeedsAttention(comment.body);
    const marked = !unchanged && comment.side !== "file";
    if (comment.originalText != null && comment.startLine != null) {
      originalTextByKey.set(`${path}:${comment.scope}:${comment.side}:${comment.startLine}`, comment.originalText);
    }
    const seed: SeedReviewComment = {
      path,
      body: marked ? `${marker}\n${body}` : body,
      side: comment.side,
      intent: comment.intent,
      ...(comment.startLine == null ? {} : { startLine: comment.startLine }),
      ...(comment.endLine == null ? {} : { endLine: comment.endLine }),
    };
    seeds.push(seed);
    commentBySeed.set(seed, comment);
    if (marked) markedSeeds.add(seed);
  }

  const resolution = resolveSeedComments(files, visibleScopes, seeds);
  const unresolvedSeeds = new Set(resolution.unresolved);
  const unanchoredComments = resolution.unresolved
    .map((seed) => commentBySeed.get(seed))
    .filter((comment): comment is DiffReviewComment => comment != null);
  const anchoredSeeds = seeds.filter((seed) => !unresolvedSeeds.has(seed));
  const needsAttention = anchoredSeeds.filter((seed) => markedSeeds.has(seed)).length;
  const reanchored = anchoredSeeds.length - needsAttention;

  const noteLines = unanchoredComments.length === 0
    ? []
    : [
        `Needs attention (unanchored from ${shortRevision(session.revision)}):`,
        ...unanchoredComments.map(formatUnanchoredLine),
      ];
  const allComment = [session.state.draft.allComment.trimEnd(), ...noteLines].filter((line) => line.length > 0).join("\n").trim();

  const clearedState: ReviewState = {
    ...session.state,
    activeFileId: null,
    selectedCommentIndex: 0,
    selectedLineTargetByScopeFile: {},
    draft: { ...session.state.draft, allComment, comments: [] },
  };
  const rebasedState = applyResolvedSeedComments(clearedState, resolution.resolved);
  const comments = rebasedState.draft.comments.map((comment) => {
    const key = `${commentFilePath(comment.fileId)}:${comment.scope}:${comment.side}:${comment.startLine}`;
    const originalText = originalTextByKey.get(key);
    return originalText == null ? comment : { ...comment, originalText };
  });

  const idsByPath = new Map(files.map((file) => [file.path, file.id]));
  const reviewedFileIds = session.reviewedFileIds
    .map((fileId) => ({ path: commentFilePath(fileId), id: idsByPath.get(commentFilePath(fileId)) }))
    .filter((entry): entry is { path: string; id: string } => (
      entry.id != null && previousSignatures[entry.path] != null && previousSignatures[entry.path] === signatures[entry.path]
    ))
    .map((entry) => entry.id);

  return {
    data: {
      state: { ...rebasedState, draft: { ...rebasedState.draft, comments } },
      diffViewMode: session.diffViewMode,
      navigatorTreeMode: session.navigatorTreeMode,
      contextLineNavigation: session.contextLineNavigation,
      commentsGlobal: session.commentsGlobal,
      ...(session.showAllLocales == null ? {} : { showAllLocales: session.showAllLocales }),
      reviewedFileIds,
      navigatorScroll: 0,
      diffScroll: 0,
      commentsScroll: 0,
    },
    previousRevision: session.revision,
    reanchored,
    needsAttention,
    unanchored: unanchoredComments.length,
  };
}
