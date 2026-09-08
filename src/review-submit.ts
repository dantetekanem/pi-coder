import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  getProviderCapability,
  readConfiguredField,
  renderProviderOperation,
  renderProviderTemplate,
  requireProviderSettings,
  type ProviderSettings,
} from "./provider-settings.js";
import type { PullRequestProvider } from "./remote.js";
import type { DiffReviewComment, ReviewFile, ReviewSubmitPayload } from "./types.js";
import { joinReviewPath } from "./types.js";
import { saveReviewReceipt, type ReviewReceipt } from "./review-receipts.js";
import { sanitizeTerminalText } from "./sanitize.js";
import { createSubmissionJournal, submissionFingerprint, submissionPayloadDigest, SubmissionAttemptConflictError, type SubmissionActor, type SubmissionAttempt, type SubmissionDraftBinding, type SubmissionHandoff } from "./review-submission-journal.js";
import { matchesSubmissionActor, reconcileSubmissionStep } from "./review-submission-reconcile.js";
import { consumeConfirmedSubmissionDraft, type SubmissionDraftConsumption } from "./review-submission-consumption.js";

export type ReviewVerdict = "approve" | "request_changes" | "comment";

export interface ReviewInlineComment {
  path: string;
  body: string;
  line?: number;
  side?: "LEFT" | "RIGHT";
  start_line?: number;
  start_side?: "LEFT" | "RIGHT";
  subject_type?: "file";
}

export interface SubmitReviewInput {
  provider: PullRequestProvider;
  repo: string;
  prNumber: string;
  commitId: string;
  baseCommitId?: string;
  verdict: ReviewVerdict;
  body?: string;
  comments?: ReviewInlineComment[];
  prAuthorLogin?: string;
  gitRoot?: string;
}

export interface SubmitReviewOptions {
  attemptId?: string;
  handoffId?: string;
  handoffCommentIndexes?: number[];
  newIntent?: boolean;
  sourceDigest?: string;
  draft?: SubmissionDraftBinding;
}

export type ReviewSubmissionStep = {
  kind: "review" | "comments" | "verdict";
  verdict: ReviewVerdict;
  /** Planned payload scope; accepted only when this step is submitted. */
  bodyIncluded: boolean;
  /** Indexes in the final confirmed input, not in the pre-grammar draft. */
  commentIndexes: number[];
  commitId?: string;
  url?: string;
  selfPrincipalId?: string;
  /** Only the ID observed in this step's own write response, never a search candidate. */
  reviewIdSource?: "write_response";
  /** Client admission/observation times, not a proven server acceptance window. */
  startedAt?: string;
  observedAt?: string;
  message?: string;
} & (
  | { status: "submitted"; reviewId: string }
  | { status: "pending" | "unknown" | "rejected"; reviewId?: string }
);

export type SubmitReviewResult = {
  message: string;
  reviewedCommitId: string;
  url?: string;
  steps: ReviewSubmissionStep[];
  receiptStatus: "saved" | "failed" | "not_applicable";
  receipt: ReviewReceipt | null;
  blockedSelfApproval?: boolean;
  attemptId?: string;
  journalStatus?: "saved" | "failed";
  draftConsumption?: SubmissionDraftConsumption;
} & (
  | { ok: true; status: "submitted" }
  | { ok: false; status: "partial" | "unknown" | "rejected" }
);

const EVENT_BY_VERDICT: Record<ReviewVerdict, string> = {
  approve: "APPROVE",
  request_changes: "REQUEST_CHANGES",
  comment: "COMMENT",
};

function getCommentFilePath(files: ReviewFile[], fileId: string): string {
  const file = files.find((candidate) => candidate.id === fileId);
  return file == null ? fileId : joinReviewPath(file.pathPrefix, file.path);
}

function cleanReviewText(text: string): string {
  return text.trim().replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
}

function formatModifyInlineBody(comment: DiffReviewComment): string {
  const oldText = comment.originalText;
  if (oldText == null || oldText.length === 0) return comment.body;
  const lines = ["Suggested change:", "", "```diff"];
  for (const line of oldText.split(/\r\n|\n|\r/)) lines.push(`- ${line}`);
  for (const line of comment.body.split(/\r\n|\n|\r/)) lines.push(`+ ${line}`);
  lines.push("```");
  return lines.join("\n");
}

function getInlineCommentBody(comment: DiffReviewComment): string {
  return comment.intent === "modify" ? formatModifyInlineBody(comment) : cleanReviewText(comment.body);
}

export function buildInlineComments(files: ReviewFile[], comments: DiffReviewComment[]): ReviewInlineComment[] {
  const inline: ReviewInlineComment[] = [];
  for (const comment of comments) {
    if (comment.intent !== "comment" && comment.intent !== "modify") continue;
    if (comment.side === "file" || comment.startLine == null) continue;
    const file = files.find((candidate) => candidate.id === comment.fileId);
    if (file?.pathPrefix != null) continue;
    const side = comment.side === "deleted" ? "LEFT" : "RIGHT";
    const line = comment.endLine ?? comment.startLine;
    const entry: ReviewInlineComment = { path: getCommentFilePath(files, comment.fileId), line, side, body: getInlineCommentBody(comment) };
    if (comment.startLine !== line) {
      entry.start_line = comment.startLine;
      entry.start_side = side;
    }
    inline.push(entry);
  }
  return inline;
}

export function buildProviderComments(
  files: ReviewFile[],
  comments: DiffReviewComment[],
  allowFileComments: boolean,
  providerLabel: string,
): ReviewInlineComment[] {
  if (!allowFileComments) return buildInlineComments(files, comments);
  const result: ReviewInlineComment[] = [];
  for (const comment of comments) {
    if (comment.intent !== "comment" && comment.intent !== "modify") continue;
    const file = files.find((candidate) => candidate.id === comment.fileId);
    if (file == null || file.pathPrefix != null) throw new Error(`${providerLabel} cannot safely map review comment ${comment.id} to a repository path.`);
    const body = getInlineCommentBody(comment);
    if (body.trim().length === 0) throw new Error(`${providerLabel} review comment ${comment.id} has an empty body.`);
    const path = getCommentFilePath(files, comment.fileId);
    if (comment.side === "file") {
      if (comment.intent === "modify") throw new Error(`${providerLabel} cannot safely map file-level MODIFY comment ${comment.id}.`);
      result.push({ path, subject_type: "file", body });
      continue;
    }
    if (comment.startLine == null) throw new Error(`${providerLabel} cannot safely map review comment ${comment.id} without a line.`);
    const side = comment.side === "deleted" ? "LEFT" : "RIGHT";
    const line = comment.endLine ?? comment.startLine;
    const entry: ReviewInlineComment = { path, line, side, body };
    if (comment.startLine !== line) {
      entry.start_line = comment.startLine;
      entry.start_side = side;
    }
    result.push(entry);
  }
  return result;
}

export function buildReviewBody(files: ReviewFile[], payload: ReviewSubmitPayload, includeFileComments = true): string | undefined {
  const sections: string[] = [];
  const allComment = cleanReviewText(payload.allComment);
  if (payload.allIntent === "comment" && allComment.length > 0) sections.push(allComment);
  for (const comment of payload.comments) {
    if (!includeFileComments || comment.intent !== "comment" || comment.side !== "file") continue;
    const body = cleanReviewText(comment.body);
    if (body.length > 0) sections.push(`${getCommentFilePath(files, comment.fileId)}:\n${body}`);
  }
  return sections.length > 0 ? sections.join("\n\n") : undefined;
}

function providerForInput(input: SubmitReviewInput): ProviderSettings {
  return requireProviderSettings(input.provider);
}

export function buildReviewPayload(input: SubmitReviewInput, provider = providerForInput(input)): Record<string, unknown> {
  const payload: Record<string, unknown> = { event: EVENT_BY_VERDICT[input.verdict] };
  const body = input.body?.trim();
  if (body != null && body.length > 0) payload.body = body;
  if (getProviderCapability(provider, "commitIdRequired") || (input.comments?.length ?? 0) > 0) payload.commit_id = input.commitId;
  if ((input.comments?.length ?? 0) > 0) payload.comments = input.comments;
  return payload;
}

function formatReviewSummary(input: SubmitReviewInput, provider: ProviderSettings, commentCount: number, bodyIncluded: boolean): string {
  const url = renderProviderTemplate(provider.urls.canonical, { repo: input.repo, number: input.prNumber });
  const time = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
  const action = input.verdict === "approve" ? "PR was approved" : input.verdict === "request_changes" ? "Changes were requested" : "Review comment was posted";
  const comments = commentCount === 0 ? "No inline comments were added." : `${commentCount} inline comment${commentCount === 1 ? " was" : "s were"} added.`;
  const body = bodyIncluded
    ? input.verdict === "approve"
      ? "Your review body comment was included in the approval."
      : input.verdict === "request_changes"
        ? "Your review body comment was included in the change request."
        : "Your review body comment was included."
    : undefined;
  return [url, `${action} at ${time}.`, comments, body].filter((line): line is string => line != null).join("\n");
}

function parseJson(value: string, provider: ProviderSettings, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`Malformed ${provider.label} response for ${label}.`);
  }
}

async function executeOperation(
  pi: ExtensionAPI,
  input: SubmitReviewInput,
  provider: ProviderSettings,
  operation: string,
  values: Record<string, string | number>,
  timeout: number,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const configured = renderProviderOperation(provider, operation, values);
  return pi.exec(provider.executable, configured.args, { cwd: input.gitRoot, timeout });
}

async function getCurrentActor(pi: ExtensionAPI, input: SubmitReviewInput, provider: ProviderSettings): Promise<SubmissionActor> {
  if (provider.operations.identity == null) throw new Error(`${provider.label} must configure identity before a submission intent can be confirmed.`);
  const result = await executeOperation(pi, input, provider, "identity", { repo: input.repo, number: input.prNumber }, 15000);
  if (result.code !== 0 || result.stdout.trim().length === 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `${provider.label} identity lookup failed.`);
  const parsed = parseJson(result.stdout.trim(), provider, "current user");
  const id = remoteId(readConfiguredField(provider, "identityId", parsed));
  const login = readConfiguredField(provider, "identityLogin", parsed);
  if (typeof login !== "string" || login.length === 0) throw new Error(`Malformed ${provider.label} response for current user.`);
  return id == null ? { kind: "login", value: login, login } : { kind: "id", value: id, login };
}

async function validateLiveTarget(pi: ExtensionAPI, input: SubmitReviewInput, provider: ProviderSettings): Promise<void> {
  if (!getProviderCapability(provider, "validateTargetBeforeSubmit")) return;
  const result = await executeOperation(pi, input, provider, "pullRequest", { repo: input.repo, number: input.prNumber }, 15000);
  if (result.code !== 0 || result.stdout.trim().length === 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `${provider.label} target validation failed.`);
  const parsed = parseJson(result.stdout.trim(), provider, `PR #${input.prNumber} target`);
  const state = readConfiguredField(provider, "state", parsed);
  const head = readConfiguredField(provider, "headRefOid", parsed);
  if (typeof state !== "string" || typeof head !== "string") throw new Error(`Malformed ${provider.label} response for PR #${input.prNumber} target validation.`);
  if (state.toLowerCase() !== "open") throw new Error(`${provider.label} PR #${input.prNumber} is no longer open.`);
  if (head !== input.commitId) throw new Error(`${provider.label} PR #${input.prNumber} head changed from ${input.commitId} to ${head}. Reopen the review before submitting.`);
}

function validateReviewComments(input: SubmitReviewInput, provider: ProviderSettings): string | undefined {
  for (const [index, comment] of (input.comments ?? []).entries()) {
    const segments = comment.path.split("/");
    if (comment.path.length === 0 || comment.path.startsWith("/") || comment.path.includes("\\") || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
      return `Review comment ${index + 1} has an unsafe repository path.`;
    }
    if (comment.body.trim().length === 0) return `Review comment ${index + 1} has an empty body.`;
    if (comment.subject_type === "file") {
      if (!getProviderCapability(provider, "fileComments")) return `File-level review comment ${index + 1} is not supported by ${provider.label}.`;
      if (comment.line != null || comment.side != null || comment.start_line != null || comment.start_side != null) return `File-level review comment ${index + 1} contains unsupported line fields.`;
      continue;
    }
    if (!Number.isInteger(comment.line) || comment.line == null || comment.line < 1 || (comment.side !== "LEFT" && comment.side !== "RIGHT")) {
      return `Review comment ${index + 1} has an unsupported inline location.`;
    }
    if (comment.start_line != null && (!Number.isInteger(comment.start_line) || comment.start_line < 1 || comment.start_line > comment.line || comment.start_side !== comment.side)) {
      return `Review comment ${index + 1} has an unsupported inline range.`;
    }
  }
  return undefined;
}

const STATE_BY_VERDICT: Record<ReviewVerdict, string> = {
  approve: "APPROVED", request_changes: "CHANGES_REQUESTED", comment: "COMMENTED",
};

function remoteId(value: unknown): string | undefined {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;
  return typeof value === "string" && value.trim().length > 0 && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : undefined;
}

function reviewUrl(value: unknown, canonical: string): string {
  try {
    const url = new URL(typeof value === "string" ? value : canonical);
    if (url.origin === new URL(canonical).origin && !url.username && !url.password) return url.href;
  } catch { /* Keep the configured target link when the response has no usable review link. */ }
  return canonical;
}

function readSubmissionResponse(
  input: SubmitReviewInput, provider: ProviderSettings, planned: ReviewSubmissionStep,
  result: { stdout: string; stderr: string; code: number; killed?: boolean }, actor: SubmissionActor,
): ReviewSubmissionStep {
  const header = result.stdout.match(/^HTTP\/[\d.]+ (\d{3})[^\r\n]*\r?\n/);
  const separator = header == null ? undefined : /\r?\n\r?\n/.exec(result.stdout);
  const statusCode = header == null ? undefined : Number(header[1]);
  const body = separator == null ? result.stdout : result.stdout.slice(separator.index + separator[0].length);
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { /* A write with no usable response remains unknown. */ }
  const id = remoteId(readConfiguredField(provider, "submissionId", parsed));
  const state = readConfiguredField(provider, "submissionState", parsed);
  const commit = readConfiguredField(provider, "submissionCommitId", parsed);
  const principal = readConfiguredField(provider, "submissionAuthor", parsed);
  const principalId = readConfiguredField(provider, "submissionAuthorId", parsed);
  const canonical = renderProviderTemplate(provider.urls.canonical, { repo: input.repo, number: input.prNumber });
  const evidence: ReviewSubmissionStep = {
    ...planned, status: "unknown", ...(id == null ? {} : { reviewId: id, reviewIdSource: "write_response" }),
    ...(typeof commit === "string" ? { commitId: commit } : {}),
    ...(typeof principal === "string" ? { selfPrincipalId: principal } : {}),
    url: reviewUrl(readConfiguredField(provider, "submissionUrl", parsed), canonical),
  };
  if (result.killed || result.code !== 0 || (statusCode != null && (statusCode < 200 || statusCode >= 300))) {
    const rejected = id == null && !result.killed && statusCode != null && [401, 403, 404, 405, 413, 422].includes(statusCode);
    return { ...evidence, status: rejected ? "rejected" : "unknown", message: result.stderr.trim() || (statusCode == null ? "Provider write outcome is uncertain." : `Provider returned HTTP ${statusCode}.`) };
  }
  if (id == null || typeof state !== "string") return { ...evidence, message: `Malformed ${provider.label} response after review submission; inspect the PR before retrying.` };
  if (state.toUpperCase() !== STATE_BY_VERDICT[planned.verdict]) return { ...evidence, message: `Unexpected ${provider.label} review state ${sanitizeTerminalText(state)}; acceptance is unknown.` };
  if (commit != null && commit !== input.commitId) return { ...evidence, message: `${provider.label} returned a different reviewed commit; acceptance of this payload is unknown.` };
  if ((principal !== undefined || principalId !== undefined) && !matchesSubmissionActor(actor, principalId, principal)) return { ...evidence, message: `${provider.label} response actor does not establish the captured reviewer; acceptance is unknown.` };
  return { ...evidence, status: "submitted", reviewId: id };
}

async function postReview(pi: ExtensionAPI, input: SubmitReviewInput, provider: ProviderSettings, planned: ReviewSubmissionStep, actor: SubmissionActor): Promise<ReviewSubmissionStep> {
  let directory: string | undefined;
  let started = false;
  let outcome: ReviewSubmissionStep = { ...planned, status: "rejected" };
  try {
    const payload = buildReviewPayload({ ...input, verdict: planned.verdict, body: planned.bodyIncluded ? input.body : undefined, comments: planned.commentIndexes.map((index) => input.comments![index]!) }, provider);
    directory = mkdtempSync(join(tmpdir(), "pi-code-diff-review-"));
    const payloadPath = join(directory, "review.json");
    writeFileSync(payloadPath, JSON.stringify(payload), { encoding: "utf8", mode: 0o600 });
    const operation = renderProviderOperation(provider, "submitReview", { repo: input.repo, number: input.prNumber, payloadPath });
    started = true;
    const result = await pi.exec(provider.executable, operation.args, { cwd: input.gitRoot, timeout: 20000 });
    outcome = readSubmissionResponse(input, provider, planned, result, actor);
  } catch (error) {
    outcome = { ...outcome, status: started ? "unknown" : "rejected", message: error instanceof Error ? error.message : String(error) };
  } finally {
    if (directory != null) {
      try { rmSync(directory, { recursive: true, force: true }); }
      catch { outcome = { ...outcome, message: [outcome.message, "The private temporary request file could not be removed."].filter(Boolean).join(" ") }; }
    }
  }
  return outcome;
}

function submissionResult(input: SubmitReviewInput, provider: ProviderSettings | undefined, steps: ReviewSubmissionStep[], message?: string, principal?: string | null): SubmitReviewResult {
  const accepted = steps.filter((step) => step.status === "submitted");
  const status = steps.length > 0 && accepted.length === steps.length ? "submitted"
    : accepted.length > 0 ? "partial" : steps.some((step) => step.status === "unknown") ? "unknown" : "rejected";
  const canonical = provider == null ? undefined : renderProviderTemplate(provider.urls.canonical, { repo: input.repo, number: input.prNumber });
  const url = [...steps].reverse().find((step) => step.reviewId != null)?.url ?? canonical;
  let receipt: ReviewReceipt | null = null;
  if (accepted.length > 0 && url != null) {
    try {
      receipt = saveReviewReceipt({
        provider: input.provider, repo: input.repo, number: input.prNumber, url,
        verdict: accepted.at(-1)!.verdict, intendedVerdict: input.verdict, outcome: status === "submitted" ? "submitted" : "partial",
        reviewIds: accepted.map((step) => step.reviewId), selfPrincipalId: principal ?? accepted.at(-1)!.selfPrincipalId,
        headSha: input.commitId, body: accepted.some((step) => step.bodyIncluded) ? input.body : undefined,
        comments: accepted.flatMap((step) => step.commentIndexes.map((index) => input.comments![index]!)),
      });
    } catch { /* Never turn a known remote result into an invitation to repeat it. */ }
  }
  const receiptStatus: SubmitReviewResult["receiptStatus"] = accepted.length === 0 ? "not_applicable" : receipt == null ? "failed" : "saved";
  const summary = status === "submitted" && provider != null
    ? message ?? formatReviewSummary(input, provider, input.comments?.length ?? 0, input.body != null && input.body.trim().length > 0)
    : [url, message ?? steps.find((step) => step.status !== "submitted" && step.status !== "pending")?.message ?? "Review was not submitted."].filter(Boolean).join("\n");
  const details = [
    status === "partial" ? "Some review steps were submitted; the remaining verdict or comments were not confirmed." : undefined,
    summary, `Reviewed commit: ${input.commitId}.`,
    status === "unknown" || status === "partial" ? "Do not repost confirmed or uncertain steps; inspect the PR before retrying." : undefined,
    receiptStatus === "failed" ? "Remote acceptance is confirmed, but the local receipt could not be saved. Do not repost." : undefined,
    ...accepted.flatMap((step) => step.message == null ? [] : [step.message]),
  ].filter(Boolean).join("\n");
  const common = { message: details.split("\n").map(sanitizeTerminalText).join("\n"), reviewedCommitId: input.commitId, url, steps, receiptStatus, receipt };
  return status === "submitted" ? { ...common, status, ok: true } : { ...common, status, ok: false };
}

function submissionPlan(input: SubmitReviewInput, provider: ProviderSettings): ReviewSubmissionStep[] {
  const commentIndexes = (input.comments ?? []).map((_comment, index) => index);
  const bodyIncluded = Boolean(input.body?.trim());
  return input.verdict === "approve" && commentIndexes.length > 0 && !getProviderCapability(provider, "atomicReview")
    ? [{ kind: "comments", verdict: "comment", bodyIncluded: false, commentIndexes, status: "pending" }, { kind: "verdict", verdict: "approve", bodyIncluded, commentIndexes: [], status: "pending" }]
    : [{ kind: "review", verdict: input.verdict, bodyIncluded, commentIndexes, status: "pending" }];
}

function submissionProviderDigest(provider: ProviderSettings): string {
  return submissionFingerprint({ executable: provider.executable, canonical: provider.urls.canonical,
    operations: [provider.operations.submitReview, provider.operations.identity, provider.operations.pullRequest],
    capabilities: provider.capabilities,
    fields: Object.fromEntries(Object.entries(provider.fields).filter(([name]) => ["identityId", "identityLogin", "submissionId", "submissionState", "submissionCommitId", "submissionAuthorId", "submissionAuthor", "state", "headRefOid"].includes(name))),
  });
}

export function prepareSubmissionHandoff(input: SubmitReviewInput, context: { sourceDigest: string; draft: SubmissionDraftBinding }): SubmissionHandoff {
  const captured = structuredClone({ input, ...context });
  return createSubmissionJournal().saveHandoff({ ...captured, providerDigest: submissionProviderDigest(providerForInput(captured.input)) });
}

function handoffTarget(input: SubmitReviewInput): string {
  return submissionFingerprint([input.provider, input.provider === "github" ? input.repo.toLowerCase() : input.repo, input.prNumber, input.commitId, input.gitRoot ?? null]);
}
function commentGeometry(comment: ReviewInlineComment): string {
  return submissionFingerprint([comment.path, comment.subject_type ?? "line", comment.line ?? null, comment.side ?? null, comment.start_line ?? comment.line ?? null, comment.start_side ?? comment.side ?? null]);
}
function resolveHandoff(input: SubmitReviewInput, provider: ProviderSettings, handoff: SubmissionHandoff, indexes: number[] | undefined): SubmissionDraftBinding {
  if (handoffTarget(input) !== handoffTarget(handoff.input) || handoff.providerDigest !== submissionProviderDigest(provider)) throw new Error("The grammar handoff target, revision, execution directory or provider contract changed; reopen the review for a new decision.");
  const comments = input.comments ?? [];
  const selected = indexes ?? (comments.length === 0 ? [] : undefined);
  if (selected == null || selected.length !== comments.length || new Set(selected).size !== selected.length
    || selected.some((index, position) => !Number.isSafeInteger(index) || index < 0 || index >= (handoff.input.comments?.length ?? 0)
      || commentGeometry(handoff.input.comments![index]!) !== commentGeometry(comments[position]!))) throw new Error("The grammar handoff requires one valid original index per final comment, with its original location unchanged.");
  return { ...structuredClone(handoff.draft), comments: selected.map((index) => structuredClone(handoff.draft.comments[index]!)),
    ...(input.body?.trim() ? {} : { bodyComments: [], allCommentFingerprint: undefined }),
  };
}

export async function submitPullRequestReview(pi: ExtensionAPI, input: SubmitReviewInput, options: SubmitReviewOptions = {}): Promise<SubmitReviewResult> {
  let provider: ProviderSettings | undefined;
  let actor: SubmissionActor | undefined;
  let attempt: SubmissionAttempt | undefined;
  let steps: ReviewSubmissionStep[] = [];
  let journalStatus: "saved" | "failed" = "saved";
  let observedResultUnsaved = false;
  let wrote = false;
  const finish = (message?: string): SubmitReviewResult => {
    const result = { ...submissionResult(input, provider, steps, message, actor?.login), ...(attempt == null ? {} : { attemptId: attempt.id, journalStatus }) };
    let draftConsumption: SubmissionDraftConsumption = { status: "not_applicable" };
    if (attempt?.draft != null && steps.some((step) => step.status === "submitted")) {
      if (journalStatus === "failed") {
        draftConsumption = { status: "retained", message: "Drafts retained because confirmed response evidence could not be saved in the intent journal. Do not repost." };
      } else {
        try { draftConsumption = consumeConfirmedSubmissionDraft(attempt); }
        catch (error) { draftConsumption = { status: "failed", message: `Draft cleanup failed; saved feedback was retained. ${error instanceof Error ? error.message : String(error)}` }; }
      }
    }
    const localMessage = draftConsumption.message?.split("\n").map(sanitizeTerminalText).join("\n");
    return { ...result, draftConsumption, message: localMessage == null ? result.message : `${result.message}\n${localMessage}` };
  };
  try {
    // Capture approval before the first await, not from caller-owned arrays after preflight.
    input = structuredClone(input);
    options = structuredClone(options);
    if (options.handoffId != null && options.attemptId != null) throw new Error("Use a pending handoff or a confirmed attempt, not both.");
    if (options.handoffCommentIndexes != null && options.handoffId == null) throw new Error("Original comment indexes require a trusted grammar handoff.");
    const journal = createSubmissionJournal();
    const persistSteps = (updated: ReviewSubmissionStep[], observedResult = false) => {
      journalStatus = "failed";
      observedResultUnsaved = observedResult;
      attempt = journal.update(attempt!.id, attempt!.generation, updated);
      observedResultUnsaved = false;
      journalStatus = "saved";
      return structuredClone(attempt.steps);
    };
    if (options.attemptId != null) {
      if (options.newIntent) throw new Error("Choose an existing attempt or an explicitly new intent, not both.");
      attempt = journal.load(options.attemptId) ?? undefined;
      if (attempt == null) throw new Error("Submission attempt is missing; it cannot authorize a new write.");
      if (attempt.payloadDigest !== submissionPayloadDigest(input)) {
        attempt = undefined;
        throw new Error("Confirmed submission payload or target changed. Make a new review decision; this attempt was not changed.");
      }
      input = structuredClone(attempt.input);
      actor = attempt.actor;
      steps = structuredClone(attempt.steps);
      if (steps.every((step) => step.status === "submitted")) return finish("This submission attempt was already confirmed. No provider write was repeated.");
    }
    provider = structuredClone(providerForInput(input));
    renderProviderTemplate(provider.urls.canonical, { repo: input.repo, number: input.prNumber });
    renderProviderOperation(provider, "submitReview", { repo: input.repo, number: input.prNumber, payloadPath: "prepared-review.json" });
    const invalidComment = validateReviewComments(input, provider);
    if (invalidComment != null) throw new Error(invalidComment);
    if (input.verdict === "request_changes" && !input.body?.trim() && ((input.comments?.length ?? 0) === 0 || getProviderCapability(provider, "requestChangesBodyRequired"))) {
      throw new Error(getProviderCapability(provider, "requestChangesBodyRequired") ? `${provider.label} request changes needs a review body.` : "Request changes needs a review body or at least one inline comment.");
    }
    if (options.handoffId != null) {
      const handoff = journal.loadHandoff(options.handoffId);
      if (handoff == null) throw new Error("Grammar handoff is missing; its source context cannot authorize a submission.");
      options = { ...options, sourceDigest: handoff.sourceDigest, draft: resolveHandoff(input, provider, handoff, options.handoffCommentIndexes) };
    }
    let currentActor: SubmissionActor | undefined;
    if (attempt == null) {
      currentActor = await getCurrentActor(pi, input, provider);
      journalStatus = "failed";
      const created = journal.create({ input, actor: currentActor, providerDigest: submissionProviderDigest(provider), sourceDigest: options.sourceDigest, draft: options.draft, handoffId: options.handoffId, steps: submissionPlan(input, provider) }, options.newIntent);
      journalStatus = "saved";
      attempt = created.attempt;
      input = structuredClone(attempt.input);
      actor = attempt.actor;
      steps = structuredClone(attempt.steps);
    }
    if (steps.every((step) => step.status === "submitted")) return finish("This submission attempt was already confirmed. No provider write was repeated.");
    if (attempt.providerDigest !== submissionProviderDigest(provider)) throw new Error("The confirmed provider contract changed. Inspect this attempt before making a new review decision.");
    for (let index = 0; index < steps.length; index++) {
      if (steps[index]!.status === "submitted") continue;
      if (steps[index]!.status === "unknown") {
        const reconciled = await reconcileSubmissionStep(pi, input, provider, steps[index]!, actor!);
        if (reconciled.status !== "submitted") { steps[index] = { ...reconciled, status: "unknown" }; break; }
        steps[index] = reconciled;
        steps = persistSteps(steps, true);
        continue;
      }
      currentActor ??= await getCurrentActor(pi, input, provider);
      if (!matchesSubmissionActor(actor!, currentActor.kind === "id" ? currentActor.value : undefined, currentActor.login)) throw new Error("The signed-in reviewer differs from this confirmed intent. No remaining step was posted.");
      if (input.verdict === "approve" && input.prAuthorLogin != null && currentActor.login?.toLowerCase() === input.prAuthorLogin.toLowerCase()) {
        return { ...finish(`Refusing to approve your own pull request. You are signed in as ${currentActor.login}, who authored PR #${input.prNumber}. ${provider.label} does not allow self-approval. Use Comment or Request changes instead.`), blockedSelfApproval: true };
      }
      await validateLiveTarget(pi, input, provider);
      currentActor = undefined;
      const planned = steps[index]!;
      const admitted = [...steps];
      admitted[index] = { kind: planned.kind, verdict: planned.verdict, bodyIncluded: planned.bodyIncluded, commentIndexes: planned.commentIndexes, status: "unknown", startedAt: new Date().toISOString() };
      steps = persistSteps(admitted);
      wrote = true;
      steps[index] = { ...await postReview(pi, input, provider, steps[index]!, actor!), observedAt: new Date().toISOString() };
      steps = persistSteps(steps, true);
      if (steps[index]!.status !== "submitted") break;
    }
    return finish(!wrote && steps.every((step) => step.status === "submitted") ? "Recovered confirmed review evidence. No provider write was repeated." : undefined);
  } catch (error) {
    // Admission conflicts adopt durable evidence; failed observation saves must not erase this call's result.
    if (error instanceof SubmissionAttemptConflictError && !observedResultUnsaved) {
      attempt = error.current;
      steps = structuredClone(attempt.steps);
      actor = attempt.actor;
      journalStatus = "saved";
    }
    const message = sanitizeTerminalText(error instanceof Error ? error.message : String(error));
    const result = finish(message);
    const persistenceWarning = journalStatus !== "failed" ? "" : result.ok
      ? "\nRemote acceptance is confirmed, but the local intent update failed. Do not repost."
      : "\nLocal intent persistence failed; existing evidence was retained.";
    return { ...result, message: `${result.message}${persistenceWarning}${attempt == null ? "" : `\nAttempt: ${attempt.id}. Retained confirmed or uncertain steps must not be reposted.`}` };
  }
}
