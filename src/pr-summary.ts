import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ReviewContextPanelSource } from "./types.js";
import { hasHandoffContext } from "./pr-handoff.js";
import {
  getProviderCapability,
  readConfiguredField,
  renderProviderOperation,
  renderProviderTemplate,
  requireProviderSettings,
  type ProviderSettings,
} from "./provider-settings.js";
import type { RemoteReviewTarget } from "./remote.js";

interface PullRequestAuthor {
  login?: string;
}

interface PullRequestComment {
  author?: PullRequestAuthor;
  body?: string;
  createdAt?: string;
  submittedAt?: string;
  state?: string;
  url?: string;
  path?: string;
  line?: number | null;
}

interface PullRequestThread {
  path?: string;
  line?: number | null;
  isResolved?: boolean;
  isOutdated?: boolean;
  comments?: PullRequestComment[];
}

interface PullRequestCheck {
  name?: string;
  workflowName?: string;
  status?: string;
  conclusion?: string;
}

interface PullRequestDetails {
  url?: string;
  isDraft?: boolean;
  checksUnavailable?: boolean;
  mergeStateStatus?: string;
  reviewDecision?: string;
  comments?: PullRequestComment[];
  reviews?: PullRequestComment[];
  openReviewThreads?: PullRequestThread[];
  statusCheckRollup?: PullRequestCheck[];
  createdAt?: string;
  updatedAt?: string;
}

interface StatusSummary {
  status: "pending" | "blocked" | "approved";
  reason: string;
}

const SUMMARY_LABELS = new Set(["Title", "URL", "Author", "Diff", "Status", "Problem", "Changes", "Validation", "Open comments", "Stack"]);

const QUERY_OPEN_TOKEN = "__CODE_DIFF_QUERY_OPEN__";
const QUERY_CLOSE_TOKEN = "__CODE_DIFF_QUERY_CLOSE__";

const OPEN_REVIEW_THREADS_QUERY = `
query PullRequestOpenThreads($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 50) {
        nodes {
          isResolved
          isOutdated
          path
          line
          comments(first: 20) {
            nodes {
              author { login }
              body
              createdAt
              url
              path
              line
            }
          }
        }
      }
    }
  }
}`;

function providerForTarget(target: RemoteReviewTarget): ProviderSettings {
  const providerId = target.provider ?? target.handoff?.provider;
  if (providerId == null) throw new Error("Remote pull request provider is not configured.");
  return requireProviderSettings(providerId);
}

function pullRequestUrl(target: RemoteReviewTarget, provider: ProviderSettings): string {
  const pr = target.pullRequest!;
  const repo = target.repo ?? pr.repo;
  if (repo == null) return target.remote;
  return renderProviderTemplate(provider.urls.canonical, { repo, number: pr.number });
}

function normalizePlainText(value: string): string {
  return value
    .replace(/\\+x0a/gi, "\n")
    .replace(/\\+u000a/gi, "\n")
    .replace(/&#10;/g, "\n")
    .replace(/\\+n/g, "\n")
    .replace(/[–—]/g, "-")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[^\x09\x0a\x0d\x20-\x7e]/g, " ");
}

function stripMarkup(value: string): string {
  return normalizePlainText(value)
    .replace(/<!--[^]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function compact(value: string | undefined, maxLength: number): string {
  const clean = stripMarkup(value ?? "");
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function latestSubstantiveItems(items: PullRequestComment[] | undefined, limit: number): PullRequestComment[] {
  return [...(items ?? [])]
    .filter((item) => stripMarkup(item.body ?? "").length > 0 || item.state != null)
    .sort((a, b) => String(b.submittedAt ?? b.createdAt ?? "").localeCompare(String(a.submittedAt ?? a.createdAt ?? "")))
    .slice(0, limit);
}

function openReviewThreads(details: PullRequestDetails, limit: number): PullRequestThread[] {
  return [...(details.openReviewThreads ?? [])]
    .filter((thread) => thread.isResolved !== true && thread.isOutdated !== true)
    .filter((thread) => latestSubstantiveItems(thread.comments, 1).length > 0)
    .sort((a, b) => {
      const aLatest = latestSubstantiveItems(a.comments, 1)[0];
      const bLatest = latestSubstantiveItems(b.comments, 1)[0];
      return String(bLatest?.createdAt ?? "").localeCompare(String(aLatest?.createdAt ?? ""));
    })
    .slice(0, limit);
}

function latestThreadComment(thread: PullRequestThread): PullRequestComment | undefined {
  return latestSubstantiveItems(thread.comments, 1)[0];
}

function formatThreadLocation(thread: PullRequestThread, comment?: PullRequestComment): string {
  const path = comment?.path ?? thread.path;
  const line = comment?.line ?? thread.line;
  if (path == null || path.length === 0) return "PR";
  return line == null ? path : `${path}:${line}`;
}

function formatThreadSummary(thread: PullRequestThread, maxLength: number): string {
  const comment = latestThreadComment(thread);
  const author = comment?.author?.login ?? "unknown";
  return `${author} at ${formatThreadLocation(thread, comment)}: ${compact(comment?.body, maxLength)}`;
}

function hasChangesRequested(details: PullRequestDetails): boolean {
  return String(details.reviewDecision ?? "").toUpperCase() === "CHANGES_REQUESTED"
    || latestSubstantiveItems(details.reviews, 20).some((review) => review.state === "CHANGES_REQUESTED");
}

function checkName(check: PullRequestCheck): string {
  return check.name ?? check.workflowName ?? "check";
}

function failingChecks(details: PullRequestDetails): PullRequestCheck[] {
  const failing = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
  return (details.statusCheckRollup ?? []).filter((check) => failing.has(String(check.conclusion ?? "").toUpperCase()));
}

function pendingChecks(details: PullRequestDetails): PullRequestCheck[] {
  return (details.statusCheckRollup ?? []).filter((check) => {
    const status = String(check.status ?? "").toUpperCase();
    const conclusion = String(check.conclusion ?? "").toUpperCase();
    return status.length > 0 && status !== "COMPLETED" && conclusion.length === 0;
  });
}

function hasStackBlocker(details: PullRequestDetails): boolean {
  return latestSubstantiveItems(details.comments, 20).some((comment) => {
    const body = stripMarkup(comment.body ?? "").toLowerCase();
    return body.includes("not mergeable") || body.includes("downstack") || body.includes("blocked");
  });
}

function deriveStatus(details: PullRequestDetails): StatusSummary {
  if (details.isDraft) return { status: "blocked", reason: "draft PR" };
  if (hasChangesRequested(details)) return { status: "blocked", reason: "changes requested" };

  const failed = failingChecks(details);
  if (failed.length > 0) return { status: "blocked", reason: `${failed.length} failing check${failed.length === 1 ? "" : "s"}` };

  if (openReviewThreads(details, 1).length > 0) return { status: "pending", reason: "open review comments" };
  if (hasStackBlocker(details)) return { status: "blocked", reason: "stack or merge blocker called out in comments" };

  const mergeState = String(details.mergeStateStatus ?? "").toUpperCase();
  if (["BLOCKED", "DIRTY", "UNKNOWN", "UNSTABLE"].includes(mergeState)) return { status: "blocked", reason: `merge state ${mergeState.toLowerCase()}` };

  if (String(details.reviewDecision ?? "").toUpperCase() === "APPROVED") return { status: "approved", reason: "review decision approved" };

  const pending = pendingChecks(details);
  if (pending.length > 0) return { status: "pending", reason: `${pending.length} pending check${pending.length === 1 ? "" : "s"}` };

  return { status: "pending", reason: "waiting for review" };
}

function extractBodySignal(body: string): string {
  const lines = stripMarkup(body)
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, "").replace(/^[-*]\s*/, "").trim())
    .filter((line) => line.length > 0 && !/^\|/.test(line));
  return lines.slice(0, 4).join(" ");
}

function formatChecks(details: PullRequestDetails, provider: ProviderSettings): string {
  if (details.checksUnavailable) return `Check details unavailable from ${provider.label} context.`;
  const failed = failingChecks(details).slice(0, 4).map(checkName);
  if (failed.length > 0) return `Failing: ${failed.join(", ")}`;
  const pending = pendingChecks(details).slice(0, 4).map(checkName);
  if (pending.length > 0) return `Pending: ${pending.join(", ")}`;
  return "No failing checks found.";
}

function formatReadableSummary(value: string): string {
  const lines = stripMarkup(value)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 20);
  const readable: string[] = [];

  for (const line of lines) {
    const match = line.match(/^([A-Za-z][A-Za-z ]{1,32}):\s*(.*)$/);
    if (match != null && SUMMARY_LABELS.has(match[1]!)) {
      if (readable.length > 0) readable.push("");
      readable.push(`${match[1]}:`);
      if (match[2]!.trim().length > 0) readable.push(match[2]!.trim());
    } else {
      readable.push(line);
    }
  }

  return readable.join("\n").trim();
}

function replaceSummaryField(summary: string, label: string, value: string): string {
  const field = `${label}:`;
  const cleanValue = stripMarkup(value);
  const lines = summary.split("\n");
  const index = lines.findIndex((line) => line.trim() === field);
  if (index < 0) return `${field}\n${cleanValue}\n\n${summary}`.trim();

  let end = index + 1;
  while (end < lines.length && lines[end]!.trim().length === 0) end += 1;
  if (end < lines.length) lines[end] = cleanValue;
  else lines.push(cleanValue);
  return lines.join("\n").trim();
}

function formatDiffStats(target: RemoteReviewTarget): string {
  const pr = target.pullRequest!;
  const fileLabel = pr.changedFiles === 1 ? "file" : "files";
  return `${pr.changedFiles} ${fileLabel} touched | +${pr.additions}/-${pr.deletions}`;
}

function enforceIdentityFields(summary: string, target: RemoteReviewTarget, details: PullRequestDetails, provider: ProviderSettings): string {
  const pr = target.pullRequest!;
  const url = details.url ?? pullRequestUrl(target, provider);
  return [
    ["Diff", formatDiffStats(target)],
    ["Author", pr.authorLogin],
    ["URL", url],
    ["Title", pr.title],
  ].reduce((current, [label, value]) => replaceSummaryField(current, label, value), summary);
}

function fallbackSummary(target: RemoteReviewTarget, details: PullRequestDetails, provider: ProviderSettings): string {
  const pr = target.pullRequest!;
  const status = deriveStatus(details);
  const threads = openReviewThreads(details, 4).map((thread) => formatThreadSummary(thread, 180));
  const reviews = latestSubstantiveItems(details.reviews, 3)
    .map((review) => `${review.author?.login ?? "unknown"} ${String(review.state ?? "commented").toLowerCase().replace(/_/g, " ")}${stripMarkup(review.body ?? "").length > 0 ? `: ${compact(review.body, 120)}` : ""}`);
  const comments = latestSubstantiveItems(details.comments, 3)
    .map((comment) => `${comment.author?.login ?? "unknown"}: ${compact(comment.body, 160)}`);
  const bodySignal = extractBodySignal(pr.body);

  return [
    `Title: ${pr.title}`,
    `URL: ${details.url ?? pullRequestUrl(target, provider)}`,
    `Author: ${pr.authorLogin}`,
    `Diff: ${formatDiffStats(target)}`,
    `Status: ${status.status} - ${status.reason}`,
    `Problem: ${bodySignal || "PR body did not include a clear problem statement."}`,
    "Changes: Not summarized by the model; read the diff for implementation details.",
    `Validation: ${formatChecks(details, provider)}`,
    `Open comments: ${threads.length > 0 ? threads.join("; ") : reviews.length > 0 ? reviews.join("; ") : comments.length > 0 ? comments.join("; ") : "None found."}`,
    pr.stackParent != null ? `Stack: parent #${pr.stackParent.number} ${pr.stackParent.title}` : undefined,
  ].filter((line): line is string => line != null).join("\n");
}

function formatSummaryInput(target: RemoteReviewTarget, details: PullRequestDetails, provider: ProviderSettings): string {
  const pr = target.pullRequest!;
  const status = deriveStatus(details);
  const reviews = latestSubstantiveItems(details.reviews, 8)
    .map((review) => `- ${review.author?.login ?? "unknown"} ${String(review.state ?? "commented").toLowerCase().replace(/_/g, " ")}: ${compact(review.body, 350) || "no body"}`)
    .join("\n");
  const comments = latestSubstantiveItems(details.comments, 10)
    .map((comment) => `- ${comment.author?.login ?? "unknown"}: ${compact(comment.body, 450)}`)
    .join("\n");
  const openThreads = openReviewThreads(details, 10)
    .map((thread) => `- ${formatThreadSummary(thread, 450)}`)
    .join("\n");

  return [
    `Title: ${pr.title}`,
    `URL: ${details.url ?? pullRequestUrl(target, provider)}`,
    `Author: ${pr.authorLogin}`,
    `Diff: ${formatDiffStats(target)}`,
    `State: ${pr.state}`,
    `Computed status: ${status.status} - ${status.reason}`,
    `Review decision: ${details.reviewDecision ?? "unknown"}`,
    `Merge state: ${details.mergeStateStatus ?? "unknown"}`,
    `Checks: ${formatChecks(details, provider)}`,
    pr.stackParent != null ? `Stack parent: #${pr.stackParent.number} ${pr.stackParent.title}` : `Base branch: ${pr.baseRefName}`,
    "",
    "PR body:",
    compact(pr.body, 6000) || "No body.",
    "",
    "Open review comments:",
    openThreads || "No unresolved review threads found.",
    "",
    "Reviews:",
    reviews || "No review bodies found.",
    "",
    "PR conversation comments:",
    comments || "No PR conversation comments found.",
  ].join("\n");
}

function providerString(provider: ProviderSettings, field: string, value: unknown): string | undefined {
  const configured = readConfiguredField(provider, field, value);
  return typeof configured === "string" && configured.length > 0 ? configured : undefined;
}

function providerBoolean(provider: ProviderSettings, field: string, value: unknown): boolean | undefined {
  const configured = readConfiguredField(provider, field, value);
  return typeof configured === "boolean" ? configured : undefined;
}

function providerNumber(provider: ProviderSettings, field: string, value: unknown): number | null | undefined {
  const configured = readConfiguredField(provider, field, value);
  return typeof configured === "number" && Number.isFinite(configured) ? configured : configured === null ? null : undefined;
}

function providerRows(provider: ProviderSettings, field: string, value: unknown, required: boolean): unknown[] {
  const configured = readConfiguredField(provider, field, value);
  const rows = configured ?? (Array.isArray(value) ? value : undefined);
  if (Array.isArray(rows)) return rows;
  if (!required && configured == null) return [];
  throw new Error(`Malformed ${provider.label} response for ${field}.`);
}

function providerComment(provider: ProviderSettings, value: unknown): PullRequestComment {
  const author = providerString(provider, "commentAuthor", value);
  return {
    ...(author == null ? {} : { author: { login: author } }),
    body: providerString(provider, "commentBody", value),
    createdAt: providerString(provider, "commentCreatedAt", value),
    submittedAt: providerString(provider, "commentSubmittedAt", value),
    state: providerString(provider, "commentState", value),
    url: providerString(provider, "commentUrl", value),
    path: providerString(provider, "commentPath", value),
    line: providerNumber(provider, "commentLine", value),
  };
}

function providerCheck(provider: ProviderSettings, value: unknown): PullRequestCheck {
  return {
    name: providerString(provider, "checkName", value),
    workflowName: providerString(provider, "checkWorkflowName", value),
    status: providerString(provider, "checkStatus", value),
    conclusion: providerString(provider, "checkConclusion", value),
  };
}

function encodeProviderQuery(value: string): string {
  return value.replaceAll("{", QUERY_OPEN_TOKEN).replaceAll("}", QUERY_CLOSE_TOKEN);
}

function decodeProviderQuery(value: string): string {
  return value.replaceAll(QUERY_OPEN_TOKEN, "{").replaceAll(QUERY_CLOSE_TOKEN, "}");
}

function parseProviderJson(provider: ProviderSettings, value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`Malformed ${provider.label} response for ${label}.`);
  }
}

async function fetchProviderOperation(
  pi: ExtensionAPI,
  target: RemoteReviewTarget,
  provider: ProviderSettings,
  operation: string,
  values: Record<string, string | number>,
  label: string,
): Promise<unknown> {
  const rendered = renderProviderOperation(provider, operation, values);
  const args = rendered.args.map(decodeProviderQuery);
  const result = await pi.exec(provider.executable, args, { cwd: target.gitRoot, timeout: 45000 });
  if (result.code !== 0 || result.stdout.trim().length === 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `Could not fetch ${provider.label} ${label}.`);
  }
  return parseProviderJson(provider, result.stdout.trim(), label);
}

function parseGraphqlReviewThreads(value: unknown): PullRequestThread[] {
  const parsed = value as {
    data?: {
      repository?: {
        pullRequest?: {
          reviewThreads?: {
            nodes?: Array<{
              isResolved?: boolean;
              isOutdated?: boolean;
              path?: string;
              line?: number | null;
              comments?: { nodes?: PullRequestComment[] };
            }>;
          };
        };
      };
    };
  };
  return (parsed?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? []).map((thread) => ({
    isResolved: thread.isResolved,
    isOutdated: thread.isOutdated,
    path: thread.path,
    line: thread.line,
    comments: thread.comments?.nodes ?? [],
  }));
}

async function fetchOpenReviewThreads(
  pi: ExtensionAPI,
  target: RemoteReviewTarget,
  provider: ProviderSettings,
  repo: string,
  number: string,
): Promise<PullRequestThread[]> {
  const parts = repo.split("/");
  const parsedNumber = Number.parseInt(number, 10);
  if (getProviderCapability(provider, "graphqlReviewThreads") && parts.length === 2 && Number.isFinite(parsedNumber)) {
    try {
      const payload = await fetchProviderOperation(pi, target, provider, "reviewThreads", {
        owner: parts[0]!,
        name: parts[1]!,
        number: parsedNumber,
        query: encodeProviderQuery(OPEN_REVIEW_THREADS_QUERY.replace(/\s+/g, " ").trim()),
      }, `PR #${number} review threads`);
      return parseGraphqlReviewThreads(payload);
    } catch {
      if (provider.operations.reviewComments == null) return [];
    }
  }

  const payload = await fetchProviderOperation(pi, target, provider, "reviewComments", { repo, number }, `PR #${number} review comments`);
  const rows = providerRows(provider, "pullRequestReviewComments", payload, true);
  return rows.map((row) => {
    const comment = providerComment(provider, row);
    return {
      path: comment.path,
      line: comment.line,
      isResolved: providerBoolean(provider, "commentResolved", row) === true,
      isOutdated: providerBoolean(provider, "commentOutdated", row) === true,
      comments: [comment],
    };
  });
}

async function fetchPullRequestDetails(
  pi: ExtensionAPI,
  target: RemoteReviewTarget,
  provider: ProviderSettings,
): Promise<PullRequestDetails> {
  const pr = target.pullRequest!;
  const repo = target.repo ?? pr.repo;
  if (repo == null) throw new Error(`Could not fetch ${provider.label} PR #${pr.number} context without a repository.`);

  const detailsPayload = await fetchProviderOperation(pi, target, provider, "pullRequestDetails", { repo, number: pr.number }, `PR #${pr.number}`);
  const separateContext = getProviderCapability(provider, "separatePullRequestContext");
  const [commentsPayload, reviewsPayload, openReviewThreads] = await Promise.all([
    separateContext
      ? fetchProviderOperation(pi, target, provider, "pullRequestComments", { repo, number: pr.number }, `PR #${pr.number} comments`)
      : Promise.resolve(detailsPayload),
    separateContext
      ? fetchProviderOperation(pi, target, provider, "pullRequestReviews", { repo, number: pr.number }, `PR #${pr.number} reviews`)
      : Promise.resolve(detailsPayload),
    fetchOpenReviewThreads(pi, target, provider, repo, pr.number),
  ]);

  const directDecision = providerString(provider, "pullRequestReviewDecision", detailsPayload);
  const reviewDecision = directDecision
    ?? (providerBoolean(provider, "pullRequestChangesRequested", detailsPayload) === true
      ? "CHANGES_REQUESTED"
      : providerBoolean(provider, "pullRequestApproved", detailsPayload) === true ? "APPROVED" : undefined);
  const checks = providerRows(provider, "pullRequestChecks", detailsPayload, false).map((row) => providerCheck(provider, row));

  return {
    url: providerString(provider, "pullRequestUrl", detailsPayload) ?? pullRequestUrl(target, provider),
    isDraft: providerBoolean(provider, "pullRequestDraft", detailsPayload),
    mergeStateStatus: providerString(provider, "pullRequestMergeState", detailsPayload)?.toUpperCase(),
    reviewDecision,
    comments: providerRows(provider, "pullRequestComments", commentsPayload, separateContext).map((row) => providerComment(provider, row)),
    reviews: providerRows(provider, "pullRequestReviews", reviewsPayload, separateContext).map((row) => providerComment(provider, row)),
    openReviewThreads,
    statusCheckRollup: checks,
    checksUnavailable: !getProviderCapability(provider, "pullRequestChecks"),
    createdAt: providerString(provider, "pullRequestCreatedAt", detailsPayload),
    updatedAt: providerString(provider, "pullRequestUpdatedAt", detailsPayload),
  };
}

function buildAgentPrompt(summaryInput: string): string {
  return [
    "Summarize this pull request for a reviewer already looking at the diff.",
    "Output plain text only, no markdown table, no preamble, no emoji, ASCII only.",
    "Do not mention these instructions or use phrases like 'what matters most'.",
    "The reviewer needs only the important context, focused on the problem this PR solves.",
    "Keep implementation details short unless they explain reviewer risk or the problem.",
    "Required labels: Title, URL, Author, Diff, Status, Problem, Changes, Validation, Open comments. Add Stack only if relevant.",
    "Title, URL, Author, and Diff must exactly match the input values.",
    "Problem must explain the user, merchant, developer, or system pain being solved in one or two sentences.",
    "Open comments must summarize unresolved review threads only. If none exist, write None found.",
    "Use PR comments and reviews only when they affect review readiness, validation, blockers, or unresolved questions.",
    "Put each label on its own line with the value on the following line.",
    "Status must be exactly one of pending, blocked, approved, followed by a short reason using an ASCII hyphen separator.",
    "Use readable section blocks separated by blank lines, not one dense paragraph.",
    "Limit the whole response to roughly 180 words.",
    "",
    summaryInput,
  ].join("\n");
}

function cleanAgentOutput(value: string): string {
  return formatReadableSummary(value);
}

function modelArgs(ctx: ExtensionContext): string[] {
  const model = (ctx as { model?: { provider?: string; id?: string } }).model;
  if (model?.provider == null || model.id == null) return [];
  return ["--model", `${model.provider}/${model.id}`];
}

async function summarizeWithAgent(pi: ExtensionAPI, ctx: ExtensionContext, target: RemoteReviewTarget, summaryInput: string): Promise<string | undefined> {
  const prompt = buildAgentPrompt(summaryInput);
  const result = await pi.exec("pi", [
    "--no-tools",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-session",
    ...modelArgs(ctx),
    "--thinking",
    "minimal",
    "-p",
    prompt,
  ], { cwd: target.gitRoot, timeout: 90000 });
  if (result.code !== 0 || result.stdout.trim().length === 0) return undefined;
  return cleanAgentOutput(result.stdout);
}

function suppliedPullRequestDetails(target: RemoteReviewTarget, provider: ProviderSettings): PullRequestDetails | undefined {
  const handoff = target.handoff;
  if (handoff == null || !hasHandoffContext(handoff)) return undefined;
  return {
    url: pullRequestUrl(target, provider),
    reviewDecision: handoff.reviewDecision,
    comments: [],
    reviews: handoff.reviews.map((review) => ({ author: { login: review.author }, state: review.state })),
    openReviewThreads: (handoff.threads ?? []).map((thread) => ({
      path: thread.path,
      line: thread.line ?? null,
      isResolved: thread.resolved === true,
      isOutdated: thread.outdated === true,
      comments: thread.comments.map((comment) => ({
        author: { login: comment.author },
        body: comment.body,
        createdAt: comment.createdAt,
        state: comment.state,
        path: thread.path,
        line: thread.line ?? null,
      })),
    })),
    statusCheckRollup: (handoff.checks ?? []).map((check) => ({ name: check.name, status: check.status, conclusion: check.conclusion })),
    checksUnavailable: handoff.checks == null,
  };
}

async function loadRemotePullRequestSummary(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  target: RemoteReviewTarget,
  provider: ProviderSettings,
): Promise<string> {
  const supplied = suppliedPullRequestDetails(target, provider);
  const details = supplied ?? await fetchPullRequestDetails(pi, target, provider);
  const suppliedSummary = target.handoff?.summary;
  if (suppliedSummary != null) return enforceIdentityFields(formatReadableSummary(suppliedSummary), target, details, provider);
  const fallback = fallbackSummary(target, details, provider);
  try {
    const generated = await summarizeWithAgent(pi, ctx, target, formatSummaryInput(target, details, provider));
    return enforceIdentityFields(formatReadableSummary(generated ?? fallback), target, details, provider);
  } catch {
    return enforceIdentityFields(formatReadableSummary(fallback), target, details, provider);
  }
}

export function createRemotePullRequestSummarySource(pi: ExtensionAPI, ctx: ExtensionContext, target: RemoteReviewTarget | undefined): ReviewContextPanelSource | undefined {
  if (target?.pullRequest == null) return undefined;
  const provider = providerForTarget(target);
  return {
    title: `${provider.label} PR context`,
    loadingText: `Loading ${provider.label} PR context...`,
    load: () => loadRemotePullRequestSummary(pi, ctx, target, provider),
    url: pullRequestUrl(target, provider),
  };
}
