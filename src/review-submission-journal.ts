import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { withReviewSessionLock, writeReviewSessionFileAtomic } from "./review-session-persistence.js";
import type { ReviewSubmissionStep, SubmitReviewInput } from "./review-submit.js";

export interface SubmissionActor {
  kind: "id" | "login";
  value: string;
  login: string | null;
}

export interface SubmissionDraftItem { id: string; fingerprint: string }
export interface SubmissionDraftBinding {
  identity: string;
  sessionId: string;
  comments: SubmissionDraftItem[];
  bodyComments: SubmissionDraftItem[];
  allCommentFingerprint?: string;
  sourceFingerprint?: string;
}

export interface SubmissionHandoffSeed {
  input: SubmitReviewInput;
  providerDigest: string;
  sourceDigest: string;
  draft: SubmissionDraftBinding;
}
export interface SubmissionHandoff extends SubmissionHandoffSeed {
  version: 1;
  kind: "handoff";
  id: string;
  ordinal: number;
  createdAt: string;
  key: string;
}

export interface SubmissionAttemptSeed {
  input: SubmitReviewInput;
  handoffId?: string;
  actor: SubmissionActor;
  providerDigest: string;
  sourceDigest?: string;
  draft?: SubmissionDraftBinding;
  steps: ReviewSubmissionStep[];
}

export interface SubmissionAttempt extends SubmissionAttemptSeed {
  version: 1;
  id: string;
  generation: number;
  ordinal: number;
  createdAt: string;
  updatedAt: string;
  payloadDigest: string;
  key: string;
  remainingSourceFingerprint?: string;
  previousSourceFingerprint?: string;
}

export class SubmissionAttemptConflictError extends Error {
  constructor(readonly current: SubmissionAttempt) {
    super(`Submission attempt ${current.id} generation conflict; current evidence was retained.`);
    this.name = "SubmissionAttemptConflictError";
  }
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const VERDICTS = new Set(["approve", "request_changes", "comment"]);
const STATUSES = new Set(["pending", "unknown", "submitted", "rejected"]);

function record(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  return record(value) ? Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => [key, canonical(value[key])])) : value;
}
export function submissionFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
export function submissionDraftSourceFingerprint(
  input: Pick<SubmitReviewInput, "provider" | "repo" | "prNumber" | "commitId" | "baseCommitId" | "gitRoot">,
  draft: { allComment: string; allIntent: string; comments: unknown[] },
): string {
  return submissionFingerprint({
    provider: input.provider, repo: input.provider === "github" ? input.repo.toLowerCase() : input.repo,
    number: input.prNumber, commit: input.commitId, base: input.baseCommitId, cwd: input.gitRoot,
    draft: { allComment: draft.allComment, allIntent: draft.allIntent, comments: draft.comments },
  });
}
export function submissionPayloadDigest(input: SubmitReviewInput): string {
  return submissionFingerprint({
    provider: input.provider, repo: input.provider === "github" ? input.repo.toLowerCase() : input.repo,
    number: input.prNumber, commit: input.commitId, verdict: input.verdict, body: input.body?.trim() ?? "",
    comments: (input.comments ?? []).map((comment) => [comment.path, comment.body, comment.subject_type ?? "line", comment.line ?? null, comment.side ?? null, comment.start_line ?? null, comment.start_side ?? null]),
  });
}
function attemptKey(seed: SubmissionAttemptSeed): string {
  return submissionFingerprint([submissionPayloadDigest(seed.input), seed.actor.kind, seed.actor.kind === "login" ? seed.actor.value.toLowerCase() : seed.actor.value, seed.sourceDigest ?? null, seed.draft?.identity ?? null, seed.draft?.sessionId ?? null]);
}
function handoffKey(seed: SubmissionHandoffSeed): string {
  return submissionFingerprint([seed.input, seed.providerDigest, seed.sourceDigest, seed.draft]);
}
function scope(step: ReviewSubmissionStep): string {
  return submissionFingerprint([step.kind, step.verdict, step.bodyIncluded, step.commentIndexes]);
}
function inputValid(value: unknown): value is SubmitReviewInput {
  if (!record(value) || ![value.provider, value.repo, value.prNumber, value.commitId].every((item) => typeof item === "string" && item.length > 0) || !VERDICTS.has(String(value.verdict))) return false;
  if (value.body != null && typeof value.body !== "string") return false;
  if ([value.gitRoot, value.baseCommitId, value.prAuthorLogin].some((item) => item != null && typeof item !== "string")) return false;
  return value.comments == null || (Array.isArray(value.comments) && value.comments.every((comment) => record(comment)
    && typeof comment.path === "string" && typeof comment.body === "string"
    && [comment.line, comment.start_line].every((line) => line == null || (typeof line === "number" && Number.isSafeInteger(line) && line > 0))
    && [comment.side, comment.start_side].every((side) => side == null || side === "LEFT" || side === "RIGHT")
    && (comment.subject_type == null || comment.subject_type === "file")));
}
function draftValid(value: unknown): value is SubmissionDraftBinding | undefined {
  if (value == null) return true;
  return record(value) && typeof value.identity === "string" && typeof value.sessionId === "string"
    && [value.comments, value.bodyComments].every((items) => Array.isArray(items) && items.every((item) => record(item) && typeof item.id === "string" && typeof item.fingerprint === "string" && HASH.test(item.fingerprint)))
    && [value.allCommentFingerprint, value.sourceFingerprint].every((fingerprint) => fingerprint == null || (typeof fingerprint === "string" && HASH.test(fingerprint)));
}
function parseAttempt(value: unknown, id: string): SubmissionAttempt {
  const invalid = () => new Error(`Invalid submission attempt ${id}; inspect the retained journal before retrying.`);
  if (!record(value) || value.version !== 1 || value.id !== id || !UUID.test(id)
    || ![value.generation, value.ordinal].every((number) => typeof number === "number" && Number.isSafeInteger(number) && number > 0)
    || ![value.createdAt, value.updatedAt].every((date) => typeof date === "string" && Number.isFinite(Date.parse(date)))
    || !inputValid(value.input) || !record(value.actor) || !["id", "login"].includes(String(value.actor.kind))
    || typeof value.actor.value !== "string" || value.actor.value.length === 0 || (value.actor.login !== null && typeof value.actor.login !== "string")
    || typeof value.providerDigest !== "string" || !HASH.test(value.providerDigest)
    || (value.handoffId != null && (typeof value.handoffId !== "string" || !UUID.test(value.handoffId)))
    || [value.sourceDigest, value.remainingSourceFingerprint, value.previousSourceFingerprint].some((fingerprint) => fingerprint != null && (typeof fingerprint !== "string" || !HASH.test(fingerprint))) || !draftValid(value.draft)
    || !Array.isArray(value.steps) || value.steps.length === 0 || value.steps.length > 2) throw invalid();
  const commentCount = value.input.comments?.length ?? 0;
  if (!value.steps.every((step) => record(step) && ["review", "comments", "verdict"].includes(String(step.kind))
    && VERDICTS.has(String(step.verdict)) && STATUSES.has(String(step.status)) && typeof step.bodyIncluded === "boolean"
    && Array.isArray(step.commentIndexes) && step.commentIndexes.every((index) => Number.isSafeInteger(index) && index >= 0 && index < commentCount)
    && new Set(step.commentIndexes).size === step.commentIndexes.length
    && (step.status !== "submitted" || (typeof step.reviewId === "string" && step.reviewId.length > 0))
    && (step.reviewId == null || (typeof step.reviewId === "string" && step.reviewId.length > 0 && step.reviewIdSource === "write_response")))) throw invalid();
  const attempt = value as unknown as SubmissionAttempt;
  if (attempt.payloadDigest !== submissionPayloadDigest(attempt.input) || attempt.key !== attemptKey(attempt)) throw invalid();
  return attempt;
}

function parseHandoff(value: unknown, id: string): SubmissionHandoff {
  if (!record(value) || value.version !== 1 || value.kind !== "handoff" || value.id !== id || !UUID.test(id)
    || typeof value.ordinal !== "number" || !Number.isSafeInteger(value.ordinal) || value.ordinal <= 0
    || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) || !inputValid(value.input)
    || typeof value.providerDigest !== "string" || !HASH.test(value.providerDigest)
    || typeof value.sourceDigest !== "string" || !HASH.test(value.sourceDigest) || !record(value.draft) || !draftValid(value.draft)
    || value.draft.comments.length !== (value.input.comments?.length ?? 0)) throw new Error(`Invalid submission handoff ${id}; retained context cannot authorize a write.`);
  const handoff = value as unknown as SubmissionHandoff;
  if (handoff.key !== handoffKey(handoff)) throw new Error(`Invalid submission handoff ${id}; its captured context changed.`);
  return handoff;
}

/** Short local-filesystem transactions only; callers never hold the mutex over a provider await.
 * Bounds apply to retained journal data plus atomic replacement, not process peak memory.
 * Unknown/completed intents are never silently evicted. No fsync or shared-filesystem guarantee.
 */
export function createSubmissionJournal(options: { directory?: string; maxRecords?: number; maxRecordBytes?: number; maxBytes?: number } = {}) {
  const directory = options.directory ?? process.env.PI_CODE_DIFF_SUBMISSIONS_DIR ?? join(getAgentDir(), "cache", "pi-code-diff", "submissions");
  const maxRecords = options.maxRecords ?? 1024;
  const maxRecordBytes = options.maxRecordBytes ?? 4 * 1024 * 1024;
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
  const pathFor = (id: string, handoff = false) => {
    if (!UUID.test(id)) throw new Error("Invalid submission attempt id.");
    return join(directory, `${id}${handoff ? ".handoff" : ""}.json`);
  };
  const readRecord = (path: string): unknown => {
    if (!existsSync(path)) return undefined;
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.size > maxRecordBytes) throw new Error("Invalid submission record: record size limit or file type.");
    try { return JSON.parse(readFileSync(path, "utf8")) as unknown; }
    catch { throw new Error("Invalid submission record; retained record is unreadable."); }
  };
  const load = (id: string): SubmissionAttempt | null => {
    const value = readRecord(pathFor(id));
    return value === undefined ? null : parseAttempt(value, id);
  };
  const loadHandoff = (id: string): SubmissionHandoff | null => {
    const value = readRecord(pathFor(id, true));
    return value === undefined ? null : parseHandoff(value, id);
  };
  const inventory = () => {
    const attempts: SubmissionAttempt[] = [];
    const handoffs: SubmissionHandoff[] = [];
    if (!existsSync(directory)) return { attempts, handoffs, bytes: 0 };
    let bytes = 0;
    for (const name of readdirSync(directory)) {
      if (name === ".write-lock") continue;
      const stats = lstatSync(join(directory, name));
      if (!stats.isFile()) throw new Error("Invalid submission journal entry; inspect the retained store.");
      bytes += stats.size;
      if (bytes > maxBytes) throw new Error("Submission journal capacity exceeded; retained intents were not removed.");
      if (!name.endsWith(".json")) continue; // Orphan atomic temporaries still count toward the byte budget.
      if (attempts.length + handoffs.length >= maxRecords) throw new Error("Submission journal capacity exceeded.");
      if (name.endsWith(".handoff.json")) {
        const handoff = loadHandoff(name.slice(0, -13));
        if (handoff != null) handoffs.push(handoff);
      } else {
        const attempt = load(name.slice(0, -5));
        if (attempt != null) attempts.push(attempt);
      }
    }
    return { attempts, handoffs, bytes };
  };
  const transaction = <T>(operation: () => T): T => {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(directory, 0o700);
    return withReviewSessionLock(directory, operation);
  };
  const writeRecord = (path: string, value: SubmissionAttempt | SubmissionHandoff, retainedBytes: number) => {
    const text = `${JSON.stringify(value)}\n`;
    const bytes = Buffer.byteLength(text);
    if (bytes > maxRecordBytes) throw new Error("Submission attempt exceeds the record size limit; payload was not truncated.");
    if (retainedBytes + bytes > maxBytes) throw new Error("Submission journal capacity cannot accommodate atomic replacement; retained intents were not removed.");
    writeReviewSessionFileAtomic(path, text);
  };
  const persist = (attempt: SubmissionAttempt, retainedBytes: number) => {
    parseAttempt(attempt, attempt.id);
    writeRecord(pathFor(attempt.id), attempt, retainedBytes);
    return structuredClone(attempt);
  };
  const latest = <T extends { ordinal: number }>(records: T[]): T | null => records.sort((left, right) => right.ordinal - left.ordinal)[0] ?? null;
  return {
    load,
    loadHandoff,
    findHandoffForDraft(identity: string, sessionId: string, sourceDigest: string) {
      const { attempts, handoffs } = inventory();
      return latest(handoffs.filter((handoff) => handoff.draft.identity === identity && handoff.draft.sessionId === sessionId && handoff.sourceDigest === sourceDigest
        && !attempts.some((attempt) => attempt.handoffId === handoff.id)));
    },
    saveHandoff(seed: SubmissionHandoffSeed): SubmissionHandoff {
      return transaction(() => {
        const { attempts, handoffs, bytes } = inventory();
        const key = handoffKey(seed);
        const existing = latest(handoffs.filter((handoff) => handoff.key === key && !attempts.some((attempt) => attempt.handoffId === handoff.id)));
        if (existing != null) return existing;
        if (attempts.length + handoffs.length >= maxRecords) throw new Error("Submission journal capacity reached; pending handoffs were retained.");
        const ordinal = Math.max(0, ...attempts.map((attempt) => attempt.ordinal), ...handoffs.map((handoff) => handoff.ordinal)) + 1;
        const handoff: SubmissionHandoff = { ...structuredClone(seed), version: 1, kind: "handoff", id: randomUUID(), ordinal, createdAt: new Date().toISOString(), key };
        parseHandoff(handoff, handoff.id);
        writeRecord(pathFor(handoff.id, true), handoff, bytes);
        return structuredClone(handoff);
      });
    },
    findForDraft(identity: string, sessionId: string, sourceDigest: string, remainingSourceFingerprint?: string) {
      return latest(inventory().attempts.filter((attempt) => attempt.draft?.identity === identity && attempt.draft.sessionId === sessionId
        && (attempt.sourceDigest === sourceDigest || (remainingSourceFingerprint != null && [attempt.remainingSourceFingerprint, attempt.previousSourceFingerprint].includes(remainingSourceFingerprint)))));
    },
    create(seed: SubmissionAttemptSeed, forceNew = false): { attempt: SubmissionAttempt; created: boolean } {
      return transaction(() => {
        const { attempts, handoffs, bytes } = inventory();
        if (seed.handoffId != null) {
          const handoff = handoffs.find((candidate) => candidate.id === seed.handoffId);
          if (handoff == null || handoff.sourceDigest !== seed.sourceDigest || handoff.draft.identity !== seed.draft?.identity || handoff.draft.sessionId !== seed.draft?.sessionId) throw new Error("Submission handoff is missing or belongs to another source.");
          const linked = latest(attempts.filter((candidate) => candidate.handoffId === seed.handoffId));
          if (linked != null && !forceNew) {
            if (linked.payloadDigest !== submissionPayloadDigest(seed.input) || submissionFingerprint(linked.draft) !== submissionFingerprint(seed.draft)) throw new Error("This handoff already has a different confirmed payload or source selection. Use its saved attempt; a new decision is required to change it.");
            return { attempt: linked, created: false };
          }
        }
        const key = attemptKey(seed);
        // Changed authentication is not permission to create an otherwise identical intent.
        const existing = latest(attempts.filter((attempt) => attempt.key === attemptKey({ ...seed, actor: attempt.actor })));
        if (!forceNew && existing != null) {
          if (seed.handoffId != null) throw new Error(`This source already has an existing attempt ${existing.id}. Resume that attempt, or explicitly confirm a new intent; this different handoff was not bound.`);
          return { attempt: existing, created: false };
        }
        if (attempts.length + handoffs.length >= maxRecords) throw new Error("Submission journal capacity reached; retained intents were not removed.");
        const ordinal = Math.max(0, ...attempts.map((attempt) => attempt.ordinal), ...handoffs.map((handoff) => handoff.ordinal)) + 1;
        const timestamp = new Date().toISOString();
        const attempt: SubmissionAttempt = { ...structuredClone(seed), version: 1, id: randomUUID(), generation: 1, ordinal, createdAt: timestamp, updatedAt: timestamp, payloadDigest: submissionPayloadDigest(seed.input), key };
        return { attempt: persist(attempt, bytes), created: true };
      });
    },
    update(id: string, generation: number, steps: ReviewSubmissionStep[], remainingSourceFingerprint?: string): SubmissionAttempt {
      return transaction(() => {
        const current = load(id);
        if (current == null) throw new Error(`Submission attempt ${id} is missing; no new write is authorized.`);
        if (current.generation !== generation) throw new SubmissionAttemptConflictError(current);
        if (steps.length !== current.steps.length || steps.some((step, index) => scope(step) !== scope(current.steps[index]!))) throw new Error("Submission step scope is immutable.");
        if (current.steps.some((step, index) => step.status === "submitted" && (steps[index]!.status !== "submitted" || steps[index]!.reviewId !== step.reviewId))) throw new Error("A completed step cannot lose its accepted evidence.");
        if (remainingSourceFingerprint !== undefined && !HASH.test(remainingSourceFingerprint)) throw new Error("Invalid remaining source fingerprint.");
        const next: SubmissionAttempt = { ...current, generation: generation + 1, updatedAt: new Date().toISOString(), steps: structuredClone(steps),
          ...(remainingSourceFingerprint === undefined ? {} : {
            remainingSourceFingerprint,
            ...(remainingSourceFingerprint === current.remainingSourceFingerprint ? {} : { previousSourceFingerprint: current.remainingSourceFingerprint }),
          }),
        };
        return persist(next, inventory().bytes);
      });
    },
  };
}
