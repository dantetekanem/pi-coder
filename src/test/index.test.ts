import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hashTargetSlice } from "../workbench/target.js";

const mocks = vi.hoisted(() => ({
  loadCommentShortcuts: vi.fn(),
  getReviewWindowData: vi.fn(),
  getReviewWindowDataForRevisionRange: vi.fn(),
  loadReviewFileContents: vi.fn(),
  composeReviewPrompt: vi.fn(),
  composeDiscussionPrompt: vi.fn(),
  runReviewApp: vi.fn(),
  resolveRemoteReviewTarget: vi.fn(),
  createReviewSessionId: vi.fn(() => "automatic-session"),
  loadReviewSession: vi.fn(),
  saveReviewSession: vi.fn(),
  saveReviewSessionWithStatus: vi.fn(() => ({ id: "automatic-session", saved: true })),
  deleteReviewSession: vi.fn(),
  listReviewSessions: vi.fn((): any[] => []),
  buildReviewFileSignatures: vi.fn((): Record<string, string> => ({})),
  rebaseReviewSession: vi.fn(),
  reviewGrammar: vi.fn(),
  submitPullRequestReview: vi.fn(),
  saveReviewReceipt: vi.fn(),
  createRemoteReviewRepliesSource: vi.fn(),
  repliesSource: { title: "Replies", loadingText: "Loading", load: vi.fn() },
  runPiWorkbench: vi.fn(),
  withHerdrPaneZoom: vi.fn(async (action: () => Promise<unknown>) => action()),
  repositoryStatusRefresh: vi.fn(async () => undefined),
  repositoryStatusShutdown: vi.fn(async () => undefined),
}));

vi.mock("../shortcuts.js", () => ({
  loadCommentShortcuts: mocks.loadCommentShortcuts,
  getShortcutConfigPath: () => join(preferencesDir, "code-diff.json"),
}));

const preferencesDir = mkdtempSync(join(tmpdir(), "pi-code-diff-index-"));
const preferencesPath = join(preferencesDir, "code-diff-preferences.json");
const settingsPath = join(preferencesDir, "provider-settings.json");
const originalPreferencesPath = process.env.PI_CODE_DIFF_PREFERENCES_PATH;
const originalSettingsPath = process.env.PI_CODE_DIFF_SETTINGS_PATH;
process.env.PI_CODE_DIFF_PREFERENCES_PATH = preferencesPath;
process.env.PI_CODE_DIFF_SETTINGS_PATH = settingsPath;

afterAll(() => {
  if (originalPreferencesPath == null) delete process.env.PI_CODE_DIFF_PREFERENCES_PATH;
  else process.env.PI_CODE_DIFF_PREFERENCES_PATH = originalPreferencesPath;
  if (originalSettingsPath == null) delete process.env.PI_CODE_DIFF_SETTINGS_PATH;
  else process.env.PI_CODE_DIFF_SETTINGS_PATH = originalSettingsPath;
  rmSync(preferencesDir, { recursive: true, force: true });
});

vi.mock("../git.js", () => ({
  getReviewWindowData: mocks.getReviewWindowData,
  getReviewWindowDataForRevisionRange: mocks.getReviewWindowDataForRevisionRange,
  loadReviewFileContents: mocks.loadReviewFileContents,
}));

vi.mock("../prompt.js", () => ({
  composeReviewPrompt: mocks.composeReviewPrompt,
  composeDiscussionPrompt: mocks.composeDiscussionPrompt,
}));

vi.mock("../remote.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../remote.js")>()),
  resolveRemoteReviewTarget: mocks.resolveRemoteReviewTarget,
}));

vi.mock("../review-session.js", () => ({
  createReviewSessionId: mocks.createReviewSessionId,
  loadReviewSession: mocks.loadReviewSession,
  saveReviewSession: mocks.saveReviewSession,
  saveReviewSessionWithStatus: mocks.saveReviewSessionWithStatus,
  deleteReviewSession: mocks.deleteReviewSession,
  listReviewSessions: mocks.listReviewSessions,
  buildReviewFileSignatures: mocks.buildReviewFileSignatures,
  rebaseReviewSession: mocks.rebaseReviewSession,
}));

vi.mock("../ui/review-app.js", () => ({
  runReviewApp: mocks.runReviewApp,
}));

vi.mock("../ui/full-screen-overlay.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ui/full-screen-overlay.js")>()),
  withHerdrPaneZoom: mocks.withHerdrPaneZoom,
}));

vi.mock("../review-grammar.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../review-grammar.js")>()),
  reviewGrammar: mocks.reviewGrammar,
}));

vi.mock("../review-submit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../review-submit.js")>()),
  submitPullRequestReview: mocks.submitPullRequestReview,
}));

vi.mock("../review-receipts.js", () => ({
  saveReviewReceipt: mocks.saveReviewReceipt,
}));

vi.mock("../review-replies.js", () => ({
  createRemoteReviewRepliesSource: mocks.createRemoteReviewRepliesSource,
}));

vi.mock("../adapters/pi/index.js", () => ({
  runPiWorkbench: mocks.runPiWorkbench,
}));

vi.mock("../git-change-status.js", () => ({
  RepositoryChangeStatusController: class {
    refresh = mocks.repositoryStatusRefresh;
    shutdown = mocks.repositoryStatusShutdown;
    getSummary = () => null;
  },
}));

const { buildReviewEndActions, composeRemoteDiscussionPrompt, composeReviewSubmissionPrompt, mergeReviewBodies, submitUiConfirmedReview, default: codeDiffExtension } = await import("../index.js");

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function testSettings() {
  const provider = (id: string, fileComments: boolean) => ({
    label: `${id} code host`,
    executable: `cli-${id}`,
    urls: {
      patterns: [{ host: `${id}.code.example`, path: "/{repo}/change/{number}" }],
      canonical: `https://${id}.code.example/{repo}/change/{number}`,
    },
    operations: { identity: { args: ["identity"] } },
    refs: {},
    fields: {},
    capabilities: { fileComments },
  });
  return {
    version: 1,
    providers: {
      github: {
        ...provider("github", false),
        urls: {
          patterns: [{ host: "github.com", path: "/{repo}/pull/{number}" }],
          canonical: "https://github.com/{repo}/pull/{number}",
        },
      },
      secondary: provider("secondary", true),
    },
    repositories: {},
  };
}

function remoteTarget() {
  return {
    provider: "github",
    gitRoot: "/repo",
    baseRef: "origin/main",
    headRef: "origin/pr/1/head",
    remote: "example/widgets#1",
    branch: "feature/review",
    repo: "example/widgets",
    pullRequest: {
      number: "1",
      repo: "example/widgets",
      title: "Add review mode",
      body: "",
      additions: 1,
      deletions: 0,
      changedFiles: 1,
      authorLogin: "alice",
      state: "OPEN" as const,
      reviews: [],
      headRefName: "feature/review",
      headRefOid: "abc123",
      baseRefName: "main",
    },
  };
}

function remoteReviewFile() {
  return {
    id: "src/app.ts::all::origin/main::origin/pr/1/head",
    path: "src/app.ts",
    worktreeStatus: "modified" as const,
    hasWorkingTreeFile: true,
    inGitDiff: false,
    inLastCommit: false,
    inAllFiles: true,
    gitDiff: null,
    lastCommit: null,
    allFiles: {
      status: "modified" as const,
      oldPath: "src/app.ts",
      newPath: "src/app.ts",
      displayPath: "src/app.ts",
      hasOriginal: true,
      hasModified: true,
    },
  };
}

function localReviewFile() {
  return {
    id: "src/app.ts::working::::",
    path: "src/app.ts",
    worktreeStatus: "modified" as const,
    hasWorkingTreeFile: true,
    inGitDiff: true,
    inLastCommit: false,
    inAllFiles: false,
    gitDiff: {
      status: "modified" as const,
      oldPath: "src/app.ts",
      newPath: "src/app.ts",
      displayPath: "src/app.ts",
      hasOriginal: true,
      hasModified: true,
    },
    lastCommit: null,
    allFiles: null,
  };
}

function reviewSessionData(
  draft: { allComment: string; allIntent: "discuss" | "comment" | "modify"; comments: any[] },
  activeFileId = remoteReviewFile().id,
  activeScope: "git-diff" | "all-files" = "all-files",
) {
  return {
    state: {
      activeScope,
      activeFileId,
      searchQuery: "",
      focus: "diff" as const,
      wrapLines: true,
      hideUnchanged: false,
      selectedCommentIndex: 0,
      selectedLineTargetByScopeFile: {},
      draft,
    },
    diffViewMode: "unified" as const,
    navigatorTreeMode: false,
    contextLineNavigation: true,
    commentsGlobal: false,
    reviewedFileIds: [],
    navigatorScroll: 0,
    diffScroll: 0,
    commentsScroll: 0,
  };
}

describe("code diff extension", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rmSync(preferencesPath, { force: true });
    writeFileSync(settingsPath, JSON.stringify(testSettings()), "utf8");
    mocks.loadReviewSession.mockReturnValue(null);
    mocks.saveReviewSessionWithStatus.mockReturnValue({ id: "automatic-session", saved: true });
    mocks.listReviewSessions.mockReturnValue([]);
    mocks.buildReviewFileSignatures.mockReturnValue({});
    mocks.rebaseReviewSession.mockImplementation((session: any) => ({
      data: session,
      previousRevision: session.revision ?? "unknown",
      reanchored: session.state.draft.comments.length,
      needsAttention: 0,
      unanchored: 0,
    }));
    mocks.loadCommentShortcuts.mockReturnValue({
      shortcuts: [],
      globalShortcut: "alt+s",
      warnings: ["bad shortcut config"],
      path: "/tmp/code-diff.json",
    });
    mocks.composeDiscussionPrompt.mockReturnValue("");
    mocks.resolveRemoteReviewTarget.mockResolvedValue(remoteTarget());
    mocks.reviewGrammar.mockImplementation(async (_ctx, original) => ({ status: "safe", corrected: original, changes: [] }));
    mocks.submitPullRequestReview.mockResolvedValue({ ok: true, message: "https://github.com/example/widgets/pull/1\nReview comment was posted at 12:00.\n1 inline comment was added." });
    mocks.createRemoteReviewRepliesSource.mockImplementation((_pi, _ctx, target) => target?.pullRequest == null ? undefined : mocks.repliesSource);
    mocks.runPiWorkbench.mockResolvedValue({ status: "closed", changedPaths: [] });
  });

  it("builds an agent-mediated review submission prompt", () => {
    const prompt = composeReviewSubmissionPrompt({
      provider: "github",
      gitRoot: "/repo",
      baseRef: "origin/main",
      headRef: "origin/pr/1/head",
      remote: "example/widgets#1",
      branch: "feature/review",
      repo: "example/widgets",
      pullRequest: {
        number: "1",
        repo: "example/widgets",
        title: "Add review mode",
        body: "",
        additions: 1,
        deletions: 0,
        changedFiles: 1,
        authorLogin: "alice",
        state: "OPEN",
        reviews: [],
        headRefName: "feature/review",
        headRefOid: "abc123",
        baseRefName: "main",
      },
    }, "comment", undefined, [
      { path: "src/app.ts", line: 12, side: "RIGHT", body: "Shouwlwn be as MagicModules" },
    ]);

    expect(prompt).toContain("Do not read files, search the repository, run commands, run tests, inspect diffs, open plans, create todos, or enter plan mode.");
    expect(prompt).toContain("Fix only grammar, spelling, capitalization, and punctuation");
    expect(prompt).toContain("The review UI already captured the user's explicit confirmation of the exact verdict and original text.");
    expect(prompt).toContain("If every correction is limited to grammar, spelling, capitalization, punctuation, or meaning-preserving syntax and clarity, call submit_pr_review immediately with the cleaned arguments and do not ask for confirmation.");
    expect(prompt).toContain("Ask only about text items whose correction may change meaning, intent, tone, technical substance, or requested scope.");
    expect(prompt).toContain("Original: <original text>");
    expect(prompt).toContain("Fixed   : <fixed text>");
    expect(prompt).toContain("Choices: Approve, Edit, Skip");
    expect(prompt).toContain("Present each such item using this exact style");
    expect(prompt).toContain("If the current ask tool can queue multiple questions, batch the uncertain text items in one ask call");
    expect(prompt).toContain("one separate question per item");
    expect(prompt).toContain("Apply grammar-only corrections automatically.");
    expect(prompt).toContain("The user's Approve choice is the confirmation to submit an uncertain item.");
    expect(prompt).toContain("Do not ask for a second/final submission confirmation.");
    expect(prompt).toContain("Call submit_pr_review once with the full arguments below");
    expect(prompt).toContain("reply with the PR link and the short action summary returned by the tool");
    expect(prompt).toContain('"body": "Shouwlwn be as MagicModules"');
    expect(prompt).toContain('"repo": "example/widgets"');
  });

  it("submits grammar-only corrections immediately after the review UI confirmation", async () => {
    const original = "can we have these 2 components in variables and isolated, so we can simplify this rendering?";
    const corrected = "Can we isolate these two components in variables so we can simplify this rendering?";
    mocks.reviewGrammar.mockResolvedValue({
      status: "safe",
      corrected: { comments: [corrected] },
      changes: [{ key: "comment:0", original, corrected, grammarOnly: true, reason: "Grammar and word order only." }],
    });
    const pi = { sendUserMessage: vi.fn() };
    const ctx = {
      model: { id: "test-model" },
      modelRegistry: {},
      isIdle: vi.fn(() => true),
      ui: {
        setStatus: vi.fn(),
        select: vi.fn(),
        editor: vi.fn(),
        notify: vi.fn(),
      },
    };
    const comments = [{ path: "src/app.ts", line: 12, side: "RIGHT" as const, body: original }];

    await submitUiConfirmedReview(pi as never, ctx as never, remoteTarget(), "comment", undefined, comments);

    expect(ctx.ui.select).not.toHaveBeenCalled();
    expect(mocks.submitPullRequestReview).toHaveBeenCalledWith(pi, expect.objectContaining({
      verdict: "comment",
      comments: [{ path: "src/app.ts", line: 12, side: "RIGHT", body: corrected }],
    }));
    expect(mocks.saveReviewReceipt).toHaveBeenCalledWith({
      provider: "github",
      repo: "example/widgets",
      number: "1",
      url: "https://github.com/example/widgets/pull/1",
      verdict: "comment",
      headSha: "abc123",
      body: undefined,
      comments: [{ path: "src/app.ts", line: 12, side: "RIGHT", body: corrected }],
    });
    expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("already submitted this github code host review"));
  });

  it("does not save a receipt when the provider rejects the submission", async () => {
    mocks.submitPullRequestReview.mockResolvedValue({ ok: false, blockedSelfApproval: true, message: "Refusing to approve your own pull request." });
    const pi = { sendUserMessage: vi.fn() };
    const ctx = {
      model: { id: "test-model" },
      modelRegistry: {},
      isIdle: vi.fn(() => true),
      ui: { setStatus: vi.fn(), select: vi.fn(), editor: vi.fn(), notify: vi.fn() },
    };

    const result = await submitUiConfirmedReview(pi as never, ctx as never, remoteTarget(), "approve", undefined, []);

    expect(result.submitted).not.toBe(true);
    expect(mocks.saveReviewReceipt).not.toHaveBeenCalled();
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("does not save a receipt when grammar verification falls back to the agent", async () => {
    mocks.reviewGrammar.mockResolvedValue({ status: "error", error: "model unavailable" });
    const pi = { sendUserMessage: vi.fn() };
    const ctx = {
      model: { id: "test-model" },
      modelRegistry: {},
      isIdle: vi.fn(() => true),
      ui: { setStatus: vi.fn(), select: vi.fn(), editor: vi.fn(), notify: vi.fn() },
    };

    const result = await submitUiConfirmedReview(pi as never, ctx as never, remoteTarget(), "comment", "Review body", []);

    expect(result.submitted).not.toBe(true);
    expect(mocks.submitPullRequestReview).not.toHaveBeenCalled();
    expect(mocks.saveReviewReceipt).not.toHaveBeenCalled();
    expect(pi.sendUserMessage).toHaveBeenCalledOnce();
  });

  it("does not save a receipt when the reviewer cancels an uncertain grammar change", async () => {
    mocks.reviewGrammar.mockResolvedValue({
      status: "review",
      corrected: { body: "Changed meaning", comments: [] },
      changes: [{ key: "body", original: "Original meaning", corrected: "Changed meaning", grammarOnly: false, reason: "Changes meaning." }],
    });
    const pi = { sendUserMessage: vi.fn() };
    const ctx = {
      model: { id: "test-model" },
      modelRegistry: {},
      isIdle: vi.fn(() => true),
      ui: { setStatus: vi.fn(), select: vi.fn(async () => "Cancel review submission"), editor: vi.fn(), notify: vi.fn() },
    };

    const result = await submitUiConfirmedReview(pi as never, ctx as never, remoteTarget(), "comment", "Original meaning", []);

    expect(result.message).toBe("Review submission cancelled; nothing was posted.");
    expect(mocks.submitPullRequestReview).not.toHaveBeenCalled();
    expect(mocks.saveReviewReceipt).not.toHaveBeenCalled();
  });

  it("does not save a receipt for the agent-mediated submission tool", async () => {
    const tools = new Map<string, any>();
    const pi = {
      registerCommand: vi.fn(),
      registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
      registerShortcut: vi.fn(),
      on: vi.fn(),
    };
    codeDiffExtension(pi as never);

    await tools.get("submit_pr_review").execute("tool-call", {
      repo: "example/widgets",
      prNumber: "1",
      commitId: "abc123",
      verdict: "comment",
      body: "Fallback body",
    }, new AbortController().signal, vi.fn(), { hasUI: false, ui: { notify: vi.fn() } });

    expect(mocks.submitPullRequestReview).toHaveBeenCalledOnce();
    expect(mocks.saveReviewReceipt).not.toHaveBeenCalled();
  });

  it("asks only about corrections that may change technical meaning", async () => {
    const firstOriginal = "This dont render correctly.";
    const firstCorrected = "This doesn't render correctly.";
    const secondOriginal = "Can this handle the empty state?";
    const secondCorrected = "This must handle every empty state.";
    mocks.reviewGrammar.mockResolvedValue({
      status: "review",
      corrected: { comments: [firstCorrected, secondCorrected] },
      changes: [
        { key: "comment:0", original: firstOriginal, corrected: firstCorrected, grammarOnly: true, reason: "Grammar only." },
        { key: "comment:1", original: secondOriginal, corrected: secondCorrected, grammarOnly: false, reason: "Changes a question into a requirement." },
      ],
    });
    const pi = { sendUserMessage: vi.fn() };
    const ctx = {
      model: { id: "test-model" },
      modelRegistry: {},
      isIdle: vi.fn(() => true),
      ui: {
        setStatus: vi.fn(),
        select: vi.fn(async (_title: string, _options: string[]) => "Keep original text"),
        editor: vi.fn(),
        notify: vi.fn(),
      },
    };
    const comments = [
      { path: "src/app.ts", line: 12, side: "RIGHT" as const, body: firstOriginal },
      { path: "src/app.ts", line: 20, side: "RIGHT" as const, body: secondOriginal },
    ];

    await submitUiConfirmedReview(pi as never, ctx as never, remoteTarget(), "comment", undefined, comments);

    expect(ctx.ui.select).toHaveBeenCalledTimes(1);
    expect(ctx.ui.select.mock.calls[0]?.[0]).toContain("Comment 2: src/app.ts:20 (RIGHT)");
    expect(mocks.submitPullRequestReview).toHaveBeenCalledWith(pi, expect.objectContaining({
      comments: [
        { path: "src/app.ts", line: 12, side: "RIGHT", body: firstCorrected },
        { path: "src/app.ts", line: 20, side: "RIGHT", body: secondOriginal },
      ],
    }));
  });

  it("merges optional review body comments with existing review body text", () => {
    expect(mergeReviewBodies("LGTM", "src/app.ts:\nNice catch")).toBe("LGTM\n\nsrc/app.ts:\nNice catch");
    expect(mergeReviewBodies("  ", undefined)).toBeUndefined();
  });

  it("registers code, diff, and review commands plus agent tools", () => {
    const pi = {
      registerCommand: vi.fn(),
      registerTool: vi.fn(),
      registerShortcut: vi.fn(),
      on: vi.fn(),
    };

    codeDiffExtension(pi as never);

    expect(pi.registerCommand).toHaveBeenCalledWith("code", expect.any(Object));
    expect(pi.registerCommand).toHaveBeenCalledWith("diff", expect.any(Object));
    expect(pi.registerCommand).toHaveBeenCalledWith("review", expect.any(Object));
    const codeCommand = pi.registerCommand.mock.calls.find(([name]) => name === "code")?.[1];
    expect(codeCommand.getArgumentCompletions("sy")).toEqual([
      expect.objectContaining({ value: "syntax", label: "syntax" }),
    ]);
    expect(codeCommand.getArgumentCompletions("workbench")).toBeNull();
    const diffCommand = pi.registerCommand.mock.calls.find(([name]) => name === "diff")?.[1];
    const reviewCommand = pi.registerCommand.mock.calls.find(([name]) => name === "review")?.[1];
    expect(reviewCommand).toBe(diffCommand);
    expect(pi.registerCommand).not.toHaveBeenCalledWith("code-diff", expect.any(Object));
    expect(pi.registerCommand).not.toHaveBeenCalledWith("interactive-review", expect.any(Object));
    expect(pi.registerTool).not.toHaveBeenCalledWith(expect.objectContaining({ name: "interactive_review" }));
    expect(pi.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "open_code" }));
    const openCode = pi.registerTool.mock.calls.find(([tool]) => tool.name === "open_code")?.[0];
    expect(openCode.parameters.properties.path).toBeDefined();
    expect(pi.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "open_code_diff" }));
    expect(pi.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "submit_pr_review" }));
  });

  it("mounts /diff through the Herdr-aware fullscreen boundary", async () => {
    const tools = new Map<string, any>();
    mocks.getReviewWindowData.mockResolvedValue({
      repoRoot: "/repo",
      files: [localReviewFile()],
      branchBaseRevision: undefined,
      modifiedRevision: undefined,
      visibleScopes: ["git-diff"],
    });
    mocks.runReviewApp.mockResolvedValue({ type: "cancel" });
    const pi = {
      registerCommand: vi.fn(),
      registerTool: vi.fn((tool) => tools.set(tool.name, tool)),
      registerShortcut: vi.fn(),
      on: vi.fn(),
      exec: vi.fn(),
    };
    const ctx = {
      hasUI: true,
      cwd: "/repo",
      ui: { notify: vi.fn(), setWidget: vi.fn(), setEditorText: vi.fn() },
    };

    codeDiffExtension(pi as never);
    await tools.get("open_code_diff").execute("tool-call", {}, new AbortController().signal, vi.fn(), ctx);

    expect(mocks.withHerdrPaneZoom).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({
      run: expect.any(Function),
      warn: expect.any(Function),
    }));
    expect(mocks.runReviewApp).toHaveBeenCalledOnce();
  });

  it("coalesces mutating-tool Git status refreshes asynchronously without replacing the footer", async () => {
    vi.useFakeTimers();
    try {
      const events = new Map<string, (event: any, ctx: any) => Promise<void> | void>();
      const pi = {
        registerCommand: vi.fn(),
        registerTool: vi.fn(),
        registerShortcut: vi.fn(),
        on: vi.fn((event: string, handler) => events.set(event, handler)),
      };
      const ctx = { mode: "tui", hasUI: true, cwd: "/repo", ui: { notify: vi.fn(), setStatus: vi.fn(), setFooter: vi.fn() } };

      codeDiffExtension(pi as never);
      await events.get("session_start")!({ reason: "startup" }, ctx);
      mocks.repositoryStatusRefresh.mockClear();
      const firstRefresh = deferred<undefined>();
      mocks.repositoryStatusRefresh.mockImplementationOnce(() => firstRefresh.promise).mockResolvedValue(undefined);
      const toolEnded = events.get("tool_execution_end")!;

      expect(toolEnded({ toolName: "edit", isError: false }, ctx)).toBeUndefined();
      toolEnded({ toolName: "write", isError: true }, ctx);
      toolEnded({ toolName: "read", isError: false }, ctx);
      await vi.advanceTimersByTimeAsync(249);
      expect(mocks.repositoryStatusRefresh).not.toHaveBeenCalled();

      toolEnded({ toolName: "bash", isError: false }, ctx);
      await vi.advanceTimersByTimeAsync(249);
      expect(mocks.repositoryStatusRefresh).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(mocks.repositoryStatusRefresh).toHaveBeenCalledExactlyOnceWith(ctx);

      toolEnded({ toolName: "edit", isError: false }, ctx);
      toolEnded({ toolName: "write", isError: false }, ctx);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(mocks.repositoryStatusRefresh).toHaveBeenCalledTimes(1);

      firstRefresh.resolve(undefined);
      await vi.advanceTimersByTimeAsync(249);
      expect(mocks.repositoryStatusRefresh).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(mocks.repositoryStatusRefresh).toHaveBeenCalledTimes(2);

      await events.get("agent_end")!({}, ctx);
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.repositoryStatusRefresh).toHaveBeenCalledTimes(2);

      toolEnded({ toolName: "edit", isError: false }, ctx);
      await events.get("session_shutdown")!({ reason: "quit" }, ctx);
      await vi.advanceTimersByTimeAsync(250);
      expect(mocks.repositoryStatusRefresh).toHaveBeenCalledTimes(2);
      expect(mocks.repositoryStatusShutdown).toHaveBeenCalledWith(ctx);
      expect(ctx.ui.setFooter).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("selects a persistent Shiki theme before routing /code to the workbench", async () => {
    const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
    const pi = {
      registerCommand: vi.fn((name: string, command) => commands.set(name, command)),
      registerTool: vi.fn(),
      registerShortcut: vi.fn(),
      on: vi.fn(),
    };
    const custom = vi.fn(async (factory: (...args: any[]) => any) => {
      let selected: string | null = null;
      const component = factory(
        { requestRender: vi.fn() },
        { fg: (_color: string, text: string) => text, bold: (text: string) => text },
        {},
        (value: string | null) => { selected = value; },
      );
      for (let index = 0; index < 100 && !component.render(100).join("\n").includes("→ GitHub Light"); index += 1) {
        component.handleInput("\x1b[B");
      }
      component.handleInput("\r");
      return selected;
    });
    const ctx = { hasUI: true, cwd: "/repo", ui: { notify: vi.fn(), custom } };

    codeDiffExtension(pi as never);
    await commands.get("code")!.handler("syntax", ctx);
    expect(mocks.runPiWorkbench).not.toHaveBeenCalled();

    await commands.get("code")!.handler("", ctx);

    expect(custom).toHaveBeenCalledOnce();
    expect(mocks.runPiWorkbench).toHaveBeenCalledWith(ctx, {
      cwd: "/repo",
      launch: { capabilities: { discuss: true } },
      syntaxTheme: "github-light",
    });
    expect(commands.get("code")).not.toBe(commands.get("diff"));
    expect(mocks.getReviewWindowData).not.toHaveBeenCalled();
    expect(mocks.repositoryStatusRefresh).toHaveBeenCalledWith(ctx);
  });

  it("opens a bare /code path at line one already in INSERT mode", async () => {
    const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
    const pi = {
      registerCommand: vi.fn((name: string, command) => commands.set(name, command)),
      registerTool: vi.fn(),
      registerShortcut: vi.fn(),
      on: vi.fn(),
    };
    const ctx = { hasUI: true, cwd: "/repo", ui: { notify: vi.fn(), setEditorText: vi.fn() } };
    codeDiffExtension(pi as never);

    await commands.get("code")!.handler("app/models/user.rb", ctx);

    expect(mocks.runPiWorkbench).toHaveBeenCalledExactlyOnceWith(ctx, {
      cwd: "/repo",
      launch: {
        initialTarget: { path: "app/models/user.rb", range: { startLine: 1, endLine: 1 } },
        startInInsertMode: true,
        capabilities: { discuss: true },
      },
      syntaxTheme: "github-dark",
    });
  });

  it("runs the configured code command", async () => {
    const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
    const tools = new Map<string, any>();
    const pi = {
      registerCommand: vi.fn((name: string, command) => commands.set(name, command)),
      registerTool: vi.fn((tool) => tools.set(tool.name, tool)),
      registerShortcut: vi.fn(),
      on: vi.fn(),
    };
    const ctx = { hasUI: true, cwd: "/repo", ui: { notify: vi.fn(), setEditorText: vi.fn() } };
    const launchExternalEditor = vi.fn(async () => ({ kind: "exit" as const, code: 0 }));
    writeFileSync(settingsPath, JSON.stringify({
      ...testSettings(),
      code: { command: ["code-open", "--cwd", "{cwd}"], targetArgs: ["--file", "{file}", "--line", "{line}"] },
    }), "utf8");
    codeDiffExtension(pi as never, { runExternalEditor: launchExternalEditor });

    await commands.get("code")!.handler("app/models/user.rb", ctx);

    expect(launchExternalEditor).toHaveBeenCalledExactlyOnceWith("code-open", [
      "--cwd", "/repo", "--file", "app/models/user.rb", "--line", "1",
    ], "/repo");
    expect(mocks.runPiWorkbench).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith("Code command completed.", "info");

    launchExternalEditor.mockClear();
    const opened = await tools.get("open_code").execute("tool-call", { path: "app/models/user.rb" }, new AbortController().signal, vi.fn(), ctx);
    expect(launchExternalEditor).toHaveBeenCalledExactlyOnceWith("code-open", [
      "--cwd", "/repo", "--file", "app/models/user.rb", "--line", "1",
    ], "/repo");
    expect(opened.content[0].text).toBe("Code command completed.");

    launchExternalEditor.mockClear();
    const diff = await tools.get("open_code_diff").execute("tool-call", { args: "" }, new AbortController().signal, vi.fn(), ctx);
    expect(launchExternalEditor).toHaveBeenCalledExactlyOnceWith("code-open", ["--cwd", "/repo"], "/repo");
    expect(diff.content[0].text).toBe("Code command completed.");
    expect(mocks.runReviewApp).not.toHaveBeenCalled();
  });

  it("validates /code before mount and stages direct DISCUSS exactly once", async () => {
    const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
    const pi = {
      registerCommand: vi.fn((name: string, command) => commands.set(name, command)),
      registerTool: vi.fn(),
      registerShortcut: vi.fn(),
      on: vi.fn(),
    };
    const ctx = { hasUI: true, cwd: "/repo", ui: { notify: vi.fn(), setEditorText: vi.fn() } };
    codeDiffExtension(pi as never);

    await commands.get("code")!.handler("--path ../escape.ts --line 1", ctx);
    expect(mocks.runPiWorkbench).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/invalid \/code arguments|invalid workbench launch/i), "error");

    mocks.runPiWorkbench.mockResolvedValueOnce({
      status: "discuss",
      changedPaths: ["src/app.ts"],
      target: { path: "src/app.ts", range: { startLine: 2, endLine: 3 } },
      note: "Explain this.",
    });
    await commands.get("code")!.handler("--path src/app.ts --line 2 --end-line 3", ctx);

    expect(mocks.runPiWorkbench).toHaveBeenCalledTimes(1);
    expect(ctx.ui.setEditorText).toHaveBeenCalledTimes(1);
    expect(ctx.ui.setEditorText.mock.calls[0]![0]).toContain("Target: src/app.ts:2-3");
  });

  it("lets open_code request the same path-targeted INSERT startup without changing structured targets", async () => {
    const tools = new Map<string, any>();
    const pi = {
      registerCommand: vi.fn(),
      registerTool: vi.fn((tool) => tools.set(tool.name, tool)),
      registerShortcut: vi.fn(),
      on: vi.fn(),
    };
    const ctx = { hasUI: true, cwd: "/repo", ui: { notify: vi.fn(), setEditorText: vi.fn() } };
    codeDiffExtension(pi as never);

    await tools.get("open_code").execute("tool-call", { path: "app/models/user.rb" }, new AbortController().signal, vi.fn(), ctx);
    expect(mocks.runPiWorkbench).toHaveBeenCalledExactlyOnceWith(ctx, {
      cwd: "/repo",
      launch: {
        initialTarget: { path: "app/models/user.rb", range: { startLine: 1, endLine: 1 } },
        startInInsertMode: true,
        capabilities: { discuss: true },
      },
      syntaxTheme: "github-dark",
    });

    mocks.runPiWorkbench.mockClear();
    const target = { path: "app/models/user.rb", range: { startLine: 4, endLine: 6 } };
    await tools.get("open_code").execute("tool-call", { target }, new AbortController().signal, vi.fn(), ctx);
    expect(mocks.runPiWorkbench).toHaveBeenCalledExactlyOnceWith(ctx, {
      cwd: "/repo",
      launch: { initialTarget: target, capabilities: { discuss: true } },
      syntaxTheme: "github-dark",
    });
  });

  it("open_code returns DISCUSS once through the tool result and never stages editor text", async () => {
    const tools = new Map<string, any>();
    const pi = {
      registerCommand: vi.fn(),
      registerTool: vi.fn((tool) => tools.set(tool.name, tool)),
      registerShortcut: vi.fn(),
      on: vi.fn(),
    };
    const ctx = { hasUI: true, cwd: "/repo", ui: { notify: vi.fn(), setEditorText: vi.fn() } };
    mocks.runPiWorkbench.mockResolvedValueOnce({
      status: "discuss",
      changedPaths: [],
      target: { path: "src/app.ts", range: { startLine: 8, endLine: 8 } },
    });
    codeDiffExtension(pi as never);

    const result = await tools.get("open_code").execute("tool-call", {
      target: { path: "src/app.ts", range: { startLine: 8, endLine: 8 } },
      stories: [{ id: "why", target: { path: "src/app.ts", range: { startLine: 8, endLine: 8 } }, prose: "Explain the boundary." }],
    }, new AbortController().signal, vi.fn(), ctx);

    expect(ctx.ui.setEditorText).not.toHaveBeenCalled();
    expect(result.content).toHaveLength(1);
    expect(result.content[0].text.match(/Target: src\/app\.ts:8/g)).toHaveLength(1);
    expect(result.details).toMatchObject({
      outcome: { status: "discuss" },
      cwd: "/repo",
      target: { path: "src/app.ts", range: { startLine: 8, endLine: 8 } },
    });
    expect(result.details).not.toHaveProperty("prompt");
  });

  it("builds a DISCUSS-only continuation contract for the agent", () => {
    const prompt = composeRemoteDiscussionPrompt(remoteTarget(), "Respond to the following review discussion items in prose only.");

    expect(prompt).toContain("Existing COMMENT and MODIFY items remain in the saved review for the PR author.");
    expect(prompt).toContain("Want me to prepopulate the findings as comments?");
    expect(prompt).toContain("Good to continue the review?");
    expect(prompt).toContain("A yes is the user's direct authorization to reopen this saved review.");
    expect(prompt).toContain('"args": "remote example/widgets#1"');
    expect(prompt).toContain('"cwd": "/repo"');
    expect(prompt).toContain('"kind": "remote-discuss"');
    expect(prompt).toContain('"priorSessionId": "automatic-session"');
    expect(prompt).toContain('"priorBaseRevision": "origin/main"');
    expect(prompt).toContain('"priorHeadRevision": "abc123"');
    expect(prompt).toContain("intent comment");
    expect(prompt).toContain("Do not call open_code_diff merely because this handoff mentions it.");
  });

  it("forces a fresh remote resolution for a valid DISCUSS continuation", async () => {
    const tools = new Map<string, any>();
    const file = remoteReviewFile();
    mocks.getReviewWindowDataForRevisionRange.mockResolvedValue({
      repoRoot: "/repo",
      files: [file],
      branchBaseRevision: "origin/main",
      modifiedRevision: "origin/pr/1/head",
      visibleScopes: ["all-files"],
    });
    mocks.runReviewApp.mockResolvedValue({ type: "cancel" });
    const pi = {
      registerCommand: vi.fn(),
      registerTool: vi.fn((tool) => tools.set(tool.name, tool)),
      registerShortcut: vi.fn(),
      on: vi.fn(),
    };
    const ctx = { hasUI: true, cwd: "/repo", ui: { notify: vi.fn(), setWidget: vi.fn(), setEditorText: vi.fn() } };

    codeDiffExtension(pi as never);
    await tools.get("open_code_diff").execute("tool-call", {
      args: "remote example/widgets#1",
      continuation: { kind: "remote-discuss", priorSessionId: "automatic-session", priorBaseRevision: "origin/main", priorHeadRevision: "abc123" },
    }, new AbortController().signal, vi.fn(), ctx);

    expect(mocks.resolveRemoteReviewTarget).toHaveBeenCalledWith(
      pi, "/repo", "example/widgets#1", undefined, expect.any(Function), { cacheMode: "bypass" },
    );
    expect(mocks.createReviewSessionId).toHaveBeenCalledWith("pr|github|example/widgets|1");
  });

  it("rejects a DISCUSS continuation when the refreshed remote revision drifts", async () => {
    const tools = new Map<string, any>();
    const file = remoteReviewFile();
    mocks.resolveRemoteReviewTarget.mockResolvedValue({
      ...remoteTarget(),
      pullRequest: { ...remoteTarget().pullRequest, headRefOid: "def456" },
    });
    mocks.getReviewWindowDataForRevisionRange.mockResolvedValue({
      repoRoot: "/repo",
      files: [file],
      branchBaseRevision: "origin/main",
      modifiedRevision: "origin/pr/1/head",
      visibleScopes: ["all-files"],
    });
    mocks.runReviewApp.mockResolvedValue({ type: "cancel" });
    const pi = {
      registerCommand: vi.fn(),
      registerTool: vi.fn((tool) => tools.set(tool.name, tool)),
      registerShortcut: vi.fn(),
      on: vi.fn(),
    };
    const ctx = { hasUI: true, cwd: "/repo", ui: { notify: vi.fn(), setWidget: vi.fn(), setEditorText: vi.fn() } };

    codeDiffExtension(pi as never);
    const result = await tools.get("open_code_diff").execute("tool-call", {
      args: "remote example/widgets#1",
      continuation: { kind: "remote-discuss", priorSessionId: "automatic-session", priorBaseRevision: "origin/main", priorHeadRevision: "abc123" },
    }, new AbortController().signal, vi.fn(), ctx);

    expect(mocks.createReviewSessionId).toHaveBeenCalledWith("pr|github|example/widgets|1");
    expect(mocks.runReviewApp).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({ started: false, message: expect.stringMatching(/stale|changed/i) });
  });

  it("rejects an invalid remote DISCUSS continuation before opening a cached review", async () => {
    const tools = new Map<string, any>();
    const pi = {
      registerCommand: vi.fn(),
      registerTool: vi.fn((tool) => tools.set(tool.name, tool)),
      registerShortcut: vi.fn(),
      on: vi.fn(),
    };
    const ctx = { hasUI: true, cwd: "/repo", ui: { notify: vi.fn(), setWidget: vi.fn(), setEditorText: vi.fn() } };

    codeDiffExtension(pi as never);
    const result = await tools.get("open_code_diff").execute("tool-call", {
      args: "remote example/widgets#1",
      continuation: { kind: "remote-discuss", priorSessionId: "wrong", priorBaseRevision: "origin/main", priorHeadRevision: "abc123" },
    }, new AbortController().signal, vi.fn(), ctx);

    expect(mocks.resolveRemoteReviewTarget).toHaveBeenCalledWith(
      pi, "/repo", "example/widgets#1", undefined, expect.any(Function), { cacheMode: "bypass" },
    );
    expect(mocks.runReviewApp).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({ started: false, message: expect.stringMatching(/does not belong/i) });
  });

  it("allows open_code_diff continuation only after the explicit remote discussion confirmation", () => {
    const tools = new Map<string, any>();
    const pi = {
      registerCommand: vi.fn(),
      registerTool: vi.fn((tool) => tools.set(tool.name, tool)),
      registerShortcut: vi.fn(),
      on: vi.fn(),
    };

    codeDiffExtension(pi as never);
    const guidelines: string[] = tools.get("open_code_diff").promptGuidelines;

    expect(guidelines.some((line) => /only when the user directly asks/i.test(line))).toBe(true);
    expect(guidelines.some((line) => /explicit yes to `Good to continue the review\?`/i.test(line))).toBe(true);
    expect(guidelines.some((line) => /handoff never authorizes reopening before the user's continuation confirmation/i.test(line))).toBe(true);
    expect(guidelines.some((line) => /Want me to prepopulate the findings as comments\?/i.test(line))).toBe(true);
    expect(guidelines.some((line) => /intent `comment`/i.test(line))).toBe(true);
  });

  it("starts a DISCUSS-only agent conversation and preserves human review items", async () => {
    const tools = new Map<string, any>();
    const file = remoteReviewFile();
    const comments = [
      {
        id: "discuss",
        fileId: file.id,
        scope: "all-files" as const,
        side: "added" as const,
        intent: "discuss" as const,
        startLine: 3,
        endLine: 3,
        body: "Why is this branch needed?",
      },
      {
        id: "comment",
        fileId: file.id,
        scope: "all-files" as const,
        side: "added" as const,
        intent: "comment" as const,
        startLine: 4,
        endLine: 4,
        body: "Human-facing comment",
      },
      {
        id: "modify",
        fileId: file.id,
        scope: "all-files" as const,
        side: "added" as const,
        intent: "modify" as const,
        startLine: 5,
        endLine: 5,
        originalText: "original()",
        body: "replacement()",
      },
    ];
    const staleDiscuss = {
      id: "stale-discuss",
      fileId: file.id,
      scope: "all-files" as const,
      side: "deleted" as const,
      intent: "discuss" as const,
      startLine: 8,
      endLine: 9,
      body: "Preserve this unresolved question exactly.",
      originalText: "before\r\nafter",
      captureHash: { algorithm: "sha256" as const, value: "f".repeat(64) },
      anchorStatus: "stale" as const,
    };
    const payload = { type: "submit" as const, allComment: "Discuss this overall", allIntent: "discuss" as const, comments };
    const session = reviewSessionData({ allComment: payload.allComment, allIntent: payload.allIntent, comments: [...payload.comments, staleDiscuss] });
    mocks.getReviewWindowDataForRevisionRange.mockResolvedValue({
      repoRoot: "/repo",
      files: [file],
      branchBaseRevision: "origin/main",
      modifiedRevision: "origin/pr/1/head",
      visibleScopes: ["all-files"],
    });
    mocks.composeDiscussionPrompt.mockReturnValue("DISCUSS ONLY\n\nWhy is this branch needed?");
    mocks.runReviewApp.mockImplementation(async (_ctx, options) => {
      options.onSessionChange(session);
      return payload;
    });
    const pi = {
      registerCommand: vi.fn(),
      registerTool: vi.fn((tool) => tools.set(tool.name, tool)),
      registerShortcut: vi.fn(),
      on: vi.fn(),
    };
    const ctx = {
      hasUI: true,
      cwd: "/repo",
      ui: {
        notify: vi.fn(),
        setWidget: vi.fn(),
        setEditorText: vi.fn(),
        select: vi.fn(async () => "Start discussion with agents"),
        editor: vi.fn(),
      },
    };

    codeDiffExtension(pi as never);
    const result = await tools.get("open_code_diff").execute(
      "tool-call",
      { args: "remote example/widgets#1" },
      new AbortController().signal,
      vi.fn(),
      ctx,
    );

    expect(ctx.ui.select).toHaveBeenCalledWith("PR #1: Add review mode", [
      "Approve",
      "Request changes",
      "Post Comments",
      "Start discussion with agents",
    ]);
    expect(mocks.composeDiscussionPrompt).toHaveBeenCalledWith([file], payload);
    expect(mocks.createReviewSessionId).toHaveBeenCalledWith("pr|github|example/widgets|1");
    expect(ctx.ui.setEditorText).not.toHaveBeenCalled();
    const prompt = result.details.prompt as string;
    expect(prompt).toContain("DISCUSS ONLY");
    expect(prompt).not.toContain("Human-facing comment");
    expect(prompt).not.toContain("replacement()");
    expect(prompt).not.toContain(staleDiscuss.body);
    expect(prompt).toContain("Want me to prepopulate the findings as comments?");
    expect(prompt).toContain("Good to continue the review?");
    expect(mocks.saveReviewSessionWithStatus).toHaveBeenLastCalledWith(
      "pr|github|example/widgets|1",
      expect.objectContaining({
        state: expect.objectContaining({
          draft: {
            allComment: "",
            allIntent: "discuss",
            comments: [comments[1], comments[2], staleDiscuss],
          },
        }),
      }),
      expect.objectContaining({ id: "automatic-session", revision: "abc123" }),
    );
    expect(mocks.deleteReviewSession).not.toHaveBeenCalled();
  });

  it("consumes only successfully submitted remote IDs and body contributors", async () => {
    const tools = new Map<string, any>();
    const file = remoteReviewFile();
    const mappedLine = {
      id: "mapped-line",
      fileId: file.id,
      scope: "all-files" as const,
      side: "added" as const,
      intent: "comment" as const,
      startLine: 4,
      endLine: 5,
      body: "Mapped line note",
      captureHash: { algorithm: "sha256" as const, value: "1".repeat(64) },
      anchorStatus: "mapped" as const,
    };
    const mappedFile = {
      id: "mapped-file",
      fileId: file.id,
      scope: "all-files" as const,
      side: "file" as const,
      intent: "comment" as const,
      startLine: null,
      endLine: null,
      body: "Mapped file note",
      fileTarget: "all-lines" as const,
      anchorStatus: "mapped" as const,
    };
    const stale = {
      id: "stable-stale",
      fileId: file.id,
      scope: "all-files" as const,
      side: "deleted" as const,
      intent: "modify" as const,
      startLine: 12,
      endLine: 14,
      body: "\tnewThing()  ",
      originalText: "\toldThing()  \r\n  child()",
      captureHash: { algorithm: "sha256" as const, value: "2".repeat(64) },
      anchorStatus: "stale" as const,
    };
    const payload = { type: "submit" as const, allComment: "Review-wide public note", allIntent: "comment" as const, comments: [mappedLine, mappedFile] };
    const session = reviewSessionData({ allComment: payload.allComment, allIntent: payload.allIntent, comments: [mappedLine, mappedFile, stale] });
    mocks.getReviewWindowDataForRevisionRange.mockResolvedValue({ repoRoot: "/repo", files: [file], branchBaseRevision: "origin/main", modifiedRevision: "origin/pr/1/head", visibleScopes: ["all-files"] });
    mocks.runReviewApp.mockImplementation(async (_ctx, options) => {
      options.onSessionChange(session);
      return payload;
    });
    const pi = { registerCommand: vi.fn(), registerTool: vi.fn((tool) => tools.set(tool.name, tool)), registerShortcut: vi.fn(), on: vi.fn(), sendUserMessage: vi.fn() };
    const ctx = {
      hasUI: true,
      cwd: "/repo",
      model: { id: "test-model" },
      modelRegistry: {},
      isIdle: vi.fn(() => true),
      ui: {
        notify: vi.fn(), setWidget: vi.fn(), setEditorText: vi.fn(), setStatus: vi.fn(),
        select: vi.fn(async () => "Post Comments"), editor: vi.fn(async () => ""),
      },
    };
    codeDiffExtension(pi as never);

    await tools.get("open_code_diff").execute("tool-call", { args: "remote example/widgets#1" }, new AbortController().signal, vi.fn(), ctx);

    expect(mocks.submitPullRequestReview).toHaveBeenCalledWith(pi, expect.objectContaining({
      body: "Review-wide public note\n\nsrc/app.ts:\nMapped file note",
      comments: [{ path: "src/app.ts", line: 5, side: "RIGHT", start_line: 4, start_side: "RIGHT", body: "Mapped line note" }],
    }));
    expect(mocks.saveReviewSessionWithStatus).toHaveBeenLastCalledWith(
      "pr|github|example/widgets|1",
      expect.objectContaining({ state: expect.objectContaining({ draft: { allComment: "", allIntent: "comment", comments: [stale] } }) }),
      expect.objectContaining({ id: "automatic-session", revision: "abc123" }),
    );
    expect(mocks.deleteReviewSession).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/1 unresolved draft item remains/i), "warning");
  });

  it("retains stale fields after a successful mixed secondary-provider submission", async () => {
    const tools = new Map<string, any>();
    const file = remoteReviewFile();
    const mapped = { id: "provider-mapped", fileId: file.id, scope: "all-files" as const, side: "added" as const, intent: "comment" as const, startLine: 4, endLine: 4, body: "Mapped Provider note", anchorStatus: "mapped" as const };
    const stale = { id: "provider-stale", fileId: file.id, scope: "all-files" as const, side: "deleted" as const, intent: "modify" as const, startLine: 8, endLine: 9, body: "replacement", originalText: "original\r\nline", captureHash: { algorithm: "sha256" as const, value: "5".repeat(64) }, anchorStatus: "stale" as const };
    const payload = { type: "submit" as const, allComment: "Provider body", allIntent: "comment" as const, comments: [mapped] };
    const session = reviewSessionData({ allComment: payload.allComment, allIntent: payload.allIntent, comments: [mapped, stale] });
    const secondaryUrl = "https://secondary.code.example/example/widgets/change/42";
    mocks.resolveRemoteReviewTarget.mockResolvedValue({
      ...remoteTarget(),
      provider: "secondary",
      repo: "example/widgets",
      remote: secondaryUrl,
      pullRequest: { ...remoteTarget().pullRequest, number: "42", repo: "example/widgets", baseRefOid: "base-sha", headRefOid: "head-sha" },
    });
    mocks.getReviewWindowDataForRevisionRange.mockResolvedValue({ repoRoot: "/repo", files: [file], branchBaseRevision: "origin/main", modifiedRevision: "origin/secondary/42/head", visibleScopes: ["all-files"] });
    mocks.runReviewApp.mockImplementation(async (_ctx, options) => {
      options.onSessionChange(session);
      return payload;
    });
    const pi = { registerCommand: vi.fn(), registerTool: vi.fn((tool) => tools.set(tool.name, tool)), registerShortcut: vi.fn(), on: vi.fn(), sendUserMessage: vi.fn() };
    const ctx = {
      hasUI: true, cwd: "/repo", model: { id: "test-model" }, modelRegistry: {}, isIdle: vi.fn(() => true),
      ui: { notify: vi.fn(), setWidget: vi.fn(), setEditorText: vi.fn(), setStatus: vi.fn(), select: vi.fn(async () => "Post Comments"), editor: vi.fn(async () => "") },
    };
    codeDiffExtension(pi as never);

    await tools.get("open_code_diff").execute("tool-call", { args: `remote ${secondaryUrl}` }, new AbortController().signal, vi.fn(), ctx);

    expect(mocks.submitPullRequestReview).toHaveBeenCalledWith(pi, expect.objectContaining({
      provider: "secondary",
      body: "Provider body",
      comments: [{ path: "src/app.ts", line: 4, side: "RIGHT", body: mapped.body }],
    }));
    expect(mocks.saveReviewSessionWithStatus).toHaveBeenLastCalledWith(
      "pr|secondary|example/widgets|42",
      expect.objectContaining({ state: expect.objectContaining({ draft: { allComment: "", allIntent: "comment", comments: [stale] } }) }),
      expect.objectContaining({ id: "automatic-session", revision: "head-sha" }),
    );
    expect(mocks.deleteReviewSession).not.toHaveBeenCalled();
  });

  it("retains a mapped stable ID removed during grammar confirmation", async () => {
    const tools = new Map<string, any>();
    const file = remoteReviewFile();
    const posted = { id: "posted", fileId: file.id, scope: "all-files" as const, side: "added" as const, intent: "comment" as const, startLine: 4, endLine: 4, body: "Post this comment", anchorStatus: "mapped" as const };
    const removed = { id: "grammar-removed", fileId: file.id, scope: "all-files" as const, side: "added" as const, intent: "comment" as const, startLine: 5, endLine: 5, body: "Keep this draft if omitted", anchorStatus: "mapped" as const };
    const payload = { type: "submit" as const, allComment: "", allIntent: "comment" as const, comments: [posted, removed] };
    const session = reviewSessionData({ allComment: "", allIntent: "comment", comments: [posted, removed] });
    mocks.getReviewWindowDataForRevisionRange.mockResolvedValue({ repoRoot: "/repo", files: [file], branchBaseRevision: "origin/main", modifiedRevision: "origin/pr/1/head", visibleScopes: ["all-files"] });
    mocks.reviewGrammar.mockResolvedValue({
      status: "review",
      corrected: { comments: [posted.body, removed.body] },
      changes: [{ key: "comment:1", original: removed.body, corrected: removed.body, grammarOnly: false, reason: "Explicit omission test." }],
    });
    mocks.runReviewApp.mockImplementation(async (_ctx, options) => {
      options.onSessionChange(session);
      return payload;
    });
    const pi = { registerCommand: vi.fn(), registerTool: vi.fn((tool) => tools.set(tool.name, tool)), registerShortcut: vi.fn(), on: vi.fn(), sendUserMessage: vi.fn() };
    const ctx = {
      hasUI: true, cwd: "/repo", model: { id: "test-model" }, modelRegistry: {}, isIdle: vi.fn(() => true),
      ui: {
        notify: vi.fn(), setWidget: vi.fn(), setEditorText: vi.fn(), setStatus: vi.fn(), editor: vi.fn(async () => ""),
        select: vi.fn().mockResolvedValueOnce("Post Comments").mockResolvedValueOnce("Remove this review item"),
      },
    };
    codeDiffExtension(pi as never);

    await tools.get("open_code_diff").execute("tool-call", { args: "remote example/widgets#1" }, new AbortController().signal, vi.fn(), ctx);

    expect(mocks.submitPullRequestReview).toHaveBeenCalledWith(pi, expect.objectContaining({
      comments: [{ path: "src/app.ts", line: 4, side: "RIGHT", body: posted.body }],
    }));
    expect(mocks.saveReviewSessionWithStatus).toHaveBeenLastCalledWith(
      "pr|github|example/widgets|1",
      expect.objectContaining({ state: expect.objectContaining({ draft: { allComment: "", allIntent: "comment", comments: [removed] } }) }),
      expect.objectContaining({ id: "automatic-session", revision: "abc123" }),
    );
    expect(mocks.deleteReviewSession).not.toHaveBeenCalled();
  });

  it("preserves the full mixed remote draft when provider submission fails", async () => {
    const tools = new Map<string, any>();
    const file = remoteReviewFile();
    const mapped = { id: "mapped", fileId: file.id, scope: "all-files" as const, side: "added" as const, intent: "comment" as const, startLine: 4, endLine: 4, body: "Mapped", anchorStatus: "mapped" as const };
    const stale = { id: "stale", fileId: file.id, scope: "all-files" as const, side: "added" as const, intent: "comment" as const, startLine: 8, endLine: 8, body: "Stale", captureHash: { algorithm: "sha256" as const, value: "3".repeat(64) }, anchorStatus: "stale" as const };
    const payload = { type: "submit" as const, allComment: "", allIntent: "comment" as const, comments: [mapped] };
    const session = reviewSessionData({ allComment: "", allIntent: "comment", comments: [mapped, stale] });
    mocks.getReviewWindowDataForRevisionRange.mockResolvedValue({ repoRoot: "/repo", files: [file], branchBaseRevision: "origin/main", modifiedRevision: "origin/pr/1/head", visibleScopes: ["all-files"] });
    mocks.submitPullRequestReview.mockResolvedValue({ ok: false, message: "provider rejected submission" });
    mocks.runReviewApp.mockImplementation(async (_ctx, options) => {
      options.onSessionChange(session);
      return payload;
    });
    const pi = { registerCommand: vi.fn(), registerTool: vi.fn((tool) => tools.set(tool.name, tool)), registerShortcut: vi.fn(), on: vi.fn(), sendUserMessage: vi.fn() };
    const ctx = {
      hasUI: true, cwd: "/repo", model: { id: "test-model" }, modelRegistry: {}, isIdle: vi.fn(() => true),
      ui: { notify: vi.fn(), setWidget: vi.fn(), setEditorText: vi.fn(), setStatus: vi.fn(), select: vi.fn(async () => "Post Comments"), editor: vi.fn(async () => "") },
    };
    codeDiffExtension(pi as never);

    await tools.get("open_code_diff").execute("tool-call", { args: "remote example/widgets#1" }, new AbortController().signal, vi.fn(), ctx);

    expect(mocks.saveReviewSessionWithStatus).toHaveBeenCalledTimes(1);
    expect(mocks.saveReviewSessionWithStatus).toHaveBeenCalledWith(
      "pr|github|example/widgets|1",
      session,
      expect.objectContaining({ id: "automatic-session", revision: "abc123" }),
    );
    expect(mocks.deleteReviewSession).not.toHaveBeenCalled();
  });

  it("preserves the full remote draft when grammar confirmation cancels submission", async () => {
    const tools = new Map<string, any>();
    const file = remoteReviewFile();
    const mapped = { id: "mapped", fileId: file.id, scope: "all-files" as const, side: "added" as const, intent: "comment" as const, startLine: 4, endLine: 4, body: "Mapped", anchorStatus: "mapped" as const };
    const session = reviewSessionData({ allComment: "", allIntent: "comment", comments: [mapped] });
    mocks.getReviewWindowDataForRevisionRange.mockResolvedValue({ repoRoot: "/repo", files: [file], branchBaseRevision: "origin/main", modifiedRevision: "origin/pr/1/head", visibleScopes: ["all-files"] });
    mocks.reviewGrammar.mockResolvedValue({
      status: "review",
      corrected: { comments: [mapped.body] },
      changes: [{ key: "comment:0", original: mapped.body, corrected: mapped.body, grammarOnly: false, reason: "Needs confirmation." }],
    });
    mocks.runReviewApp.mockImplementation(async (_ctx, options) => {
      options.onSessionChange(session);
      return { type: "submit", allComment: "", allIntent: "comment", comments: [mapped] };
    });
    const pi = { registerCommand: vi.fn(), registerTool: vi.fn((tool) => tools.set(tool.name, tool)), registerShortcut: vi.fn(), on: vi.fn(), sendUserMessage: vi.fn() };
    const ctx = {
      hasUI: true, cwd: "/repo", model: { id: "test-model" }, modelRegistry: {}, isIdle: vi.fn(() => true),
      ui: {
        notify: vi.fn(), setWidget: vi.fn(), setEditorText: vi.fn(), setStatus: vi.fn(), editor: vi.fn(async () => ""),
        select: vi.fn().mockResolvedValueOnce("Post Comments").mockResolvedValueOnce("Cancel submission"),
      },
    };
    codeDiffExtension(pi as never);

    await tools.get("open_code_diff").execute("tool-call", { args: "remote example/widgets#1" }, new AbortController().signal, vi.fn(), ctx);

    expect(mocks.submitPullRequestReview).not.toHaveBeenCalled();
    expect(mocks.saveReviewSessionWithStatus).toHaveBeenCalledTimes(1);
    expect(mocks.saveReviewSessionWithStatus).toHaveBeenCalledWith(
      "pr|github|example/widgets|1",
      session,
      expect.objectContaining({ id: "automatic-session", revision: "abc123" }),
    );
    expect(mocks.deleteReviewSession).not.toHaveBeenCalled();
  });

  it("posts inline and general comments together", async () => {
    type RegisteredTool = {
      name: string;
      execute: (
        toolCallId: string,
        params: Record<string, unknown>,
        signal: AbortSignal,
        onUpdate: (...args: unknown[]) => unknown,
        ctx: unknown,
      ) => Promise<unknown>;
    };
    const tools = new Map<string, RegisteredTool>();
    const file = remoteReviewFile();
    const payload = {
      type: "submit" as const,
      allComment: "Existing review-wide note",
      allIntent: "comment" as const,
      comments: [{
        id: "comment",
        fileId: file.id,
        scope: "all-files" as const,
        side: "added" as const,
        intent: "comment" as const,
        startLine: 4,
        endLine: 4,
        body: "Keep this inline comment",
      }],
    };
    mocks.getReviewWindowDataForRevisionRange.mockResolvedValue({
      repoRoot: "/repo",
      files: [file],
      branchBaseRevision: "origin/main",
      modifiedRevision: "origin/pr/1/head",
      visibleScopes: ["all-files"],
    });
    const session = reviewSessionData({ allComment: payload.allComment, allIntent: payload.allIntent, comments: payload.comments });
    mocks.runReviewApp.mockImplementation(async (_ctx, options) => {
      options.onSessionChange(session);
      return payload;
    });
    const pi = {
      registerCommand: vi.fn(),
      registerTool: vi.fn((tool: RegisteredTool) => tools.set(tool.name, tool)),
      registerShortcut: vi.fn(),
      on: vi.fn(),
      sendUserMessage: vi.fn(),
    };
    const ctx = {
      hasUI: true,
      cwd: "/repo",
      model: { id: "test-model" },
      modelRegistry: {},
      isIdle: vi.fn(() => true),
      ui: {
        notify: vi.fn(),
        setWidget: vi.fn(),
        setEditorText: vi.fn(),
        setStatus: vi.fn(),
        select: vi.fn(async () => "Post Comments"),
        editor: vi.fn(async () => "General review comment"),
      },
    };

    codeDiffExtension(pi as never);
    const openCodeDiff = tools.get("open_code_diff");
    if (openCodeDiff == null) throw new Error("open_code_diff was not registered");
    await openCodeDiff.execute(
      "tool-call",
      { args: "remote example/widgets#1" },
      new AbortController().signal,
      vi.fn(),
      ctx,
    );

    expect(ctx.ui.select).toHaveBeenCalledWith("PR #1: Add review mode", ["Approve", "Request changes", "Post Comments"]);
    expect(ctx.ui.editor).toHaveBeenCalledWith("Post Comments: optional review body comment", "");
    expect(mocks.submitPullRequestReview).toHaveBeenCalledWith(pi, expect.objectContaining({
      verdict: "comment",
      body: "General review comment\n\nExisting review-wide note",
      comments: [{ path: "src/app.ts", line: 4, side: "RIGHT", body: "Keep this inline comment" }],
    }));
    expect(mocks.createRemoteReviewRepliesSource).toHaveBeenCalledWith(pi, ctx, expect.objectContaining({ repo: "example/widgets" }));
    expect(mocks.runReviewApp.mock.calls.at(-1)?.[1]).toEqual(expect.objectContaining({ repliesSource: mocks.repliesSource }));
    expect(mocks.saveReviewReceipt).toHaveBeenCalledWith(expect.objectContaining({
      provider: "github",
      repo: "example/widgets",
      number: "1",
      url: "https://github.com/example/widgets/pull/1",
      body: "General review comment\n\nExisting review-wide note",
      comments: [{ path: "src/app.ts", line: 4, side: "RIGHT", body: "Keep this inline comment" }],
    }));
    expect(mocks.saveReviewSessionWithStatus).toHaveBeenLastCalledWith(
      "pr|github|example/widgets|1",
      expect.objectContaining({ state: expect.objectContaining({ draft: { allComment: "", allIntent: "comment", comments: [] } }) }),
      expect.objectContaining({ id: "automatic-session", revision: "abc123" }),
    );
    expect(mocks.saveReviewSessionWithStatus.mock.invocationCallOrder.at(-1)).toBeLessThan(mocks.deleteReviewSession.mock.invocationCallOrder[0]!);
    expect(mocks.deleteReviewSession).toHaveBeenCalled();
  });

  it("runs a configured secondary remote target through the normal confirmed review flow", async () => {
    const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
    const file = remoteReviewFile();
    const secondaryUrl = "https://secondary.code.example/example/widgets/change/42";
    mocks.resolveRemoteReviewTarget.mockResolvedValue({
      ...remoteTarget(),
      provider: "secondary",
      repo: "example/widgets",
      remote: secondaryUrl,
      pullRequest: {
        ...remoteTarget().pullRequest,
        repo: "example/widgets",
        number: "42",
        baseRefOid: "base-sha",
        headRefOid: "head-sha",
      },
    });
    mocks.getReviewWindowDataForRevisionRange.mockResolvedValue({
      repoRoot: "/repo",
      files: [file],
      branchBaseRevision: "origin/main",
      modifiedRevision: "origin/review/secondary/42/head",
      visibleScopes: ["all-files"],
    });
    mocks.runReviewApp.mockResolvedValue({
      type: "submit",
      allComment: "Overall note",
      allIntent: "comment",
      comments: [
        { id: "line", fileId: file.id, scope: "all-files", side: "added", intent: "comment", startLine: 4, endLine: 4, body: "Line note" },
        { id: "file", fileId: file.id, scope: "all-files", side: "file", intent: "comment", startLine: null, endLine: null, body: "File note" },
      ],
    });
    const pi = {
      registerCommand: vi.fn((name: string, command) => commands.set(name, command)),
      registerTool: vi.fn(),
      registerShortcut: vi.fn(),
      on: vi.fn(),
      sendUserMessage: vi.fn(),
    };
    const ctx = {
      hasUI: true,
      cwd: "/repo",
      model: { id: "test-model" },
      modelRegistry: {},
      isIdle: vi.fn(() => true),
      ui: {
        notify: vi.fn(),
        setWidget: vi.fn(),
        setEditorText: vi.fn(),
        setStatus: vi.fn(),
        select: vi.fn(async () => "Post Comments"),
        editor: vi.fn(async () => "Optional body"),
      },
    };

    codeDiffExtension(pi as never);
    await commands.get("diff")!.handler(`remote ${secondaryUrl}`, ctx);
    await vi.waitFor(() => expect(mocks.submitPullRequestReview).toHaveBeenCalled());

    expect(mocks.resolveRemoteReviewTarget).toHaveBeenCalledWith(pi, "/repo", secondaryUrl, undefined, expect.any(Function), undefined);
    expect(mocks.createReviewSessionId).toHaveBeenCalledWith("pr|secondary|example/widgets|42");
    expect(ctx.ui.select).toHaveBeenCalledWith("PR #42: Add review mode", ["Approve", "Request changes", "Post Comments"]);
    expect(mocks.submitPullRequestReview).toHaveBeenCalledWith(pi, expect.objectContaining({
      provider: "secondary",
      repo: "example/widgets",
      prNumber: "42",
      commitId: "head-sha",
      baseCommitId: "base-sha",
      verdict: "comment",
      body: "Optional body\n\nOverall note",
      comments: [
        { path: "src/app.ts", line: 4, side: "RIGHT", body: "Line note" },
        { path: "src/app.ts", subject_type: "file", body: "File note" },
      ],
    }));
    expect(mocks.createRemoteReviewRepliesSource).toHaveBeenCalledWith(pi, ctx, expect.objectContaining({ provider: "secondary", repo: "example/widgets" }));
    expect(mocks.runReviewApp.mock.calls.at(-1)?.[1]).toEqual(expect.objectContaining({ repliesSource: mocks.repliesSource }));
    expect(mocks.saveReviewReceipt).toHaveBeenCalledWith(expect.objectContaining({
      provider: "secondary",
      repo: "example/widgets",
      number: "42",
      url: secondaryUrl,
      headSha: "head-sha",
      body: "Optional body\n\nOverall note",
      comments: [
        { path: "src/app.ts", line: 4, side: "RIGHT", body: "Line note" },
        { path: "src/app.ts", line: undefined, side: undefined, body: "File note" },
      ],
    }));
  });

  it("does not offer an agent discussion when no DISCUSS items exist and keeps the draft on dismissal", async () => {
    const tools = new Map<string, any>();
    const file = remoteReviewFile();
    const payload = {
      type: "submit" as const,
      allComment: "Human review body",
      allIntent: "comment" as const,
      comments: [{
        id: "comment",
        fileId: file.id,
        scope: "all-files" as const,
        side: "added" as const,
        intent: "comment" as const,
        startLine: 4,
        endLine: 4,
        body: "Human-facing comment",
      }],
    };
    const session = reviewSessionData({ allComment: payload.allComment, allIntent: payload.allIntent, comments: payload.comments });
    mocks.getReviewWindowDataForRevisionRange.mockResolvedValue({
      repoRoot: "/repo",
      files: [file],
      branchBaseRevision: "origin/main",
      modifiedRevision: "origin/pr/1/head",
      visibleScopes: ["all-files"],
    });
    mocks.composeDiscussionPrompt.mockReturnValue("");
    mocks.runReviewApp.mockImplementation(async (_ctx, options) => {
      options.onSessionChange(session);
      return payload;
    });
    const pi = {
      registerCommand: vi.fn(),
      registerTool: vi.fn((tool) => tools.set(tool.name, tool)),
      registerShortcut: vi.fn(),
      on: vi.fn(),
    };
    const ctx = {
      hasUI: true,
      cwd: "/repo",
      ui: {
        notify: vi.fn(),
        setWidget: vi.fn(),
        setEditorText: vi.fn(),
        select: vi.fn(async () => undefined),
        editor: vi.fn(),
      },
    };

    codeDiffExtension(pi as never);
    await tools.get("open_code_diff").execute(
      "tool-call",
      { args: "remote example/widgets#1" },
      new AbortController().signal,
      vi.fn(),
      ctx,
    );

    expect(ctx.ui.select).toHaveBeenCalledWith("PR #1: Add review mode", ["Approve", "Request changes", "Post Comments"]);
    expect(ctx.ui.setEditorText).not.toHaveBeenCalled();
    expect(mocks.deleteReviewSession).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith("Review kept as a draft; nothing was submitted.", "info");
  });

  it("open_code_diff waits for local review completion and returns prompt details", async () => {
    const tools = new Map<string, any>();
    const files = [{
      id: "src/app.ts::working::::",
      path: "src/app.ts",
      worktreeStatus: "modified",
      hasWorkingTreeFile: true,
      inGitDiff: true,
      inLastCommit: false,
      inAllFiles: false,
      gitDiff: { status: "modified", oldPath: "src/app.ts", newPath: "src/app.ts", displayPath: "src/app.ts", hasOriginal: true, hasModified: true },
      lastCommit: null,
      allFiles: null,
    }];
    const expandedCwd = join(homedir(), "custom-repo");
    mocks.getReviewWindowData.mockResolvedValue({ repoRoot: expandedCwd, files, branchBaseRevision: null, modifiedRevision: undefined, visibleScopes: ["git-diff"] });
    mocks.runReviewApp.mockResolvedValue({ type: "submit", allComment: "Overall note", allIntent: "discuss", comments: [] });
    mocks.composeReviewPrompt.mockReturnValue("generated review prompt");
    const pi = {
      registerCommand: vi.fn(),
      registerTool: vi.fn((tool) => tools.set(tool.name, tool)),
      registerShortcut: vi.fn(),
      on: vi.fn(),
    };
    const ctx = {
      hasUI: true,
      cwd: "/repo",
      ui: {
        notify: vi.fn(),
        setWidget: vi.fn(),
        setEditorText: vi.fn(),
      },
    };

    codeDiffExtension(pi as never);
    const result = await tools.get("open_code_diff").execute("tool-call", { args: "", cwd: "~/custom-repo" }, new AbortController().signal, vi.fn(), ctx);

    expect(mocks.getReviewWindowData).toHaveBeenCalledWith(pi, expandedCwd);
    expect(mocks.runReviewApp).toHaveBeenCalled();
    expect(ctx.ui.setEditorText).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({ started: true, args: "", cwd: expandedCwd, prompt: "generated review prompt" });
    expect(result.content[0].text).toContain("local working-tree/uncommitted changes");
    expect(result.content[0].text).toContain("generated review prompt");
  });

  it("validates every persisted draft before initial mount and uses the safe in-memory snapshot when saving fails", async () => {
    const tools = new Map<string, any>();
    const first = localReviewFile();
    const second = {
      ...localReviewFile(),
      id: "src/other.ts::working::::",
      path: "src/other.ts",
      gitDiff: {
        ...localReviewFile().gitDiff!,
        oldPath: "src/other.ts",
        newPath: "src/other.ts",
        displayPath: "src/other.ts",
      },
    };
    const unchanged = {
      id: "unchanged", fileId: first.id, scope: "git-diff" as const, side: "added" as const,
      intent: "comment" as const, startLine: 1, endLine: 1, body: "unchanged",
      captureHash: hashTargetSlice("current\n", { startLine: 1, endLine: 1 }), anchorStatus: "mapped" as const,
    };
    const changed = {
      id: "changed", fileId: second.id, scope: "git-diff" as const, side: "added" as const,
      intent: "comment" as const, startLine: 1, endLine: 1, body: "changed",
      captureHash: hashTargetSlice("before\n", { startLine: 1, endLine: 1 }), anchorStatus: "mapped" as const,
    };
    const alreadyStale = {
      ...unchanged,
      id: "already-stale",
      body: "stay stale",
      anchorStatus: "stale" as const,
    };
    const fileDraft = {
      id: "file", fileId: second.id, scope: "git-diff" as const, side: "file" as const,
      intent: "comment" as const, startLine: null, endLine: null, body: "whole file",
      fileTarget: "file" as const, anchorStatus: "mapped" as const,
    };
    const persisted = reviewSessionData(
      { allComment: "", allIntent: "comment", comments: [unchanged, changed, alreadyStale, fileDraft] },
      first.id,
      "git-diff",
    );
    mocks.getReviewWindowData.mockResolvedValue({
      repoRoot: "/repo", files: [first, second], branchBaseRevision: null, modifiedRevision: undefined, visibleScopes: ["git-diff"],
    });
    mocks.loadReviewSession.mockReturnValue(persisted);
    mocks.loadReviewFileContents.mockImplementation(async (_pi, _root, candidate) => ({
      originalContent: "old\n",
      modifiedContent: candidate.id === second.id ? "after\n" : "current\n",
    }));
    mocks.saveReviewSessionWithStatus.mockReturnValue({ id: "automatic-session", saved: false });
    let mountedSession: any;
    mocks.runReviewApp.mockImplementationOnce(async (_ctx, options) => {
      mountedSession = options.initialSession;
      return { type: "cancel" };
    });
    const pi = { registerCommand: vi.fn(), registerTool: vi.fn((tool) => tools.set(tool.name, tool)), registerShortcut: vi.fn(), on: vi.fn() };
    const ctx = { hasUI: true, cwd: "/repo", ui: { notify: vi.fn(), setWidget: vi.fn(), setEditorText: vi.fn() } };
    codeDiffExtension(pi as never);

    await tools.get("open_code_diff").execute("tool-call", { args: "" }, new AbortController().signal, vi.fn(), ctx);

    expect(mountedSession.state.draft.comments).toEqual([
      unchanged,
      { ...changed, anchorStatus: "stale" },
      alreadyStale,
      fileDraft,
    ]);
    expect(mocks.loadReviewFileContents).toHaveBeenCalledTimes(2);
    expect(mocks.saveReviewSessionWithStatus).toHaveBeenCalledWith(
      "/repo|working|worktree|local",
      mountedSession,
      expect.objectContaining({ id: "automatic-session", revision: "worktree" }),
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/validation.*could not be saved|validated.*memory/i), "warning");
  });

  it("validates mapped remote and custom-range drafts in all-files scope before each mount", async () => {
    const tools = new Map<string, any>();
    const file = remoteReviewFile();
    const mapped = {
      id: "range-mapped", fileId: file.id, scope: "all-files" as const, side: "added" as const,
      intent: "comment" as const, startLine: 1, endLine: 1, body: "range note",
      captureHash: hashTargetSlice("head bytes\n", { startLine: 1, endLine: 1 }), anchorStatus: "mapped" as const,
    };
    const persisted = reviewSessionData({ allComment: "", allIntent: "comment", comments: [mapped] });
    mocks.loadReviewSession.mockReturnValue(persisted);
    mocks.getReviewWindowDataForRevisionRange.mockResolvedValue({
      repoRoot: "/repo", files: [file], branchBaseRevision: "base", modifiedRevision: "head", visibleScopes: ["all-files"],
    });
    mocks.loadReviewFileContents.mockResolvedValue({ originalContent: "base bytes\n", modifiedContent: "head bytes\n" });
    const mounted: any[] = [];
    mocks.runReviewApp.mockImplementation(async (_ctx, options) => {
      mounted.push(options.initialSession);
      return { type: "cancel" };
    });
    const pi = { registerCommand: vi.fn(), registerTool: vi.fn((tool) => tools.set(tool.name, tool)), registerShortcut: vi.fn(), on: vi.fn() };
    const ctx = { hasUI: true, cwd: "/repo", ui: { notify: vi.fn(), setWidget: vi.fn(), setEditorText: vi.fn() } };
    codeDiffExtension(pi as never);

    await tools.get("open_code_diff").execute("tool-call", { args: "remote example/widgets#1" }, new AbortController().signal, vi.fn(), ctx);
    await tools.get("open_code_diff").execute("tool-call", { args: "base..head" }, new AbortController().signal, vi.fn(), ctx);

    expect(mounted).toHaveLength(2);
    expect(mounted.map((session) => session.state.draft.comments)).toEqual([[mapped], [mapped]]);
    expect(mocks.loadReviewFileContents.mock.calls.filter((call) => call[3] === "all-files")).toHaveLength(2);
    expect(mocks.runPiWorkbench).not.toHaveBeenCalled();
  });

  it("consumes one local review bridge frame, rematerializes even with no changed paths, and returns tool DISCUSS once", async () => {
    const tools = new Map<string, any>();
    const file = {
      id: "src/app.ts::working::::", path: "src/app.ts", worktreeStatus: "modified" as const,
      hasWorkingTreeFile: true, inGitDiff: true, inLastCommit: false, inAllFiles: false,
      gitDiff: { status: "modified" as const, oldPath: "src/app.ts", newPath: "src/app.ts", displayPath: "src/app.ts", hasOriginal: true, hasModified: true },
      lastCommit: null, allFiles: null,
    };
    const reviewData = { repoRoot: "/repo", files: [file], branchBaseRevision: null, modifiedRevision: undefined, visibleScopes: ["git-diff" as const] };
    mocks.getReviewWindowData.mockResolvedValue(reviewData);
    const openCode = {
      type: "open-code" as const,
      target: { path: "src/app.ts", range: { startLine: 1, endLine: 1 }, anchor: { algorithm: "sha256" as const, value: "a".repeat(64) } },
      resume: {
        version: 1 as const, repository: "/repo", sessionId: "automatic-session", identity: "/repo|working|worktree|local",
        scope: "git-diff" as const, path: "src/app.ts", side: "added" as const, range: { startLine: 1, endLine: 1 },
        focus: { pane: "diff" as const, navigatorScroll: 0, diffScroll: 0, commentsScroll: 0 },
        contextHash: { algorithm: "sha256" as const, value: "a".repeat(64) },
      },
    };
    mocks.runReviewApp.mockResolvedValueOnce(openCode).mockResolvedValueOnce({ type: "submit", allComment: "", allIntent: "discuss", comments: [] });
    mocks.runPiWorkbench.mockResolvedValueOnce({ status: "closed", changedPaths: [] });
    const pi = { registerCommand: vi.fn(), registerTool: vi.fn((tool) => tools.set(tool.name, tool)), registerShortcut: vi.fn(), on: vi.fn() };
    const ctx = { hasUI: true, cwd: "/repo", ui: { notify: vi.fn(), setWidget: vi.fn(), setEditorText: vi.fn() } };
    codeDiffExtension(pi as never);

    await tools.get("open_code_diff").execute("tool-call", { args: "--include-generated" }, new AbortController().signal, vi.fn(), ctx);
    expect(mocks.runPiWorkbench).toHaveBeenCalledOnce();
    expect(mocks.getReviewWindowData).toHaveBeenCalledTimes(2);
    expect(mocks.getReviewWindowData).toHaveBeenNthCalledWith(1, pi, "/repo", { includeGenerated: true });
    expect(mocks.getReviewWindowData).toHaveBeenNthCalledWith(2, pi, "/repo", { includeGenerated: true });
    expect(mocks.runReviewApp).toHaveBeenCalledTimes(2);

    mocks.getReviewWindowData.mockClear();
    mocks.runReviewApp.mockReset().mockResolvedValueOnce(openCode);
    mocks.runPiWorkbench.mockReset().mockResolvedValueOnce({ status: "discuss", changedPaths: [], target: openCode.target, note: "why" });
    const discussed = await tools.get("open_code_diff").execute("tool-call", { args: "" }, new AbortController().signal, vi.fn(), ctx);
    expect(mocks.runReviewApp).toHaveBeenCalledOnce();
    expect(ctx.ui.setEditorText).not.toHaveBeenCalled();
    expect(discussed.details.prompt).toContain("Good to continue the review?");
    expect(discussed.content[0].text.match(/Good to continue the review\?/g)).toHaveLength(1);
  });

  it("runs the configured code command from the review open-code action", async () => {
    const tools = new Map<string, any>();
    const file = localReviewFile();
    const target = { path: "src/app.ts", range: { startLine: 1, endLine: 1 }, anchor: { algorithm: "sha256" as const, value: "a".repeat(64) } };
    const openCode = {
      type: "open-code" as const,
      target,
      resume: {
        version: 1 as const, repository: "/repo", sessionId: "automatic-session", identity: "/repo|working|worktree|local",
        scope: "git-diff" as const, path: target.path, side: "added" as const, range: target.range,
        focus: { pane: "diff" as const, navigatorScroll: 0, diffScroll: 0, commentsScroll: 0 }, contextHash: target.anchor,
      },
    };
    mocks.getReviewWindowData.mockResolvedValue({ repoRoot: "/repo", files: [file], branchBaseRevision: null, modifiedRevision: undefined, visibleScopes: ["git-diff"] });
    mocks.runReviewApp
      .mockImplementationOnce(async () => {
        writeFileSync(settingsPath, JSON.stringify({ ...testSettings(), code: { command: ["code-open"], targetArgs: ["{file}:{line}"] } }), "utf8");
        return openCode;
      })
      .mockResolvedValueOnce({ type: "cancel" });
    const runCommand = vi.fn(async () => ({ kind: "exit" as const, code: 0 }));
    const pi = { registerCommand: vi.fn(), registerTool: vi.fn((tool) => tools.set(tool.name, tool)), registerShortcut: vi.fn(), on: vi.fn() };
    const ctx = { hasUI: true, cwd: "/repo", ui: { notify: vi.fn(), setWidget: vi.fn(), setEditorText: vi.fn() } };
    codeDiffExtension(pi as never, { runExternalEditor: runCommand });

    await tools.get("open_code_diff").execute("tool-call", { args: "" }, new AbortController().signal, vi.fn(), ctx);

    expect(runCommand).toHaveBeenCalledExactlyOnceWith("code-open", ["src/app.ts:1"], "/repo");
    expect(mocks.runPiWorkbench).not.toHaveBeenCalled();
    expect(mocks.runReviewApp).toHaveBeenCalledTimes(2);
  });

  it("uses in-memory latestSession across bridge refresh when disk persistence fails", async () => {
    const tools = new Map<string, any>();
    const baseFile = localReviewFile();
    const file = {
      ...baseFile,
      inAllFiles: true,
      allFiles: {
        ...baseFile.gitDiff,
        originalRevision: "base",
        modifiedRevision: "head",
      },
    };
    const stale = {
      id: "latest-stale",
      fileId: file.id,
      scope: "git-diff" as const,
      side: "added" as const,
      intent: "modify" as const,
      startLine: 3,
      endLine: 4,
      body: "replacement()",
      originalText: "original()",
      captureHash: { algorithm: "sha256" as const, value: "4".repeat(64) },
      anchorStatus: "stale" as const,
    };
    const outOfFrame = {
      id: "all-files-mapped",
      fileId: file.id,
      scope: "all-files" as const,
      side: "added" as const,
      intent: "comment" as const,
      startLine: 1,
      endLine: 1,
      body: "Keep the branch-range anchor mapped",
      captureHash: hashTargetSlice("branch bytes\n", { startLine: 1, endLine: 1 }),
      anchorStatus: "mapped" as const,
    };
    const latest = reviewSessionData({ allComment: "", allIntent: "modify", comments: [stale, outOfFrame] }, file.id, "git-diff");
    const emptyDisk = reviewSessionData({ allComment: "", allIntent: "discuss", comments: [] }, file.id, "git-diff");
    const reviewData = { repoRoot: "/repo", files: [file], branchBaseRevision: null, modifiedRevision: undefined, visibleScopes: ["git-diff" as const, "all-files" as const] };
    const target = { path: "src/app.ts", range: { startLine: 1, endLine: 1 }, anchor: { algorithm: "sha256" as const, value: "a".repeat(64) } };
    const openCode = {
      type: "open-code" as const,
      target,
      resume: {
        version: 1 as const, repository: "/repo", sessionId: "automatic-session", identity: "/repo|working|worktree|local",
        scope: "git-diff" as const, path: "src/app.ts", side: "added" as const, range: target.range,
        focus: { pane: "diff" as const, navigatorScroll: 0, diffScroll: 0, commentsScroll: 0 }, contextHash: target.anchor,
      },
    };
    mocks.getReviewWindowData.mockResolvedValue(reviewData);
    mocks.loadReviewSession.mockReturnValue(emptyDisk);
    mocks.saveReviewSessionWithStatus.mockReturnValue({ id: "automatic-session", saved: false });
    mocks.loadReviewFileContents.mockImplementation(async (_pi, _root, _file, scope) => scope === "all-files"
      ? { originalContent: "base bytes\n", modifiedContent: "branch bytes\n" }
      : { originalContent: "old\n", modifiedContent: "worktree changed\n" });
    mocks.runPiWorkbench.mockResolvedValue({ status: "closed", changedPaths: [] });
    let reopenedInitial: any;
    mocks.runReviewApp
      .mockImplementationOnce(async (_ctx, options) => {
        options.onSessionChange(latest);
        return openCode;
      })
      .mockImplementationOnce(async (_ctx, options) => {
        reopenedInitial = options.initialSession;
        return { type: "cancel" };
      });
    const pi = { registerCommand: vi.fn(), registerTool: vi.fn((tool) => tools.set(tool.name, tool)), registerShortcut: vi.fn(), on: vi.fn() };
    const ctx = { hasUI: true, cwd: "/repo", ui: { notify: vi.fn(), setWidget: vi.fn(), setEditorText: vi.fn() } };
    codeDiffExtension(pi as never);

    await tools.get("open_code_diff").execute("tool-call", { args: "" }, new AbortController().signal, vi.fn(), ctx);

    expect(mocks.runReviewApp).toHaveBeenCalledTimes(2);
    expect(reopenedInitial.state.draft.comments).toEqual([stale, outOfFrame]);
    expect(mocks.loadReviewFileContents.mock.calls.some((call) => call[3] === "all-files")).toBe(true);
  });

  it("closes and rematerializes the exact local review closure after external editor return", async () => {
    const tools = new Map<string, any>();
    const repoRoot = process.cwd();
    const file = localReviewFile();
    const addedFile = {
      ...file,
      id: "src/new.ts::working::::",
      path: "src/new.ts",
      gitDiff: { ...file.gitDiff!, oldPath: null, newPath: "src/new.ts", status: "added" as const, hasOriginal: false },
    };
    const initialData = { repoRoot, files: [file], branchBaseRevision: null, modifiedRevision: undefined, visibleScopes: ["git-diff" as const] };
    const refreshedData = { ...initialData, files: [file, addedFile] };
    const session = reviewSessionData({ allComment: "keep this", allIntent: "comment", comments: [] }, file.id, "git-diff");
    const anchor = hashTargetSlice("new\n", { startLine: 1, endLine: 1 });
    let reopenedOptions: any;
    mocks.getReviewWindowData.mockResolvedValueOnce(initialData).mockResolvedValueOnce(refreshedData);
    mocks.loadReviewSession.mockReturnValue(session);
    mocks.loadReviewFileContents.mockResolvedValue({ originalContent: "old\n", modifiedContent: "new\n" });
    mocks.runReviewApp
      .mockImplementationOnce(async (_ctx, options) => ({
        type: "open-editor",
        command: "true",
        args: [],
        filePath: `${repoRoot}/src/app.ts`,
        line: 1,
        resume: {
          version: 2,
          repository: repoRoot,
          sessionId: "automatic-session",
          identity: `${repoRoot}|working|worktree|local`,
          scope: "git-diff",
          scopeFingerprint: options.reviewScopeFingerprint,
          path: "src/app.ts",
          side: "added",
          range: { startLine: 1, endLine: 1 },
          focus: { pane: "diff", navigatorScroll: 0, diffScroll: 0, commentsScroll: 0 },
          contextHash: anchor,
          selectedHash: anchor,
          context: { before: 1, after: 1, hash: anchor },
        },
      }))
      .mockImplementationOnce(async (_ctx, options) => {
        reopenedOptions = options;
        return { type: "cancel" };
      });
    const pi = { registerCommand: vi.fn(), registerTool: vi.fn((tool) => tools.set(tool.name, tool)), registerShortcut: vi.fn(), on: vi.fn() };
    const ctx = { hasUI: true, cwd: repoRoot, ui: { notify: vi.fn(), setWidget: vi.fn(), setEditorText: vi.fn() } };
    codeDiffExtension(pi as never);

    await tools.get("open_code_diff").execute("tool-call", { args: "" }, new AbortController().signal, vi.fn(), ctx);

    expect(mocks.getReviewWindowData).toHaveBeenCalledTimes(2);
    expect(mocks.runReviewApp).toHaveBeenCalledTimes(2);
    expect(reopenedOptions.files).toEqual([file, addedFile]);
    expect(reopenedOptions.initialSession.state.activeFileId).toBe(file.id);
    expect(reopenedOptions.initialBanner).toContain("Returned from $EDITOR");
  });

  it("rematerializes the local review with a distinct signal-termination banner", async () => {
    const tools = new Map<string, any>();
    const repoRoot = process.cwd();
    const file = localReviewFile();
    const reviewData = { repoRoot, files: [file], branchBaseRevision: null, modifiedRevision: undefined, visibleScopes: ["git-diff" as const] };
    let reopenedOptions: any;
    mocks.getReviewWindowData.mockResolvedValueOnce(reviewData).mockResolvedValueOnce(reviewData);
    mocks.runReviewApp
      .mockResolvedValueOnce({ type: "open-editor", command: "editor", args: [], filePath: `${repoRoot}/src/app.ts`, line: 1 })
      .mockImplementationOnce(async (_ctx, options) => {
        reopenedOptions = options;
        return { type: "cancel" };
      });
    const launchExternalEditor = vi.fn(async () => ({ kind: "signal" as const, signal: "SIGTERM" }));
    const pi = { registerCommand: vi.fn(), registerTool: vi.fn((tool) => tools.set(tool.name, tool)), registerShortcut: vi.fn(), on: vi.fn() };
    const ctx = { hasUI: true, cwd: repoRoot, ui: { notify: vi.fn(), setWidget: vi.fn(), setEditorText: vi.fn() } };
    codeDiffExtension(pi as never, { runExternalEditor: launchExternalEditor });

    await tools.get("open_code_diff").execute("tool-call", { args: "" }, new AbortController().signal, vi.fn(), ctx);

    expect(launchExternalEditor).toHaveBeenCalledWith("editor", [], repoRoot);
    expect(mocks.getReviewWindowData).toHaveBeenCalledTimes(2);
    expect(reopenedOptions.initialBanner).toBe("$EDITOR was terminated by SIGTERM.");
  });

  it("rematerializes the local review with a sanitized spawn-error banner", async () => {
    const tools = new Map<string, any>();
    const repoRoot = process.cwd();
    const file = localReviewFile();
    const reviewData = { repoRoot, files: [file], branchBaseRevision: null, modifiedRevision: undefined, visibleScopes: ["git-diff" as const] };
    let reopenedOptions: any;
    mocks.getReviewWindowData.mockResolvedValueOnce(reviewData).mockResolvedValueOnce(reviewData);
    mocks.runReviewApp
      .mockResolvedValueOnce({ type: "open-editor", command: "editor", args: [], filePath: `${repoRoot}/src/app.ts`, line: 1 })
      .mockImplementationOnce(async (_ctx, options) => {
        reopenedOptions = options;
        return { type: "cancel" };
      });
    const launchExternalEditor = vi.fn(async () => {
      throw new Error("ENOENT\u001b[31m\neditor");
    });
    const pi = { registerCommand: vi.fn(), registerTool: vi.fn((tool) => tools.set(tool.name, tool)), registerShortcut: vi.fn(), on: vi.fn() };
    const ctx = { hasUI: true, cwd: repoRoot, ui: { notify: vi.fn(), setWidget: vi.fn(), setEditorText: vi.fn() } };
    codeDiffExtension(pi as never, { runExternalEditor: launchExternalEditor });

    await tools.get("open_code_diff").execute("tool-call", { args: "" }, new AbortController().signal, vi.fn(), ctx);

    expect(mocks.getReviewWindowData).toHaveBeenCalledTimes(2);
    expect(reopenedOptions.initialBanner).toBe("Could not open $EDITOR: ENOENT\\x1b[31m\\x0aeditor");
  });

  it("reopens the in-memory review instead of promising a DISCUSS handoff after failed persistence", async () => {
    const tools = new Map<string, any>();
    const file = localReviewFile();
    const latest = reviewSessionData({ allComment: "draft that must survive", allIntent: "comment", comments: [] }, file.id, "git-diff");
    const target = { path: "src/app.ts", range: { startLine: 1, endLine: 1 }, anchor: { algorithm: "sha256" as const, value: "a".repeat(64) } };
    const openCode = { type: "open-code" as const, target, resume: {
      version: 2 as const, repository: "/repo", sessionId: "automatic-session", identity: "/repo|working|worktree|local", scope: "git-diff" as const, scopeFingerprint: expect.any(String),
      path: "src/app.ts", side: "added" as const, range: target.range, focus: { pane: "diff" as const, navigatorScroll: 0, diffScroll: 0, commentsScroll: 0 }, contextHash: target.anchor, selectedHash: target.anchor,
      context: { before: 1, after: 1, hash: target.anchor },
    } };
    mocks.getReviewWindowData.mockResolvedValue({ repoRoot: "/repo", files: [file], branchBaseRevision: null, modifiedRevision: undefined, visibleScopes: ["git-diff"] });
    mocks.saveReviewSessionWithStatus.mockReturnValue({ id: "automatic-session", saved: false });
    mocks.runPiWorkbench.mockResolvedValueOnce({ status: "discuss", changedPaths: [], target, note: "why" });
    let reopened: any;
    mocks.runReviewApp
      .mockImplementationOnce(async (_ctx, options) => { options.onSessionChange(latest); return { ...openCode, resume: { ...openCode.resume, scopeFingerprint: options.reviewScopeFingerprint } }; })
      .mockImplementationOnce(async (_ctx, options) => { reopened = options.initialSession; return { type: "cancel" }; });
    const pi = { registerCommand: vi.fn(), registerTool: vi.fn((tool) => tools.set(tool.name, tool)), registerShortcut: vi.fn(), on: vi.fn() };
    const ctx = { hasUI: true, cwd: "/repo", ui: { notify: vi.fn(), setWidget: vi.fn(), setEditorText: vi.fn() } };
    codeDiffExtension(pi as never);

    const result = await tools.get("open_code_diff").execute("tool-call", { args: "" }, new AbortController().signal, vi.fn(), ctx);
    expect(reopened).toEqual(expect.objectContaining({ state: latest.state }));
    expect(result.details).toMatchObject({ started: true, message: "Review cancelled." });
    expect(result.details).not.toHaveProperty("prompt");
  });

  it("stages review-bridge DISCUSS exactly once for direct /diff", async () => {
    const commands = new Map<string, any>();
    const file = {
      id: "src/app.ts::working::::", path: "src/app.ts", worktreeStatus: "modified" as const,
      hasWorkingTreeFile: true, inGitDiff: true, inLastCommit: false, inAllFiles: false,
      gitDiff: { status: "modified" as const, oldPath: "src/app.ts", newPath: "src/app.ts", displayPath: "src/app.ts", hasOriginal: true, hasModified: true },
      lastCommit: null, allFiles: null,
    };
    const target = { path: "src/app.ts", range: { startLine: 1, endLine: 1 }, anchor: { algorithm: "sha256" as const, value: "a".repeat(64) } };
    mocks.getReviewWindowData.mockResolvedValue({ repoRoot: "/repo", files: [file], branchBaseRevision: null, modifiedRevision: undefined, visibleScopes: ["git-diff"] });
    mocks.runReviewApp.mockResolvedValueOnce({
      type: "open-code", target,
      resume: { version: 1, repository: "/repo", sessionId: "automatic-session", identity: "/repo|working|worktree|local", scope: "git-diff", path: "src/app.ts", side: "added", range: target.range, focus: { pane: "diff", navigatorScroll: 0, diffScroll: 0, commentsScroll: 0 }, contextHash: target.anchor },
    });
    mocks.runPiWorkbench.mockResolvedValueOnce({ status: "discuss", changedPaths: [], target });
    const pi = { registerCommand: vi.fn((name, command) => commands.set(name, command)), registerTool: vi.fn(), registerShortcut: vi.fn(), on: vi.fn() };
    const ctx = { hasUI: true, cwd: "/repo", ui: { notify: vi.fn(), setWidget: vi.fn(), setEditorText: vi.fn() } };
    codeDiffExtension(pi as never);

    await commands.get("diff").handler("", ctx);
    await vi.waitFor(() => expect(ctx.ui.setEditorText).toHaveBeenCalledOnce());
    expect(ctx.ui.setEditorText.mock.calls[0]![0].match(/Good to continue the review\?/g)).toHaveLength(1);
  });

  it("rejects stale-only local submission truthfully and keeps the exact full session", async () => {
    const tools = new Map<string, any>();
    const file = localReviewFile();
    const stale = {
      id: "stable-stale-id",
      fileId: file.id,
      scope: "git-diff" as const,
      side: "added" as const,
      intent: "modify" as const,
      startLine: 7,
      endLine: 8,
      body: "\treplacement()  ",
      originalText: "\toriginal()  ",
      captureHash: { algorithm: "sha256" as const, value: "c".repeat(64) },
      anchorStatus: "stale" as const,
    };
    const session = reviewSessionData({ allComment: "", allIntent: "discuss", comments: [stale] }, file.id, "git-diff");
    mocks.getReviewWindowData.mockResolvedValue({ repoRoot: "/repo", files: [file], branchBaseRevision: null, modifiedRevision: undefined, visibleScopes: ["git-diff"] });
    mocks.runReviewApp.mockImplementation(async (_ctx, options) => {
      options.onSessionChange(session);
      return { type: "submit", allComment: "", allIntent: "discuss", comments: [] };
    });
    const pi = { registerCommand: vi.fn(), registerTool: vi.fn((tool) => tools.set(tool.name, tool)), registerShortcut: vi.fn(), on: vi.fn() };
    const ctx = { hasUI: true, cwd: "/repo", ui: { notify: vi.fn(), setWidget: vi.fn(), setEditorText: vi.fn() } };
    codeDiffExtension(pi as never);

    const result = await tools.get("open_code_diff").execute("tool-call", { args: "" }, new AbortController().signal, vi.fn(), ctx);

    expect(result.details).toMatchObject({ started: true, message: expect.stringMatching(/unresolved.*session automatic-session/i) });
    expect(result.details).not.toHaveProperty("prompt");
    expect(mocks.composeReviewPrompt).not.toHaveBeenCalled();
    expect(mocks.deleteReviewSession).not.toHaveBeenCalled();
    expect(mocks.saveReviewSessionWithStatus).toHaveBeenCalledWith(
      "/repo|working|worktree|local",
      session,
      expect.objectContaining({ id: "automatic-session", revision: "worktree" }),
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/unresolved.*remain/i), "warning");
  });

  it("consumes mapped local IDs and the emitted all-note while retaining exact stale fields", async () => {
    const tools = new Map<string, any>();
    const file = localReviewFile();
    const mapped = {
      id: "mapped-all-lines",
      fileId: file.id,
      scope: "git-diff" as const,
      side: "file" as const,
      intent: "comment" as const,
      startLine: null,
      endLine: null,
      body: "Mapped all-lines note",
      fileTarget: "all-lines" as const,
      anchorStatus: "mapped" as const,
    };
    const stale = {
      id: "stable-stale-id",
      fileId: file.id,
      scope: "git-diff" as const,
      side: "deleted" as const,
      intent: "modify" as const,
      startLine: 11,
      endLine: 13,
      body: "\tproposed()  ",
      originalText: "\tbefore()  \r\n  child()",
      captureHash: { algorithm: "sha256" as const, value: "d".repeat(64) },
      anchorStatus: "stale" as const,
    };
    const submitted = { type: "submit" as const, allComment: "Review-wide note", allIntent: "comment" as const, comments: [mapped] };
    const session = reviewSessionData({ allComment: submitted.allComment, allIntent: submitted.allIntent, comments: [mapped, stale] }, file.id, "git-diff");
    mocks.getReviewWindowData.mockResolvedValue({ repoRoot: "/repo", files: [file], branchBaseRevision: null, modifiedRevision: undefined, visibleScopes: ["git-diff"] });
    mocks.composeReviewPrompt.mockReturnValue("generated mapped-only prompt");
    mocks.runReviewApp.mockImplementation(async (_ctx, options) => {
      options.onSessionChange(session);
      return submitted;
    });
    const pi = { registerCommand: vi.fn(), registerTool: vi.fn((tool) => tools.set(tool.name, tool)), registerShortcut: vi.fn(), on: vi.fn() };
    const ctx = { hasUI: true, cwd: "/repo", ui: { notify: vi.fn(), setWidget: vi.fn(), setEditorText: vi.fn() } };
    codeDiffExtension(pi as never);

    const result = await tools.get("open_code_diff").execute("tool-call", { args: "" }, new AbortController().signal, vi.fn(), ctx);

    expect(mocks.composeReviewPrompt).toHaveBeenCalledWith([file], submitted);
    expect(result.details).toMatchObject({ prompt: "generated mapped-only prompt", message: expect.stringMatching(/1 unresolved draft item remains/i) });
    expect(mocks.saveReviewSessionWithStatus).toHaveBeenLastCalledWith(
      "/repo|working|worktree|local",
      expect.objectContaining({
        state: expect.objectContaining({
          draft: { allComment: "", allIntent: "comment", comments: [stale] },
        }),
      }),
      expect.objectContaining({ id: "automatic-session", revision: "worktree" }),
    );
    expect(mocks.deleteReviewSession).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/1 unresolved draft item remains/i), "warning");
  });

  it("keeps the last durable full snapshot when residual-session persistence fails", async () => {
    const tools = new Map<string, any>();
    const file = localReviewFile();
    const mapped = { id: "mapped", fileId: file.id, scope: "git-diff" as const, side: "file" as const, intent: "comment" as const, startLine: null, endLine: null, body: "Mapped", anchorStatus: "mapped" as const };
    const stale = { id: "stale", fileId: file.id, scope: "git-diff" as const, side: "added" as const, intent: "comment" as const, startLine: 4, endLine: 4, body: "Stale", captureHash: { algorithm: "sha256" as const, value: "e".repeat(64) }, anchorStatus: "stale" as const };
    const session = reviewSessionData({ allComment: "", allIntent: "comment", comments: [mapped, stale] }, file.id, "git-diff");
    mocks.getReviewWindowData.mockResolvedValue({ repoRoot: "/repo", files: [file], branchBaseRevision: null, modifiedRevision: undefined, visibleScopes: ["git-diff"] });
    mocks.composeReviewPrompt.mockReturnValue("mapped prompt");
    mocks.saveReviewSessionWithStatus.mockReturnValue({ id: "automatic-session", saved: false });
    mocks.loadReviewSession.mockReturnValue(reviewSessionData({ allComment: "", allIntent: "comment", comments: [] }, file.id, "git-diff"));
    mocks.runReviewApp.mockImplementation(async (_ctx, options) => {
      options.onSessionChange(session);
      return { type: "submit", allComment: "", allIntent: "comment", comments: [mapped] };
    });
    const pi = { registerCommand: vi.fn(), registerTool: vi.fn((tool) => tools.set(tool.name, tool)), registerShortcut: vi.fn(), on: vi.fn() };
    const ctx = { hasUI: true, cwd: "/repo", ui: { notify: vi.fn(), setWidget: vi.fn(), setEditorText: vi.fn() } };
    codeDiffExtension(pi as never);

    await tools.get("open_code_diff").execute("tool-call", { args: "" }, new AbortController().signal, vi.fn(), ctx);

    expect(mocks.saveReviewSessionWithStatus).toHaveBeenLastCalledWith(
      "/repo|working|worktree|local",
      expect.objectContaining({ state: expect.objectContaining({ draft: expect.objectContaining({ comments: [stale] }) }) }),
      expect.objectContaining({ id: "automatic-session", revision: "worktree" }),
    );
    expect(mocks.deleteReviewSession).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/could not save.*previous full snapshot.*submitted items may appear again/i), "warning");
  });

  it("sends 'PR approved' to the agent when a local review is submitted empty", async () => {
    const tools = new Map<string, any>();
    const files = [{
      id: "src/app.ts::working::::",
      path: "src/app.ts",
      worktreeStatus: "modified",
      hasWorkingTreeFile: true,
      inGitDiff: true,
      inLastCommit: false,
      inAllFiles: false,
      gitDiff: { status: "modified", oldPath: "src/app.ts", newPath: "src/app.ts", displayPath: "src/app.ts", hasOriginal: true, hasModified: true },
      lastCommit: null,
      allFiles: null,
    }];
    mocks.getReviewWindowData.mockResolvedValue({ repoRoot: "/repo", files, branchBaseRevision: null, modifiedRevision: undefined, visibleScopes: ["git-diff"] });
    mocks.runReviewApp.mockResolvedValue({ type: "submit", allComment: "", allIntent: "discuss", comments: [] });
    const pi = {
      registerCommand: vi.fn(),
      registerTool: vi.fn((tool) => tools.set(tool.name, tool)),
      registerShortcut: vi.fn(),
      on: vi.fn(),
      sendUserMessage: vi.fn(),
    };
    const ctx = {
      hasUI: true,
      cwd: "/repo",
      isIdle: () => true,
      ui: {
        notify: vi.fn(),
        setWidget: vi.fn(),
        setEditorText: vi.fn(),
      },
    };

    codeDiffExtension(pi as never);
    const result = await tools.get("open_code_diff").execute("tool-call", { args: "" }, new AbortController().signal, vi.fn(), ctx);

    const reviewOptions = mocks.runReviewApp.mock.calls.at(-1)![1];
    expect(reviewOptions.allowEmptySubmit).toBe(true);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(mocks.composeReviewPrompt).not.toHaveBeenCalled();
    expect(ctx.ui.setEditorText).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({ started: true, prompt: "PR approved" });
  });

  it("dispatches exact and fallback submodule reviews through the correct loaders", async () => {
    const tools = new Map<string, any>();
    const rootFiles = [{
      id: "packages/app::working::::",
      path: "packages/app",
      worktreeStatus: "modified",
      hasWorkingTreeFile: true,
      inGitDiff: true,
      inLastCommit: false,
      inAllFiles: false,
      gitDiff: null,
      lastCommit: null,
      allFiles: null,
    }];
    const rootData = { repoRoot: "/repo", files: rootFiles, branchBaseRevision: null, visibleScopes: ["git-diff"] };
    const nestedData = { repoRoot: "/repo/packages/app", files: [], branchBaseRevision: "abc", modifiedRevision: "def", visibleScopes: ["all-files"] };
    mocks.getReviewWindowData.mockResolvedValue(rootData);
    mocks.getReviewWindowDataForRevisionRange.mockResolvedValue(nestedData);
    const pi = {
      registerCommand: vi.fn(),
      registerTool: vi.fn((tool) => tools.set(tool.name, tool)),
      registerShortcut: vi.fn(),
      on: vi.fn(),
    };
    const ctx = {
      hasUI: true,
      cwd: "/repo",
      ui: { notify: vi.fn(), setWidget: vi.fn(), setEditorText: vi.fn() },
    };

    codeDiffExtension(pi as never);
    mocks.runReviewApp.mockImplementationOnce(async (_ctx, options) => {
      await options.loadSubmoduleReviewData({ repoRoot: "/repo/packages/app", path: "packages/app", oldSha: "abc", newSha: "def", available: true });
      return { type: "cancel" };
    });
    await tools.get("open_code_diff").execute("tool-call", { args: "" }, new AbortController().signal, vi.fn(), ctx);
    expect(mocks.getReviewWindowDataForRevisionRange).toHaveBeenCalledWith(pi, "/repo/packages/app", "abc", "def", { wholeRepo: true });

    mocks.runReviewApp.mockImplementationOnce(async (_ctx, options) => {
      await options.loadSubmoduleReviewData({ repoRoot: "/repo/packages/app", path: "packages/app", oldSha: "abc", newSha: "abc", available: true });
      return { type: "cancel" };
    });
    await tools.get("open_code_diff").execute("tool-call", { args: "" }, new AbortController().signal, vi.fn(), ctx);
    expect(mocks.getReviewWindowData).toHaveBeenCalledWith(pi, "/repo/packages/app", { wholeRepo: true });
  });

  it("open_code_diff seeds prepopulated comments and warns about unresolved ones", async () => {
    const tools = new Map<string, any>();
    const files = [{
      id: "src/app.ts::working::::",
      path: "src/app.ts",
      worktreeStatus: "modified",
      hasWorkingTreeFile: true,
      inGitDiff: true,
      inLastCommit: false,
      inAllFiles: false,
      gitDiff: { status: "modified", oldPath: "src/app.ts", newPath: "src/app.ts", displayPath: "src/app.ts", hasOriginal: true, hasModified: true },
      lastCommit: null,
      allFiles: null,
    }];
    mocks.getReviewWindowData.mockResolvedValue({ repoRoot: "/repo", files, branchBaseRevision: null, modifiedRevision: undefined, visibleScopes: ["git-diff"] });
    mocks.runReviewApp.mockResolvedValue({ type: "submit", allComment: "Overall note", allIntent: "discuss", comments: [] });
    mocks.composeReviewPrompt.mockReturnValue("generated review prompt");
    const pi = {
      registerCommand: vi.fn(),
      registerTool: vi.fn((tool) => tools.set(tool.name, tool)),
      registerShortcut: vi.fn(),
      on: vi.fn(),
    };
    const ctx = {
      hasUI: true,
      cwd: "/repo",
      ui: {
        notify: vi.fn(),
        setWidget: vi.fn(),
        setEditorText: vi.fn(),
      },
    };

    codeDiffExtension(pi as never);
    await tools.get("open_code_diff").execute("tool-call", {
      args: "",
      comments: [
        { path: "src/app.ts", body: "Handle the nil case.", line: 3, intent: "comment" },
        { path: "src/missing.ts", body: "Nope", line: 1 },
      ],
    }, new AbortController().signal, vi.fn(), ctx);

    expect(mocks.runReviewApp).toHaveBeenCalledWith(ctx, expect.objectContaining({
      seedComments: [
        { fileId: "src/app.ts::working::::", scope: "git-diff", side: "added", intent: "comment", startLine: 3, endLine: 3, body: "Handle the nil case." },
      ],
    }));
    expect(ctx.ui.notify).toHaveBeenCalledWith("pi-coder: could not place 1 prepopulated comment (src/missing.ts).", "warning");
  });

  it("keeps saved review items when prepopulated findings target the same location", async () => {
    const tools = new Map<string, any>();
    const file = {
      id: "src/app.ts::working::::",
      path: "src/app.ts",
      worktreeStatus: "modified" as const,
      hasWorkingTreeFile: true,
      inGitDiff: true,
      inLastCommit: false,
      inAllFiles: false,
      gitDiff: { status: "modified" as const, oldPath: "src/app.ts", newPath: "src/app.ts", displayPath: "src/app.ts", hasOriginal: true, hasModified: true },
      lastCommit: null,
      allFiles: null,
    };
    const existing = {
      id: "existing",
      fileId: file.id,
      scope: "git-diff" as const,
      side: "added" as const,
      intent: "comment" as const,
      startLine: 3,
      endLine: 3,
      body: "Keep this human comment.",
    };
    mocks.loadReviewSession.mockReturnValue({ ...reviewSessionData({ allComment: "", allIntent: "discuss", comments: [existing] }, file.id, "git-diff"), revision: "worktree", fileSignatures: {} });
    mocks.getReviewWindowData.mockResolvedValue({ repoRoot: "/repo", files: [file], branchBaseRevision: null, modifiedRevision: undefined, visibleScopes: ["git-diff"] });
    mocks.runReviewApp.mockResolvedValue({ type: "cancel" });
    const pi = {
      registerCommand: vi.fn(),
      registerTool: vi.fn((tool) => tools.set(tool.name, tool)),
      registerShortcut: vi.fn(),
      on: vi.fn(),
    };
    const ctx = {
      hasUI: true,
      cwd: "/repo",
      ui: { notify: vi.fn(), setWidget: vi.fn(), setEditorText: vi.fn() },
    };

    codeDiffExtension(pi as never);
    await tools.get("open_code_diff").execute("tool-call", {
      args: "",
      comments: [
        { path: "src/app.ts", body: "Conflicting generated finding.", line: 3 },
        { path: "src/app.ts", body: "New generated finding.", line: 5 },
      ],
    }, new AbortController().signal, vi.fn(), ctx);

    expect(mocks.runReviewApp).toHaveBeenCalledWith(ctx, expect.objectContaining({
      initialSession: expect.objectContaining({ state: expect.objectContaining({ draft: expect.objectContaining({ comments: [{ ...existing, anchorStatus: "stale" }] }) }) }),
      seedComments: [
        { fileId: file.id, scope: "git-diff", side: "added", intent: "comment", startLine: 5, endLine: 5, body: "New generated finding." },
      ],
    }));
    expect(ctx.ui.notify).toHaveBeenCalledWith("pi-coder: kept 1 existing review item; skipped conflicting prepopulated comment.", "warning");
  });

  it("open_code_diff seeds prepopulated comments into the all-files scope for a custom range", async () => {
    const tools = new Map<string, any>();
    const files = [{
      id: "src/app.ts::all::base::head",
      path: "src/app.ts",
      worktreeStatus: "modified",
      hasWorkingTreeFile: true,
      inGitDiff: false,
      inLastCommit: false,
      inAllFiles: true,
      gitDiff: null,
      lastCommit: null,
      allFiles: { status: "modified", oldPath: "src/app.ts", newPath: "src/app.ts", displayPath: "src/app.ts", hasOriginal: true, hasModified: true },
    }];
    mocks.getReviewWindowDataForRevisionRange.mockResolvedValue({ repoRoot: "/repo", files, branchBaseRevision: "base", modifiedRevision: "head", visibleScopes: ["all-files"] });
    mocks.runReviewApp.mockResolvedValue({ type: "submit", allComment: "Overall note", allIntent: "discuss", comments: [] });
    mocks.composeReviewPrompt.mockReturnValue("generated review prompt");
    const pi = {
      registerCommand: vi.fn(),
      registerTool: vi.fn((tool) => tools.set(tool.name, tool)),
      registerShortcut: vi.fn(),
      on: vi.fn(),
    };
    const ctx = {
      hasUI: true,
      cwd: "/repo",
      ui: {
        notify: vi.fn(),
        setWidget: vi.fn(),
        setEditorText: vi.fn(),
      },
    };

    codeDiffExtension(pi as never);
    await tools.get("open_code_diff").execute("tool-call", {
      args: "base..head",
      comments: [{ path: "src/app.ts", body: "Range note.", line: 5 }],
    }, new AbortController().signal, vi.fn(), ctx);

    expect(mocks.getReviewWindowDataForRevisionRange).toHaveBeenCalledWith(pi, "/repo", "base", "head");
    expect(mocks.runReviewApp).toHaveBeenCalledWith(ctx, expect.objectContaining({
      seedComments: [
        { fileId: "src/app.ts::all::base::head", scope: "all-files", side: "added", intent: "comment", startLine: 5, endLine: 5, body: "Range note." },
      ],
    }));

    mocks.getReviewWindowDataForRevisionRange.mockClear();
    await tools.get("open_code_diff").execute("tool-call", { args: "base...head" }, new AbortController().signal, vi.fn(), ctx);
    expect(mocks.getReviewWindowDataForRevisionRange).toHaveBeenCalledWith(pi, "/repo", "base", "head", { mergeBase: true });
  });

  it("does not seed comments when the diff command is invoked", async () => {
    const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
    const files = [{
      id: "src/app.ts::working::::",
      path: "src/app.ts",
      worktreeStatus: "modified",
      hasWorkingTreeFile: true,
      inGitDiff: true,
      inLastCommit: false,
      inAllFiles: false,
      gitDiff: { status: "modified", oldPath: "src/app.ts", newPath: "src/app.ts", displayPath: "src/app.ts", hasOriginal: true, hasModified: true },
      lastCommit: null,
      allFiles: null,
    }];
    mocks.getReviewWindowData.mockResolvedValue({ repoRoot: "/repo", files, branchBaseRevision: null, modifiedRevision: undefined, visibleScopes: ["git-diff"] });
    mocks.runReviewApp.mockResolvedValue({ type: "submit", allComment: "Overall note", allIntent: "discuss", comments: [] });
    mocks.composeReviewPrompt.mockReturnValue("generated review prompt");
    const pi = {
      registerCommand: vi.fn((name: string, command) => commands.set(name, command)),
      registerTool: vi.fn(),
      registerShortcut: vi.fn(),
      on: vi.fn(),
    };
    const ctx = {
      hasUI: true,
      cwd: "/repo",
      ui: {
        notify: vi.fn(),
        setWidget: vi.fn(),
        setEditorText: vi.fn(),
      },
    };

    codeDiffExtension(pi as never);
    await commands.get("diff")!.handler("", ctx);
    await vi.waitFor(() => expect(mocks.runReviewApp).toHaveBeenCalled());

    expect(mocks.runReviewApp).toHaveBeenCalledWith(ctx, expect.objectContaining({ seedComments: [] }));
    await vi.waitFor(() => expect(ctx.ui.setEditorText).toHaveBeenCalledTimes(1));
    expect(ctx.ui.setEditorText).toHaveBeenCalledWith("generated review prompt");
    await vi.waitFor(() => expect(mocks.repositoryStatusRefresh).toHaveBeenCalledWith(ctx));
  });

  it("expands --cwd for the diff command", async () => {
    const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
    const expandedCwd = join(homedir(), "Poetry/rpgmenace");
    const files = [{
      id: "app/admin/dashboard.rb::working::::",
      path: "app/admin/dashboard.rb",
      worktreeStatus: "modified",
      hasWorkingTreeFile: true,
      inGitDiff: true,
      inLastCommit: false,
      inAllFiles: false,
      gitDiff: { status: "modified", oldPath: "app/admin/dashboard.rb", newPath: "app/admin/dashboard.rb", displayPath: "app/admin/dashboard.rb", hasOriginal: true, hasModified: true },
      lastCommit: null,
      allFiles: null,
    }];
    mocks.getReviewWindowData.mockResolvedValue({ repoRoot: expandedCwd, files, branchBaseRevision: null, modifiedRevision: undefined, visibleScopes: ["git-diff"] });
    mocks.runReviewApp.mockResolvedValue({ type: "submit", allComment: "Overall note", allIntent: "discuss", comments: [] });
    mocks.composeReviewPrompt.mockReturnValue("generated review prompt");
    const pi = {
      registerCommand: vi.fn((name: string, command) => commands.set(name, command)),
      registerTool: vi.fn(),
      registerShortcut: vi.fn(),
      on: vi.fn(),
    };
    const ctx = {
      hasUI: true,
      cwd: "/repo",
      ui: {
        notify: vi.fn(),
        setWidget: vi.fn(),
        setEditorText: vi.fn(),
      },
    };

    codeDiffExtension(pi as never);
    await commands.get("diff")!.handler("--cwd ~/Poetry/rpgmenace --include-generated --whole-repo --resume saved-session", ctx);
    await vi.waitFor(() => expect(mocks.getReviewWindowData).toHaveBeenCalledWith(pi, expandedCwd, { includeGenerated: true, wholeRepo: true }));
    expect(mocks.loadReviewSession).toHaveBeenCalledWith(`${expandedCwd}|working|worktree|local`, "saved-session");
    await vi.waitFor(() => expect(mocks.deleteReviewSession).toHaveBeenCalledWith(`${expandedCwd}|working|worktree|local`, "saved-session"));

    mocks.deleteReviewSession.mockClear();
    const discardCommands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
    const discardPi = {
      registerCommand: vi.fn((name: string, command) => discardCommands.set(name, command)),
      registerTool: vi.fn(),
      registerShortcut: vi.fn(),
      on: vi.fn(),
    };
    codeDiffExtension(discardPi as never);
    await discardCommands.get("diff")!.handler("--cwd ~/Poetry/rpgmenace --discard-resume", ctx);
    await vi.waitFor(() => expect(mocks.deleteReviewSession).toHaveBeenCalledWith(`${expandedCwd}|working|worktree|local`, "automatic-session"));
  });

  it("treats a bare existing local directory as the diff cwd", async () => {
    const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
    const localRepo = await mkdtemp(join(tmpdir(), "pi-code-diff-local-"));
    const files = [{
      id: "src/app.ts::working::::",
      path: "src/app.ts",
      worktreeStatus: "modified",
      hasWorkingTreeFile: true,
      inGitDiff: true,
      inLastCommit: false,
      inAllFiles: false,
      gitDiff: { status: "modified", oldPath: "src/app.ts", newPath: "src/app.ts", displayPath: "src/app.ts", hasOriginal: true, hasModified: true },
      lastCommit: null,
      allFiles: null,
    }];
    mocks.getReviewWindowData.mockResolvedValue({ repoRoot: localRepo, files, branchBaseRevision: null, modifiedRevision: undefined, visibleScopes: ["git-diff"] });
    mocks.runReviewApp.mockResolvedValue({ type: "submit", allComment: "Overall note", allIntent: "discuss", comments: [] });
    mocks.composeReviewPrompt.mockReturnValue("generated review prompt");
    const pi = {
      registerCommand: vi.fn((name: string, command) => commands.set(name, command)),
      registerTool: vi.fn(),
      registerShortcut: vi.fn(),
      on: vi.fn(),
    };
    const ctx = {
      hasUI: true,
      cwd: "/repo",
      ui: {
        notify: vi.fn(),
        setWidget: vi.fn(),
        setEditorText: vi.fn(),
      },
    };

    codeDiffExtension(pi as never);
    await commands.get("diff")!.handler(localRepo, ctx);
    await vi.waitFor(() => expect(mocks.getReviewWindowData).toHaveBeenCalledWith(pi, localRepo));
    expect(mocks.getReviewWindowDataForRevisionRange).not.toHaveBeenCalled();
  });

  it("leases pending shortcut discovery against slash and tool overlap, then releases after success", async () => {
    const commands = new Map<string, any>();
    const tools = new Map<string, any>();
    let shortcut: { handler: (ctx: any) => Promise<void> } | undefined;
    const discovery = deferred<any>();
    mocks.getReviewWindowData.mockReturnValue(discovery.promise);
    const pi = {
      registerCommand: vi.fn((name: string, command) => commands.set(name, command)),
      registerTool: vi.fn((tool) => tools.set(tool.name, tool)),
      registerShortcut: vi.fn((_key: string, registered) => { shortcut = registered; }),
      on: vi.fn(),
    };
    const ctx = {
      hasUI: true,
      cwd: "/repo",
      ui: { notify: vi.fn(), setWidget: vi.fn(), setEditorText: vi.fn() },
    };

    codeDiffExtension(pi as never);
    const shortcutRun = shortcut!.handler(ctx);
    await commands.get("diff").handler("", ctx);
    const blockedTool = await tools.get("open_code_diff").execute(
      "blocked-tool",
      { args: "" },
      new AbortController().signal,
      vi.fn(),
      ctx,
    );

    expect(mocks.getReviewWindowData).toHaveBeenCalledTimes(1);
    expect(blockedTool.details).toMatchObject({ started: false, message: "A review session is already open." });
    expect(mocks.repositoryStatusRefresh).not.toHaveBeenCalled();

    discovery.resolve({ repoRoot: "/repo", files: [], branchBaseRevision: null, modifiedRevision: undefined, visibleScopes: ["git-diff"] });
    await shortcutRun;

    expect(mocks.repositoryStatusRefresh).toHaveBeenCalledTimes(1);
    expect(mocks.repositoryStatusRefresh).toHaveBeenLastCalledWith(ctx);

    mocks.getReviewWindowData.mockResolvedValueOnce({ repoRoot: "/repo", files: [], branchBaseRevision: null, modifiedRevision: undefined, visibleScopes: ["git-diff"] });
    const releasedTool = await tools.get("open_code_diff").execute(
      "released-tool",
      { args: "" },
      new AbortController().signal,
      vi.fn(),
      ctx,
    );

    expect(releasedTool.details).toMatchObject({ started: false, message: "No reviewable files found for this diff." });
    expect(mocks.getReviewWindowData).toHaveBeenCalledTimes(2);
    expect(mocks.repositoryStatusRefresh).toHaveBeenCalledTimes(2);
  });

  it("returns /diff immediately, leases out shortcut and tool discovery, and releases after rejection", async () => {
    const commands = new Map<string, any>();
    const tools = new Map<string, any>();
    let shortcut: { handler: (ctx: any) => Promise<void> } | undefined;
    const discovery = deferred<any>();
    const refreshAfterRejection = deferred<void>();
    mocks.getReviewWindowData.mockReturnValue(discovery.promise);
    mocks.repositoryStatusRefresh.mockImplementationOnce(async () => { refreshAfterRejection.resolve(); });
    const pi = {
      registerCommand: vi.fn((name: string, command) => commands.set(name, command)),
      registerTool: vi.fn((tool) => tools.set(tool.name, tool)),
      registerShortcut: vi.fn((_key: string, registered) => { shortcut = registered; }),
      on: vi.fn(),
    };
    const ctx = {
      hasUI: true,
      cwd: "/repo",
      ui: { notify: vi.fn(), setWidget: vi.fn(), setEditorText: vi.fn() },
    };

    codeDiffExtension(pi as never);
    await expect(commands.get("diff").handler("", ctx)).resolves.toBeUndefined();
    expect(mocks.getReviewWindowData).toHaveBeenCalledTimes(1);
    expect(mocks.repositoryStatusRefresh).not.toHaveBeenCalled();

    const blockedShortcut = shortcut!.handler(ctx);
    const blockedTool = await tools.get("open_code_diff").execute(
      "blocked-tool",
      { args: "" },
      new AbortController().signal,
      vi.fn(),
      ctx,
    );
    expect(mocks.getReviewWindowData).toHaveBeenCalledTimes(1);
    await expect(blockedShortcut).resolves.toBeUndefined();
    expect(blockedTool.details).toMatchObject({ started: false, message: "A review session is already open." });

    discovery.reject(new Error("discovery failed"));
    await refreshAfterRejection.promise;
    expect(ctx.ui.notify).toHaveBeenCalledWith("Could not start review: discovery failed", "error");
    expect(mocks.repositoryStatusRefresh).toHaveBeenCalledTimes(1);

    mocks.getReviewWindowData.mockResolvedValueOnce({ repoRoot: "/repo", files: [], branchBaseRevision: null, modifiedRevision: undefined, visibleScopes: ["git-diff"] });
    const releasedTool = await tools.get("open_code_diff").execute(
      "released-tool",
      { args: "" },
      new AbortController().signal,
      vi.fn(),
      ctx,
    );
    expect(releasedTool.details).toMatchObject({ started: false, message: "No reviewable files found for this diff." });
    expect(mocks.getReviewWindowData).toHaveBeenCalledTimes(2);
    expect(mocks.repositoryStatusRefresh).toHaveBeenCalledTimes(2);
  });

  it("shows progressive local loading without blocking and clears it when data settles", async () => {
    vi.useFakeTimers();
    try {
      const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
      let resolveData: (data: unknown) => void = () => {};
      mocks.getReviewWindowData.mockReturnValue(new Promise((resolve) => { resolveData = resolve; }));
      const pi = {
        registerCommand: vi.fn((name: string, command) => commands.set(name, command)),
        registerTool: vi.fn(),
        registerShortcut: vi.fn(),
        on: vi.fn(),
      };
      const ctx = {
        hasUI: true,
        cwd: "/repo",
        ui: {
          notify: vi.fn(),
          setWidget: vi.fn(),
          setEditorText: vi.fn(),
        },
      };
      const renderedProgress = () => {
        const factory = ctx.ui.setWidget.mock.calls.at(-1)?.[1];
        expect(factory).toEqual(expect.any(Function));
        const component = factory({ requestRender: vi.fn() }, { fg: (_color: string, text: string) => text });
        const text = component.render(100).join("\n");
        component.dispose?.();
        return text;
      };

      codeDiffExtension(pi as never);
      await expect(commands.get("diff")!.handler("", ctx)).resolves.toBeUndefined();

      expect(ctx.ui.setWidget).toHaveBeenCalledTimes(1);
      expect(renderedProgress()).toContain("Loading local changes…");

      await vi.advanceTimersByTimeAsync(4_999);
      expect(ctx.ui.setWidget).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(ctx.ui.setWidget).toHaveBeenCalledTimes(2);
      expect(renderedProgress()).toContain("Still loading local changes… Large repositories can take a little longer.");

      resolveData({ repoRoot: "/repo", files: [], branchBaseRevision: "main", modifiedRevision: "HEAD" });
      await vi.advanceTimersByTimeAsync(0);
      expect(ctx.ui.setWidget).toHaveBeenLastCalledWith("pi-code-diff-local", undefined);
      expect(ctx.ui.notify).toHaveBeenCalledWith("No reviewable files found for this diff.", "info");
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears pending local loading on session shutdown", async () => {
    vi.useFakeTimers();
    try {
      const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
      const handlers = new Map<string, (event: any, ctx: any) => Promise<void> | void>();
      mocks.getReviewWindowData.mockReturnValue(new Promise(() => {}));
      const pi = {
        registerCommand: vi.fn((name: string, command) => commands.set(name, command)),
        registerTool: vi.fn(),
        registerShortcut: vi.fn(),
        on: vi.fn((event: string, handler) => handlers.set(event, handler)),
      };
      const ctx = {
        hasUI: true,
        cwd: "/repo",
        ui: {
          notify: vi.fn(),
          setWidget: vi.fn(),
          setStatus: vi.fn(),
          setEditorText: vi.fn(),
        },
      };

      codeDiffExtension(pi as never);
      await commands.get("diff")!.handler("", ctx);
      expect(ctx.ui.setWidget).toHaveBeenCalledTimes(1);

      await handlers.get("session_shutdown")!({ reason: "quit" }, ctx);
      expect(ctx.ui.setWidget).toHaveBeenLastCalledWith("pi-code-diff-local", undefined);
      const callsAfterShutdown = ctx.ui.setWidget.mock.calls.length;

      await vi.advanceTimersByTimeAsync(5_000);
      expect(ctx.ui.setWidget).toHaveBeenCalledTimes(callsAfterShutdown);
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces initial shortcut config warnings on startup and reload", async () => {
    const handlers = new Map<string, (event: any, ctx: any) => Promise<void>>();
    const pi = {
      registerCommand: vi.fn(),
      registerTool: vi.fn(),
      registerShortcut: vi.fn(),
      on: vi.fn((event: string, handler) => handlers.set(event, handler)),
    };
    const ctx = { hasUI: true, cwd: "/repo", ui: { notify: vi.fn(), setStatus: vi.fn(), setFooter: vi.fn() } };

    codeDiffExtension(pi as never);

    await handlers.get("session_start")?.({ reason: "startup" }, ctx);
    await handlers.get("session_start")?.({ reason: "reload" }, ctx);

    expect(ctx.ui.notify).toHaveBeenCalledTimes(2);
    expect(ctx.ui.notify).toHaveBeenNthCalledWith(1, "pi-coder config: bad shortcut config", "warning");
    expect(ctx.ui.notify).toHaveBeenNthCalledWith(2, "pi-coder config: bad shortcut config", "warning");
  });

  it("forwards validated pull request metadata to the remote resolver and rejects malformed or non-remote handoffs", async () => {
    const tools = new Map<string, any>();
    const files = [{
      id: "src/app.ts::all::base::head",
      path: "src/app.ts",
      worktreeStatus: "modified",
      hasWorkingTreeFile: true,
      inGitDiff: false,
      inLastCommit: false,
      inAllFiles: true,
      gitDiff: null,
      lastCommit: null,
      allFiles: { status: "modified", oldPath: "src/app.ts", newPath: "src/app.ts", displayPath: "src/app.ts", hasOriginal: true, hasModified: true },
    }];
    const pullRequest = {
      provider: "github",
      repo: "example/widgets",
      number: "1",
      url: "https://github.com/example/widgets/pull/1",
      title: "Add review mode",
      authorLogin: "alice",
      state: "OPEN",
      baseRefName: "main",
      headRefName: "feature/review",
      headRefOid: "a".repeat(40),
      additions: 1,
      deletions: 0,
      changedFiles: 1,
      queue: { position: 2, total: 4 },
    };
    mocks.resolveRemoteReviewTarget.mockResolvedValue(remoteTarget());
    mocks.getReviewWindowDataForRevisionRange.mockResolvedValue({ repoRoot: "/repo", files, branchBaseRevision: "origin/main", modifiedRevision: "origin/pr/1/head", visibleScopes: ["all-files"] });
    mocks.runReviewApp.mockResolvedValue({ type: "cancel" });
    const pi = {
      registerCommand: vi.fn(),
      registerTool: vi.fn((tool) => tools.set(tool.name, tool)),
      registerShortcut: vi.fn(),
      on: vi.fn(),
    };
    const ctx = {
      hasUI: true,
      cwd: "/repo",
      ui: { notify: vi.fn(), setWidget: vi.fn(), setEditorText: vi.fn() },
    };

    codeDiffExtension(pi as never);
    const signal = new AbortController().signal;
    await tools.get("open_code_diff").execute("tool-call", {
      args: "remote https://github.com/example/widgets/pull/1",
      pullRequest,
    }, signal, vi.fn(), ctx);

    expect(mocks.resolveRemoteReviewTarget).toHaveBeenCalledWith(
      pi,
      "/repo",
      "https://github.com/example/widgets/pull/1",
      undefined,
      expect.any(Function),
      expect.objectContaining({ provider: "github", number: "1", headRefOid: "a".repeat(40), queue: { position: 2, total: 4 } }),
    );

    mocks.resolveRemoteReviewTarget.mockClear();
    const malformed = await tools.get("open_code_diff").execute("tool-call", {
      args: "remote https://github.com/example/widgets/pull/1",
      pullRequest: { ...pullRequest, headRefOid: "abc123" },
    }, signal, vi.fn(), ctx);
    expect(malformed.details).toMatchObject({ started: false, message: "Invalid pull request handoff: headRefOid must be a full commit SHA." });
    expect(mocks.resolveRemoteReviewTarget).not.toHaveBeenCalled();

    const nonRemote = await tools.get("open_code_diff").execute("tool-call", { args: "", pullRequest }, signal, vi.fn(), ctx);
    expect(nonRemote.details).toMatchObject({ started: false, message: "Supplied pull request metadata requires a remote review target, for example: remote <url>." });
    expect(mocks.resolveRemoteReviewTarget).not.toHaveBeenCalled();
  });

  function remoteReviewHarness(headRefOid: string) {
    const tools = new Map<string, any>();
    const file = remoteReviewFile();
    const target = remoteTarget();
    mocks.resolveRemoteReviewTarget.mockResolvedValue({ ...target, pullRequest: { ...target.pullRequest, headRefOid } });
    mocks.getReviewWindowDataForRevisionRange.mockResolvedValue({
      repoRoot: "/repo",
      files: [file],
      branchBaseRevision: "origin/main",
      modifiedRevision: "origin/pr/1/head",
      visibleScopes: ["all-files"],
    });
    const pi = {
      registerCommand: vi.fn(),
      registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
      registerShortcut: vi.fn(),
      on: vi.fn(),
    };
    const ctx = {
      hasUI: true,
      cwd: "/repo",
      ui: { notify: vi.fn(), setWidget: vi.fn(), setEditorText: vi.fn(), select: vi.fn(), editor: vi.fn() },
    };
    codeDiffExtension(pi as never);
    return { tools, ctx, file };
  }

  it("keeps the remote session identity stable when the head moves and re-anchors the parked draft", async () => {
    const parked = { ...reviewSessionData({ allComment: "", allIntent: "discuss", comments: [] }), revision: "abc123", fileSignatures: {}, identity: "pr|github|example/widgets|1", id: "automatic-session" };
    mocks.loadReviewSession.mockReturnValue(parked);
    mocks.buildReviewFileSignatures.mockReturnValue({ "src/app.ts": "modified:src/app.ts:1:0" });
    mocks.runReviewApp.mockResolvedValue({ type: "cancel", disposition: "park" });

    const { tools, ctx } = remoteReviewHarness("def456");
    await tools.get("open_code_diff").execute("tool-call", { args: "remote example/widgets#1" }, new AbortController().signal, vi.fn(), ctx);

    expect(mocks.createReviewSessionId).toHaveBeenCalledWith("pr|github|example/widgets|1");
    expect(mocks.rebaseReviewSession).toHaveBeenCalledWith(parked, expect.any(Array), ["all-files"], { "src/app.ts": "modified:src/app.ts:1:0" });
    expect(mocks.deleteReviewSession).not.toHaveBeenCalled();
    expect(mocks.saveReviewSessionWithStatus).toHaveBeenLastCalledWith(
      "pr|github|example/widgets|1",
      expect.anything(),
      expect.objectContaining({ id: "automatic-session", revision: "def456", fileSignatures: { "src/app.ts": "modified:src/app.ts:1:0" } }),
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith("Review parked. Resume with /diff remote example/widgets#1.", "info");
  });

  it("deletes the saved session only when the reviewer explicitly discards", async () => {
    mocks.runReviewApp.mockResolvedValue({ type: "cancel", disposition: "discard" });

    const { tools, ctx } = remoteReviewHarness("abc123");
    await tools.get("open_code_diff").execute("tool-call", { args: "remote example/widgets#1" }, new AbortController().signal, vi.fn(), ctx);

    expect(mocks.deleteReviewSession).toHaveBeenCalledWith("pr|github|example/widgets|1", "automatic-session");
  });

  it("puts the last verdict first and offers one empty-body fast path", () => {
    expect(buildReviewEndActions(null).choices).toEqual(["Approve", "Request changes", "Post Comments"]);
    expect(buildReviewEndActions("comment").choices).toEqual([
      "Post Comments",
      "Post Comments without a body",
      "Approve",
      "Request changes",
    ]);
    expect(buildReviewEndActions("approve").actions.get("Approve without a body")).toEqual({ verdict: "approve", skipBody: true });
    expect(buildReviewEndActions("approve").actions.get("Approve")).toEqual({ verdict: "approve", skipBody: false });
  });

  it("skips the body editor on the fast path and offers the queued next pull request", async () => {
    writeFileSync(preferencesPath, JSON.stringify({ lastReviewVerdict: "approve" }), "utf8");
    const tools = new Map<string, any>();
    const file = remoteReviewFile();
    mocks.resolveRemoteReviewTarget.mockImplementation(async (...args: any[]) => ({ ...remoteTarget(), handoff: args[5] }));
    mocks.getReviewWindowDataForRevisionRange.mockResolvedValue({
      repoRoot: "/repo",
      files: [file],
      branchBaseRevision: "origin/main",
      modifiedRevision: "origin/pr/1/head",
      visibleScopes: ["all-files"],
    });
    mocks.runReviewApp.mockResolvedValue({
      type: "submit",
      allComment: "Existing review-wide note",
      allIntent: "comment",
      comments: [],
    });
    let prSelectCount = 0;
    const pi = {
      registerCommand: vi.fn(),
      registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
      registerShortcut: vi.fn(),
      on: vi.fn(),
      sendUserMessage: vi.fn(),
    };
    const ctx = {
      hasUI: true,
      cwd: "/repo",
      model: { id: "test-model" },
      modelRegistry: {},
      isIdle: vi.fn(() => true),
      ui: {
        notify: vi.fn(),
        setWidget: vi.fn(),
        setEditorText: vi.fn(),
        setStatus: vi.fn(),
        select: vi.fn(async (title: string) => {
          if (title.startsWith("Next queued review")) return "Review it now";
          prSelectCount += 1;
          return prSelectCount === 1 ? "Approve without a body" : undefined;
        }),
        editor: vi.fn(),
      },
    };

    codeDiffExtension(pi as never);
    await tools.get("open_code_diff").execute("tool-call", {
      args: "remote https://github.com/example/widgets/pull/1",
      pullRequest: {
        provider: "github",
        repo: "example/widgets",
        number: "1",
        url: "https://github.com/example/widgets/pull/1",
        title: "Add review mode",
        authorLogin: "alice",
        state: "OPEN",
        baseRefName: "main",
        headRefName: "feature/review",
        headRefOid: "a".repeat(40),
        additions: 1,
        deletions: 0,
        changedFiles: 1,
        nextCandidate: { url: "https://github.com/example/widgets/pull/2", title: "Follow-up fix" },
      },
    }, new AbortController().signal, vi.fn(), ctx);

    expect(ctx.ui.select).toHaveBeenCalledWith("PR #1: Add review mode", [
      "Approve",
      "Approve without a body",
      "Request changes",
      "Post Comments",
    ]);
    expect(ctx.ui.editor).not.toHaveBeenCalled();
    expect(mocks.submitPullRequestReview).toHaveBeenCalledWith(pi, expect.objectContaining({
      verdict: "approve",
      body: "Existing review-wide note",
    }));
    expect(ctx.ui.select).toHaveBeenCalledWith("Next queued review: Follow-up fix (https://github.com/example/widgets/pull/2)", ["Review it now", "Not now"]);
    expect(mocks.resolveRemoteReviewTarget).toHaveBeenCalledWith(
      pi,
      "/repo",
      "https://github.com/example/widgets/pull/2",
      undefined,
      expect.any(Function),
      undefined,
    );
  });

  it("keeps the review result when the queued next pull request is declined", async () => {
    const tools = new Map<string, any>();
    mocks.resolveRemoteReviewTarget.mockImplementation(async (...args: any[]) => ({ ...remoteTarget(), handoff: args[5] }));
    mocks.getReviewWindowDataForRevisionRange.mockResolvedValue({
      repoRoot: "/repo",
      files: [remoteReviewFile()],
      branchBaseRevision: "origin/main",
      modifiedRevision: "origin/pr/1/head",
      visibleScopes: ["all-files"],
    });
    mocks.runReviewApp.mockResolvedValue({ type: "submit", allComment: "Looks good", allIntent: "comment", comments: [] });
    const pi = {
      registerCommand: vi.fn(),
      registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
      registerShortcut: vi.fn(),
      on: vi.fn(),
      sendUserMessage: vi.fn(),
    };
    const ctx = {
      hasUI: true,
      cwd: "/repo",
      model: { id: "test-model" },
      modelRegistry: {},
      isIdle: vi.fn(() => true),
      ui: {
        notify: vi.fn(),
        setWidget: vi.fn(),
        setEditorText: vi.fn(),
        setStatus: vi.fn(),
        select: vi.fn(async (title: string) => (title.startsWith("Next queued review") ? "Not now" : "Post Comments")),
        editor: vi.fn(async () => ""),
      },
    };

    codeDiffExtension(pi as never);
    const result: any = await tools.get("open_code_diff").execute("tool-call", {
      args: "remote https://github.com/example/widgets/pull/1",
      pullRequest: {
        provider: "github",
        repo: "example/widgets",
        number: "1",
        url: "https://github.com/example/widgets/pull/1",
        title: "Add review mode",
        authorLogin: "alice",
        state: "OPEN",
        baseRefName: "main",
        headRefName: "feature/review",
        headRefOid: "a".repeat(40),
        additions: 1,
        deletions: 0,
        changedFiles: 1,
        nextCandidate: { url: "https://github.com/example/widgets/pull/2" },
      },
    }, new AbortController().signal, vi.fn(), ctx);

    expect(mocks.submitPullRequestReview).toHaveBeenCalledTimes(1);
    expect(mocks.resolveRemoteReviewTarget).toHaveBeenCalledTimes(1);
    expect(result.details).toMatchObject({ started: true, submitted: true });
  });

  it("offers a resume picker for a bare --resume and reopens the chosen parked review", async () => {
    const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
    mocks.listReviewSessions.mockReturnValue([{
      id: "parked-session",
      identity: "pr|github|example/widgets|1",
      updatedAt: "2025-01-02T03:04:05.000Z",
      revision: "abc123",
      commentCount: 3,
      reviewedCount: 1,
      kind: "remote",
      label: "example/widgets#1 Add review mode",
      url: "https://github.com/example/widgets/pull/1",
      resumeArgs: "remote example/widgets#1",
      cwd: "/repo",
    }]);
    mocks.getReviewWindowDataForRevisionRange.mockResolvedValue({
      repoRoot: "/repo",
      files: [remoteReviewFile()],
      branchBaseRevision: "origin/main",
      modifiedRevision: "origin/pr/1/head",
      visibleScopes: ["all-files"],
    });
    mocks.runReviewApp.mockResolvedValue({ type: "cancel", disposition: "park" });
    const pi = {
      registerCommand: vi.fn((name: string, command: any) => commands.set(name, command)),
      registerTool: vi.fn(),
      registerShortcut: vi.fn(),
      on: vi.fn(),
    };
    const choice = "example/widgets#1 Add review mode · 3 comments · 1 reviewed · 2025-01-02 03:04";
    const ctx = {
      hasUI: true,
      cwd: "/repo",
      ui: { notify: vi.fn(), setWidget: vi.fn(), setEditorText: vi.fn(), select: vi.fn(async () => choice), editor: vi.fn() },
    };

    codeDiffExtension(pi as never);
    await commands.get("diff")!.handler("--resume", ctx);

    await vi.waitFor(() => expect(ctx.ui.select).toHaveBeenCalledWith("Resume a parked review", [choice]));
    await vi.waitFor(() => expect(mocks.resolveRemoteReviewTarget).toHaveBeenCalledWith(pi, "/repo", "example/widgets#1", "/repo", expect.any(Function), undefined));
    await vi.waitFor(() => expect(mocks.loadReviewSession).toHaveBeenCalledWith("pr|github|example/widgets|1", "parked-session"));
  });
});
