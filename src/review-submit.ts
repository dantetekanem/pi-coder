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

export interface SubmitReviewResult {
  ok: boolean;
  message: string;
  blockedSelfApproval?: boolean;
}

interface ReviewSubmission {
  verdict: ReviewVerdict;
  body?: string;
  comments?: ReviewInlineComment[];
}

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

async function getCurrentLogin(pi: ExtensionAPI, input: SubmitReviewInput, provider: ProviderSettings): Promise<string | null> {
  if (provider.operations.identity == null) return null;
  const result = await executeOperation(pi, input, provider, "identity", { repo: input.repo, number: input.prNumber }, 15000);
  if (result.code !== 0 || result.stdout.trim().length === 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `${provider.label} identity lookup failed.`);
  const login = readConfiguredField(provider, "identityLogin", parseJson(result.stdout.trim(), provider, "current user"));
  if (typeof login !== "string" || login.length === 0) throw new Error(`Malformed ${provider.label} response for current user.`);
  return login;
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

async function postReview(pi: ExtensionAPI, input: SubmitReviewInput, provider: ProviderSettings, submission: ReviewSubmission): Promise<SubmitReviewResult> {
  const payload = buildReviewPayload({ ...input, verdict: submission.verdict, body: submission.body, comments: submission.comments }, provider);
  const directory = mkdtempSync(join(tmpdir(), "pi-code-diff-review-"));
  const payloadPath = join(directory, "review.json");
  try {
    writeFileSync(payloadPath, JSON.stringify(payload), { encoding: "utf8", mode: 0o600 });
    const result = await executeOperation(pi, input, provider, "submitReview", { repo: input.repo, number: input.prNumber, payloadPath }, 20000);
    if (result.code !== 0) return { ok: false, message: result.stderr.trim() || result.stdout.trim() || `${provider.label} review submission failed.` };
    if (getProviderCapability(provider, "validateSubmitResponse")) {
      const parsed = parseJson(result.stdout.trim(), provider, "review submission");
      const id = readConfiguredField(provider, "submissionId", parsed);
      const state = readConfiguredField(provider, "submissionState", parsed);
      if ((typeof id !== "number" && typeof id !== "string") || typeof state !== "string") {
        return { ok: false, message: `Malformed ${provider.label} response after review submission; inspect the PR before retrying.` };
      }
    }
    return { ok: true, message: "submitted" };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export async function submitPullRequestReview(pi: ExtensionAPI, input: SubmitReviewInput): Promise<SubmitReviewResult> {
  let provider: ProviderSettings;
  try {
    provider = providerForInput(input);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  const invalidComment = validateReviewComments(input, provider);
  if (invalidComment != null) return { ok: false, message: invalidComment };

  if (input.verdict === "approve") {
    try {
      const me = await getCurrentLogin(pi, input, provider);
      if (me != null && input.prAuthorLogin != null && me.toLowerCase() === input.prAuthorLogin.toLowerCase()) {
        return {
          ok: false,
          blockedSelfApproval: true,
          message: `Refusing to approve your own pull request. You are signed in as ${me}, who authored PR #${input.prNumber}. ${provider.label} does not allow self-approval. Use Comment or Request changes instead.`,
        };
      }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  const hasBody = input.body != null && input.body.trim().length > 0;
  const hasComments = (input.comments?.length ?? 0) > 0;
  if (input.verdict === "request_changes" && !hasBody && (!hasComments || getProviderCapability(provider, "requestChangesBodyRequired"))) {
    return { ok: false, message: getProviderCapability(provider, "requestChangesBodyRequired")
      ? `${provider.label} request changes needs a review body.`
      : "Request changes needs a review body or at least one inline comment." };
  }

  try {
    await validateLiveTarget(pi, input, provider);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }

  const body = input.body?.trim();
  const comments = input.comments ?? [];
  if (input.verdict === "approve" && comments.length > 0 && !getProviderCapability(provider, "atomicReview")) {
    const commentResult = await postReview(pi, input, provider, { verdict: "comment", comments });
    if (!commentResult.ok) return { ok: false, message: `Could not add review comments before approval: ${commentResult.message}` };
    const approvalResult = await postReview(pi, input, provider, { verdict: "approve", body });
    if (!approvalResult.ok) return { ok: false, message: `Review comments were added, but approval failed: ${approvalResult.message}` };
    return { ok: true, message: formatReviewSummary(input, provider, comments.length, body != null && body.length > 0) };
  }

  const result = await postReview(pi, input, provider, { verdict: input.verdict, body, comments });
  if (!result.ok) return result;
  return { ok: true, message: formatReviewSummary(input, provider, comments.length, body != null && body.length > 0) };
}
