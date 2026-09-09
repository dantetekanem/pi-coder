import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { PersistedDiffViewMode } from "./preferences.js";
import { ReviewSessionLockedError, withReviewSessionLock, writeReviewSessionFileAtomic as writeFileAtomic, type ReviewSessionLockInfo } from "./review-session-persistence.js";
import { applyResolvedSeedComments, resolveSeedComments, type SeedReviewComment } from "./seed-comments.js";
import type { DiffReviewComment, ReviewFile, ReviewFileComparison, ReviewScope, ReviewState } from "./types.js";

export const REVIEW_SESSION_VERSION = 3;
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
  /** null/omitted creates only; replacing a snapshot requires its last loaded/saved generation. */
  expectedGeneration?: number | null;
  /** Explicit resume may migrate a legacy target key while retaining its instance and generation. */
  previousIdentity?: string;
  revision: string;
  fileSignatures?: Record<string, string>;
  meta?: ReviewSessionMeta;
}

export interface PersistedReviewSession extends ReviewSessionData {
  version: typeof REVIEW_SESSION_VERSION;
  generation: number;
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

export function createReviewInstanceId(): string {
  return randomUUID();
}

export function getReviewSessionPathForDiagnostics(id: string): string {
  const name = `${id.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`;
  if (name.toLowerCase() === INDEX_FILE_NAME) throw new Error("Review session id is reserved for the index");
  return join(getSessionsDir(), name);
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
  if (value.version !== 1 && value.version !== 2 && value.version !== REVIEW_SESSION_VERSION) return null;
  if (value.version === REVIEW_SESSION_VERSION && !isGeneration(value.generation)) return null;
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
    generation: value.version === REVIEW_SESSION_VERSION ? value.generation as number : 0,
    id: value.id,
    identity,
    updatedAt: value.updatedAt,
    revision,
    fileSignatures: readStringMap(value.fileSignatures),
    ...(meta == null ? {} : { meta }),
  };
}

function isGeneration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

type StoredSession =
  | { kind: "missing" }
  | { kind: "unreadable" }
  | { kind: "deleted"; generation: number }
  | { kind: "session"; session: PersistedReviewSession };

function readStoredSession(identity: string, id: string): StoredSession {
  try {
    const value: unknown = JSON.parse(readFileSync(getReviewSessionPathForDiagnostics(id), "utf8"));
    if (!isRecord(value) || value.id !== id || value.identity !== identity) return { kind: "unreadable" };
    if (value.version === REVIEW_SESSION_VERSION && value.deleted === true && isGeneration(value.generation)) {
      return { kind: "deleted", generation: value.generation };
    }
    const session = migrateReviewSession(value, identity);
    return session == null ? { kind: "unreadable" } : { kind: "session", session };
  } catch (error) {
    return error != null && typeof error === "object" && "code" in error && error.code === "ENOENT"
      ? { kind: "missing" }
      : { kind: "unreadable" };
  }
}

export function loadReviewSession(identity: string, id = createReviewSessionId(identity)): PersistedReviewSession | null {
  const stored = readStoredSession(identity, id);
  return stored.kind === "session" ? stored.session : null;
}

/** Terminal instances still identify their target for a DISCUSS continuation, but cannot be resumed. */
export function hasReviewSessionIdentity(identity: string, id: string): boolean {
  const stored = readStoredSession(identity, id);
  return stored.kind === "session" || stored.kind === "deleted";
}

function readIndexEntries(): ReviewSessionIndexEntry[] {
  let entries: ReviewSessionIndexEntry[] = [];
  try {
    const parsed = JSON.parse(readFileSync(getIndexPath(), "utf8")) as unknown;
    if (isRecord(parsed) && Array.isArray(parsed.sessions)) entries = parsed.sessions.filter(isIndexEntry);
  } catch { /* Snapshot files remain authoritative when the index is missing or unreadable. */ }

  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  // A crash can leave valid metadata incomplete or with an instance's previous target identity.
  for (const entry of rebuildIndexEntries()) byId.set(entry.id, entry);
  return [...byId.values()];
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

/** Recover membership from valid canonical snapshots; leave unknown or misplaced files untouched. */
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
      if (session == null || getReviewSessionPathForDiagnostics(session.id) !== join(directory, name)) continue;
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
  return !Number.isNaN(updatedAt) && now - updatedAt > REVIEW_SESSION_TTL_MS;
}

/** Tombstones are terminal and retained: removing them would permit an old create-only writer to resurrect the id. */
function writeTombstone(identity: string, id: string, generation: number): void {
  writeFileAtomic(getReviewSessionPathForDiagnostics(id), `${JSON.stringify({
    version: REVIEW_SESSION_VERSION, id, identity, generation, deleted: true, deletedAt: new Date().toISOString(),
  })}\n`);
}

function writeIndexEntries(entries: ReviewSessionIndexEntry[]): boolean {
  try {
    writeFileAtomic(getIndexPath(), `${JSON.stringify({ version: REVIEW_SESSION_VERSION, sessions: entries }, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

/** Caller holds the store lock. Expiry must use the snapshot, never a stale index timestamp. */
function updateIndex(mutate: (entries: ReviewSessionIndexEntry[]) => ReviewSessionIndexEntry[], now = Date.now()) {
  const kept: ReviewSessionIndexEntry[] = [];
  for (const entry of readIndexEntries()) {
    const stored = readStoredSession(entry.identity, entry.id);
    if (stored.kind === "missing" || stored.kind === "deleted") continue;
    if (stored.kind === "unreadable") {
      kept.push(entry);
      continue;
    }
    const actual = toIndexEntry(stored.session);
    if (isExpired(actual, now) && stored.session.generation < Number.MAX_SAFE_INTEGER) {
      try {
        writeTombstone(entry.identity, entry.id, stored.session.generation + 1);
        continue;
      } catch { /* Retain the entry if deletion could not be recorded. */ }
    }
    kept.push(actual);
  }
  const entries = sortIndexEntries(mutate(kept));
  return { entries, indexUpdated: writeIndexEntries(entries) };
}

export function listReviewSessions(): ReviewSessionIndexEntry[] {
  return withReviewSessionLock(getSessionsDir(), () => updateIndex((entries) => entries).entries);
}

/** Composition writes share terminal-state checks with snapshot deletion; no orphan recovery ids. */
export function withReviewCompositionStore<T>(identity: string, id: string, operation: (directory: string, active: boolean) => T): T {
  return withReviewSessionLock(getSessionsDir(), () => operation(
    join(getSessionsDir(), "compositions"), readStoredSession(identity, id).kind === "session",
  ));
}

export interface ReviewSessionConflict {
  status: "conflict";
  reason: "generation-mismatch" | "deleted" | "unreadable" | "generation-exhausted";
  expectedGeneration: number | null;
  actualGeneration: number | null;
  current: PersistedReviewSession | null;
}

type ReviewSessionWriteFailure = ReviewSessionConflict
  | { status: "locked"; lock: ReviewSessionLockInfo }
  | { status: "error"; message: string };

export type ReviewSessionSaveResult =
  | { id: string; saved: true; status: "saved"; generation: number; indexUpdated: boolean }
  | ({ id: string; saved: false; attempted: ReviewSessionData } & ReviewSessionWriteFailure);

export type ReviewSessionDeleteResult =
  | { id: string; deleted: true; status: "deleted"; generation: number; indexUpdated: boolean }
  | ({ id: string; deleted: false } & ReviewSessionWriteFailure);

type ReviewSessionSaveContext = ReviewSessionContext | string;

function normalizeSaveContext(context: ReviewSessionSaveContext): ReviewSessionContext {
  return typeof context === "string" ? { id: context, revision: "unknown" } : context;
}

function compareGeneration(stored: StoredSession, expectedGeneration: number | null): ReviewSessionConflict | null {
  const current = stored.kind === "session" ? stored.session : null;
  const actualGeneration = current?.generation ?? (stored.kind === "deleted" ? stored.generation : null);
  const reason = stored.kind === "unreadable" ? "unreadable"
    : stored.kind === "deleted" ? "deleted"
    : actualGeneration !== expectedGeneration ? "generation-mismatch"
    : actualGeneration === Number.MAX_SAFE_INTEGER ? "generation-exhausted"
    : null;
  return reason == null ? null : { status: "conflict", reason, expectedGeneration, actualGeneration, current };
}

function writeFailure(error: unknown): ReviewSessionWriteFailure {
  return error instanceof ReviewSessionLockedError
    ? { status: "locked", lock: error.lock }
    : { status: "error", message: error instanceof Error ? error.message : String(error) };
}

/**
 * Compare and replace within one process-safe boundary. Conflict feedback is returned, not written
 * or merged automatically; callers must retain attempted/current until the user resolves it.
 * A completed rename is process-crash safe, not an fsync/power-loss guarantee.
 */
export function saveReviewSessionWithStatus(
  identity: string,
  data: ReviewSessionData,
  context: ReviewSessionSaveContext = { revision: "unknown" },
): ReviewSessionSaveResult {
  const normalizedContext = normalizeSaveContext(context);
  const id = normalizedContext.id ?? createReviewSessionId(identity);
  const expectedGeneration = normalizedContext.expectedGeneration ?? null;
  const attempted = structuredClone(data);
  try {
    if (expectedGeneration !== null && !isGeneration(expectedGeneration)) throw new Error("Invalid expected review generation");
    if (normalizedContext.previousIdentity != null && expectedGeneration === null) throw new Error("Identity migration requires a loaded generation");
    return withReviewSessionLock(getSessionsDir(), (): ReviewSessionSaveResult => {
      const conflict = compareGeneration(readStoredSession(normalizedContext.previousIdentity ?? identity, id), expectedGeneration);
      if (conflict != null) return { id, saved: false, attempted, ...conflict };
      const generation = (expectedGeneration ?? 0) + 1;
      const session: PersistedReviewSession = {
        ...attempted,
        state: normalizeAnchors(attempted.state, false),
        version: REVIEW_SESSION_VERSION,
        generation,
        id,
        identity,
        updatedAt: new Date().toISOString(),
        revision: normalizedContext.revision,
        fileSignatures: normalizedContext.fileSignatures ?? {},
        ...(normalizedContext.meta == null ? {} : { meta: normalizedContext.meta }),
      };
      writeFileAtomic(getReviewSessionPathForDiagnostics(id), `${JSON.stringify(session, null, 2)}\n`);
      // The snapshot is committed. Index failure must not invite a blind retry of that generation.
      let indexUpdated = false;
      try {
        indexUpdated = updateIndex((entries) => [toIndexEntry(session), ...entries.filter((entry) => entry.id !== id)]).indexUpdated;
      } catch { /* The committed snapshot remains available by id when index maintenance fails. */ }
      return { id, saved: true, status: "saved", generation, indexUpdated };
    });
  } catch (error) {
    return { id, saved: false, attempted, ...writeFailure(error) };
  }
}

export class ReviewSessionSaveError extends Error {
  readonly result: Extract<ReviewSessionSaveResult, { saved: false }>;

  constructor(result: Extract<ReviewSessionSaveResult, { saved: false }>) {
    super(`Review session ${result.id} was not saved: ${result.status}`);
    this.name = "ReviewSessionSaveError";
    this.result = result;
  }
}

export function saveReviewSession(
  identity: string,
  data: ReviewSessionData,
  context: ReviewSessionSaveContext = { revision: "unknown" },
): string {
  const result = saveReviewSessionWithStatus(identity, data, context);
  if (!result.saved) throw new ReviewSessionSaveError(result);
  return result.id;
}

/** An omitted generation may only tombstone an unused id; existing snapshots require an exact generation. */
export function deleteReviewSession(
  identity: string,
  id = createReviewSessionId(identity),
  expectedGeneration?: number,
): ReviewSessionDeleteResult {
  try {
    if (expectedGeneration != null && !isGeneration(expectedGeneration)) throw new Error("Invalid expected review generation");
    return withReviewSessionLock(getSessionsDir(), (): ReviewSessionDeleteResult => {
      const conflict = compareGeneration(readStoredSession(identity, id), expectedGeneration ?? null);
      if (conflict != null) return { id, deleted: false, ...conflict };
      const generation = (expectedGeneration ?? 0) + 1;
      writeTombstone(identity, id, generation);
      let indexUpdated = false;
      try {
        indexUpdated = updateIndex((entries) => entries.filter((entry) => entry.id !== id)).indexUpdated;
      } catch { /* The terminal snapshot still prevents resurrection. */ }
      return { id, deleted: true, status: "deleted", generation, indexUpdated };
    });
  } catch (error) {
    return { id, deleted: false, ...writeFailure(error) };
  }
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
