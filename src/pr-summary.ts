import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ReviewContextPanelSource, ReviewConversationMetadata, ReviewThreadCoverage } from "./types.js";
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
import { collectRepliesToSelf, createRemoteReviewRepliesSource, fetchReviewThreads, getSelfLogin, type ReviewThreadRead } from "./review-replies.js";
import { createConversationRead, createConversationReader } from "./conversation.js";

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
  isResolved: boolean | null;
  isOutdated?: boolean;
  comments?: PullRequestComment[];
}

interface PullRequestCheck {
  name?: string;
  workflowName?: string;
  status?: string;
  conclusion?: string;
}

export interface PullRequestDetails {
  threadRead?: ReviewThreadRead;
  unavailable?: string[];
  pending?: string[];
  url?: string;
  isDraft?: boolean;
  checksUnavailable?: boolean;
  mergeStateStatus?: string;
  reviewDecision?: string;
  comments?: PullRequestComment[];
  reviews?: PullRequestComment[];
  openReviewThreads?: PullRequestThread[];
  threadCoverage?: ReviewThreadCoverage;
  statusCheckRollup?: PullRequestCheck[];
  createdAt?: string;
  updatedAt?: string;
}

interface StatusSummary {
  status: "pending" | "blocked" | "approved";
  reason: string;
}

const SUMMARY_LABELS = new Set(["Title", "URL", "Author", "Head", "Diff", "Status", "Problem", "Changes", "Validation", "Open comments", "Stack"]);

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
  const resolution = thread.isResolved == null ? " (resolution unknown)" : "";
  return `${author} at ${formatThreadLocation(thread, comment)}${resolution}: ${compact(comment?.body, maxLength)}`;
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

  const threads = openReviewThreads(details, Number.POSITIVE_INFINITY);
  if (threads.some((thread) => thread.isResolved == null)) return { status: "pending", reason: "review resolution unknown" };
  if (threads.length > 0) return { status: "pending", reason: "open review comments" };
  if (hasStackBlocker(details)) return { status: "blocked", reason: "stack or merge blocker called out in comments" };

  const mergeState = String(details.mergeStateStatus ?? "").toUpperCase();
  if (["BLOCKED", "DIRTY", "UNKNOWN", "UNSTABLE"].includes(mergeState)) return { status: "blocked", reason: `merge state ${mergeState.toLowerCase()}` };

  if (details.unavailable?.length) return { status: "pending", reason: `${details.unavailable.join(", ")} unavailable` };
  if (details.pending?.length) return { status: "pending", reason: `${details.pending.join(", ")} pending` };
  if (details.threadCoverage === "partial") return { status: "pending", reason: "thread read incomplete" };
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

function formatDiffStats(target: RemoteReviewTarget): string {
  const pr = target.pullRequest!;
  const fileLabel = pr.changedFiles === 1 ? "file" : "files";
  return `${pr.changedFiles} ${fileLabel} touched | +${pr.additions}/-${pr.deletions}`;
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
  const missing = (details.unavailable ?? []).filter((section) => !["PR details", "checks"].includes(section));
  const conversation = threads.length ? threads.join("; ") : reviews.length ? reviews.join("; ") : comments.join("; ");
  const coverage = [
    missing.length ? `Unavailable: ${missing.join(", ")}` : "",
    details.pending?.length ? `Pending: ${details.pending.join(", ")}` : "",
    details.threadCoverage === "partial" ? "Thread read incomplete." : "",
  ].filter(Boolean).join("; ");

  return [
    `Title: ${pr.title}`,
    `URL: ${details.url ?? pullRequestUrl(target, provider)}`,
    `Author: ${pr.authorLogin}`,
    `Head: ${pr.headRefName} @ ${pr.headRefOid}`,
    `Diff: ${formatDiffStats(target)}`,
    `Status: ${status.status} - ${status.reason}`,
    `Problem: ${bodySignal || "PR body did not include a clear problem statement."}`,
    "Changes: Read the diff for implementation details.",
    `Validation: ${formatChecks(details, provider)}`,
    `Open comments: ${[conversation, coverage].filter(Boolean).join("; ") || "None found."}`,
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
    details.threadCoverage === "partial" ? "Thread read incomplete; this is only fetched context." : "",
    openThreads || (details.unavailable?.includes("review threads") ? "Review threads unavailable." : "No unresolved review threads found."),
    "",
    "Reviews:",
    reviews || (details.unavailable?.includes("reviews") ? "Reviews unavailable." : "No review bodies found."),
    "",
    "PR conversation comments:",
    comments || (details.unavailable?.includes("PR comments") ? "PR comments unavailable." : "No PR conversation comments found."),
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
  const result = await pi.exec(provider.executable, rendered.args, { cwd: target.gitRoot, timeout: 45000 });
  if (result.code !== 0 || result.stdout.trim().length === 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `Could not fetch ${provider.label} ${label}.`);
  }
  return parseProviderJson(provider, result.stdout.trim(), label);
}

async function fetchOpenReviewThreads(
  pi: ExtensionAPI,
  target: RemoteReviewTarget,
  provider: ProviderSettings,
  repo: string,
  number: string,
): Promise<{ threads: PullRequestThread[]; coverage?: ReviewThreadCoverage; read?: ReviewThreadRead }> {
  const read = await fetchReviewThreads(pi, target, provider, repo, number);
  const threads = read.contextRows == null
    ? read.threads.map((thread) => ({
      isResolved: thread.resolved,
      isOutdated: thread.outdated,
      path: thread.path,
      line: thread.line,
      comments: thread.comments.map((comment) => ({ ...comment, author: { login: comment.author } })),
    }))
    : read.contextRows.map((row) => {
      const comment = providerComment(provider, row);
      return {
        path: comment.path,
        line: comment.line,
        isResolved: providerBoolean(provider, "commentResolved", row) ?? null,
        isOutdated: providerBoolean(provider, "commentOutdated", row) === true,
        comments: [comment],
      };
    });
  return { threads, coverage: read.coverage, read };
}

async function fetchPullRequestDetails(
  read: ReturnType<typeof createConversationRead>,
  target: RemoteReviewTarget,
  provider: ProviderSettings,
  onFacts: (details: PullRequestDetails) => void,
): Promise<PullRequestDetails> {
  const pi = read.pi;
  const pr = target.pullRequest!;
  const repo = target.repo ?? pr.repo;
  if (repo == null) return {
    unavailable: ["PR details", "checks", "PR comments", "reviews", "review threads"],
    checksUnavailable: true,
  };
  let unavailable: string[] = [];
  const retain = read.retain;
  async function readSection<T>(name: string, read: () => Promise<T>, fallback: T): Promise<T> {
    try {
      const value = retain(await read());
      unavailable = unavailable.filter((section) => section !== name);
      return value;
    } catch {
      unavailable.push(name);
      return fallback;
    }
  }
  const detailsPayload = await readSection("PR details", () => fetchProviderOperation(pi, target, provider, "pullRequestDetails", { repo, number: pr.number }, `PR #${pr.number}`), undefined);
  const separateContext = getProviderCapability(provider, "separatePullRequestContext");
  const readComments = async (field: string, embedded = false) => {
    const payload = separateContext && !embedded
      ? await fetchProviderOperation(pi, target, provider, field, { repo, number: pr.number }, `PR #${pr.number} ${field}`)
      : detailsPayload;
    if (payload == null) throw new Error("Context section unavailable.");
    return providerRows(provider, field, payload, separateContext && !embedded).map((row) => providerComment(provider, row));
  };
  const [embeddedComments, embeddedReviews, checks] = await Promise.all([
    readSection("PR comments", () => readComments("pullRequestComments", true), []),
    readSection("reviews", () => readComments("pullRequestReviews", true), []),
    readSection("checks", async () => {
      if (detailsPayload == null) throw new Error("Check details unavailable.");
      return providerRows(provider, "pullRequestChecks", detailsPayload, false).map((row) => providerCheck(provider, row));
    }, []),
  ]);

  const directDecision = providerString(provider, "pullRequestReviewDecision", detailsPayload);
  const reviewDecision = directDecision
    ?? (providerBoolean(provider, "pullRequestChangesRequested", detailsPayload) === true
      ? "CHANGES_REQUESTED"
      : providerBoolean(provider, "pullRequestApproved", detailsPayload) === true ? "APPROVED" : undefined);

  const details: PullRequestDetails = {
    unavailable: [...unavailable].sort(),
    pending: ["review threads", ...(separateContext ? ["PR comments", "reviews"] : [])],
    url: providerString(provider, "pullRequestUrl", detailsPayload) ?? pullRequestUrl(target, provider),
    isDraft: providerBoolean(provider, "pullRequestDraft", detailsPayload),
    mergeStateStatus: providerString(provider, "pullRequestMergeState", detailsPayload)?.toUpperCase(),
    reviewDecision,
    comments: embeddedComments,
    reviews: embeddedReviews,
    statusCheckRollup: checks,
    checksUnavailable: (!getProviderCapability(provider, "pullRequestChecks") && checks.length === 0) || unavailable.includes("checks"),
    createdAt: providerString(provider, "pullRequestCreatedAt", detailsPayload),
    updatedAt: providerString(provider, "pullRequestUpdatedAt", detailsPayload),
  };
  onFacts(retain(details));
  const [comments, reviews, threadRead] = await Promise.all([
    separateContext ? readSection("PR comments", () => readComments("pullRequestComments"), embeddedComments) : embeddedComments,
    separateContext ? readSection("reviews", () => readComments("pullRequestReviews"), embeddedReviews) : embeddedReviews,
    readSection("review threads", () => fetchOpenReviewThreads(pi, target, provider, repo, pr.number), { threads: [] }),
  ]);
  return retain({ ...details, pending: undefined, unavailable: [...new Set(unavailable)].sort(), comments, reviews,
    openReviewThreads: threadRead.threads, threadCoverage: threadRead.coverage, threadRead: threadRead.read });
}

function buildAgentPrompt(summaryInput: string): string {
  return [
    "Write an optional reviewer-focused explanation for a pull request whose facts are shown separately.",
    "Output plain text only, no markdown table, no preamble, no emoji, ASCII only.",
    "Do not restate title, URL, author, diff counts, status, checks, or other factual fields.",
    "Focus on the problem this PR solves, the important implementation choice, and reviewer risk.",
    "Use PR comments and reviews only when they affect review readiness, blockers, or unresolved questions.",
    "Limit the response to roughly 120 words.",
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
      isResolved: thread.resolved ?? null,
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

export function createRemotePullRequestSources(pi: ExtensionAPI, ctx: ExtensionContext, target: RemoteReviewTarget | undefined) {
  if (target?.pullRequest == null) return {};
  const provider = providerForTarget(target);
  const pr = target.pullRequest;
  const repo = target.repo ?? pr.repo;
  const reader = createConversationReader(pi, target, async (read, onProgress) => {
    const [details, selfLogin] = await Promise.all([
      fetchPullRequestDetails(read, target, provider, (details) => onProgress({ details })),
      repo == null ? null : getSelfLogin(read.pi, target, provider, repo, pr.number).then(read.retain).then((selfLogin) => {
        onProgress({ selfLogin });
        return selfLogin;
      }).catch(() => null),
    ]);
    const replies = details.threadRead != null && selfLogin != null
      ? collectRepliesToSelf(details.threadRead.threads, selfLogin) : undefined;
    return { details, selfLogin, replies };
  }, suppliedPullRequestDetails(target, provider));
  return { contextPanelSource: createRemotePullRequestSummarySource(pi, ctx, target, reader), repliesSource: createRemoteReviewRepliesSource(pi, ctx, target, reader) };
}

export function createRemotePullRequestSummarySource(pi: ExtensionAPI, ctx: ExtensionContext, target: RemoteReviewTarget | undefined, reader?: ReturnType<typeof createConversationReader>): ReviewContextPanelSource | undefined {
  if (target?.pullRequest == null) return undefined;
  const provider = providerForTarget(target);
  let requestToken = 0;
  let useHandoff = true;
  return {
    title: `${provider.label} PR context`,
    loadingText: `Loading ${provider.label} PR context...`,
    load: async (onUpdate, options) => {
      const token = ++requestToken;
      const shared = reader?.load(options);
      if (options?.refresh) useHandoff = false;
      let metadata: ReviewConversationMetadata | undefined;
      let supplied = shared == null && useHandoff ? suppliedPullRequestDetails(target, provider) : undefined;
      const read = shared == null && supplied == null ? createConversationRead(pi) : undefined;
      let known: PullRequestDetails = { checksUnavailable: true, pending: ["PR details", "checks", "PR comments", "reviews", "review threads"] };
      let resolveFacts!: (details: PullRequestDetails) => void;
      const early = new Promise<PullRequestDetails>((resolve) => { resolveFacts = resolve; });
      void shared?.facts.then((details) => { known = details; resolveFacts(details); });
      const complete = (shared != null ? shared.snapshot.then((snapshot) => {
        metadata = snapshot.metadata;
        supplied = snapshot.supplied ? snapshot.details : undefined;
        return snapshot.details;
      }) : read == null ? Promise.resolve(supplied!) : fetchPullRequestDetails(read, target, provider, (details) => {
        known = details;
        resolveFacts(details);
      })).catch(() => ({ ...known, pending: undefined, unavailable: [...(known.unavailable ?? []), ...(known.pending ?? [])] }))
        .finally(() => read?.close());
      void complete.then(resolveFacts);
      const format = (details: PullRequestDetails) => formatReadableSummary(fallbackSummary(target, details, provider));
      const isCurrent = () => token === requestToken && (metadata == null || reader!.isCurrent(metadata));
      void complete.then((details) => {
        if (!isCurrent()) return;
        const facts = format(details);
        if (supplied == null || metadata != null) onUpdate?.(facts, metadata);
        const explanation = supplied != null && target.handoff?.summary != null
          ? Promise.resolve(target.handoff.summary)
          : summarizeWithAgent(pi, ctx, target, formatSummaryInput(target, details, provider));
        void explanation.then((text) => {
          const clean = text == null ? "" : cleanAgentOutput(text);
          if (isCurrent() && clean.length > 0) onUpdate?.(`${facts}\n\nGenerated explanation (optional):\n${clean}`, metadata);
        }).catch(() => undefined);
      }).catch(() => undefined);
      return format(await (onUpdate == null ? complete : early));
    },
    url: pullRequestUrl(target, provider),
  };
}
