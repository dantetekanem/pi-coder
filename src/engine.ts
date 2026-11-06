import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { createGitTestSource, findExistingStoryTests } from "./diff-story/existing-tests.js";
import { getReviewWindowData, getReviewWindowDataForRevisionRange, loadReviewFileContents, type ReviewWindowData, type ReviewWindowOptions } from "./git.js";
import type { ExternalEditorLauncher, ExternalEditorOutcome, PiCoderCommandNames, PiCoderCommandResult, PiCoderEngine, PiCoderEngineOptions, PiCoderToolName, PiCoderToolResult, ReviewRunStatus } from "./host/engine.js";
import type { HostApi, HostContext, HostTheme } from "./host/types.js";
import { composeDiscussionPrompt, composeReviewPrompt } from "./prompt.js";
import { parsePullRequestHandoff, type PullRequestHandoff } from "./pr-handoff.js";
import { createRemotePullRequestSources } from "./pr-summary.js";
import { loadReviewPreferences, saveReviewPreference, type PersistedReviewVerdict } from "./preferences.js";
import { getProviderCapability, getProviderSettings, loadPiCoderSettings, renderProviderTemplate, requireProviderSettings, type CodeCommandSettings, type ProviderSettings } from "./provider-settings.js";
import { createReviewSourceLinks, type ReviewSourceLinks } from "./source-links.js";
import { buildReviewOrderSignals, countHandoffThreads } from "./review-order.js";
import { listReviewCompositions, removeReviewComposition, saveReviewComposition } from "./review-composition.js";
import { reviewGrammar, type GrammarReviewResult, type GrammarTextChange, type ReviewTextSet } from "./review-grammar.js";
import { buildReviewFileSignatures, createReviewInstanceId, createReviewSessionId, deleteReviewSession, hasReviewSessionIdentity, listReviewSessions, loadReviewSession, rebaseReviewSession, saveReviewSessionWithStatus, type ReviewSessionData, type ReviewSessionIndexEntry, type ReviewSessionMeta } from "./review-session.js";
import { formatPullRequestContext, resolveRemoteReviewTarget, type RemoteDiscussContinuation, type RemoteReviewTarget } from "./remote.js";
import { buildProviderComments, buildReviewBody, composeSubmissionRecovery, prepareSubmissionHandoff, submitPullRequestReview, type ReviewInlineComment, type ReviewVerdict, type SubmitReviewInput, type SubmitReviewOptions, type SubmitReviewResult } from "./review-submit.js";
import { createSubmissionJournal, submissionDraftSourceFingerprint, submissionFingerprint, type SubmissionDraftBinding } from "./review-submission-journal.js";
import { hasConsumableConfirmedSubmissionDraft } from "./review-submission-consumption.js";
import { anchorResolvedSeedComments, partitionResolvedSeedComments, resolveSeedComments, type SeedReviewComment } from "./seed-comments.js";
import { sanitizeTerminalText } from "./sanitize.js";
import { loadCommentShortcuts } from "./shortcuts.js";
import { runReviewApp } from "./ui/review-app.js";
import { prepareDiffStory, selectStoryAgent, type PreparedDiffStory } from "./ui/diff-story.js";
import { getScopedFiles } from "./state.js";
import { withHerdrPaneZoom } from "./ui/full-screen-overlay.js";
import { pickSyntaxTheme } from "./ui/syntax-theme-picker.js";
import { runPiWorkbench } from "./adapters/pi/index.js";
import { composeCodeDiscussionPrompt, parseDirectCodeArgs, runGuardedPiWorkbench } from "./adapters/pi/coordinator.js";
import { createReviewScopeFingerprint, placeReviewSubmitComments, resolveReviewResume, revalidateReviewDraftAnchors } from "./adapters/pi/review-bridge.js";
import { ReviewInvocationCoordinator } from "./adapters/pi/review-invocation.js";
import { listBundledShikiThemes } from "./workbench/node/shiki.js";
import { normalizeWorkbenchLaunch } from "./workbench/target.js";
import type { CodeStory, CodeTarget, WorkbenchCompletionResult, WorkbenchLaunch } from "./workbench/contracts.js";
import { hasExactSubmoduleRange, type ReviewComposition, type ReviewFile, type ReviewScope, type ReviewSubmitPayload } from "./types.js";

type InteractiveReviewMode = "working" | "staged" | "branch" | "custom";

interface InteractiveReviewParams {
  story?: boolean;
  mode?: InteractiveReviewMode;
  ref?: string;
  resume?: string;
  resumeIdentity?: string;
  tree?: string;
  branch?: string;
  project?: string;
  remote?: string;
  handoff?: PullRequestHandoff;
  cwd?: string;
  includeGenerated?: boolean;
  wholeRepo?: boolean;
  discardResume?: boolean;
  continuation?: RemoteDiscussContinuation;
}

export type { ExternalEditorLauncher, ExternalEditorOutcome };

export function runExternalEditor(command: string, args: string[], cwd: string): Promise<ExternalEditorOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      shell: false,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (signal != null) resolve({ kind: "signal", signal });
      else if (code != null) resolve({ kind: "exit", code });
      else reject(new Error("$EDITOR closed without an exit code or signal"));
    });
  });
}

const MODE_VALUES = new Set(["working", "staged", "branch", "custom"]);
const DEFAULT_COMMAND_NAMES: PiCoderCommandNames = { diff: "/diff", diffStory: "/diff-story", code: "/code" };

function expandHomePath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolvePath(homedir(), path.slice(2));
  return path;
}

function normalizeReviewCwd(cwd: string, fallbackCwd: string): string {
  const expandedCwd = expandHomePath(cwd);
  if (isAbsolute(expandedCwd)) return resolvePath(expandedCwd);

  const expandedFallback = expandHomePath(fallbackCwd);
  const baseCwd = isAbsolute(expandedFallback) ? expandedFallback : resolvePath(expandedFallback);
  return resolvePath(baseCwd, expandedCwd);
}

function resolveLocalReviewCwdArg(arg: string, fallbackCwd: string): string | null {
  const reviewCwd = normalizeReviewCwd(arg, fallbackCwd);
  try {
    return statSync(reviewCwd).isDirectory() ? reviewCwd : null;
  } catch {
    return null;
  }
}

function parseInteractiveReviewArgs(args: string): InteractiveReviewParams {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const params: InteractiveReviewParams = {};

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const next = () => tokens[++index];

    if (MODE_VALUES.has(token)) {
      params.mode = token as InteractiveReviewMode;
      continue;
    }

    if (token === "--ref" || token === "--custom") params.ref = next();
    else if (token === "--resume") {
      const candidate = tokens[index + 1];
      params.resume = candidate != null && !candidate.startsWith("-") ? next() : "latest";
    }
    else if (token === "--discard-resume") params.discardResume = true;
    else if (token === "--tree") params.tree = next();
    else if (token === "--branch") params.branch = next();
    else if (token === "--project") params.project = next();
    else if (token === "--remote") params.remote = next();
    else if (token === "--cwd") params.cwd = next();
    else if (token.startsWith("--cwd=")) params.cwd = token.slice("--cwd=".length);
    else if (token === "--include-generated") params.includeGenerated = true;
    else if (token === "--whole-repo") params.wholeRepo = true;
  }

  if (params.ref != null) params.mode = "custom";
  return params;
}

function extractRemoteArgs(trimmed: string, fallbackCwd: string): string | null {
  if (trimmed.length === 0) return null;
  const tokens = trimmed.split(/\s+/);
  const firstToken = tokens[0]!;
  if (firstToken.toLowerCase() === "remote") {
    return tokens[1] ?? null;
  }
  if (trimmed.startsWith("-") || MODE_VALUES.has(firstToken)) return parseInteractiveReviewArgs(trimmed).remote ?? null;
  if (trimmed.includes("..")) return null;
  return resolveLocalReviewCwdArg(trimmed, fallbackCwd) == null ? trimmed : null;
}

function unsupported(message: string, ctx: HostContext): ReviewRunStatus {
  if (ctx.hasUI) ctx.ui.notify(message, "warning");
  return { started: false, message };
}

const DIFF_STORY_TUI_MESSAGE = "Diff stories require a TUI session.";

function canOpenDiffStory(ctx: HostContext): boolean {
  return ctx.hasUI && (ctx.mode == null || ctx.mode === "tui");
}

const REVIEW_PROGRESS_FRAMES = ["-", "\\", "|", "/"];
const LOCAL_PROGRESS_DELAY_MS = 5_000;
const LOCAL_PROGRESS_MESSAGE = "Loading local changes…";
const LOCAL_PROGRESS_SLOW_MESSAGE = "Still loading local changes… Large repositories can take a little longer.";

class ReviewProgressWidget implements Component {
  private frame = 0;
  private timer: ReturnType<typeof setInterval>;

  constructor(private tui: TUI, private theme: HostTheme, private message: string) {
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % REVIEW_PROGRESS_FRAMES.length;
      this.tui.requestRender?.();
    }, 120);
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const border = this.theme.fg("borderMuted", "─".repeat(safeWidth));
    const text = `${REVIEW_PROGRESS_FRAMES[this.frame]} ${this.message}`;
    return [border, truncateToWidth(this.theme.fg("muted", text), safeWidth, "…", false)];
  }

  invalidate(): void {}

  dispose(): void {
    clearInterval(this.timer);
  }
}

function setReviewProgress(ctx: HostContext, key: string, message: string | undefined): void {
  ctx.ui.setWidget(key, message == null ? undefined : (tui, theme) => new ReviewProgressWidget(tui, theme, message));
}

function setRemoteProgress(ctx: HostContext, message: string | undefined): void {
  setReviewProgress(ctx, "pi-coder-remote", message);
}

function setLocalProgress(ctx: HostContext, message: string | undefined): void {
  setReviewProgress(ctx, "pi-coder-local", message);
}

export function mergeReviewBodies(...bodies: Array<string | undefined>): string | undefined {
  const parts = bodies.map((body) => body?.trim()).filter((body): body is string => body != null && body.length > 0);
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function providerForTarget(target: RemoteReviewTarget): ProviderSettings {
  const providerId = target.provider ?? target.handoff?.provider;
  if (providerId == null) throw new Error("Remote pull request provider is not configured.");
  return requireProviderSettings(providerId);
}

function loadReviewSourceLinks(target: RemoteReviewTarget | undefined): ReviewSourceLinks | undefined {
  try {
    const settings = loadPiCoderSettings();
    const providerId = target?.pullRequest == null ? undefined : target.provider ?? target.handoff?.provider;
    const provider = providerId == null ? undefined : getProviderSettings(providerId, settings);
    return createReviewSourceLinks(settings, provider, target?.repo ?? target?.pullRequest?.repo);
  } catch {
    return undefined;
  }
}

function pullRequestProviderName(target: RemoteReviewTarget): string {
  return providerForTarget(target).label;
}

function pullRequestUrl(target: RemoteReviewTarget): string {
  const pr = target.pullRequest!;
  const repo = target.repo ?? pr.repo;
  if (repo == null) return target.remote;
  return renderProviderTemplate(providerForTarget(target).urls.canonical, { repo, number: pr.number });
}

export function composeReviewSubmissionPrompt(target: RemoteReviewTarget, verdict: ReviewVerdict, body: string | undefined, comments: ReviewInlineComment[]): string {
  const pr = target.pullRequest!;
  const args = {
    provider: target.provider,
    repo: target.repo,
    prNumber: pr.number,
    commitId: pr.headRefOid,
    baseCommitId: pr.baseRefOid,
    verdict,
    prAuthorLogin: pr.authorLogin,
    cwd: target.gitRoot,
    body: body == null || body.trim().length === 0 ? undefined : body.trim(),
    comments: comments.length > 0 ? comments : undefined,
  };
  const verdictLabel = verdict === "request_changes" ? "REQUEST CHANGES" : verdict.toUpperCase();
  const prUrl = pullRequestUrl(target);
  const provider = pullRequestProviderName(target);
  return [
    `Prepare a ${provider} PR review submission for PR #${pr.number} (${target.repo ?? "this repo"}): ${pr.title}.`,
    "",
    `Verdict: ${verdictLabel}`,
    "",
    "Hard constraints:",
    "- This is not a request to review, inspect, or understand the code. The user already selected the exact review locations.",
    "- Do not read files, search the repository, run commands, run tests, inspect diffs, open plans, create todos, or enter plan mode.",
    "- Do not change path, line, side, verdict, PR number, commit id, repo, cwd, author fields, or remove existing inline comments.",
    "- The review UI already captured the user's explicit confirmation of the exact verdict and original text.",
    "- Grammar, spelling, capitalization, punctuation, and meaning-preserving syntax corrections are already authorized by the review UI and do not require another confirmation.",
    "- Only a correction that may change meaning, intent, tone, technical substance, or requested scope requires exact per-item approval before submission.",
    "- Call submit_pr_review once with the full arguments below. The tool handles approval plus inline comments safely.",
    "",
    "Your job:",
    "1. Fix only grammar, spelling, capitalization, and punctuation in the review body and inline comment bodies. Do not change meaning.",
    "2. Compare every cleaned body/comment with its original and classify whether the correction preserves meaning, intent, tone, technical substance, and requested scope.",
    "3. If every correction is limited to grammar, spelling, capitalization, punctuation, or meaning-preserving syntax and clarity, call submit_pr_review immediately with the cleaned arguments and do not ask for confirmation.",
    "4. Ask only about text items whose correction may change meaning, intent, tone, technical substance, or requested scope. Present each such item using this exact style, with one separate decision per item:",
    "   Comment 1: <path>:<line-or-range> (<side>)",
    "   Original: <original text>",
    "   Fixed   : <fixed text>",
    "   Choices: Approve, Edit, Skip",
    "5. Ask for decisions using the available local confirmation/asking tooling. If the current ask tool can queue multiple questions, batch the uncertain text items in one ask call with one separate question per item. If batching is unavailable, ask one item at a time. Do not collapse all decisions into one combined prompt.",
    "6. Apply grammar-only corrections automatically. For approved uncertain items, use the fixed text. For edited items, use the user's replacement text. For skipped items, remove that body/comment from the submission.",
    "7. The user's Approve choice is the confirmation to submit an uncertain item. After the last uncertain item is approved, edited, or skipped, call submit_pr_review immediately with the arguments below, applying automatic grammar-only corrections and replacing only uncertain body/comment text with the approved or edited text. Do not ask for a second/final submission confirmation.",
    `8. Do not approve this PR if the current ${provider} user (${pr.authorLogin}) authored it; the tool refuses self-approval.`,
    `9. After submit_pr_review succeeds, reply with the PR link and the short action summary returned by the tool. PR link: ${prUrl}`,
    "",
    "submit_pr_review arguments:",
    "```json",
    JSON.stringify(args, null, 2),
    "```",
  ].join("\n");
}

const USE_CORRECTED_TEXT = "Use corrected text";
const EDIT_CORRECTED_TEXT = "Edit corrected text";
const KEEP_ORIGINAL_TEXT = "Keep original text";
const REMOVE_REVIEW_ITEM = "Remove this review item";
const CANCEL_REVIEW_SUBMISSION = "Cancel submission";

function sendReviewFollowUp(pi: HostApi, ctx: HostContext, message: string): void {
  if (ctx.isIdle()) pi.sendUserMessage(message);
  else pi.sendUserMessage(message, { deliverAs: "followUp" });
}

function getGrammarChangeLocation(change: GrammarTextChange, comments: ReviewInlineComment[]): string {
  if (change.key === "body") return "Review body";
  const index = Number.parseInt(change.key.slice("comment:".length), 10);
  const comment = comments[index];
  if (comment == null) return `Comment ${index + 1}`;
  if (comment.subject_type === "file") return `Comment ${index + 1}: ${comment.path} (file)`;
  const range = comment.start_line == null || comment.start_line === comment.line
    ? String(comment.line)
    : `${comment.start_line}-${comment.line}`;
  return `Comment ${index + 1}: ${comment.path}:${range} (${comment.side})`;
}

function setResolvedGrammarText(
  change: GrammarTextChange,
  value: string | undefined,
  resolved: { body?: string; commentBodies: Array<string | undefined> },
): void {
  if (change.key === "body") {
    resolved.body = value;
    return;
  }
  const index = Number.parseInt(change.key.slice("comment:".length), 10);
  resolved.commentBodies[index] = value;
}

interface ResolvedReviewText {
  body?: string;
  comments: ReviewInlineComment[];
  commentIndexes: number[];
}

async function resolveUncertainGrammarChanges(
  ctx: HostContext,
  result: Extract<GrammarReviewResult, { status: "review" }>,
  comments: ReviewInlineComment[],
): Promise<ResolvedReviewText | null> {
  const resolved: { body?: string; commentBodies: Array<string | undefined> } = {
    body: result.corrected.body,
    commentBodies: [...result.corrected.comments],
  };

  for (const change of result.changes.filter((candidate) => !candidate.grammarOnly)) {
    const location = getGrammarChangeLocation(change, comments);
    const title = [
      location,
      `Original: ${sanitizeTerminalText(change.original)}`,
      `Fixed: ${sanitizeTerminalText(change.corrected)}`,
      `Why this needs approval: ${sanitizeTerminalText(change.reason)}`,
    ].join("\n\n");
    const choice = await ctx.ui.select(title, [
      USE_CORRECTED_TEXT,
      EDIT_CORRECTED_TEXT,
      KEEP_ORIGINAL_TEXT,
      REMOVE_REVIEW_ITEM,
      CANCEL_REVIEW_SUBMISSION,
    ]);
    if (choice == null || choice === CANCEL_REVIEW_SUBMISSION) return null;
    if (choice === USE_CORRECTED_TEXT) continue;
    if (choice === KEEP_ORIGINAL_TEXT) {
      setResolvedGrammarText(change, change.original, resolved);
      continue;
    }
    if (choice === REMOVE_REVIEW_ITEM) {
      setResolvedGrammarText(change, undefined, resolved);
      continue;
    }
    const edited = await ctx.ui.editor(`Edit ${location}`, change.corrected);
    if (edited == null) return null;
    setResolvedGrammarText(change, edited, resolved);
  }

  const retained = comments.flatMap((comment, index) => {
    const body = resolved.commentBodies[index];
    return body == null ? [] : [{ comment: { ...comment, body }, index }];
  });
  return {
    body: resolved.body,
    comments: retained.map((item) => item.comment),
    commentIndexes: retained.map((item) => item.index),
  };
}

interface UiConfirmedReviewOutcome {
  status: ReviewRunStatus;
  submitted: boolean;
}

function unsubmittedReviewOutcome(status: ReviewRunStatus): UiConfirmedReviewOutcome {
  return { status, submitted: false };
}

function continueSubmissionHandoff(
  pi: HostApi, ctx: HostContext, target: RemoteReviewTarget,
  handoff: { id: string; input: SubmitReviewInput },
  newIntent?: boolean,
): UiConfirmedReviewOutcome {
  const { input } = handoff;
  const prompt = [
    "Continue grammar correction of this saved RAW, unconfirmed review. Nothing has been submitted.",
    "Fix only grammar, spelling, punctuation, and meaning-preserving clarity. Do not inspect code or change the target, verdict, or comment locations.",
    "Obtain the user's approval of the final review text before calling submit_pr_review. Never treat this raw handoff as confirmed text.",
    "Keep handoffId unchanged. Supply one unique original index per final comment in handoffCommentIndexes; retain original indexes when omitting or reordering comments (removing original comment 0 leaves index 1 for original comment 1).",
    "Submit only the approved final text. Never use newIntent to blindly retry an unknown write.",
    "submit_pr_review arguments:",
    "```json",
    JSON.stringify({ ...input, cwd: input.gitRoot, gitRoot: undefined, newIntent, handoffId: handoff.id, handoffCommentIndexes: (input.comments ?? []).map((_comment, index) => index) }, null, 2),
    "```",
  ].join("\n");
  sendReviewFollowUp(pi, ctx, prompt);
  return unsubmittedReviewOutcome({ started: true, prompt, context: formatPullRequestContext(target.pullRequest!) });
}

async function submitUiConfirmedReviewWithOutcome(
  pi: HostApi,
  ctx: HostContext,
  target: RemoteReviewTarget,
  verdict: ReviewVerdict,
  body: string | undefined,
  comments: ReviewInlineComment[],
  association?: { sourceDigest: string; draft: SubmissionDraftBinding; newIntent?: boolean },
): Promise<UiConfirmedReviewOutcome> {
  const pr = target.pullRequest!;
  const provider = providerForTarget(target);
  const original: ReviewTextSet = {
    body,
    comments: comments.map((comment) => comment.body),
  };
  let grammarResult: GrammarReviewResult = { status: "safe", corrected: original, changes: [] };

  if (body != null || comments.length > 0) {
    ctx.ui.setStatus("pi-coder-grammar", `Checking review grammar with ${ctx.models.label("grammar") ?? "the active model"}...`);
    try {
      grammarResult = await reviewGrammar(ctx.models, original);
    } finally {
      ctx.ui.setStatus("pi-coder-grammar", undefined);
    }
  }

  if (grammarResult.status === "error") {
    if (association != null) {
      try {
        const repo = target.repo ?? pr.repo;
        if (repo == null) throw new Error("Repository is unknown.");
        const handoff = prepareSubmissionHandoff({ provider: provider.id, repo, prNumber: pr.number,
          commitId: pr.headRefOid, baseCommitId: pr.baseRefOid, verdict, body, comments,
          prAuthorLogin: pr.authorLogin, gitRoot: target.gitRoot }, { sourceDigest: association.sourceDigest, draft: association.draft });
        return continueSubmissionHandoff(pi, ctx, target, handoff, association.newIntent);
      } catch (error) {
        const message = `Could not save grammar handoff; review kept as a draft: ${error instanceof Error ? error.message : String(error)}`;
        ctx.ui.notify(message, "warning");
        return unsubmittedReviewOutcome({ started: true, message, context: formatPullRequestContext(pr) });
      }
    }
    const prompt = composeReviewSubmissionPrompt(target, verdict, body, comments);
    sendReviewFollowUp(pi, ctx, prompt);
    ctx.ui.notify(`Could not verify grammar automatically: ${grammarResult.error} Sent the review to the agent instead.`, "warning");
    return unsubmittedReviewOutcome({ started: true, prompt, context: formatPullRequestContext(pr) });
  }

  const resolved: ResolvedReviewText | null = grammarResult.status === "review"
    ? await resolveUncertainGrammarChanges(ctx, grammarResult, comments)
    : {
        body: grammarResult.corrected.body,
        comments: comments.map((comment, index) => ({ ...comment, body: grammarResult.corrected.comments[index]! })),
        commentIndexes: comments.map((_comment, index) => index),
      };
  if (resolved == null) {
    const message = "Review submission cancelled; nothing was posted.";
    ctx.ui.notify(message, "info");
    return unsubmittedReviewOutcome({ started: true, message, context: formatPullRequestContext(pr) });
  }

  const repo = target.repo ?? pr.repo;
  if (repo == null) {
    const message = `Could not submit the review because the ${pullRequestProviderName(target)} repository is unknown.`;
    ctx.ui.notify(message, "warning");
    return unsubmittedReviewOutcome({ started: true, message, context: formatPullRequestContext(pr) });
  }
  return deliverConfirmedReview(pi, ctx, target, {
    provider: provider.id,
    repo,
    prNumber: pr.number,
    commitId: pr.headRefOid,
    baseCommitId: pr.baseRefOid,
    verdict,
    body: resolved.body,
    comments: resolved.comments,
    prAuthorLogin: pr.authorLogin,
    gitRoot: target.gitRoot,
  }, association == null ? undefined : {
    ...association,
    draft: { ...association.draft, comments: resolved.commentIndexes.map((index) => association.draft.comments[index]!) },
  });
}

async function deliverConfirmedReview(
  pi: HostApi, ctx: HostContext, target: RemoteReviewTarget,
  input: SubmitReviewInput,
  options?: SubmitReviewOptions,
): Promise<UiConfirmedReviewOutcome> {
  const pr = target.pullRequest!;
  ctx.ui.setStatus("pi-coder-submit", `Posting the review to ${pullRequestProviderName(target)}...`);
  let submission: SubmitReviewResult;
  try {
    submission = options == null
      ? await submitPullRequestReview(pi, input)
      : await submitPullRequestReview(pi, input, options);
  } finally {
    ctx.ui.setStatus("pi-coder-submit", undefined);
  }
  ctx.ui.notify(submission.message, submission.ok ? "info" : "warning");
  if (!submission.ok) {
    const recovery = composeSubmissionRecovery(input, submission);
    if (recovery != null) sendReviewFollowUp(pi, ctx, recovery);
    return unsubmittedReviewOutcome({ started: true, message: submission.message, submission, context: formatPullRequestContext(pr) });
  }

  const prUrl = pullRequestUrl(target);
  sendReviewFollowUp(pi, ctx, [
    `pi-coder already submitted this ${pullRequestProviderName(target)} review after its grammar safety pass.`,
    "Do not ask for confirmation and do not submit the review again.",
    "Run any configured post-review completion callback, then report the result briefly.",
    `PR: ${prUrl}`,
    submission.message,
  ].join("\n"));
  return {
    status: { started: true, message: submission.message, submitted: true, submission, context: formatPullRequestContext(pr) },
    submitted: true,
  };
}

export async function submitUiConfirmedReview(
  pi: HostApi,
  ctx: HostContext,
  target: RemoteReviewTarget,
  verdict: ReviewVerdict,
  body: string | undefined,
  comments: ReviewInlineComment[],
): Promise<ReviewRunStatus> {
  return (await submitUiConfirmedReviewWithOutcome(pi, ctx, target, verdict, body, comments)).status;
}

const REVIEW_VERDICT_LABELS: Record<ReviewVerdict, string> = {
  approve: "Approve",
  request_changes: "Request changes",
  comment: "Post Comments",
};

const REVIEW_VERDICT_ORDER: ReviewVerdict[] = ["approve", "request_changes", "comment"];

export interface ReviewEndAction {
  verdict: ReviewVerdict;
  skipBody: boolean;
}

/**
 * Puts the last-used verdict first so the selector opens on it, and offers one explicit
 * empty-body fast path for that verdict. Every choice still requires a deliberate pick.
 */
export function buildReviewEndActions(lastVerdict: PersistedReviewVerdict | null | undefined): { choices: string[]; actions: Map<string, ReviewEndAction> } {
  const ordered = lastVerdict == null
    ? REVIEW_VERDICT_ORDER
    : [lastVerdict, ...REVIEW_VERDICT_ORDER.filter((verdict) => verdict !== lastVerdict)];
  const choices: string[] = [];
  const actions = new Map<string, ReviewEndAction>();

  for (const verdict of ordered) {
    const label = REVIEW_VERDICT_LABELS[verdict];
    choices.push(label);
    actions.set(label, { verdict, skipBody: false });
    if (verdict !== lastVerdict) continue;
    const fastLabel = `${label} without a body`;
    choices.push(fastLabel);
    actions.set(fastLabel, { verdict, skipBody: true });
  }

  return { choices, actions };
}

function pullRequestSessionIdentity(target: RemoteReviewTarget): string {
  const pr = target.pullRequest!;
  const provider = providerForTarget(target).id;
  const repo = target.repo ?? target.remote;
  return ["pr", provider, repo, pr.number].join("|");
}

export function composeRemoteReviewPrompt(target: RemoteReviewTarget, reviewPrompt: string): string {
  const lines: string[] = [];

  if (target.pullRequest != null) {
    const context = formatPullRequestContext(target.pullRequest);
    const provider = pullRequestProviderName(target);
    lines.push(`${provider} PR review feedback.`);
    lines.push("");
    lines.push(context);
    if (target.repo != null) lines.push(`URL: ${pullRequestUrl(target)}`);
    lines.push(`Head commit: ${target.pullRequest.headRefOid}`);
  } else {
    lines.push(`Remote branch review feedback for ${target.branch}.`);
  }
  lines.push("");
  lines.push("Remote review agent-only flow:");
  lines.push("- This handoff is for the agent only. Do not post comments, approve, request changes, or take any public pull-request action from this prompt.");
  lines.push("- DISCUSS items are agent-only questions. Answer them in prose; do not edit files or post to the pull request unless the user explicitly asks for a separate change.");
  lines.push("");
  lines.push("Rules for pull-request actions:");
  lines.push("- Do not post comments, approve, or request changes until the user explicitly confirms the exact public action.");
  lines.push("- For line-specific comments, verify the path, side, line, and head commit before constructing the review request.");
  lines.push("- Deleted-side comments may need to be posted as general review body comments if exact LEFT-side mapping is uncertain.");
  lines.push("");
  lines.push(reviewPrompt);
  return lines.join("\n").trim();
}

export function composeRemoteDiscussionPrompt(target: RemoteReviewTarget, discussionPrompt: string, sessionId = createReviewSessionId(pullRequestSessionIdentity(target))): string {
  const pr = target.pullRequest!;
  const context = formatPullRequestContext(pr);
  const reopenArguments = {
    args: `remote ${target.remote}`,
    cwd: target.gitRoot,
    continuation: {
      kind: "remote-discuss" as const,
      priorSessionId: sessionId,
      priorBaseRevision: target.baseRef,
      priorHeadRevision: pr.headRefOid,
    },
  };
  const lines = [
    `${pullRequestProviderName(target)} PR review discussion.`,
    "",
    context,
    ...(target.repo == null ? [] : [`URL: ${pullRequestUrl(target)}`]),
    `Head commit: ${pr.headRefOid}`,
    "",
    "Saved review state:",
    "- The DISCUSS items below were consumed when this conversation started.",
    "- Existing COMMENT and MODIFY items remain in the saved review for the PR author. They are not instructions for you and must not be acted on during this discussion.",
    "",
    "Discussion rules:",
    "- Discuss the user's questions in prose. Read code or gather evidence when needed, but do not edit files or post anything to the pull request.",
    "- Keep the conversation open until the questions are resolved or the user decides to stop.",
    "",
    "Completion flow:",
    "1. If the discussion produces concrete findings that would help the PR author, ask exactly: Want me to prepopulate the findings as comments?",
    "2. Use the available ask-user tool for that decision. Do not infer approval from the surrounding conversation.",
    "3. Only after confirmation, convert those findings into open_code_diff seed comments with intent comment. Do not turn them into discuss or modify items.",
    "4. Ask exactly: Good to continue the review?",
    "5. Use the available ask-user tool for that decision. A yes is the user's direct authorization to reopen this saved review.",
    "6. Only after that confirmation, call open_code_diff with the base arguments below. If finding prepopulation was confirmed, add only those new findings in the comments array.",
    "7. Do not call open_code_diff merely because this handoff mentions it. If the user declines or cancels continuation, leave the saved review closed.",
    "",
    "open_code_diff base arguments:",
    "```json",
    JSON.stringify(reopenArguments, null, 2),
    "```",
    "",
    discussionPrompt,
  ];
  return lines.join("\n").trim();
}

interface DraftConsumption {
  commentIds: readonly string[];
  consumeAllComment: boolean;
}

interface RemotePrFinishResult {
  status: ReviewRunStatus;
  consumption?: DraftConsumption;
}

interface ReviewSessionTarget {
  identity: string;
  revision: string;
  meta: ReviewSessionMeta;
}

function buildReviewSessionTarget(data: ReviewWindowData, remoteTarget?: RemoteReviewTarget): ReviewSessionTarget {
  const { repoRoot, branchBaseRevision, modifiedRevision } = data;
  const pr = remoteTarget?.pullRequest;
  const revision = pr?.headRefOid ?? modifiedRevision ?? "worktree";

  if (remoteTarget != null && pr != null) {
    const repo = remoteTarget.repo ?? remoteTarget.remote;
    const url = pullRequestUrl(remoteTarget);
    return {
      identity: pullRequestSessionIdentity(remoteTarget),
      revision,
      meta: {
        kind: "remote",
        label: `${repo}#${pr.number} ${pr.title}`,
        url,
        resumeArgs: `remote ${remoteTarget.remote}`,
        cwd: remoteTarget.gitRoot,
      },
    };
  }

  const identity = [repoRoot, branchBaseRevision ?? "working", revision, remoteTarget?.remote ?? "local"].join("|");
  if (remoteTarget != null) {
    return {
      identity,
      revision,
      meta: { kind: "remote", label: `${remoteTarget.repo ?? remoteTarget.remote} ${remoteTarget.branch}`, resumeArgs: `remote ${remoteTarget.remote}`, cwd: remoteTarget.gitRoot },
    };
  }
  return { identity, revision, meta: { kind: "local", label: repoRoot, resumeArgs: "", cwd: repoRoot } };
}

async function pickParkedReview(ctx: HostContext): Promise<ReviewSessionIndexEntry | null> {
  const sessions = listReviewSessions();
  if (sessions.length === 0) {
    ctx.ui.notify("No parked reviews to resume.", "info");
    return null;
  }
  const labels = sessions.map(formatParkedSessionChoice);
  const choice = await ctx.ui.select("Resume a parked review", labels);
  if (choice == null) return null;
  return sessions[labels.indexOf(choice)] ?? null;
}

function shortRevisionLabel(revision: string): string {
  return /^[0-9a-f]{40}$/i.test(revision) ? revision.slice(0, 7) : revision;
}

function formatParkedSessionChoice(entry: ReviewSessionIndexEntry): string {
  const comments = `${entry.commentCount} comment${entry.commentCount === 1 ? "" : "s"}`;
  const reviewed = `${entry.reviewedCount} reviewed`;
  const when = entry.updatedAt.slice(0, 16).replace("T", " ");
  return `${entry.label} · ${comments} · ${reviewed} · ${when} · ${entry.id}`;
}

function consumeDraftItems(session: ReviewSessionData, consumption: DraftConsumption): ReviewSessionData {
  const consumedIds = new Set(consumption.commentIds);
  return {
    ...session,
    state: {
      ...session.state,
      draft: {
        ...session.state.draft,
        allComment: consumption.consumeAllComment ? "" : session.state.draft.allComment,
        comments: session.state.draft.comments.filter((comment) => !consumedIds.has(comment.id)),
      },
    },
  };
}

function countDraftItems(session: ReviewSessionData): number {
  return session.state.draft.comments.length + (session.state.draft.allComment.trim().length > 0 ? 1 : 0);
}

function hasSubmitPayloadContent(result: ReviewSubmitPayload): boolean {
  return result.allComment.trim().length > 0 || result.comments.length > 0;
}

function getRemoteInlineCommentIds(
  files: ReviewFile[],
  result: ReviewSubmitPayload,
  supportsFileComments: boolean,
): string[] {
  return result.comments
    .filter((comment) => {
      if (comment.intent !== "comment" && comment.intent !== "modify") return false;
      const file = files.find((candidate) => candidate.id === comment.fileId);
      if (file?.pathPrefix != null) return false;
      if (comment.side === "file") return supportsFileComments && comment.intent !== "modify";
      return comment.startLine != null;
    })
    .map((comment) => comment.id);
}

function getRemoteBodyConsumption(result: ReviewSubmitPayload, includeFileComments: boolean): DraftConsumption {
  return {
    consumeAllComment: result.allIntent === "comment" && result.allComment.trim().length > 0,
    commentIds: includeFileComments
      ? result.comments
          .filter((comment) => comment.intent === "comment" && comment.side === "file" && comment.body.trim().length > 0)
          .map((comment) => comment.id)
      : [],
  };
}

export function notifyShortcutWarnings(ctx: Pick<HostContext, "hasUI" | "ui">, warnings: string[]): void {
  if (warnings.length === 0 || !ctx.hasUI) return;
  ctx.ui.notify(`pi-coder config: ${warnings.join(" ")}`, "warning");
}

export function createPiCoderEngine(pi: HostApi, options: PiCoderEngineOptions = {}): PiCoderEngine {
  const initialPreferences = loadReviewPreferences();
  const launchExternalEditor = options.runExternalEditor ?? runExternalEditor;
  const commands = options.commands ?? DEFAULT_COMMAND_NAMES;
  const fullscreenOverride = process.env.PI_CODER_HERDR_FULLSCREEN?.trim().toLowerCase();
  let herdrFullscreen = fullscreenOverride === "off"
    ? false
    : fullscreenOverride === "on"
      ? true
      : initialPreferences.herdrFullscreen;
  let activeReview = false;
  let localProgressGeneration = 0;
  let localProgressTimer: ReturnType<typeof setTimeout> | null = null;
  let localProgressContext: HostContext | null = null;

  function clearLocalProgress(expectedGeneration?: number): void {
    if (expectedGeneration != null && expectedGeneration !== localProgressGeneration) return;
    if (localProgressTimer != null) clearTimeout(localProgressTimer);
    localProgressTimer = null;
    const progressContext = localProgressContext;
    localProgressContext = null;
    if (progressContext != null) setLocalProgress(progressContext, undefined);
  }

  function beginLocalProgress(ctx: HostContext): () => void {
    clearLocalProgress();
    const generation = ++localProgressGeneration;
    localProgressContext = ctx;
    setLocalProgress(ctx, LOCAL_PROGRESS_MESSAGE);
    localProgressTimer = setTimeout(() => {
      if (generation !== localProgressGeneration || localProgressContext !== ctx) return;
      setLocalProgress(ctx, LOCAL_PROGRESS_SLOW_MESSAGE);
    }, LOCAL_PROGRESS_DELAY_MS);
    return () => clearLocalProgress(generation);
  }

  async function openReviewData(
    ctx: HostContext,
    data: ReviewWindowData,
    remoteTarget?: RemoteReviewTarget,
    seedComments?: SeedReviewComment[],
    sessionOptions?: { resumeId?: string; resumeIdentity?: string; discard?: boolean; story?: boolean },
    localReview?: { scopeFingerprint: string; refresh: () => Promise<ReviewWindowData> },
  ): Promise<ReviewRunStatus> {
    if (activeReview) {
      const message = "A review session is already open.";
      ctx.ui.notify(message, "warning");
      return { started: false, message };
    }

    activeReview = true;
    const testSearch = new AbortController();
    try {
      const repoRoot = data.repoRoot;
      let files = data.files;
      let branchBaseRevision = data.branchBaseRevision;
      let modifiedRevision = data.modifiedRevision;
      let reviewScope = data.scope;
      let loadFileContentsForReview = (activeRepoRoot: string, file: ReviewFile, scope: ReviewScope) => activeRepoRoot === repoRoot
        ? loadReviewFileContents(pi, activeRepoRoot, file, scope, branchBaseRevision, modifiedRevision)
        : loadReviewFileContents(pi, activeRepoRoot, file, scope);
      const shortcutConfig = loadCommentShortcuts();
      if (files.length === 0 && sessionOptions?.resumeId == null) {
        const message = "No reviewable files found for this diff.";
        ctx.ui.notify(message, "info");
        return { started: false, message };
      }

      notifyShortcutWarnings(ctx, shortcutConfig.warnings);
      const sessionTarget = buildReviewSessionTarget(data, remoteTarget);
      const sessionIdentity = sessionTarget.identity;
      let storageIdentity = sessionOptions?.resumeIdentity ?? sessionIdentity;
      const sessionRevision = sessionTarget.revision;
      const fileSignatures = buildReviewFileSignatures(files);
      let sessionContext = { revision: sessionRevision, fileSignatures, meta: sessionTarget.meta };
      const resumeId = sessionOptions?.resumeId === "latest"
        ? listReviewSessions().find((entry) => entry.identity === sessionIdentity)?.id
        : sessionOptions?.resumeId;
      if (sessionOptions?.resumeId === "latest" && resumeId == null) throw new Error("No parked review exists for this target.");
      const legacyId = createReviewSessionId(sessionIdentity);
      let savedSession = resumeId == null && !sessionOptions?.discard ? null : loadReviewSession(storageIdentity, resumeId ?? legacyId);
      if (resumeId != null && savedSession == null) throw new Error(`Review session ${resumeId} is missing, deleted, or belongs to another target. Use ${commands.diff} --resume to select an existing review.`);
      if (sessionOptions?.discard) {
        const deletion = deleteReviewSession(storageIdentity, resumeId ?? legacyId, savedSession?.generation);
        if (!deletion.deleted) throw new Error(`Review was not discarded (${deletion.status}); its saved snapshot was retained.`);
        savedSession = null;
        storageIdentity = sessionIdentity;
      }
      // A new review never reuses a prior instance, including a consumed legacy target-keyed draft.
      const sessionId = resumeId != null && !sessionOptions?.discard ? resumeId : createReviewInstanceId();
      let expectedGeneration: number | null = resumeId != null && savedSession != null ? savedSession.generation : null;
      let initialSession: ReviewSessionData | null = savedSession;
      if (savedSession != null && savedSession.revision !== sessionRevision) {
        const rebase = rebaseReviewSession(savedSession, files, reviewScope, fileSignatures);
        initialSession = rebase.data;
        const details = [
          `${rebase.reanchored} kept`,
          ...(rebase.needsAttention > 0 ? [`${rebase.needsAttention} need attention`] : []),
          ...(rebase.unanchored > 0 ? [`${rebase.unanchored} unanchored into the review note`] : []),
        ].join(", ");
        ctx.ui.notify(`Resumed review from ${shortRevisionLabel(rebase.previousRevision)}; head moved to ${shortRevisionLabel(sessionRevision)}: ${details}.`, rebase.needsAttention + rebase.unanchored > 0 ? "warning" : "info");
      } else if (savedSession != null) {
        ctx.ui.notify(`Resumed review session ${sessionId}.`, "info");
      }
      let recoveredComposition: ReviewComposition | undefined;
      if (resumeId != null && savedSession != null) {
        const recoveries = listReviewCompositions(storageIdentity, sessionId);
        if (recoveries.length > 0) {
          const labels = recoveries.map((item) => `${item.id.slice(0, 8)} · ${item.target.intent} · ${sanitizeTerminalText(item.path ?? "review-wide note")} · ${sanitizeTerminalText(item.text).slice(0, 60)}`);
          const selected = await ctx.ui.select("Recover unfinished editor text? Nothing is submitted.", [...labels, "Keep committed feedback; leave recovery copies saved"]);
          if (selected != null) recoveredComposition = recoveries[labels.indexOf(selected)];
        }
      }
      let latestSession: ReviewSessionData | null = initialSession;
      let latestSessionDurable = initialSession != null && expectedGeneration != null;
      let lastSaveFailure: string | undefined;
      const saveSession = (session: ReviewSessionData): boolean => {
        const save = saveReviewSessionWithStatus(sessionIdentity, session, {
          ...sessionContext, id: sessionId, expectedGeneration,
          ...(storageIdentity === sessionIdentity ? {} : { previousIdentity: storageIdentity }),
        });
        latestSessionDurable = save.saved;
        if (save.saved) {
          storageIdentity = sessionIdentity;
          expectedGeneration = save.generation;
          if (!save.indexUpdated && lastSaveFailure !== "index") ctx.ui.notify(`Review saved as ${sessionId}, but the picker index could not be updated. Resume with --resume ${sessionId}.`, "warning");
          lastSaveFailure = save.indexUpdated ? undefined : "index";
        } else if (lastSaveFailure !== save.status) {
          lastSaveFailure = save.status;
          ctx.ui.notify(`Review save ${save.status}: your edits remain in memory and the stored snapshot was not overwritten. Keep this review open until persistence is resolved.`, "warning");
        }
        return save.saved;
      };
      let lastCompositionFailure: string | undefined;
      const persistComposition = (operation: () => void): boolean => {
        try {
          operation();
          lastCompositionFailure = undefined;
          return true;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (lastCompositionFailure !== message) ctx.ui.notify(`Editor recovery failed: ${sanitizeTerminalText(message)}. Keep the editor open or copy its text.`, "warning");
          lastCompositionFailure = message;
          return false;
        }
      };
      const deleteSession = (): string | undefined => {
        const deletion = deleteReviewSession(storageIdentity, sessionId, expectedGeneration ?? undefined);
        if (deletion.deleted) return undefined;
        const message = `Review was not discarded (${deletion.status}); the saved snapshot was retained.`;
        ctx.ui.notify(message, "warning");
        return message;
      };
      const persistDraftConsumption = (
        consumption: DraftConsumption,
        failureItemLabel = "submitted items",
      ): { remainingItems: number; message?: string } => {
        const currentSession = latestSession ?? loadReviewSession(storageIdentity, sessionId);
        if (currentSession == null) return { remainingItems: 0, message: deleteSession() };
        const retainedSession = consumeDraftItems(currentSession, consumption);
        const remainingItems = countDraftItems(retainedSession);
        if (!saveSession(retainedSession)) {
          const message = `Could not save consumed review state; the previous full snapshot was retained, so ${failureItemLabel} may appear again on resume.`;
          ctx.ui.notify(message, "warning");
          return { remainingItems, message };
        }
        latestSession = retainedSession;
        latestSessionDurable = true;
        if (remainingItems === 0) {
          const hasLocalHistory = retainedSession.story != null || (retainedSession.discussions?.length ?? 0) > 0;
          return { remainingItems, message: hasLocalHistory ? undefined : deleteSession() };
        }
        const message = `${remainingItems} unresolved draft ${remainingItems === 1 ? "item remains" : "items remain"} saved in review session ${sessionId}.`;
        ctx.ui.notify(message, "warning");
        return { remainingItems, message };
      };

      if (remoteTarget?.pullRequest != null) {
        ctx.ui.notify(formatPullRequestContext(remoteTarget.pullRequest), "info");
      }

      const handoff = remoteTarget?.handoff;
      const handoffThreads = countHandoffThreads(handoff);
      const pullRequest = remoteTarget?.pullRequest;
      const reviewHeader = remoteTarget == null || pullRequest == null
        ? undefined
        : {
            identity: `${remoteTarget.repo ?? remoteTarget.remote}#${pullRequest.number}`,
            title: pullRequest.title,
            state: pullRequest.state,
            revision: pullRequest.headRefOid,
            ...(handoff?.queue == null ? {} : { queue: handoff.queue }),
            ...(handoffThreads == null ? {} : { openThreads: handoffThreads.open, awaitingReply: handoffThreads.awaitingReply }),
          };

      const pullRequestSources = createRemotePullRequestSources(pi, ctx, remoteTarget);
      const sourceLinks = loadReviewSourceLinks(remoteTarget);
      let story: PreparedDiffStory | undefined;
      if (sessionOptions?.story || initialSession?.story != null) {
        const scope = reviewScope;
        const storyFiles = getScopedFiles(files, scope);
        const testRevision = scope === "all-files" ? modifiedRevision ?? "HEAD" : scope === "git-diff" ? null : undefined;
        const repositoryPaths = new Map(storyFiles.flatMap((file) => {
          const comparison = scope === "git-diff" ? file.gitDiff : file.allFiles;
          return file.pathPrefix == null && comparison?.newPath != null ? [[file.id, comparison.newPath] as const] : [];
        }));
        const prepared = await prepareDiffStory(
          ctx,
          storyFiles,
          scope,
          (file, selectedScope) => loadFileContentsForReview(repoRoot, file, selectedScope),
          initialSession?.story,
          undefined,
          reviewHeader == null ? undefined : { header: reviewHeader, brief: pullRequestSources.contextPanelSource?.brief },
          testRevision === undefined ? undefined
            : (snapshot) => findExistingStoryTests(snapshot, createGitTestSource(pi, repoRoot, testRevision), testSearch.signal, repositoryPaths),
        );
        if (prepared == null) return { started: false, message: "Story preparation cancelled; saved feedback was not changed." };
        if (prepared !== "diff") {
          story = prepared;
          const originalLoader = loadFileContentsForReview;
          loadFileContentsForReview = (root, file, selectedScope) => {
            const captured = root === repoRoot ? story!.snapshot.files.find((entry) => entry.fileId === file.id && entry.scope === selectedScope) : undefined;
            return captured == null ? originalLoader(root, file, selectedScope) : Promise.resolve(captured.contents);
          };
        } else if (initialSession != null) initialSession = { ...initialSession, story: undefined };
      }
      const seed = resolveSeedComments(files, reviewScope, seedComments ?? []);
      const partitionedSeed = initialSession == null
        ? { applicable: seed.resolved, conflicts: [] }
        : partitionResolvedSeedComments(initialSession.state, seed.resolved);
      if (seed.unresolved.length > 0 && ctx.hasUI) {
        const label = seed.unresolved.length === 1 ? "comment" : "comments";
        const paths = seed.unresolved.map((comment) => comment.path).join(", ");
        ctx.ui.notify(`pi-coder: could not place ${seed.unresolved.length} prepopulated ${label} (${paths}).`, "warning");
      }
      if (partitionedSeed.conflicts.length > 0 && ctx.hasUI) {
        const existingLabel = partitionedSeed.conflicts.length === 1 ? "item" : "items";
        const seedLabel = partitionedSeed.conflicts.length === 1 ? "comment" : "comments";
        ctx.ui.notify(`pi-coder: kept ${partitionedSeed.conflicts.length} existing review ${existingLabel}; skipped conflicting prepopulated ${seedLabel}.`, "warning");
      }
      const applicableSeeds = await anchorResolvedSeedComments(
        partitionedSeed.applicable,
        files,
        (file, scope) => loadFileContentsForReview(repoRoot, file, scope),
      );

      let result: Awaited<ReturnType<typeof runReviewApp>>;
      let firstReview = true;
      let resumeBanner: string | undefined;
      while (true) {
        if (initialSession != null) {
          const validatedState = await revalidateReviewDraftAnchors(
            initialSession.state,
            files,
            (file, scope) => loadFileContentsForReview(repoRoot, file, scope),
            reviewScope,
          );
          initialSession = { ...initialSession, state: validatedState };
          latestSession = initialSession;
          if (!saveSession(initialSession)) {
            ctx.ui.notify("Draft anchor validation could not be saved; this mount is using the validated in-memory snapshot while the previous full durable snapshot remains intact.", "warning");
          }
        }
        const mountReview = () => runReviewApp(ctx, {
          codeCommand: commands.code,
          files,
          repoRoot,
          loadFileContents: loadFileContentsForReview,
          loadSubmoduleReviewData: (submodule) => hasExactSubmoduleRange(submodule)
            ? getReviewWindowDataForRevisionRange(pi, submodule.repoRoot, submodule.oldSha, submodule.newSha, { wholeRepo: true })
            : getReviewWindowData(pi, submodule.repoRoot, { wholeRepo: true }),
          commentShortcuts: shortcutConfig.shortcuts,
          allowEmptySubmit: remoteTarget == null || remoteTarget.pullRequest != null,
          scope: reviewScope,
          seedComments: firstReview ? applicableSeeds : [],
          ...(firstReview ? pullRequestSources : createRemotePullRequestSources(pi, ctx, remoteTarget)),
          orderSignals: buildReviewOrderSignals(handoff),
          reviewHeader,
          sourceLinks,
          story,
          initialSession: initialSession ?? undefined,
          reviewIdentity: sessionIdentity,
          reviewSessionId: sessionId,
          reviewScopeFingerprint: localReview?.scopeFingerprint,
          initialBanner: resumeBanner,
          initialComposition: firstReview ? recoveredComposition : undefined,
          onCompositionSave: (composition) => {
            // Only a first snapshot failure needs membership retried. Never reload/replay a stale generation.
            if (expectedGeneration == null && (latestSession == null || !saveSession(latestSession))) return false;
            return persistComposition(() => saveReviewComposition(storageIdentity, sessionId, composition));
          },
          onCompositionRemove: (id) => persistComposition(() => removeReviewComposition(storageIdentity, sessionId, id)),
          onSessionChange: (session) => {
            latestSession = session;
            return saveSession(session);
          },
        });
        result = herdrFullscreen
          ? await withHerdrPaneZoom(mountReview, {
              run: async (args) => {
                const command = await pi.exec("herdr", args, { timeout: 2_000 });
                return { code: command.code, stdout: command.stdout, stderr: command.stderr };
              },
              warn: (message) => ctx.ui.notify(message, "warning"),
              command: commands.diff,
            })
          : await mountReview();
        firstReview = false;

        if (result.type === "open-editor") {
          let editorBanner: string;
          try {
            const outcome = await launchExternalEditor(result.command, result.args, repoRoot);
            editorBanner = outcome.kind === "signal"
              ? `$EDITOR was terminated by ${sanitizeTerminalText(outcome.signal)}.`
              : outcome.code === 0
                ? `Returned from $EDITOR at ${result.filePath}:${result.line}.`
                : `$EDITOR exited with code ${outcome.code}.`;
          } catch (error) {
            editorBanner = `Could not open $EDITOR: ${sanitizeTerminalText(error instanceof Error ? error.message : String(error))}`;
          }

          const persisted = latestSession ?? loadReviewSession(sessionIdentity, sessionId);
          if (localReview == null) {
            initialSession = persisted;
            resumeBanner = editorBanner;
            continue;
          }
          const refreshed = await localReview.refresh();
          if (refreshed.repoRoot !== repoRoot) {
            initialSession = persisted;
            resumeBanner = `${editorBanner} Review location is stale because its canonical repository changed.`;
            continue;
          }
          files = refreshed.files;
          branchBaseRevision = refreshed.branchBaseRevision;
          modifiedRevision = refreshed.modifiedRevision;
          reviewScope = refreshed.scope;
          sessionContext = {
            ...sessionContext,
            revision: modifiedRevision ?? sessionContext.revision,
            fileSignatures: buildReviewFileSignatures(files),
          };
          if (persisted != null && result.resume != null) {
            const resolution = await resolveReviewResume(
              result.resume,
              persisted.state,
              files,
              repoRoot,
              (file) => loadFileContentsForReview(repoRoot, file, "git-diff"),
              { repository: repoRoot, identity: sessionIdentity, sessionId, scopeFingerprint: localReview.scopeFingerprint },
            );
            initialSession = { ...persisted, state: resolution.state };
            resumeBanner = [editorBanner, resolution.banner].filter((part): part is string => part != null && part.length > 0).join(" ");
          } else {
            initialSession = persisted;
            resumeBanner = editorBanner;
          }
          continue;
        }

        if (result.type !== "open-code") break;
        const resumeReference = result.resume;
        if (remoteTarget != null || resumeReference.repository !== repoRoot || resumeReference.identity !== sessionIdentity) {
          ctx.ui.notify(`This review location cannot open ${commands.code} because it is not the current local working-tree frame.`, "warning");
          initialSession = latestSession ?? loadReviewSession(sessionIdentity, sessionId);
          continue;
        }

        const code = await runCode("review-bridge", ctx, repoRoot, normalizeWorkbenchLaunch({
          initialTarget: result.target,
          capabilities: { discuss: true },
        }));
        if (code.kind === "command") {
          if (!code.command.ok) ctx.ui.notify(code.command.message, "error");
        } else {
          const outcome = code.outcome;
          if ((outcome.status === "discuss" || outcome.status === "failed") && latestSession != null && !latestSessionDurable) {
            initialSession = latestSession;
            resumeBanner = "Could not durably save the full review draft. The review remains open with its in-memory snapshot; retry before leaving it.";
            continue;
          }
          if (outcome.status === "discuss") {
            const prompt = [
              composeCodeDiscussionPrompt(repoRoot, outcome),
              "",
              `The suspended local review draft remains saved. When the discussion is complete, ask exactly: Good to continue the review? Reopen ${commands.diff} only after the user explicitly confirms.`,
            ].join("\n");
            return { started: true, prompt };
          }
          if (outcome.status === "failed") {
            const message = `Code workbench failed: ${outcome.message} The review draft remains resumable as session ${sessionId}.`;
            ctx.ui.notify(message, "error");
            return { started: true, message };
          }
        }

        const refreshed = localReview == null ? await getReviewWindowData(pi, repoRoot) : await localReview.refresh();
        const persisted = latestSession ?? loadReviewSession(sessionIdentity, sessionId);
        if (refreshed.repoRoot !== repoRoot) {
          initialSession = persisted;
          resumeBanner = "Review location is stale because its canonical repository changed.";
          continue;
        }
        files = refreshed.files;
        branchBaseRevision = refreshed.branchBaseRevision;
        modifiedRevision = refreshed.modifiedRevision;
        reviewScope = refreshed.scope;
        sessionContext = {
          ...sessionContext,
          revision: modifiedRevision ?? sessionContext.revision,
          fileSignatures: buildReviewFileSignatures(files),
        };
        if (persisted != null) {
          const resolution = await resolveReviewResume(
            resumeReference,
            persisted.state,
            files,
            repoRoot,
            (file) => loadReviewFileContents(pi, repoRoot, file, "git-diff", branchBaseRevision, modifiedRevision),
            localReview == null ? undefined : { repository: repoRoot, identity: sessionIdentity, sessionId, scopeFingerprint: localReview.scopeFingerprint },
          );
          initialSession = { ...persisted, state: resolution.state };
          resumeBanner = resolution.banner;
        } else {
          initialSession = null;
          resumeBanner = "Review location is stale because the saved review frame could not be restored.";
        }
      }

      if (result.type === "cancel") {
        if (result.disposition == null) {
          const failure = deleteSession();
          if (failure != null) return { started: false, message: failure };
          const message = "Review cancelled.";
          ctx.ui.notify(message, "info");
          return { started: true, message };
        }
        if (result.disposition === "discard") {
          const failure = deleteSession();
          return failure == null ? { started: true } : { started: false, message: failure };
        }
        if (latestSession != null && !latestSessionDurable) saveSession(latestSession);
        const resumeHint = `${commands.diff} ${sessionTarget.meta.resumeArgs ? `${sessionTarget.meta.resumeArgs} ` : ""}--resume ${sessionId}`;
        const message = latestSessionDurable
          ? `Review parked. Resume with ${resumeHint}.`
          : "Could not save the review draft; it was not safely parked.";
        ctx.ui.notify(message, latestSessionDurable ? "info" : "warning");
        return { started: latestSessionDurable, message };
      }

      const fullSession = latestSession ?? loadReviewSession(storageIdentity, sessionId);
      const placement = await placeReviewSubmitComments(result, files, (file, scope) => loadFileContentsForReview(repoRoot, file, scope));
      const submitted = placement.payload;
      if (placement.fileNotes > 0) {
        ctx.ui.notify(placement.fileNotes === 1
          ? "1 stale comment will go out as a file comment that names its original lines."
          : `${placement.fileNotes} stale comments will go out as file comments that name their original lines.`, "info");
      }
      const droppedLabel = placement.dropped === 1 ? "1 comment on a file that left the review stays" : `${placement.dropped} comments on files that left the review stay`;
      if (placement.dropped > 0) ctx.ui.notify(`${droppedLabel} saved in review session ${sessionId}.`, "warning");

      if (remoteTarget?.pullRequest != null) {
        const finished = await finishRemotePrReview(ctx, files, submitted, remoteTarget, sessionId, fullSession?.state.draft ?? result);
        let status = finished.status;
        // Provider submissions are consumed by the shared service; only DISCUSS remains caller-owned.
        if (finished.consumption != null) {
          const retained = persistDraftConsumption(finished.consumption);
          if (retained.message != null) status = { ...status, message: status.message == null ? retained.message : `${status.message}\n${retained.message}` };
        }
        const nextCandidate = handoff?.nextCandidate;
        if (status.submitted !== true || nextCandidate == null) return status;
        return { ...status, nextCandidate };
      }

      if (!hasSubmitPayloadContent(submitted) && placement.dropped > 0) {
        return { started: true, message: `Nothing was submitted. ${droppedLabel} saved in review session ${sessionId}.` };
      }
      if (remoteTarget == null && !hasSubmitPayloadContent(submitted)) {
        const retained = persistDraftConsumption({ commentIds: [], consumeAllComment: false }, "old draft items");
        const approvalMessage = "PR approved";
        return { started: true, prompt: approvalMessage, ...(retained.message == null ? {} : { message: retained.message }) };
      }
      const reviewPrompt = composeReviewPrompt(files, submitted);
      const prompt = remoteTarget == null ? reviewPrompt : composeRemoteReviewPrompt(remoteTarget, reviewPrompt);
      const retained = persistDraftConsumption({
        commentIds: submitted.comments.map((comment) => comment.id),
        consumeAllComment: submitted.allComment.trim().length > 0,
      });
      return { started: true, prompt, ...(retained.message == null ? {} : { message: retained.message }) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Could not open review UI: ${message}`, "error");
      return { started: false, message };
    } finally {
      testSearch.abort();
      activeReview = false;
    }
  }

  async function finishRemotePrReview(ctx: HostContext, files: Parameters<typeof composeReviewPrompt>[0], result: ReviewSubmitPayload, target: RemoteReviewTarget, sessionId: string, rawDraft: ReviewSessionData["state"]["draft"]): Promise<RemotePrFinishResult> {
    const pr = target.pullRequest!;
    const provider = providerForTarget(target);
    const supportsFileComments = getProviderCapability(provider, "fileComments");
    const inlineComments = buildProviderComments(files, result.comments, supportsFileComments, provider.label);
    const inlineCommentIds = getRemoteInlineCommentIds(files, result, supportsFileComments);
    const discussionPrompt = composeDiscussionPrompt(files, result);
    const includeFileComments = !supportsFileComments;
    const bodyConsumption = getRemoteBodyConsumption(result, includeFileComments);
    const identity = pullRequestSessionIdentity(target);
    const repo = target.repo ?? pr.repo;
    if (repo == null) throw new Error("Repository is unknown.");
    const sourceFingerprint = submissionDraftSourceFingerprint({ provider: provider.id, repo, prNumber: pr.number, commitId: pr.headRefOid, baseCommitId: pr.baseRefOid, gitRoot: target.gitRoot }, rawDraft);
    const sourceDigest = submissionFingerprint({ provider: provider.id, repo: target.repo ?? pr.repo, prNumber: pr.number, head: pr.headRefOid, base: pr.baseRefOid, draft: { allComment: rawDraft.allComment, allIntent: rawDraft.allIntent, comments: rawDraft.comments }, inlineComments, reviewBody: buildReviewBody(files, result, includeFileComments) });
    const bindItems = (ids: readonly string[]) => ids.map((id) => ({ id, fingerprint: submissionFingerprint(rawDraft.comments.find((comment) => comment.id === id)) }));
    const draft: SubmissionDraftBinding = {
      identity, sessionId, sourceFingerprint, comments: bindItems(inlineCommentIds), bodyComments: bindItems(bodyConsumption.commentIds),
      ...(bodyConsumption.consumeAllComment ? { allCommentFingerprint: submissionFingerprint({ allComment: rawDraft.allComment, allIntent: rawDraft.allIntent }) } : {}),
    };
    const saved = createSubmissionJournal().findForDraft(identity, sessionId, sourceDigest, sourceFingerprint);
    // Completed scope with nothing exact left to consume must not capture a new end-action decision.
    if (saved != null && saved.draft != null
      && (saved.steps.some((step) => step.status !== "submitted") || hasConsumableConfirmedSubmissionDraft(saved, rawDraft))) {
      const submitted = await deliverConfirmedReview(pi, ctx, target, saved.input, { attemptId: saved.id, sourceDigest, draft: saved.draft });
      return { status: submitted.status };
    }

    const handoff = createSubmissionJournal().findHandoffForDraft(identity, sessionId, sourceDigest);
    if (handoff != null) return { status: continueSubmissionHandoff(pi, ctx, target, handoff, saved != null ? true : undefined).status };

    const discussionChoice = "Start discussion with agents";
    const endActions = buildReviewEndActions(loadReviewPreferences().lastReviewVerdict);
    const choices = [...endActions.choices];
    if (discussionPrompt.length > 0) choices.unshift(discussionChoice);
    const choice = await ctx.ui.select(`PR #${pr.number}: ${pr.title}`, choices);
    if (choice == null) {
      ctx.ui.notify("Review kept as a draft; nothing was submitted.", "info");
      return { status: { started: true, message: "No end action selected." } };
    }

    if (choice === discussionChoice) {
      return {
        status: { started: true, prompt: composeRemoteDiscussionPrompt(target, discussionPrompt, sessionId) },
        consumption: {
          consumeAllComment: result.allIntent === "discuss" && result.allComment.trim().length > 0,
          commentIds: result.comments.filter((comment) => comment.intent === "discuss").map((comment) => comment.id),
        },
      };
    }

    const action = endActions.actions.get(choice);
    if (action == null) {
      ctx.ui.notify("Review kept as a draft; nothing was submitted.", "info");
      return { status: { started: true, message: "No end action selected." } };
    }

    const verdict: ReviewVerdict = action.verdict;
    saveReviewPreference({ lastReviewVerdict: verdict });
    const reviewBody = buildReviewBody(files, result, includeFileComments);
    const optionalBody = action.skipBody
      ? undefined
      : await ctx.ui.editor(`${REVIEW_VERDICT_LABELS[verdict]}: optional review body comment`, "");
    const body = mergeReviewBodies(optionalBody, reviewBody);
    const submitted = await submitUiConfirmedReviewWithOutcome(pi, ctx, target, verdict, body, inlineComments, { sourceDigest, draft, ...(saved == null ? {} : { newIntent: true }) });
    return { status: submitted.status };
  }

  async function offerNextReview(ctx: HostContext, status: ReviewRunStatus, cwd: string): Promise<ReviewRunStatus> {
    const candidate = status.nextCandidate;
    if (candidate == null || !ctx.hasUI) return status;

    const startChoice = "Review it now";
    const label = candidate.title == null ? candidate.url : `${candidate.title} (${candidate.url})`;
    const choice = await ctx.ui.select(`Next queued review: ${label}`, [startChoice, "Not now"]);
    if (choice !== startChoice) return status;

    try {
      const next = await runDiff(`remote ${candidate.url}`, ctx, cwd);
      if (next.started) return next;
      return { ...status, message: `${status.message ?? "Review submitted."} Next review did not start: ${next.message ?? "unknown reason"}.` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Could not open the next review: ${message}`, "warning");
      return { ...status, message: `${status.message ?? "Review submitted."} Next review did not start: ${message}.` };
    }
  }

  async function openReview(
    ctx: HostContext,
    cwd = ctx.cwd,
    comments?: SeedReviewComment[],
    options?: ReviewWindowOptions,
    sessionOptions?: { resumeId?: string; resumeIdentity?: string; discard?: boolean; story?: boolean },
  ): Promise<ReviewRunStatus> {
    const reviewCwd = normalizeReviewCwd(cwd, ctx.cwd);
    const refresh = () => options == null
      ? getReviewWindowData(pi, reviewCwd)
      : getReviewWindowData(pi, reviewCwd, options);
    const finishProgress = beginLocalProgress(ctx);
    let data: ReviewWindowData;
    try {
      data = await refresh();
    } finally {
      finishProgress();
    }
    const scopeFingerprint = createReviewScopeFingerprint(data.repoRoot, reviewCwd, options as Record<string, unknown> | undefined);
    return openReviewData(ctx, data, undefined, comments, sessionOptions, { scopeFingerprint, refresh });
  }

  function validateRemoteDiscussContinuation(target: RemoteReviewTarget, continuation: RemoteDiscussContinuation): string | undefined {
    if (target.pullRequest == null || (continuation.priorSessionId !== createReviewSessionId(pullRequestSessionIdentity(target)) && !hasReviewSessionIdentity(pullRequestSessionIdentity(target), continuation.priorSessionId))) {
      return "Remote DISCUSS continuation does not belong to the requested remote review identity.";
    }
    if (continuation.priorBaseRevision !== target.baseRef || continuation.priorHeadRevision !== target.pullRequest.headRefOid) {
      return "Remote DISCUSS continuation is stale because the reviewed pull request changed.";
    }
    return undefined;
  }

  async function runInteractiveReview(params: InteractiveReviewParams, ctx: HostContext, fallbackCwd = ctx.cwd, comments?: SeedReviewComment[]): Promise<ReviewRunStatus> {
    if (!ctx.hasUI) return { started: false, message: "Interactive review requires a TUI session." };

    if (params.resume === "latest" && params.remote == null && params.mode == null && params.ref == null && params.cwd == null && params.discardResume !== true) {
      let picked: ReviewSessionIndexEntry | null;
      try {
        picked = await pickParkedReview(ctx);
      } catch (error) {
        const message = `Could not list parked reviews: ${error instanceof Error ? error.message : String(error)}`;
        ctx.ui.notify(message, "warning");
        return { started: false, message };
      }
      if (picked == null) return { started: false, message: "No parked review selected." };
      const remote = picked.resumeArgs?.startsWith("remote ") === true ? picked.resumeArgs.slice("remote ".length) : undefined;
      return runInteractiveReview(
        {
          ...params,
          resume: picked.id,
          resumeIdentity: picked.identity,
          ...(remote == null ? {} : { remote }),
          ...(picked.cwd == null ? {} : { cwd: picked.cwd }),
        },
        ctx,
        picked.cwd ?? fallbackCwd,
        comments,
      );
    }

    const reviewCwd = params.cwd == null ? undefined : normalizeReviewCwd(params.cwd, fallbackCwd);
    const reviewOptions = {
      ...(params.includeGenerated ? { includeGenerated: true } : {}),
      ...(params.wholeRepo ? { wholeRepo: true } : {}),
    };
    const hasReviewOptions = Object.keys(reviewOptions).length > 0;
    if (params.tree != null || params.branch != null || params.project != null) return unsupported("Tree, branch, and project resolution are being ported into pi-coder next.", ctx);
    if (params.mode === "staged") return unsupported("Staged diff mode is being ported into pi-coder next.", ctx);

    if (params.remote != null) {
      try {
        const reportProgress = (message: string) => setRemoteProgress(ctx, message);
        const target = params.continuation == null
          ? await resolveRemoteReviewTarget(pi, fallbackCwd, params.remote, reviewCwd, reportProgress, params.handoff)
          : params.handoff == null
            ? await resolveRemoteReviewTarget(pi, fallbackCwd, params.remote, reviewCwd, reportProgress, { cacheMode: "bypass" })
            : await resolveRemoteReviewTarget(pi, fallbackCwd, params.remote, reviewCwd, reportProgress, params.handoff, { cacheMode: "bypass" });
        const continuationError = params.continuation == null ? undefined : validateRemoteDiscussContinuation(target, params.continuation);
        if (continuationError != null) throw new Error(continuationError);
        reportProgress(`Preparing diff for ${target.repo ?? target.branch}…`);
        const rangeOptions = {
          ...reviewOptions,
          ...(params.wholeRepo || target.pathspecs == null ? {} : { pathspecs: target.pathspecs }),
          ...(params.wholeRepo || target.workspacePath == null ? {} : { workspacePath: target.workspacePath }),
          ...(target.importAliases == null ? {} : { importAliases: target.importAliases }),
        };
        const data = Object.keys(rangeOptions).length === 0
          ? await getReviewWindowDataForRevisionRange(pi, target.gitRoot, target.baseRef, target.headRef)
          : await getReviewWindowDataForRevisionRange(pi, target.gitRoot, target.baseRef, target.headRef, rangeOptions);
        setRemoteProgress(ctx, undefined);
        // A fully consumed continuation names a terminal instance; start a fresh one for that target.
        const continuationId = params.continuation?.priorSessionId;
        const resumeId = continuationId != null && loadReviewSession(pullRequestSessionIdentity(target), continuationId) != null ? continuationId : params.resume;
        const status = await openReviewData(ctx, data, target, comments, { resumeId, resumeIdentity: params.resumeIdentity, discard: params.discardResume, story: params.story });
        return offerNextReview(ctx, status, target.gitRoot);
      } catch (error) {
        setRemoteProgress(ctx, undefined);
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Could not prepare remote review: ${message}`, "error");
        return { started: false, message };
      }
    }

    if (params.mode === "custom") {
      const range = params.ref;
      if (range == null || !range.includes("..")) return unsupported("Custom review requires a ref range like base..head.", ctx);
      const [baseRef, headRef] = range.split(/\.\.\.?/, 2);
      if (baseRef == null || headRef == null || baseRef.length === 0 || headRef.length === 0) return unsupported("Custom review requires a ref range like base..head.", ctx);
      const rangeOptions = {
        ...reviewOptions,
        ...(range.includes("...") ? { mergeBase: true } : {}),
      };
      const customCwd = reviewCwd ?? fallbackCwd;
      const refresh = () => Object.keys(rangeOptions).length === 0
        ? getReviewWindowDataForRevisionRange(pi, customCwd, baseRef, headRef)
        : getReviewWindowDataForRevisionRange(pi, customCwd, baseRef, headRef, rangeOptions);
      const data = await refresh();
      const scopeFingerprint = createReviewScopeFingerprint(data.repoRoot, customCwd, rangeOptions);
      return openReviewData(
        ctx,
        data,
        undefined,
        comments,
        { resumeId: params.resume, resumeIdentity: params.resumeIdentity, discard: params.discardResume, story: params.story },
        { scopeFingerprint, refresh },
      );
    }

    return openReview(
      ctx,
      reviewCwd ?? fallbackCwd,
      comments,
      hasReviewOptions ? reviewOptions : undefined,
      { resumeId: params.resume, resumeIdentity: params.resumeIdentity, discard: params.discardResume, story: params.story },
    );
  }

  async function runDiff(
    args: string,
    ctx: HostContext,
    cwd = ctx.cwd,
    comments?: SeedReviewComment[],
    handoff?: PullRequestHandoff,
    continuation?: RemoteDiscussContinuation,
    story = false,
  ): Promise<ReviewRunStatus> {
    if (!ctx.hasUI) return { started: false, message: "Interactive review requires a TUI session." };

    const fallbackCwd = normalizeReviewCwd(cwd, ctx.cwd);
    const trimmed = args.trim();

    if (handoff != null) {
      const remote = extractRemoteArgs(trimmed, fallbackCwd);
      if (remote == null) return unsupported("Supplied pull request metadata requires a remote review target, for example: remote <url>.", ctx);
      return runInteractiveReview({ ...parseInteractiveReviewArgs(trimmed), remote, handoff, continuation, story }, ctx, fallbackCwd, comments);
    }

    if (trimmed.length === 0) return openReview(ctx, fallbackCwd, comments, undefined, { story });

    const tokens = trimmed.split(/\s+/);
    const firstToken = tokens[0]!;

    if (firstToken.toLowerCase() === "remote") {
      const target = tokens[1];
      if (target == null) return unsupported(`Usage: ${commands.diff} remote <url | branch>`, ctx);
      return runInteractiveReview({ ...parseInteractiveReviewArgs(tokens.slice(2).join(" ")), remote: target, continuation, story }, ctx, fallbackCwd, comments);
    }

    if (trimmed.startsWith("-") || MODE_VALUES.has(firstToken)) {
      return runInteractiveReview({ ...parseInteractiveReviewArgs(trimmed), story }, ctx, fallbackCwd, comments);
    }

    const localCwd = resolveLocalReviewCwdArg(trimmed, fallbackCwd);
    if (localCwd != null) return openReview(ctx, localCwd, comments, undefined, { story });

    if (trimmed.includes("..")) {
      return runInteractiveReview({ ...parseInteractiveReviewArgs(tokens.slice(1).join(" ")), mode: "custom", ref: firstToken, story }, ctx, fallbackCwd, comments);
    }
    return runInteractiveReview({ ...parseInteractiveReviewArgs(tokens.slice(1).join(" ")), remote: firstToken, continuation, story }, ctx, fallbackCwd, comments);
  }

  function formatOpenCodeDiffToolText(status: ReviewRunStatus, args: string, cwd: string): string {
    const displayArgs = args.trim().length === 0 ? "(empty — local working-tree/uncommitted changes)" : args.trim();
    const lines = [
      status.started ? "Code diff review finished." : "Code diff review did not start.",
      `Args: ${displayArgs}`,
      `Cwd: ${cwd}`,
    ];
    if (status.message != null) lines.push(`Message: ${status.message}`);
    if (status.context != null) lines.push("", "Context:", status.context);
    if (status.prompt != null) lines.push("", "Prompt:", status.prompt);
    return lines.join("\n");
  }

  const reviewInvocations = new ReviewInvocationCoordinator<HostContext, ReviewRunStatus>({
    active: (ctx) => {
      const message = "A review session is already open.";
      if (ctx.hasUI) ctx.ui.notify(message, "warning");
      return { started: false, message };
    },
    failed: (ctx, error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (ctx.hasUI) ctx.ui.notify(`Could not start review: ${message}`, "error");
      return { started: false, message };
    },
    completed: (ctx) => {
      options.onRunSettled?.(ctx);
    },
    starting: () => ({ started: true, message: "Review is starting." }),
  });

  async function runReviewCommand(args: string, ctx: HostContext, story: boolean): Promise<PiCoderCommandResult> {
    const status = await reviewInvocations.runAwaited(ctx, () => runDiff(args, ctx, ctx.cwd, undefined, undefined, undefined, story));
    return { started: status.started, prompt: status.prompt, message: status.message, review: status };
  }

  function setFullscreen(tokens: string[], ctx: HostContext): PiCoderCommandResult {
    const value = tokens.length === 2 ? tokens[1]?.toLowerCase() : undefined;
    if (value !== "on" && value !== "off") {
      const message = `Usage: ${commands.diff} fullscreen on|off`;
      ctx.ui.notify(message, "error");
      return { started: false, message };
    }
    herdrFullscreen = value === "on";
    saveReviewPreference({ herdrFullscreen });
    const message = `${commands.diff} fullscreen: ${value}`;
    ctx.ui.notify(message, "info");
    return { started: true, message };
  }

  let codeSyntaxTheme = initialPreferences.codeSyntaxTheme;

  async function runCodeWorkbench(
    origin: "direct-code" | "open-code" | "review-bridge",
    ctx: HostContext,
    cwd: string,
    launch: WorkbenchLaunch,
  ): Promise<WorkbenchCompletionResult> {
    try {
      return await runGuardedPiWorkbench(origin, () => runPiWorkbench(ctx, { cwd, launch, syntaxTheme: codeSyntaxTheme }));
    } finally {
      options.onRunSettled?.(ctx);
    }
  }

  async function runCodeCommand(
    ctx: HostContext,
    cwd: string,
    launch: WorkbenchLaunch,
  ): Promise<{ ok: boolean; message: string } | undefined> {
    let setting: CodeCommandSettings | undefined;
    try { setting = loadPiCoderSettings().code; }
    catch (error) { return { ok: false, message: `Could not load code settings: ${error instanceof Error ? error.message : String(error)}` }; }
    if (setting == null) return undefined;
    if ((launch.stories?.length ?? 0) > 0) return { ok: false, message: "Code stories require the built-in Workbench." };

    const target = launch.initialTarget;
    const values: Record<string, string> = { cwd, file: target?.path ?? "", line: String(target?.range.startLine ?? 1) };
    const templates = [...setting.command, ...(target == null ? [] : setting.targetArgs ?? [])];
    const [command, ...args] = templates.map((template) => template.replace(/\{(cwd|file|line)\}/g, (_match, name: string) => values[name]!));
    try {
      const result = await launchExternalEditor(command!, args, cwd);
      if (result.kind === "exit" && result.code === 0) return { ok: true, message: "Code command completed." };
      const reason = result.kind === "exit" ? `exited with code ${result.code}` : `was terminated by ${result.signal}`;
      return { ok: false, message: `Code command ${reason}.` };
    } catch (error) {
      return { ok: false, message: `Could not run code command: ${error instanceof Error ? error.message : String(error)}` };
    } finally {
      options.onRunSettled?.(ctx);
    }
  }

  async function runCode(
    origin: "direct-code" | "open-code" | "review-bridge",
    ctx: HostContext,
    cwd: string,
    launch: WorkbenchLaunch,
  ) {
    const command = await runCodeCommand(ctx, cwd, launch);
    return command == null
      ? { kind: "workbench" as const, outcome: await runCodeWorkbench(origin, ctx, cwd, launch) }
      : { kind: "command" as const, command };
  }

  async function selectCodeSyntaxTheme(ctx: HostContext): Promise<PiCoderCommandResult> {
    if (!ctx.hasUI) {
      const message = `${commands.code} syntax requires a TUI session.`;
      ctx.ui.notify(message, "error");
      return { started: false, message };
    }
    try {
      const themes = await listBundledShikiThemes();
      const selected = await pickSyntaxTheme(ctx.ui, themes, codeSyntaxTheme, commands.code);
      if (selected == null) return { started: false };
      const choice = themes.find((theme) => theme.id === selected);
      if (choice == null) return { started: false };
      codeSyntaxTheme = choice.id;
      saveReviewPreference({ codeSyntaxTheme });
      const message = `${commands.code} syntax theme: ${choice.displayName}`;
      ctx.ui.notify(message, "info");
      return { started: true, message };
    } catch (error) {
      const message = `Could not load Shiki themes: ${error instanceof Error ? error.message : String(error)}`;
      ctx.ui.notify(message, "error");
      return { started: false, message };
    }
  }

  async function runCodeCommandLine(args: string, ctx: HostContext): Promise<PiCoderCommandResult> {
    if (args.trim().toLowerCase() === "syntax") return selectCodeSyntaxTheme(ctx);
    let launch: WorkbenchLaunch;
    try { launch = parseDirectCodeArgs(args, commands.code); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(message, "error");
      return { started: false, message };
    }
    const code = await runCode("direct-code", ctx, ctx.cwd, launch);
    if (code.kind === "command") {
      ctx.ui.notify(code.command.message, code.command.ok ? "info" : "error");
      return { started: code.command.ok, message: code.command.message };
    }
    const outcome = code.outcome;
    if (outcome.status === "failed") {
      const message = `Could not open code workbench: ${outcome.message}`;
      ctx.ui.notify(message, "error");
      return { started: false, message, workbench: outcome };
    }
    if (outcome.status === "discuss") return { started: true, prompt: composeCodeDiscussionPrompt(ctx.cwd, outcome), workbench: outcome };
    return { started: true, workbench: outcome };
  }

  async function runOpenCodeTool(params: unknown, ctx: HostContext): Promise<PiCoderToolResult> {
    const input = (params ?? {}) as { cwd?: string; path?: string; target?: CodeTarget; stories?: CodeStory[] };
    const cwd = normalizeReviewCwd(input.cwd ?? ctx.cwd, ctx.cwd);
    let launch: WorkbenchLaunch;
    try {
      if (input.path != null && input.target != null) throw new Error("open_code path and target cannot be combined.");
      const path = input.path?.startsWith("@") ? input.path.slice(1) : input.path;
      const initialTarget = path == null
        ? input.target
        : { path, range: { startLine: 1, endLine: 1 } };
      launch = normalizeWorkbenchLaunch({
        ...(initialTarget == null ? {} : { initialTarget }),
        ...(path == null ? {} : { startInInsertMode: true }),
        ...(input.stories == null ? {} : { stories: input.stories }),
        capabilities: { discuss: true },
      });
    } catch (error) {
      const outcome: WorkbenchCompletionResult = { status: "failed", message: error instanceof Error ? error.message : String(error) };
      return { text: `Code workbench did not start: ${outcome.message}`, details: { outcome, cwd } };
    }
    const code = await runCode("open-code", ctx, cwd, launch);
    if (code.kind === "command") {
      return { text: code.command.message, details: { command: code.command, cwd } };
    }
    const outcome = code.outcome;
    if (outcome.status === "discuss") {
      const prompt = composeCodeDiscussionPrompt(cwd, outcome);
      return { text: prompt, details: { outcome, cwd, target: outcome.target } };
    }
    const text = outcome.status === "closed"
      ? `Code workbench closed. Changed paths: ${outcome.changedPaths.length === 0 ? "none" : outcome.changedPaths.join(", ")}`
      : `Code workbench failed: ${outcome.message}`;
    return { text, details: { outcome, cwd } };
  }

  async function runOpenCodeDiffTool(params: unknown, ctx: HostContext): Promise<PiCoderToolResult> {
    const input = (params ?? {}) as {
      args?: string;
      cwd?: string;
      continuation?: RemoteDiscussContinuation;
      comments?: SeedReviewComment[];
      pullRequest?: unknown;
    };
    const args = input.args ?? "";
    const cwd = normalizeReviewCwd(input.cwd ?? ctx.cwd, ctx.cwd);
    const command = await runCodeCommand(ctx, cwd, {});
    if (command != null) {
      return { text: command.message, details: { started: command.ok, message: command.message, args, cwd } };
    }
    const continuation = input.continuation;
    if (continuation != null && (
      continuation.kind !== "remote-discuss"
      || ![continuation.priorSessionId, continuation.priorBaseRevision, continuation.priorHeadRevision].every((value) => typeof value === "string" && value.length > 0)
      || !/^remote\s+\S[\s\S]*$/.test(args.trim())
    )) {
      const message = "Invalid remote DISCUSS continuation marker.";
      if (ctx.hasUI) ctx.ui.notify(message, "warning");
      const status: ReviewRunStatus = { started: false, message };
      return { text: formatOpenCodeDiffToolText(status, args, cwd), details: { ...status, args, cwd } };
    }

    let handoff: PullRequestHandoff | undefined;
    try {
      handoff = input.pullRequest == null ? undefined : parsePullRequestHandoff(input.pullRequest);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (ctx.hasUI) ctx.ui.notify(message, "warning");
      const status: ReviewRunStatus = { started: false, message };
      return { text: formatOpenCodeDiffToolText(status, args, cwd), details: { ...status, args, cwd } };
    }

    const status = await reviewInvocations.runAwaited(
      ctx,
      () => runDiff(args, ctx, cwd, input.comments, handoff, continuation),
    );
    return { text: formatOpenCodeDiffToolText(status, args, cwd), details: { ...status, args, cwd } };
  }

  async function runOpenCodeDiffStoryTool(params: unknown, ctx: HostContext): Promise<PiCoderToolResult> {
    const input = (params ?? {}) as { args?: string; cwd?: string };
    const args = input.args ?? "";
    const cwd = normalizeReviewCwd(input.cwd ?? ctx.cwd, ctx.cwd);
    const status: ReviewRunStatus = canOpenDiffStory(ctx)
      ? await reviewInvocations.runAwaited(ctx, () => runDiff(args, ctx, cwd, undefined, undefined, undefined, true))
      : { started: false, message: DIFF_STORY_TUI_MESSAGE };
    return { text: formatOpenCodeDiffToolText(status, args, cwd), details: { ...status, args, cwd } };
  }

  async function runSubmitPrReviewTool(params: unknown, ctx: HostContext): Promise<PiCoderToolResult> {
    const input = (params ?? {}) as {
      provider: string;
      repo: string;
      prNumber: string;
      commitId: string;
      baseCommitId?: string;
      verdict: ReviewVerdict;
      body?: string;
      comments?: ReviewInlineComment[];
      prAuthorLogin?: string;
      cwd?: string;
      attemptId?: string;
      handoffId?: string;
      handoffCommentIndexes?: number[];
      newIntent?: boolean;
    };
    const submitInput: SubmitReviewInput = {
      provider: input.provider,
      repo: input.repo,
      prNumber: input.prNumber,
      commitId: input.commitId,
      baseCommitId: input.baseCommitId,
      verdict: input.verdict,
      body: input.body,
      comments: input.comments,
      prAuthorLogin: input.prAuthorLogin,
      gitRoot: input.cwd,
    };
    const result = await submitPullRequestReview(pi, submitInput, { attemptId: input.attemptId, newIntent: input.newIntent,
      ...(input.handoffId == null ? {} : { handoffId: input.handoffId }),
      ...(input.handoffCommentIndexes == null ? {} : { handoffCommentIndexes: input.handoffCommentIndexes }),
    });
    if (ctx.hasUI) ctx.ui.notify(result.message, result.ok ? "info" : "warning");
    const recovery = composeSubmissionRecovery(submitInput, result);
    return { text: recovery == null ? result.message : `${result.message}\n\n${recovery}`, details: { result } };
  }

  return {
    async diff(args, ctx) {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      if (tokens[0]?.toLowerCase() === "fullscreen") return setFullscreen(tokens, ctx);
      return runReviewCommand(args, ctx, false);
    },
    async diffStory(args, ctx) {
      if (!canOpenDiffStory(ctx)) {
        ctx.ui.notify(DIFF_STORY_TUI_MESSAGE, "error");
        return { started: false, message: DIFF_STORY_TUI_MESSAGE };
      }
      if (args.trim() === "agent") return { started: (await selectStoryAgent(ctx)) === true };
      return runReviewCommand(args, ctx, true);
    },
    code: runCodeCommandLine,
    async runTool(name: PiCoderToolName, params, ctx) {
      switch (name) {
        case "open_code": return runOpenCodeTool(params, ctx);
        case "open_code_diff": return runOpenCodeDiffTool(params, ctx);
        case "open_code_diff_story": return runOpenCodeDiffStoryTool(params, ctx);
        case "submit_pr_review": return runSubmitPrReviewTool(params, ctx);
        default: throw new Error(`Unknown pi-coder tool: ${String(name)}`);
      }
    },
    shutdown() {
      activeReview = false;
      clearLocalProgress();
    },
  };
}
