import { isDeepStrictEqual } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readConfiguredField, renderProviderOperation, renderProviderTemplate, type ProviderSettings } from "./provider-settings.js";
import type { ReviewInlineComment, ReviewSubmissionStep, SubmitReviewInput } from "./review-submit.js";
import type { SubmissionActor } from "./review-submission-journal.js";

function safeId(value: unknown): string | undefined {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;
  return typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value) ? value : undefined;
}

export function matchesSubmissionActor(actor: SubmissionActor, id: unknown, login: unknown): boolean {
  if (actor.kind === "id") {
    const value = typeof id === "number" ? (Number.isSafeInteger(id) && id > 0 ? String(id) : undefined) : id;
    // Actor IDs are compared as data, never interpolated into a request path.
    return typeof value === "string" && value === actor.value && value.trim().length > 0 && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value);
  }
  return typeof login === "string" && login.length > 0 && actor.value.length > 0 && login.toLowerCase() === actor.value.toLowerCase();
}

function parseResponse(stdout: string): { data: unknown; link?: string } {
  const separator = /\r?\n\r?\n/.exec(stdout);
  if (separator == null) throw new Error("Missing HTTP evidence");
  const headers = stdout.slice(0, separator.index).split(/\r?\n/);
  if (!/^HTTP\/\d(?:\.\d)? 200(?:\s|$)/.test(headers.shift() ?? "")) throw new Error("Unsuccessful HTTP evidence");
  let link: string | undefined;
  for (const header of headers) {
    const match = /^([^:\s]+):[ \t]*(.*)$/.exec(header);
    if (match == null) throw new Error("Malformed HTTP headers");
    if (match[1]!.toLowerCase() === "link") {
      if (link !== undefined || !match[2]) throw new Error("Ambiguous pagination");
      link = match[2];
    }
  }
  return { data: JSON.parse(stdout.slice(separator.index + separator[0].length)) as unknown, link };
}

function nextPage(link: string | undefined, provider: ProviderSettings, input: SubmitReviewInput, reviewId: string): number | undefined {
  if (link === undefined) return undefined;
  let next: number | undefined;
  for (const entry of link.split(",")) {
    const match = /^\s*<([^<>]+)>\s*;\s*rel="([a-z ]+)"\s*$/.exec(entry);
    if (match == null) throw new Error("Malformed pagination");
    const url = new URL(match[1]!);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("Unsafe pagination");
    if (provider.id === "github" && (url.origin !== "https://api.github.com" || url.pathname !== `/repos/${input.repo}/pulls/${input.prNumber}/reviews/${reviewId}/comments`)) throw new Error("Foreign pagination");
    const pages = url.searchParams.getAll("page");
    const page = Number(pages[0]);
    if (pages.length !== 1 || !/^[1-9]\d*$/.test(pages[0]!) || !Number.isSafeInteger(page)) throw new Error("Invalid pagination page");
    if (match[2]!.split(" ").includes("next")) {
      if (next !== undefined) throw new Error("Ambiguous next page");
      next = page;
    }
  }
  return next;
}

function commentMatches(provider: ProviderSettings, remote: unknown, planned: ReviewInlineComment, input: SubmitReviewInput, reviewId: string, actor: SubmissionActor): boolean {
  const field = (name: string) => readConfiguredField(provider, `comment${name}`, remote);
  if (safeId(field("ReviewId")) !== reviewId || !matchesSubmissionActor(actor, field("AuthorId"), field("Author"))
    || field("Path") !== planned.path || field("Body") !== planned.body
    || field("CommitId") !== input.commitId || field("OriginalCommitId") !== input.commitId) return false;
  if (planned.subject_type === "file") {
    return field("SubjectType") === "file"
      && [planned.line, planned.side, planned.start_line, planned.start_side].every((value) => value == null)
      && ["Line", "Side", "StartLine", "StartSide", "OriginalLine", "OriginalStartLine"].every((name) => field(name) == null);
  }
  // Historical remapping does not prove the original side. Refuse changed anchors rather than guessing.
  if (!Number.isSafeInteger(planned.line) || planned.line! <= 0 || !["LEFT", "RIGHT"].includes(planned.side ?? "")) return false;
  return field("SubjectType") === "line" && field("Line") === planned.line && field("OriginalLine") === planned.line
    && field("Side") === planned.side && (field("StartLine") ?? null) === (planned.start_line ?? null)
    && (field("OriginalStartLine") ?? null) === (planned.start_line ?? null)
    && (field("StartSide") ?? null) === (planned.start_side ?? null);
}

/** Buffered read evidence only: never searches for attribution and never authorizes a retry. */
export async function reconcileSubmissionStep(
  pi: ExtensionAPI,
  input: SubmitReviewInput,
  provider: ProviderSettings,
  step: ReviewSubmissionStep,
  actor: SubmissionActor,
  budgets: { requests?: number; milliseconds?: number; bytes?: number } = {},
): Promise<ReviewSubmissionStep> {
  let canonical: string;
  try { canonical = renderProviderTemplate(provider.urls.canonical, { repo: input.repo, number: input.prNumber }); }
  catch { canonical = "the pull request on the provider"; }
  const unknown = (): ReviewSubmissionStep => ({ ...step, status: "unknown", message: `Submission could not be proven. Inspect ${canonical} and resolve this attempt before starting a new submission; no write was retried.` });
  const reviewId = safeId(step.reviewId);
  if (reviewId == null || step.reviewIdSource !== "write_response" || !input.commitId
    || (provider.id === "github" && !/^[1-9]\d*$/.test(reviewId))
    || !provider.operations.review || !provider.operations.reviewCommentsForReview) return unknown();
  const requests = Math.min(budgets.requests ?? 12, 12);
  const milliseconds = Math.min(budgets.milliseconds ?? 30_000, 30_000);
  const bytes = Math.min(budgets.bytes ?? 2 * 1024 * 1024, 2 * 1024 * 1024);
  if (![requests, milliseconds, bytes].every((value) => Number.isSafeInteger(value) && value > 0)) return unknown();
  const deadline = Date.now() + milliseconds;
  let usedRequests = 0;
  let usedBytes = 0;
  const read = async (operation: string, page = 1) => {
    const remaining = deadline - Date.now();
    if (usedRequests >= requests || remaining <= 0) throw new Error("Read budget exhausted");
    const configured = renderProviderOperation(provider, operation, { repo: input.repo, number: input.prNumber, reviewId, page });
    if (configured.method != null && configured.method !== "GET") throw new Error("Not a read operation");
    for (let index = 0; index < configured.args.length; index++) {
      const arg = configured.args[index]!;
      if ((arg === "--method" || arg === "-X") && configured.args[index + 1] !== "GET") throw new Error("Not a read operation");
      if (/^(?:--method=|-X).+/.test(arg) && arg !== "--method=GET" && arg !== "-XGET") throw new Error("Not a read operation");
      if (/^(?:--input|--field|--raw-field)(?:=|$)|^-[fF]/.test(arg)) throw new Error("Not a read operation");
    }
    usedRequests++;
    const result = await pi.exec(provider.executable, configured.args, { cwd: input.gitRoot, timeout: remaining });
    // pi.exec buffers responses; this limits accepted evidence, not transport or peak memory.
    usedBytes += Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);
    if (result.code !== 0 || result.killed || usedBytes > bytes || Date.now() >= deadline) throw new Error("Incomplete read");
    return parseResponse(result.stdout);
  };
  try {
    const review = await read("review");
    const field = (name: string) => readConfiguredField(provider, `submission${name}`, review.data);
    const state = { comment: "COMMENTED", approve: "APPROVED", request_changes: "CHANGES_REQUESTED" }[step.verdict];
    if (review.link != null || safeId(field("Id")) !== reviewId || field("State") !== state
      || field("CommitId") !== input.commitId || !matchesSubmissionActor(actor, field("AuthorId"), field("Author"))
      || field("Body") !== (step.bodyIncluded ? input.body?.trim() ?? "" : "")) return unknown();
    const comments = new Map<string, unknown>();
    const visited = new Set<number>();
    let page: number | undefined = 1;
    while (page !== undefined) {
      if (visited.has(page)) return unknown();
      visited.add(page);
      const response = await read("reviewCommentsForReview", page);
      if (!Array.isArray(response.data)) return unknown();
      if (response.data.length > 0 && ["ReplyToId", "Line", "Side", "StartLine", "StartSide", "OriginalLine", "OriginalStartLine"].some((name) => !provider.fields[`comment${name}`]?.length)) return unknown();
      for (const comment of response.data) {
        const id = safeId(readConfiguredField(provider, "commentId", comment));
        if (id == null || (comments.has(id) && !isDeepStrictEqual(comments.get(id), comment))) return unknown();
        const reply = readConfiguredField(provider, "commentReplyToId", comment);
        if (reply != null && (safeId(reply) == null || (provider.id === "github" && !/^[1-9]\d*$/.test(String(reply))))) return unknown();
        comments.set(id, comment);
      }
      const next = nextPage(response.link, provider, input, reviewId);
      if (next !== undefined && next !== page + 1) return unknown();
      page = next;
    }
    const roots = [...comments.values()].filter((comment) => safeId(readConfiguredField(provider, "commentReplyToId", comment)) == null);
    if (roots.length !== step.commentIndexes.length) return unknown();
    for (const index of step.commentIndexes) {
      const planned = Number.isSafeInteger(index) && index >= 0 ? input.comments?.[index] : undefined;
      if (planned == null) return unknown();
      const match = roots.findIndex((remote) => commentMatches(provider, remote, planned, input, reviewId, actor));
      if (match < 0) return unknown();
      roots.splice(match, 1);
    }
    return { ...step, status: "submitted", reviewId, commitId: input.commitId, message: "The write-bound review and its complete planned scope were confirmed." };
  } catch {
    return unknown();
  }
}
