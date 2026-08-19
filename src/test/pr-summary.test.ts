import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRemotePullRequestSummarySource } from "../pr-summary.js";
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
                    nodes: [{
                      isResolved: false,
                      isOutdated: false,
                      path: "src/app.ts",
                      line: 42,
                      comments: { nodes: [{ author: { login: "carol" }, body: "Can compatibility remain?", createdAt: "2026-06-25T10:02:00Z" }] },
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
    expect(exec.mock.calls.some(([, args]) => args[0] === "query")).toBe(false);
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

    const summary = await createRemotePullRequestSummarySource({ exec } as never, {} as never, { ...target(), handoff: handoff as never })!.load();

    expect(exec).not.toHaveBeenCalled();
    expect(summary).toContain("Title:\nRemove old checkout path");
    expect(summary).toContain("Diff:\n2 files touched | +3/-9");
    expect(summary).toContain("Problem:\nRemove the old path.");
  });

  it("fails closed when the configured provider response is malformed", async () => {
    const exec = vi.fn(async () => ({ code: 0, stdout: "not-json", stderr: "", killed: false }));
    const source = createRemotePullRequestSummarySource({ exec } as never, {} as never, target())!;

    await expect(source.load()).rejects.toThrow("Malformed Primary code host response for PR #12.");
  });
});
