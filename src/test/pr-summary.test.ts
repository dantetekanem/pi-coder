import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRemotePullRequestSummarySource } from "../pr-summary.js";
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function conversationFacts(source: NonNullable<ReturnType<typeof createRemotePullRequestSummarySource>>): Promise<string> {
  let latest: string | undefined;
  await source.load((text) => { latest = text; });
  await vi.waitFor(() => expect(latest).toBeDefined());
  return latest!;
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
  it("loads basic context from the built-in GitHub provider without settings or handoff", async () => {
    rmSync(settingsPath, { force: true });
    const exec = vi.fn(async (command: string, args: string[]) => {
      if (command === "gh" && args[0] === "pr" && args[1] === "view") {
        return {
          code: 0,
          stdout: JSON.stringify({
            url: "https://github.com/example/widgets/pull/12",
            isDraft: false,
            mergeStateStatus: "CLEAN",
            reviewDecision: "APPROVED",
            statusCheckRollup: [{ name: "build", status: "COMPLETED", conclusion: "SUCCESS" }],
            comments: [{ author: { login: "bob" }, body: "Looks good.", createdAt: "2026-06-25T10:00:00Z", url: "https://github.com/example/widgets/pull/12#issuecomment-1" }],
            reviews: [{ author: { login: "bob" }, body: "Approved.", state: "APPROVED", submittedAt: "2026-06-25T10:01:00Z" }],
            createdAt: "2026-06-25T09:00:00Z",
            updatedAt: "2026-06-25T10:01:00Z",
          }),
          stderr: "",
          killed: false,
        };
      }
      if (command === "gh" && args.includes("--include")) {
        const rows = args.join().includes("/reviews?")
          ? [{ id: 2, user: { login: "bob" }, body: "Approved.", state: "APPROVED" }]
          : [{ id: 1, user: { login: "bob" }, body: "Looks good." }];
        return { code: 0, stdout: `HTTP/2.0 200 OK\r\n\r\n${JSON.stringify(rows)}`, stderr: "", killed: false };
      }
      if (command === "gh" && args[0] === "api" && args[1] === "graphql") {
        return {
          code: 0,
          stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } }),
          stderr: "",
          killed: false,
        };
      }
      if (command === "pi") return { code: 1, stdout: "", stderr: "agent unavailable", killed: false };
      return { code: 1, stdout: "", stderr: `unexpected ${command}`, killed: false };
    });

    const source = createRemotePullRequestSummarySource(
      { exec } as never,
      {} as never,
      { ...target("github"), remote: "https://github.com/example/widgets/pull/12" },
    )!;
    const summary = await conversationFacts(source);

    expect(source.title).toBe("GitHub PR context");
    expect(summary).toContain("Title:\nRemove old checkout path");
    expect(summary).toContain("URL:\nhttps://github.com/example/widgets/pull/12");
    expect(summary).toContain("Author:\nalice");
    expect(summary).toContain("Status:\napproved - review decision approved");
    expect(summary).toContain("Validation:\nNo failing checks found.");
    expect(summary).toContain("Open comments:\nbob approved: Approved.");
    expect(exec.mock.calls.some(([command, args]) => {
      if (command !== "pi") return false;
      const prompt = args.join("\n");
      return prompt.includes("PR conversation comments:\n- bob: Looks good.")
        && prompt.includes("Reviews:\n- bob approved: Approved.");
    })).toBe(true);
    expect(exec).toHaveBeenCalledWith(
      "gh",
      ["pr", "view", "12", "--repo", "example/widgets", "--json", expect.stringContaining("reviewDecision")],
      expect.objectContaining({ cwd: "/repo" }),
    );
  });

  it("uses configured details and capability-gated thread operations", async () => {
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
            decisions: [{ author: { name: "bob" }, state: "APPROVED", submitted: "2026-06-25T10:01:00Z" }],
            checks: [],
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
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [{
                      id: "thread-1",
                      isResolved: false,
                      isOutdated: false,
                      path: "src/app.ts",
                      line: 42,
                      comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: "comment-1", author: { login: "carol" }, body: "Can compatibility remain?", createdAt: "2026-06-25T10:02:00Z" }] },
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
    const summary = await conversationFacts(source);

    expect(source.title).toBe("Primary code host PR context");
    expect(summary).toContain("Title:\nRemove old checkout path");
    expect(summary).toContain("URL:\nhttps://primary.code.example/example/widgets/change/12");
    expect(summary).toContain("Author:\nalice");
    expect(summary).toContain("Diff:\n2 files touched | +3/-9");
    expect(summary).toContain("Status:\npending - open review comments");
    expect(summary).not.toContain("\\x0a");
    expect(exec).toHaveBeenCalledWith("cli-one", ["change", "show", "example/widgets", "12"], expect.objectContaining({ cwd: "/repo" }));
    expect(exec).toHaveBeenCalledWith("pi", expect.arrayContaining(["--model", "model-vendor/model-one"]), expect.objectContaining({ cwd: "/repo" }));
  });

  it("uses separate configured context and flat review comments when thread queries are disabled", async () => {
    const exec = vi.fn(async (command: string, args: string[]) => {
      if (command === "cli-two" && args[0] === "change") {
        return { code: 0, stdout: JSON.stringify({ draft: false, mergeState: "blocked", changeRequested: true }), stderr: "", killed: false };
      }
      if (command === "cli-two" && args[0] === "conversation") {
        return { code: 0, stdout: JSON.stringify([{ id: "top-1", author: { name: "bob" }, text: "Top-level context", created: "2026-06-25T10:00:00Z" }]), stderr: "", killed: false };
      }
      if (command === "cli-two" && args[0] === "decisions") {
        return { code: 0, stdout: "[]", stderr: "", killed: false };
      }
      if (command === "cli-two" && args[0] === "threads") {
        return { code: 0, stdout: JSON.stringify([{ id: "review-1", author: { name: "carol" }, text: "Can this preserve compatibility?",  created: "2026-06-25T10:02:00Z", file: "src/app.ts", line: 42, resolved: false }]), stderr: "", killed: false };
      }
      return { code: 1, stdout: "", stderr: "agent unavailable", killed: false };
    });

    const source = createRemotePullRequestSummarySource({ exec } as never, {} as never, target("secondary"))!;
    const summary = await conversationFacts(source);

    expect(summary).toContain("Status:\nblocked - changes requested");
    expect(summary).toContain("Validation:\nCheck details unavailable from Secondary code host context.");
    expect(summary).toContain("Can this preserve compatibility?");
    expect(exec.mock.calls.some(([, args]) => args[0] === "query")).toBe(false);
  });

  it("uses supplied handoff context without provider reads until explicit refresh", async () => {
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

    const source = createRemotePullRequestSummarySource({ exec } as never, {} as never, { ...target(), handoff: handoff as never })!;
    const summary = await source.load();

    expect(exec).not.toHaveBeenCalled();
    expect(summary).toContain("Supplied conversation; coverage unknown.");
    expect(summary).toContain("Title:\nRemove old checkout path");
    expect(summary).toContain("Diff:\n2 files touched | +3/-9");
    expect(summary).toContain("Problem:\nIntent Remove the old path. Tested Unit tests pass.");

    await source.load(undefined, { refresh: true });
    expect(exec.mock.calls.some(([command]) => command === "cli-one")).toBe(true);
  });

  it("emits authoritative facts before a delayed generated explanation", async () => {
    const model = deferred<{ code: number; stdout: string; stderr: string; killed: boolean }>();
    const exec = vi.fn(async (command: string, args: string[]) => {
      if (command === "cli-one" && args[0] === "change") {
        return { code: 0, stdout: JSON.stringify({ draft: false, mergeState: "clean", decision: "APPROVED", conversation: [], decisions: [], checks: [] }), stderr: "", killed: false };
      }
      if (command === "cli-one" && args[0] === "query") {
        return { code: 0, stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }), stderr: "", killed: false };
      }
      if (command === "pi") return model.promise;
      return { code: 1, stdout: "", stderr: `unexpected ${command}`, killed: false };
    });
    const source = createRemotePullRequestSummarySource({ exec } as never, {} as never, target())!;
    const updates: string[] = [];

    const facts = await source.load((text) => updates.push(text));

    expect(facts).toContain("Title:\nRemove old checkout path");
    expect(facts).toContain("Head:\nfeature @ abc123");
    expect(facts).toContain("Validation:\nNo check runs reported.");
    expect(facts).not.toContain("Generated explanation");
    expect(updates.every((text) => !text.includes("Generated explanation"))).toBe(true);

    model.resolve({ code: 0, stdout: "Problem: This removes a deprecated checkout path.", stderr: "", killed: false });
    await vi.waitFor(() => expect(updates.at(-1)).toContain("Generated explanation (optional):"));
    expect(updates.at(-1)).toContain("Title:\nRemove old checkout path");
    expect(updates.at(-1)).toContain("This removes a deprecated checkout path.");
  });

  it("returns useful facts before a delayed conversation page and coalesces replies retrieval", async () => {
    const page = deferred<{ code: number; stdout: string; stderr: string; killed: boolean }>();
    const exec = vi.fn(async (command: string, args: string[]) => {
      if (command === "pi") return { code: 1, stdout: "", stderr: "unavailable", killed: false };
      if (args[0] === "query") return page.promise;
      if (args[0] === "identity") return { code: 0, stdout: JSON.stringify({ actor: { name: "self" } }), stderr: "", killed: false };
      return { code: 0, stdout: args[0] === "change" ? JSON.stringify({ decision: "APPROVED", checks: [] }) : "[]", stderr: "", killed: false };
    });
    const pi = { exec } as never;
    const remote = target();
    const context = createRemotePullRequestSummarySource(pi, {} as never, remote)!;
    const replies = createRemoteReviewRepliesSource(pi, {} as never, remote)!;
    expect(context.conversation).toBe(replies.conversation);
    const updates: string[] = [];
    const factsPromise = context.load((text) => updates.push(text));
    const replyPromise = replies.load();
    const facts = await factsPromise;
    expect(facts).toContain("Title:\nRemove old checkout path");
    expect(facts).toContain("Conversation loading; coverage unknown.");
    expect(facts).toContain("Validation:\nNo check runs reported.");
    expect(updates).toEqual([]);
    const pageInfo = { hasNextPage: false, endCursor: null };
    page.resolve({ code: 0, stderr: "", killed: false, stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo, nodes: [{ id: "thread", isResolved: false, comments: { pageInfo, nodes: [{ id: "self", author: { login: "self" }, body: "Question" }, { id: "reply", author: { login: "other" }, body: "Answered" }] } }] } } } } }) });
    const snapshot = await replyPromise;
    await vi.waitFor(() => expect(updates.at(-1)).toContain("Answered"));
    expect(snapshot.replies[0]?.body).toBe("Answered");
    expect(exec.mock.calls.filter(([, args]) => args[0] === "query")).toHaveLength(1);
    expect(snapshot.conversation?.generation).toBe(context.conversation?.current?.generation);
  });

  it("handles a rejected continuation immediately while detail facts are still loading", async () => {
    const details = deferred<{ code: number; stdout: string; stderr: string; killed: boolean }>();
    const exec = vi.fn(async (_command: string, args: string[]) => args[0] === "change"
      ? details.promise : { code: 1, stdout: "", stderr: "unavailable", killed: false });
    const source = createRemotePullRequestSummarySource({ exec } as never, {} as never, target())!;
    const updates: string[] = [];
    const opening = source.load((text) => updates.push(text), { continuation: { generation: 99 } });
    // The detail request crosses an event-loop turn; a rejected reader must already have a handler.
    await new Promise<void>((resolve) => setImmediate(resolve));
    details.resolve({ code: 0, stdout: JSON.stringify({ checks: [] }), stderr: "", killed: false });
    expect(await opening).toContain("Title:\nRemove old checkout path");
    await vi.waitFor(() => expect(updates.at(-1)).toContain("Stale or foreign conversation continuation"));
    expect(updates.at(-1)).toContain("Status:\npending - review conversation unavailable");
  });

  it("retains known facts and labels unavailable detail sections", async () => {
    const exec = vi.fn(async (command: string, args: string[]) => {
      if (command === "cli-one" && args[0] === "change") {
        return {
          code: 0,
          stdout: JSON.stringify({ draft: false, mergeState: "clean", decision: "APPROVED", conversation: [{ author: { name: "bob" }, text: "Known top-level comment" }], decisions: [], checks: [{ name: "build", status: "COMPLETED", result: "FAILURE" }] }),
          stderr: "",
          killed: false,
        };
      }
      if (command === "cli-one" && (args[0] === "query" || args[0] === "threads")) {
        return { code: 1, stdout: "", stderr: "review service unavailable", killed: false };
      }
      if (command === "pi") return { code: 1, stdout: "", stderr: "agent unavailable", killed: false };
      return { code: 1, stdout: "", stderr: `unexpected ${command}`, killed: false };
    });

    const facts = await conversationFacts(createRemotePullRequestSummarySource({ exec } as never, {} as never, target())!);

    expect(facts).toContain("Title:\nRemove old checkout path");
    expect(facts).toContain("URL:\nhttps://primary.code.example/example/widgets/change/12");
    expect(facts).toContain("Head:\nfeature @ abc123");
    expect(facts).toContain("Status:\nblocked - 1 failing check");
    expect(facts).toContain("Validation:\nFailing: build");
    expect(facts).toContain("Open comments:\nbob: Known top-level comment; Unavailable: review threads, reviews.");
  });

  it("labels GraphQL failure unavailable when a provider has no REST fallback", async () => {
    const config = settings();
    const { reviewComments: _fallback, ...operations } = config.providers.primary.operations;
    writeFileSync(settingsPath, JSON.stringify({ ...config, providers: { ...config.providers, primary: { ...config.providers.primary, operations } } }), "utf8");
    const exec = vi.fn(async (_command: string, args: string[]) => args[0] === "change"
      ? { code: 0, stdout: JSON.stringify({ draft: false, mergeState: "clean", decision: "APPROVED", conversation: [], decisions: [], checks: [] }), stderr: "", killed: false }
      : { code: 1, stdout: "", stderr: "unavailable", killed: false });

    const facts = await conversationFacts(createRemotePullRequestSummarySource({ exec } as never, {} as never, target())!);

    expect(facts).toContain("Title:\nRemove old checkout path");
    expect(facts).toContain("Status:\npending - review conversation unavailable");
    expect(facts).toContain("Open comments:\nUnavailable: review threads, reviews, PR comments.");
  });

  it("keeps target facts visible when the details section fails", async () => {
    const exec = vi.fn(async () => ({ code: 1, stdout: "", stderr: "details unavailable", killed: false }));

    const facts = await conversationFacts(createRemotePullRequestSummarySource({ exec } as never, {} as never, target())!);

    expect(facts).toContain("Title:\nRemove old checkout path");
    expect(facts).toContain("URL:\nhttps://primary.code.example/example/widgets/change/12");
    expect(facts).toContain("Head:\nfeature @ abc123");
    expect(facts).toContain("Status:\npending - PR details unavailable");
    expect(facts).toContain("Validation:\nCheck details unavailable from Primary code host context.");
    expect(facts).toContain("Open comments:\nUnavailable: review threads, reviews, PR comments.");
  });
});
