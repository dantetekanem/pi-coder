import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRemotePullRequestSources, createRemotePullRequestSummarySource } from "../pr-summary.js";
import { createRemoteReviewRepliesSource } from "../review-replies.js";
import type { RemoteReviewTarget } from "../remote.js";

const originalSettingsPath = process.env.PI_CODE_DIFF_SETTINGS_PATH;
let directory: string;
let settingsPath: string;

function provider(id: string, label: string, executable: string, separate: boolean, graphql: boolean) {
  return {
    label,
    executable,
    urls: {
      patterns: [{ host: `${id}.code.example`, path: "/{repo}/change/{number}" }],
      canonical: `https://${id}.code.example/{repo}/change/{number}`,
    },
    operations: {
      identity: { args: ["identity"] },
      pullRequestDetails: { args: ["change", "show", "{repo}", "{number}"] },
      pullRequestComments: { args: ["conversation", "{repo}", "{number}"] },
      pullRequestReviews: { args: ["decisions", "{repo}", "{number}"] },
      reviewThreads: { args: ["query", "--owner", "{owner}", "--name", "{name}", "--number", "{number}", "--document", "{query}"] },
      reviewComments: { args: ["threads", "{repo}", "{number}"] },
    },
    refs: {},
    fields: {
      identityLogin: "actor.name",
      pullRequestUrl: "webUrl",
      pullRequestDraft: "draft",
      pullRequestMergeState: "mergeState",
      pullRequestReviewDecision: "decision",
      pullRequestChangesRequested: "changeRequested",
      pullRequestApproved: "approved",
      pullRequestComments: "conversation",
      pullRequestReviews: "decisions",
      pullRequestReviewComments: "threads",
      pullRequestChecks: "checks",
      pullRequestCreatedAt: "created",
      pullRequestUpdatedAt: "updated",
      commentId: "id",
      commentThreadId: "threadId",
      commentReplyToId: "replyTo",
      commentAuthor: "author.name",
      commentBody: "text",
      commentCreatedAt: "created",
      commentSubmittedAt: "submitted",
      commentState: "state",
      commentUrl: "webUrl",
      commentPath: "file",
      commentLine: "line",
      commentResolved: "resolved",
      commentOutdated: "outdated",
      checkName: "name",
      checkWorkflowName: "group",
      checkStatus: "status",
      checkConclusion: "result",
    },
    capabilities: {
      separatePullRequestContext: separate,
      graphqlReviewThreads: graphql,
      pullRequestChecks: !separate,
    },
  };
}

function settings() {
  return {
    version: 1,
    providers: {
      primary: provider("primary", "Primary code host", "cli-one", false, true),
      secondary: provider("secondary", "Secondary code host", "cli-two", true, false),
    },
    repositories: {},
  };
}

function target(providerId = "primary", pullRequest: Partial<NonNullable<RemoteReviewTarget["pullRequest"]>> = {}): RemoteReviewTarget {
  return {
    gitRoot: "/repo",
    baseRef: "origin/main",
    headRef: "origin/feature",
    remote: `https://${providerId}.code.example/example/widgets/change/12`,
    branch: "feature",
    provider: providerId as never,
    repo: "example/widgets",
    pullRequest: {
      number: "12",
      repo: "example/widgets",
      title: "Remove old checkout path",
      body: "### Intent\nRemove the old path.\n\n### Tested\nUnit tests pass.",
      additions: 3,
      deletions: 9,
      changedFiles: 2,
      authorLogin: "alice",
      state: "OPEN",
      reviews: [],
      headRefName: "feature",
      headRefOid: "abc123",
      baseRefName: "main",
      ...pullRequest,
    },
  };
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "pr-summary-settings-"));
  settingsPath = join(directory, "settings.json");
  process.env.PI_CODE_DIFF_SETTINGS_PATH = settingsPath;
  writeFileSync(settingsPath, JSON.stringify(settings()), "utf8");
});

afterEach(() => {
  if (originalSettingsPath == null) delete process.env.PI_CODE_DIFF_SETTINGS_PATH;
  else process.env.PI_CODE_DIFF_SETTINGS_PATH = originalSettingsPath;
  rmSync(directory, { recursive: true, force: true });
});

describe("remote pull request summary source", () => {
  it.each([
    [{ isDraft: true }, "Status:\nblocked - draft PR"],
    [{ mergeStateStatus: "DIRTY" }, "Status:\nblocked - merge state dirty"],
    [{ reviewDecision: "APPROVED" }, "Status:\napproved - review decision approved"],
    [{ url: "https://github.com/example/renamed/pull/12" }, "URL:\nhttps://github.com/example/renamed/pull/12"],
    [{ statusCheckRollup: [{ name: "build", status: "COMPLETED", conclusion: "FAILURE" }] }, "Validation:\nFailing: build"],
    [{ statusCheckRollup: [{ name: "unit", status: "IN_PROGRESS" }] }, "Validation:\nPending: unit"],
    [{ comments: [
      { author: { login: "bob" }, body: "First comment", createdAt: "2026-06-25T10:00:00Z" },
      { author: { login: "carol" }, body: "Latest comment", createdAt: "2026-06-25T11:00:00Z" },
    ] }, "Open comments:\ncarol: Latest comment; bob: First comment"],
    [{ reviews: [{ author: { login: "bob" }, state: "CHANGES_REQUESTED", body: "Keep compatibility" }] }, "Open comments:\nbob changes requested: Keep compatibility"],
  ])("loads built-in GitHub context without provider configuration: %j", async (details, expected) => {
    rmSync(settingsPath);
    const exec = vi.fn(async (command: string, args: string[]) => {
      if (command === "gh" && args[0] === "pr") {
        expect(args.slice(0, 6)).toEqual(["pr", "view", "12", "--repo", "example/widgets", "--json"]);
        const requestedFields = args[6]!.split(",");
        const payload = Object.fromEntries(Object.entries(details).filter(([field]) => requestedFields.includes(field)));
        return { code: 0, stdout: JSON.stringify(payload), stderr: "", killed: false };
      }
      if (command === "gh" && args[1] === "graphql") {
        return { code: 0, stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } } } }), stderr: "", killed: false };
      }
      return { code: 1, stdout: "", stderr: "model unavailable", killed: false };
    });

    const summary = await createRemotePullRequestSummarySource({ exec } as never, {} as never, target("github"))!.load();

    expect(summary).toContain(expected);
  });

  it.each([false, undefined])("uses configured details and reported thread resolution: %s", async (resolved) => {
    const exec = vi.fn(async (command: string, args: string[]) => {
      if (command === "cli-one" && args[0] === "change") {
        return {
          code: 0,
          stdout: JSON.stringify({
            webUrl: "https://primary.code.example/example/widgets/change/12",
            draft: false,
            mergeState: "clean",
            decision: "APPROVED",
            conversation: [{ author: { name: "bob" }, text: "Looks good.", created: "2026-06-25T10:00:00Z" }],
            decisions: [{ author: { name: "bob" }, state: "APPROVED", text: "Passed verification.", submitted: "2026-06-25T10:01:00Z" }],
            checks: [{ name: "unit", status: "COMPLETED", result: "SUCCESS" }],
          }),
          stderr: "",
          killed: false,
        };
      }
      if (command === "cli-one" && args[0] === "query") {
        expect(args.join(" ")).toContain("reviewThreads");
        return {
          code: 0,
          stdout: JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    nodes: [{
                      id: "thread-1",
                      isResolved: resolved,
                      isOutdated: false,
                      path: "src/app.ts",
                      line: 42,
                      comments: { nodes: [{ id: "comment-1", author: { login: "carol" }, body: "Can compatibility remain?", createdAt: "2026-06-25T10:02:00Z" }] },
                    }],
                  },
                },
              },
            },
          }),
          stderr: "",
          killed: false,
        };
      }
      if (command === "pi") {
        expect(args).toContain("--no-tools");
        expect(args).toContain("--no-session");
        expect(args.join("\n")).toContain("Can compatibility remain?");
        return {
          code: 0,
          stdout: "Title: Remove old checkout path\\x0aURL: stale\\x0aAuthor: stale\\x0aStatus: pending — open review comments\\x0aProblem: Remove the old path.\nChanges: Deletes old code.\nValidation: Unit tests pass.\nOpen comments: carol asked about compatibility.",
          stderr: "",
          killed: false,
        };
      }
      return { code: 1, stdout: "", stderr: `unexpected ${command}`, killed: false };
    });

    const source = createRemotePullRequestSummarySource({ exec } as never, { model: { provider: "model-vendor", id: "model-one" } } as never, target())!;
    const summary = await source.load();

    expect(source.title).toBe("Primary code host PR context");
    expect(summary).toContain("Title:\nRemove old checkout path");
    expect(summary).toContain("URL:\nhttps://primary.code.example/example/widgets/change/12");
    expect(summary).toContain("Author:\nalice");
    expect(summary).toContain("Diff:\n2 files touched | +3/-9");
    expect(summary).toContain(`Status:\npending - ${resolved === false ? "open review comments" : "review resolution unknown"}`);
    expect(summary).toContain("Can compatibility remain?");
    expect(summary).toContain("Validation:\nNo failing checks found.");
    const prompt = exec.mock.calls.find(([command]) => command === "pi")?.[1].at(-1);
    expect(prompt).toContain("Looks good.");
    expect(prompt).toContain("Passed verification.");
    expect(summary).not.toContain("\\x0a");
    expect(exec).toHaveBeenCalledWith("cli-one", ["change", "show", "example/widgets", "12"], expect.objectContaining({ cwd: "/repo" }));
    expect(exec).toHaveBeenCalledWith("pi", expect.arrayContaining(["--model", "model-vendor/model-one"]), expect.objectContaining({ cwd: "/repo" }));
  });

  it.each(["missing", "outer", "nested"])("qualifies incomplete thread reads rather than approving: %s", async (incomplete) => {
    const connection = {
      pageInfo: incomplete === "missing" ? undefined : { hasNextPage: incomplete === "outer" },
      nodes: [{ id: "thread", isResolved: true, comments: {
        nodes: [], pageInfo: { hasNextPage: incomplete === "nested" },
      } }],
    };
    const exec = vi.fn(async (command: string, args: string[]) => ({ code: command === "pi" ? 1 : 0, stderr: "", killed: false,
      stdout: JSON.stringify(args[0] === "query" ? { data: { repository: { pullRequest: { reviewThreads: connection } } } } : { decision: "APPROVED" }),
    }));
    const summary = await createRemotePullRequestSummarySource({ exec } as never, {} as never, target())!.load();
    expect(summary).toContain("Status:\npending - thread read incomplete");
    expect(summary).toContain("Open comments:\nThread read incomplete.");
  });

  it("uses separate configured context and flat review comments when thread queries are disabled", async () => {
    const exec = vi.fn(async (command: string, args: string[]) => {
      if (command === "cli-two" && args[0] === "change") {
        return { code: 0, stdout: JSON.stringify({ draft: false, mergeState: "blocked", changeRequested: true }), stderr: "", killed: false };
      }
      if (command === "cli-two" && args[0] === "conversation") {
        return { code: 0, stdout: JSON.stringify([{ author: { name: "bob" }, text: "Top-level context", created: "2026-06-25T10:00:00Z" }]), stderr: "", killed: false };
      }
      if (command === "cli-two" && args[0] === "decisions") {
        return { code: 0, stdout: "[]", stderr: "", killed: false };
      }
      if (command === "cli-two" && args[0] === "threads") {
        return { code: 0, stdout: JSON.stringify([{ author: { name: "carol" }, text: "Can this preserve compatibility?", created: "2026-06-25T10:02:00Z", file: "src/app.ts", line: 42, resolved: false }]), stderr: "", killed: false };
      }
      return { code: 1, stdout: "", stderr: "agent unavailable", killed: false };
    });

    const source = createRemotePullRequestSummarySource({ exec } as never, {} as never, target("secondary"))!;
    const summary = await source.load();

    expect(summary).toContain("Status:\nblocked - changes requested");
    expect(summary).toContain("Validation:\nCheck details unavailable from Secondary code host context.");
    expect(summary).toContain("Can this preserve compatibility?");
    expect(summary).toContain("Thread read incomplete.");
    expect(exec.mock.calls.some(([, args]) => args[0] === "query")).toBe(false);
  });

  it("uses healthy separate reviews after malformed embedded reviews", async () => {
    const exec = vi.fn(async (command: string, args: string[]) => ({ code: command === "pi" ? 1 : 0, stderr: "", killed: false,
      stdout: JSON.stringify(args[0] === "change" ? { decisions: {} } : args[0] === "decisions"
        ? [{ author: { name: "bob" }, text: "Recovered review", state: "COMMENTED" }] : []),
    }));
    const summary = await createRemotePullRequestSummarySource({ exec } as never, {} as never, target("secondary"))!.load();
    expect(summary).toMatch(/Open comments:\nbob commented: Recovered review; Thread read incomplete\.$/);
  });

  it("uses supplied handoff context without provider reads", async () => {
    const exec = vi.fn(async (command: string) => {
      if (command === "pi") return { code: 1, stdout: "", stderr: "agent unavailable", killed: false };
      return { code: 1, stdout: "", stderr: "provider read should not run", killed: false };
    });
    const handoff = {
      provider: "primary",
      repo: "example/widgets",
      number: "12",
      url: "https://primary.code.example/example/widgets/change/12",
      title: "Remove old checkout path",
      authorLogin: "alice",
      state: "OPEN",
      baseRefName: "main",
      headRefName: "feature",
      headRefOid: "a".repeat(40),
      additions: 3,
      deletions: 9,
      changedFiles: 2,
      summary: "Title: Stale title\nStatus: pending - waiting for review\nProblem: Remove the old path.",
      reviews: [],
      threads: [{ path: "src/app.ts", line: 42, comments: [{ author: "carol", body: "Keep compatibility?" }] }],
      checks: [{ name: "build", status: "COMPLETED", conclusion: "FAILURE" }],
    };

    const update = vi.fn();
    const summary = await createRemotePullRequestSummarySource({ exec } as never, {} as never, { ...target(), handoff: handoff as never })!.load(update);

    expect(exec).not.toHaveBeenCalled();
    expect(summary).toContain("Title:\nRemove old checkout path");
    expect(summary).toContain("Diff:\n2 files touched | +3/-9");
    expect(summary).toContain("Problem:\nIntent Remove the old path. Tested Unit tests pass.");
    expect(summary).toContain("Validation:\nFailing: build");
    expect(update.mock.lastCall?.[0]).toContain(`${summary}\n\nGenerated explanation (optional):\nTitle:\nStale title`);
  });

  it.each(["primary", "secondary"])("returns known embedded facts before slow %s conversation reads", async (providerId) => {
    const failed = { code: 1, stdout: "", stderr: "unavailable", killed: false };
    let finish!: () => void;
    const slow = new Promise<typeof failed>((resolve) => { finish = () => resolve(failed); });
    const exec = vi.fn(async (command: string, args: string[]) => command === "pi" ? failed : args[0] === "change"
      ? { ...failed, code: 0, stdout: JSON.stringify({ checks: [{ name: "unit", result: "FAILURE" }],
        conversation: [{ author: { name: "bob" }, text: "Known comment" }],
        decisions: [{ author: { name: "carol" }, text: "Known review", state: "COMMENTED" }] }) }
      : slow);
    const update = vi.fn();
    let facts: string | undefined;
    const loading = createRemotePullRequestSummarySource({ exec } as never, {} as never, target(providerId))!.load(update)
      .then((text) => { facts = text; });
    try {
      await vi.waitFor(() => expect(facts).toContain("Known review"));
      expect(facts).toContain("Status:\nblocked - 1 failing check");
      expect(facts).toContain("Validation:\nFailing: unit");
      expect(facts).toContain("Pending:");
      finish();
      await vi.waitFor(() => expect(update.mock.lastCall?.[0]).toContain("Unavailable:"));
      const prompt = exec.mock.calls.find(([command]) => command === "pi")?.[1].at(-1);
      expect(prompt).toContain("Known comment");
      expect(prompt).toContain("Known review");
    } finally {
      finish();
      await loading;
    }
  });

  it("returns authoritative facts before optional model enrichment", async () => {
    let finish!: (text: string) => void;
    const model = new Promise<string>((resolve) => { finish = resolve; });
    const exec = vi.fn(async (command: string) => ({
      code: 0, stdout: command === "pi" ? await model : "{}", stderr: "", killed: false,
    }));
    const update = vi.fn();
    const source = createRemotePullRequestSummarySource({ exec } as never, {} as never, target())!;
    let facts: string | undefined;
    const first = source.load(update).then((text) => { facts = text; });
    try {
      await vi.waitFor(() => expect(facts).toContain("Head:\nfeature @ abc123"));
      expect(facts).toContain("Title:\nRemove old checkout path");
      expect(facts).toContain("Validation:\nNo failing checks found.");
      await vi.waitFor(() => expect(update).toHaveBeenCalled());
      const completeFacts = update.mock.lastCall![0];
      finish("Status: approved - invented\nAn optional explanation.");
      await vi.waitFor(() => expect(update.mock.lastCall?.[0]).toContain("Generated explanation (optional):"));
      expect(update.mock.lastCall?.[0]).toBe(`${completeFacts}\n\nGenerated explanation (optional):\nStatus:\napproved - invented\nAn optional explanation.`);
    } finally {
      finish("");
      await first;
    }
  });

  it.each([false, true])("keeps newer context after superseded conversation completion (failed=%s)", async (failed) => {
    const empty = { code: 0, stderr: "", killed: false, stdout: JSON.stringify({ data: { repository: { pullRequest: {
      reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } },
    } } } }) };
    let finish!: (value: typeof empty) => void;
    const old = new Promise<typeof empty>((resolve) => { finish = resolve; });
    let details = 0;
    let threads = 0;
    const exec = vi.fn(async (command: string, args: string[]) => command === "pi" ? { ...empty, code: 1 }
      : args[0] === "query" ? (++threads === 1 ? old : empty)
      : { ...empty, stdout: JSON.stringify({ draft: ++details > 1 }) });
    const source = createRemotePullRequestSummarySource({ exec } as never, {} as never, target())!;
    const update = vi.fn();
    try {
      await source.load(update);
      await source.load(update);
      await vi.waitFor(() => expect(update.mock.lastCall?.[0]).toContain("blocked - draft PR"));
      const latest = update.mock.lastCall![0];
      finish({ ...empty, code: failed ? 1 : 0 });
      await new Promise(setImmediate);
      expect(update.mock.lastCall?.[0]).toBe(latest);
    } finally {
      finish(empty);
    }
  });

  it("keeps embedded facts when thread output exhausts the default byte budget", async () => {
    const oversized = { data: { repository: { pullRequest: { reviewThreads: { nodes: [{ id: "thread", comments: { nodes: [
      { id: "comment", body: `Unbounded reply ${"x".repeat(2_000_000)}` },
    ] } }] } } } } };
    const exec = vi.fn(async (command: string, args: string[]) => ({ code: command === "pi" ? 1 : 0, stderr: "", killed: false,
      stdout: JSON.stringify(args[0] === "change" ? { conversation: [{ text: "Retained comment" }] } : oversized),
    }));
    const summary = await createRemotePullRequestSummarySource({ exec } as never, {} as never, target())!.load();
    expect(summary).toContain("Retained comment; Unavailable: review threads");
    expect(exec.mock.calls.filter(([command]) => command !== "pi")).toHaveLength(2);
  });

  it.each([0, 1])("keeps target facts when details fail with exit %s", async (code) => {
    const exec = vi.fn(async () => ({ code, stdout: "not-json", stderr: "unavailable", killed: false }));
    const summary = await createRemotePullRequestSummarySource({ exec } as never, {} as never, target())!.load();
    expect(summary).toContain("Title:\nRemove old checkout path");
    expect(summary).toContain("URL:\nhttps://primary.code.example/example/widgets/change/12");
    expect(summary).toContain("Head:\nfeature @ abc123");
    expect(summary).toMatch(/Status:\npending - .*unavailable/);
    expect(summary).toContain("Check details unavailable");
    expect(summary).toMatch(/Open comments:\nUnavailable: /);
  });

  it("retains known checks and comments when reviews and threads fail", async () => {
    const exec = vi.fn(async (command: string, args: string[]) => args[0] === "change"
      ? { code: 0, stdout: JSON.stringify({ checks: [{ name: "unit", result: "FAILURE" }],
        conversation: [{ author: { name: "bob" }, text: "Known comment" }], decisions: {} }), stderr: "", killed: false }
      : { code: 1, stdout: "", stderr: "unavailable", killed: false });
    const summary = await createRemotePullRequestSummarySource({ exec } as never, {} as never, target())!.load();
    expect(summary).toContain("Status:\nblocked - 1 failing check");
    expect(summary).toContain("Validation:\nFailing: unit");
    expect(summary).toContain("bob: Known comment; Unavailable:");
    expect(summary).toContain("reviews");
    expect(summary).toContain("review threads");
    expect(exec.mock.calls.find(([command]) => command === "pi")?.[1].at(-1)).toContain("Known comment");
  });

  it.each(["conversation", "decisions", "threads"] as const)("preserves separate sections when %s fails", async (failed) => {
    const labels = { conversation: "PR comments", decisions: "reviews", threads: "review threads" };
    const exec = vi.fn(async (command: string, args: string[]) => {
      const operation = args[0]!;
      const payload = operation === "change" ? { approved: true }
        : [{ author: { name: "bob" }, text: `Known ${operation}`, resolved: true }];
      return command === "pi" || operation === failed
        ? { code: 1, stdout: "", stderr: "denied", killed: false }
        : { code: 0, stdout: JSON.stringify(payload), stderr: "", killed: false };
    });
    const summary = await createRemotePullRequestSummarySource({ exec } as never, {} as never, target("secondary"))!.load();
    expect(summary).toContain(`Unavailable: ${labels[failed]}`);
    expect(summary).toMatch(/Status:\npending - .*unavailable/);
    const prompt = exec.mock.calls.find(([command]) => command === "pi")?.[1].at(-1);
    for (const section of ["conversation", "decisions"].filter((name) => name !== failed)) expect(prompt).toContain(`Known ${section}`);
  });

  it("labels malformed checks unavailable while retaining comments", async () => {
    const exec = vi.fn(async (_command: string, args: string[]) => ({ code: 0, stderr: "", killed: false,
      stdout: JSON.stringify(args[0] === "query" ? { data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } } } }
        : { decision: "APPROVED", checks: {}, conversation: [{ author: { name: "bob" }, text: "Known comment" }] }),
    }));
    const summary = await createRemotePullRequestSummarySource({ exec } as never, {} as never, target())!.load();
    expect(summary).toContain("Status:\npending - checks unavailable");
    expect(summary).toContain("Check details unavailable");
    expect(summary).toContain("Open comments:\nbob: Known comment");
  });

  it.each(["outer", "missing comments", "non-array comments"])("labels a GraphQL failure unavailable without a REST fallback: %s", async (failure) => {
    const config = settings();
    const { reviewComments, ...operations } = config.providers.primary.operations;
    writeFileSync(settingsPath, JSON.stringify({ ...config, providers: { primary: { ...config.providers.primary, operations } } }));
    const payload = failure === "outer" ? { errors: [{ message: "denied" }] }
      : { data: { repository: { pullRequest: { reviewThreads: { nodes: [{
        isResolved: false, comments: failure === "missing comments" ? undefined : { nodes: {} },
      }] } } } } };
    const exec = vi.fn(async (_command: string, args: string[]) => ({ code: 0,
      stdout: JSON.stringify(args[0] === "query" ? payload : { decision: "APPROVED" }), stderr: "", killed: false }));
    const summary = await createRemotePullRequestSummarySource({ exec } as never, {} as never, target())!.load();
    expect(summary).toContain("Open comments:\nUnavailable: review threads");
    expect(summary).toMatch(/Status:\npending - .*unavailable/);
  });
});

describe("shared pull request sources", () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
    return { promise, resolve, reject };
  }
  const graph = (body = "Current reply") => ({ data: { repository: { pullRequest: { reviewThreads: {
    pageInfo: { hasNextPage: false }, nodes: [{ id: "thread", isResolved: false, comments: {
      pageInfo: { hasNextPage: false }, nodes: [{ id: "self", author: { login: "reviewer" }, body: `Question about ${body}` },
        { id: "reply", author: { login: "other" }, body }],
    } }],
  } } } } });
  const executor = (threads: () => Promise<unknown>, model = async () => "") => vi.fn(async (command: string, args: string[], options?: { signal?: AbortSignal }) => ({
    code: 0, stderr: "", killed: false, stdout: command === "pi" ? await model() : JSON.stringify(args[0] === "query" ? await threads()
      : args[0] === "identity" ? { actor: { name: "reviewer" } } : { conversation: [], decisions: [], checks: [] }),
  }));

  it("coalesces pending loads, shares metadata, isolates targets and fences an older model after a fresh load", async () => {
    const thread = deferred<ReturnType<typeof graph>>();
    const model = deferred<string>();
    let reads = 0;
    const exec = executor(async () => ++reads === 1 ? thread.promise : graph(), () => model.promise);
    const sources = createRemotePullRequestSources({ exec } as never, {} as never, target());
    const update = vi.fn();
    try {
      const context = sources.contextPanelSource!.load(update);
      const replies = sources.repliesSource!.load();
      expect(await context).toContain("Pending: review threads");
      expect(exec.mock.calls.filter(([, args]) => args[0] === "query")).toHaveLength(1);
      thread.resolve(graph());
      const first = await replies;
      await vi.waitFor(() => expect(update.mock.lastCall?.[1]).toEqual(first.conversation));
      expect(first.conversation).toMatchObject({ generation: 1, fetchedAt: expect.any(String),
        coverage: { details: "complete", checks: "complete", threads: "complete", identity: "complete", comments: "partial", reviews: "partial" } });
      const providerCalls = exec.mock.calls.filter(([command]) => command !== "pi");
      expect(providerCalls).toHaveLength(3);
      expect(new Set(providerCalls.map(([, , options]) => options?.signal)).size).toBe(1);
      const second = await sources.repliesSource!.load();
      expect(second.conversation?.generation).toBe(2);
      const previous = update.mock.lastCall;
      model.resolve("Outdated explanation");
      await new Promise(setImmediate);
      expect(update.mock.lastCall).toBe(previous);
      const other = await createRemotePullRequestSources({ exec } as never, {} as never, target("primary", { number: "13" })).repliesSource!.load();
      expect(other.conversation?.generation).toBe(1);
      expect(other.conversation?.identity).not.toBe(first.conversation?.identity);
    } finally {
      thread.resolve(graph());
      model.resolve("");
    }
  });

  it.each(["resolve", "reject"])("supersedes pending reads at the same head without stranding their waiters (%s)", async (outcome) => {
    const old = deferred<ReturnType<typeof graph>>();
    let reads = 0;
    const exec = executor(async () => ++reads === 1 ? old.promise : graph());
    const sources = createRemotePullRequestSources({ exec } as never, {} as never, target());
    const update = vi.fn();
    try {
      await sources.contextPanelSource!.load(update);
      let joined: Awaited<ReturnType<NonNullable<typeof sources.repliesSource>["load"]>> | undefined;
      const waiting = sources.repliesSource!.load().then((value) => { joined = value; });
      const fresh = await sources.repliesSource!.load({ refresh: true });
      expect(fresh.conversation?.generation).toBe(2);
      await vi.waitFor(() => expect(joined?.conversation).toEqual(fresh.conversation));
      await waiting;
      await vi.waitFor(() => expect(update.mock.lastCall?.[1]).toEqual(fresh.conversation));
      if (outcome === "reject") old.reject(new Error("Old failure"));
      else old.resolve(graph("Old reply"));
      await new Promise(setImmediate);
      expect(update.mock.lastCall?.[0]).toContain("Current reply");
    } finally {
      old.resolve(graph());
    }
  });

  it("preserves known identity and facts when the shared output budget rejects threads", async () => {
    const exec = executor(async () => graph("x".repeat(2_000_000)));
    const sources = createRemotePullRequestSources({ exec } as never, {} as never, target());
    const update = vi.fn();
    const context = sources.contextPanelSource!.load(update);
    const replies = expect(sources.repliesSource!.load()).rejects.toThrow("Review threads unavailable");
    expect(await context).toContain("Remove old checkout path");
    await replies;
    expect(update.mock.lastCall?.[1]).toMatchObject({ coverage: { identity: "complete", details: "complete", threads: "unavailable" } });
    expect(exec.mock.calls.filter(([command]) => command !== "pi")).toHaveLength(3);
  });

  it.each(["shared", "standalone"])("keeps supplied %s context read-free and enables truthful Replies only after explicit refresh", async (mode) => {
    const exec = executor(async () => graph());
    const supplied = { ...target(), provider: undefined, handoff: { ...target().pullRequest, provider: "primary", url: target().remote,
      summary: "Supplied explanation", reviews: [], checks: [] } as never };
    const sources = mode === "shared" ? createRemotePullRequestSources({ exec } as never, {} as never, supplied)
      : { contextPanelSource: createRemotePullRequestSummarySource({ exec } as never, {} as never, supplied),
        repliesSource: createRemoteReviewRepliesSource({ exec } as never, {} as never, supplied) };
    const update = vi.fn();
    await sources.contextPanelSource!.load(update);
    await expect(sources.repliesSource!.load()).rejects.toThrow(/refresh/i);
    expect(exec).not.toHaveBeenCalled();
    if (mode === "shared") expect(update.mock.lastCall?.[1]).toMatchObject({ fetchedAt: null, coverage: { identity: "unavailable" },
      identity: JSON.stringify(["primary", "example/widgets", "12", "abc123"]) });
    const fresh = await sources.repliesSource!.load({ refresh: true });
    expect(fresh.replies[0]?.body).toBe("Current reply");
    expect(fresh.fetchedAt).toEqual(expect.any(String));
    expect(exec.mock.calls.filter(([command]) => command !== "pi")).toHaveLength(mode === "shared" ? 3 : 2);
    await sources.contextPanelSource!.load(update, { refresh: true });
    await vi.waitFor(() => expect(exec.mock.calls.find(([command]) => command === "pi")?.[1].at(-1)).toContain("Current reply"));
  });
});
