import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getProviderSettings } from "./provider-settings.js";
import type { PullRequestProvider } from "./remote.js";
import { sanitizeTerminalText } from "./sanitize.js";

export const REVIEW_RECEIPT_VERSION = 1;

const MAX_SNIPPET_LENGTH = 240;
const MAX_RECEIPT_COMMENTS = 200;

export type ReviewReceiptVerdict = "approve" | "request_changes" | "comment";

export interface ReviewReceiptComment {
  /** Repository-relative path the comment was posted against. */
  path: string;
  line: number | null;
  side: "LEFT" | "RIGHT" | null;
  /** sha256 of the exact submitted body, so a later fetch can match without storing the body. */
  bodyHash: string;
  bodyLength: number;
  /** Bounded, control-character-escaped prefix kept only for human-readable diagnostics. */
  snippet: string;
  commentId?: string;
  threadId?: string;
  url?: string;
}

export interface ReviewReceipt {
  version: typeof REVIEW_RECEIPT_VERSION;
  provider: PullRequestProvider;
  repo: string;
  number: string;
  url: string;
  verdict: ReviewReceiptVerdict;
  submittedAt: string;
  reviewIds: string[];
  selfPrincipalId: string | null;
  headSha?: string;
  bodyHash?: string;
  bodyLength?: number;
  bodySnippet?: string;
  comments: ReviewReceiptComment[];
}

export interface ReviewReceiptCommentInput {
  path: string;
  line?: number | null;
  side?: "LEFT" | "RIGHT" | null;
  body: string;
  commentId?: string | null;
  threadId?: string | null;
  url?: string | null;
}

export interface ReviewReceiptInput {
  provider: PullRequestProvider;
  repo: string;
  number: string;
  url: string;
  verdict: ReviewReceiptVerdict;
  reviewIds?: Array<string | number | null | undefined>;
  selfPrincipalId?: string | null;
  headSha?: string | null;
  body?: string | null;
  comments?: ReviewReceiptCommentInput[];
  submittedAt?: string;
}

export function getReviewReceiptsDir(): string {
  return process.env.PI_CODE_DIFF_RECEIPTS_DIR ?? join(getAgentDir(), "cache", "pi-code-diff", "receipts");
}

function sanitizeKeySegment(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

/** Stable per-PR key so a resubmission overwrites the previous receipt instead of piling up. */
export function getReviewReceiptKey(provider: PullRequestProvider, repo: string, number: string): string {
  return `${sanitizeKeySegment(provider)}__${sanitizeKeySegment(repo)}__${sanitizeKeySegment(number)}`;
}

export function getReviewReceiptPath(provider: PullRequestProvider, repo: string, number: string): string {
  return join(getReviewReceiptsDir(), `${getReviewReceiptKey(provider, repo, number)}.json`);
}

export function hashReceiptBody(body: string): string {
  return createHash("sha256").update(body.trim().replace(/\r\n/g, "\n")).digest("hex");
}

export function boundedSnippet(body: string, limit = MAX_SNIPPET_LENGTH): string {
  const collapsed = sanitizeTerminalText(body).replace(/\s+/g, " ").trim();
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1)}…`;
}

function normalizeId(value: string | number | null | undefined): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 || trimmed.length > 200 ? undefined : trimmed;
}

export function buildReviewReceipt(input: ReviewReceiptInput): ReviewReceipt {
  const body = input.body?.trim();
  const comments = (input.comments ?? []).slice(0, MAX_RECEIPT_COMMENTS).map((comment) => ({
    path: comment.path,
    line: typeof comment.line === "number" && Number.isFinite(comment.line) ? comment.line : null,
    side: comment.side === "LEFT" || comment.side === "RIGHT" ? comment.side : null,
    bodyHash: hashReceiptBody(comment.body),
    bodyLength: comment.body.length,
    snippet: boundedSnippet(comment.body),
    ...(normalizeId(comment.commentId) == null ? {} : { commentId: normalizeId(comment.commentId)! }),
    ...(normalizeId(comment.threadId) == null ? {} : { threadId: normalizeId(comment.threadId)! }),
    ...(normalizeId(comment.url) == null ? {} : { url: normalizeId(comment.url)! }),
  }));

  return {
    version: REVIEW_RECEIPT_VERSION,
    provider: input.provider,
    repo: input.repo,
    number: input.number,
    url: input.url,
    verdict: input.verdict,
    submittedAt: input.submittedAt ?? new Date().toISOString(),
    reviewIds: (input.reviewIds ?? []).map(normalizeId).filter((id): id is string => id != null),
    selfPrincipalId: input.selfPrincipalId ?? null,
    ...(normalizeId(input.headSha) == null ? {} : { headSha: normalizeId(input.headSha)! }),
    ...(body == null || body.length === 0
      ? {}
      : { bodyHash: hashReceiptBody(body), bodyLength: body.length, bodySnippet: boundedSnippet(body) }),
    comments,
  };
}

function writeFileAtomic(path: string, contents: string): void {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, contents, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") chmodSync(temporaryPath, 0o600);
  renameSync(temporaryPath, path);
}

/** Best effort: a failed receipt write must never turn a successful remote submission into an error. */
export function saveReviewReceipt(input: ReviewReceiptInput): ReviewReceipt | null {
  const receipt = buildReviewReceipt(input);
  try {
    const dir = getReviewReceiptsDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(dir, 0o700);
    writeFileAtomic(getReviewReceiptPath(receipt.provider, receipt.repo, receipt.number), `${JSON.stringify(receipt, null, 2)}\n`);
    return receipt;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function readReceiptComment(value: unknown): ReviewReceiptComment | null {
  if (!isRecord(value) || typeof value.path !== "string" || typeof value.bodyHash !== "string") return null;
  return {
    path: value.path,
    line: typeof value.line === "number" ? value.line : null,
    side: value.side === "LEFT" || value.side === "RIGHT" ? value.side : null,
    bodyHash: value.bodyHash,
    bodyLength: typeof value.bodyLength === "number" ? value.bodyLength : 0,
    snippet: typeof value.snippet === "string" ? value.snippet : "",
    ...(typeof value.commentId === "string" ? { commentId: value.commentId } : {}),
    ...(typeof value.threadId === "string" ? { threadId: value.threadId } : {}),
    ...(typeof value.url === "string" ? { url: value.url } : {}),
  };
}

/** Tolerates legacy and corrupt records by returning null instead of throwing. */
export function parseReviewReceipt(value: unknown): ReviewReceipt | null {
  if (!isRecord(value)) return null;
  if (value.version !== REVIEW_RECEIPT_VERSION) return null;
  if (typeof value.provider !== "string" || getProviderSettings(value.provider) == null) return null;
  if (typeof value.repo !== "string" || typeof value.number !== "string" || typeof value.url !== "string") return null;
  if (value.verdict !== "approve" && value.verdict !== "request_changes" && value.verdict !== "comment") return null;

  return {
    version: REVIEW_RECEIPT_VERSION,
    provider: value.provider,
    repo: value.repo,
    number: value.number,
    url: value.url,
    verdict: value.verdict,
    submittedAt: typeof value.submittedAt === "string" ? value.submittedAt : "",
    reviewIds: Array.isArray(value.reviewIds) ? value.reviewIds.filter((id): id is string => typeof id === "string") : [],
    selfPrincipalId: typeof value.selfPrincipalId === "string" ? value.selfPrincipalId : null,
    ...(typeof value.headSha === "string" ? { headSha: value.headSha } : {}),
    ...(typeof value.bodyHash === "string" ? { bodyHash: value.bodyHash } : {}),
    ...(typeof value.bodyLength === "number" ? { bodyLength: value.bodyLength } : {}),
    ...(typeof value.bodySnippet === "string" ? { bodySnippet: value.bodySnippet } : {}),
    comments: Array.isArray(value.comments)
      ? value.comments.map(readReceiptComment).filter((comment): comment is ReviewReceiptComment => comment != null)
      : [],
  };
}

export function loadReviewReceipt(provider: PullRequestProvider, repo: string, number: string): ReviewReceipt | null {
  const path = getReviewReceiptPath(provider, repo, number);
  if (!existsSync(path)) return null;
  try {
    return parseReviewReceipt(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch {
    return null;
  }
}

export function listReviewReceipts(): ReviewReceipt[] {
  const dir = getReviewReceiptsDir();
  if (!existsSync(dir)) return [];
  const receipts: ReviewReceipt[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const receipt = parseReviewReceipt(JSON.parse(readFileSync(join(dir, name), "utf8")) as unknown);
      if (receipt != null) receipts.push(receipt);
    } catch {
      continue;
    }
  }
  return receipts.sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
}
