import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildInlineComments,
  buildProviderComments,
  buildReviewBody,
  buildReviewPayload,
  submitPullRequestReview,
} from "../review-submit.js";
import type { DiffReviewComment, ReviewFile, ReviewSubmitPayload } from "../types.js";
import { loadReviewReceipt } from "../review-receipts.js";

const originalReceiptsDir = process.env.PI_CODE_DIFF_RECEIPTS_DIR;
const originalSubmissionsDir = process.env.PI_CODE_DIFF_SUBMISSIONS_DIR;
const isIdentity = (args: string[]) => args[0] === "identity" || (args[0] === "api" && args[1] === "user");
const identityResponse = () => ({ code: 0, stdout: JSON.stringify({ id: 42, login: "reviewer", actor: { name: "reviewer" } }), stderr: "", killed: false });
const originalSettingsPath = process.env.PI_CODE_DIFF_SETTINGS_PATH;
let directory: string;
let settingsPath: string;

function provider(id: string, executable: string, capabilities: Record<string, boolean>) {
  return {
    label: `${id} code host`,
    executable,
    urls: {
      patterns: [{ host: `${id.toLowerCase()}.code.example`, path: "/{repo}/change/{number}" }],
      canonical: `https://${id.toLowerCase()}.code.example/{repo}/change/{number}`,
    },
    operations: {
      identity: { args: ["identity"] },
      pullRequest: { args: ["change", "show", "{repo}", "{number}"] },
      submitReview: { args: ["review", "create", "{repo}", "{number}", "--input", "{payloadPath}"] },
    },
    refs: {},
    fields: {
      identityLogin: "actor.name",
      state: "state",
      headRefOid: "head",
      submissionId: "id",
      submissionState: "state",
      submissionCommitId: "commit_id",
      submissionUrl: "html_url",
      submissionAuthor: "user.login",
    },
    capabilities,
  };
}

function settings() {
  return {
    version: 1,
    providers: {
      primary: provider("Primary", "cli-one", {
        atomicReview: false,
        fileComments: false,
        commitIdRequired: false,
        requestChangesBodyRequired: false,
        validateTargetBeforeSubmit: false,
        validateSubmitResponse: false,
      }),
      secondary: provider("Secondary", "cli-two", {
        atomicReview: true,
        fileComments: true,
        commitIdRequired: true,
        requestChangesBodyRequired: true,
        validateTargetBeforeSubmit: true,
        validateSubmitResponse: true,
      }),
    },
    repositories: {},
  };
}

function file(path = "src/app.ts"): ReviewFile {
  return {
    id: `${path}::working::${path}::::`,
    path,
    worktreeStatus: "modified",
    hasWorkingTreeFile: true,
    inGitDiff: true,
    inLastCommit: false,
    inAllFiles: false,
    gitDiff: { status: "modified", oldPath: path, newPath: path, displayPath: path, hasOriginal: true, hasModified: true },
    lastCommit: null,
    allFiles: null,
  };
}

function comment(overrides: Partial<DiffReviewComment> = {}): DiffReviewComment {
  return {
    id: "line:src/app.ts:4",
    fileId: file().id,
    scope: "git-diff",
    side: "added",
    intent: "comment",
    startLine: 4,
    endLine: 4,
    body: "Please keep this compatible.",
    ...overrides,
  };
}

function input(providerId = "primary") {
  return {
    provider: providerId,
    repo: "example/widgets",
    prNumber: "12",
    commitId: "abc123",
    baseCommitId: "base123",
    verdict: "comment" as const,
    gitRoot: "/repo",
  };
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "review-submit-settings-"));
  settingsPath = join(directory, "settings.json");
  process.env.PI_CODE_DIFF_SETTINGS_PATH = settingsPath;
  process.env.PI_CODE_DIFF_RECEIPTS_DIR = join(directory, "receipts");
  process.env.PI_CODE_DIFF_SUBMISSIONS_DIR = join(directory, "attempts");
  writeFileSync(settingsPath, JSON.stringify(settings()), "utf8");
});

afterEach(() => {
  if (originalSubmissionsDir == null) delete process.env.PI_CODE_DIFF_SUBMISSIONS_DIR;
  else process.env.PI_CODE_DIFF_SUBMISSIONS_DIR = originalSubmissionsDir;
  if (originalReceiptsDir == null) delete process.env.PI_CODE_DIFF_RECEIPTS_DIR;
  else process.env.PI_CODE_DIFF_RECEIPTS_DIR = originalReceiptsDir;
  if (originalSettingsPath == null) delete process.env.PI_CODE_DIFF_SETTINGS_PATH;
  else process.env.PI_CODE_DIFF_SETTINGS_PATH = originalSettingsPath;
  rmSync(directory, { recursive: true, force: true });
});

describe("review comment mapping", () => {
  it("maps inline comments and exact modifications", () => {
    const comments = buildInlineComments([file()], [
      comment(),
      comment({ id: "modify", intent: "modify", originalText: "old()", body: "new()" }),
      comment({ id: "file", side: "file", startLine: null, endLine: null }),
    ]);

    expect(comments).toHaveLength(2);
    expect(comments[0]).toMatchObject({ path: "src/app.ts", line: 4, side: "RIGHT" });
    expect(comments[1]?.body).toContain("```diff\n- old()\n+ new()\n```");
  });

  it("maps file comments only when the configured provider supports them", () => {
    const fileComment = comment({ id: "file", side: "file", startLine: null, endLine: null, body: "Whole-file note." });

    expect(buildProviderComments([file()], [fileComment], true, "Secondary code host")).toEqual([
      { path: "src/app.ts", subject_type: "file", body: "Whole-file note." },
    ]);
    expect(buildProviderComments([file()], [fileComment], false, "Primary code host")).toEqual([]);
  });

  it("builds a review body from the review-wide note and file comments", () => {
    const payload: ReviewSubmitPayload = {
      type: "submit",
      allComment: "Overall note",
      allIntent: "comment",
      comments: [comment({ id: "file", side: "file", startLine: null, endLine: null, body: "File note" })],
    };
    expect(buildReviewBody([file()], payload)).toBe("Overall note\n\nsrc/app.ts:\nFile note");
    expect(buildReviewBody([file()], payload, false)).toBe("Overall note");
  });
});

describe("configured review submission", () => {
  it("includes the commit id when comments or provider capability require it", () => {
    const primary = buildReviewPayload({ ...input("primary"), verdict: "approve", body: "Looks good" });
    const secondary = buildReviewPayload({ ...input("secondary"), verdict: "approve", body: "Looks good" });
    const withComments = buildReviewPayload({ ...input("primary"), comments: [{ path: "src/app.ts", line: 4, side: "RIGHT", body: "Note" }] });

    expect(primary).toEqual({ event: "APPROVE", body: "Looks good" });
    expect(secondary).toMatchObject({ event: "APPROVE", commit_id: "abc123" });
    expect(withComments).toMatchObject({ event: "COMMENT", commit_id: "abc123" });
  });

  it("pins every built-in GitHub verdict to the reviewed commit", () => {
    for (const verdict of ["approve", "request_changes", "comment"] as const) {
      expect(buildReviewPayload({ ...input("github"), verdict, body: "Review body" })).toEqual({
        event: verdict === "approve" ? "APPROVE" : verdict === "request_changes" ? "REQUEST_CHANGES" : "COMMENT",
        body: "Review body",
        commit_id: "abc123",
      });
    }
  });

  it("refuses self approval using the configured identity operation", async () => {
    const exec = vi.fn(async () => ({ code: 0, stdout: JSON.stringify({ actor: { name: "alice" } }), stderr: "", killed: false }));

    const result = await submitPullRequestReview({ exec } as never, {
      ...input("primary"),
      verdict: "approve",
      prAuthorLogin: "Alice",
    });

    expect(result).toMatchObject({ ok: false, blockedSelfApproval: true });
    expect(result.message).toContain("Primary code host does not allow self-approval");
  });

  it("submits comments and approval separately when atomic review is disabled", async () => {
    const payloads: unknown[] = [];
    const exec = vi.fn(async (_command: string, args: string[]) => {
      if (args[0] === "identity") return { code: 0, stdout: JSON.stringify({ actor: { name: "reviewer" } }), stderr: "", killed: false };
      const payload = JSON.parse(readFileSync(args.at(-1)!, "utf8")) as { event: string };
      payloads.push(payload);
      return { code: 0, stdout: JSON.stringify({ id: payloads.length, state: payload.event === "APPROVE" ? "APPROVED" : "COMMENTED" }), stderr: "", killed: false };
    });

    const result = await submitPullRequestReview({ exec } as never, {
      ...input("primary"),
      verdict: "approve",
      body: "Looks good",
      prAuthorLogin: "author",
      comments: [{ path: "src/app.ts", line: 4, side: "RIGHT", body: "Note" }],
    });

    expect(result.ok).toBe(true);
    expect(payloads).toEqual([
      { event: "COMMENT", commit_id: "abc123", comments: [{ path: "src/app.ts", line: 4, side: "RIGHT", body: "Note" }] },
      { event: "APPROVE", body: "Looks good" },
    ]);
    expect(result.message).toContain("https://primary.code.example/example/widgets/change/12");
  });

  it("validates the live head and submits atomically when configured", async () => {
    const calls: string[][] = [];
    const exec = vi.fn(async (_command: string, args: string[]) => {
      calls.push(args);
      if (isIdentity(args)) return identityResponse();
      if (args[0] === "change") return { code: 0, stdout: JSON.stringify({ state: "open", head: "abc123" }), stderr: "", killed: false };
      expect(JSON.parse(readFileSync(args.at(-1)!, "utf8"))).toMatchObject({ event: "COMMENT", commit_id: "abc123" });
      return { code: 0, stdout: JSON.stringify({ id: 9, state: "COMMENTED" }), stderr: "", killed: false };
    });

    const result = await submitPullRequestReview({ exec } as never, {
      ...input("secondary"),
      body: "Summary",
      comments: [{ path: "src/app.ts", subject_type: "file", body: "File note" }],
    });

    expect(result.ok).toBe(true);
    expect(calls.map((args) => args[0])).toEqual(["identity", "change", "review"]);
    expect(result.message).toContain("https://secondary.code.example/example/widgets/change/12");
  });

  it("submits a built-in GitHub approval with inline comments as one commit-pinned review", async () => {
    const payloads: unknown[] = [];
    const calls: string[][] = [];
    const exec = vi.fn(async (_command: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "api" && args[1] === "user") return { code: 0, stdout: JSON.stringify({ login: "reviewer" }), stderr: "", killed: false };
      if (args[0] === "pr") return { code: 0, stdout: JSON.stringify({ state: "OPEN", headRefOid: "abc123" }), stderr: "", killed: false };
      payloads.push(JSON.parse(readFileSync(args.at(-1)!, "utf8")) as unknown);
      return { code: 0, stdout: JSON.stringify({ id: 9, state: "APPROVED" }), stderr: "", killed: false };
    });

    const result = await submitPullRequestReview({ exec } as never, {
      ...input("github"),
      verdict: "approve",
      body: "Looks good",
      prAuthorLogin: "author",
      comments: [{ path: "src/app.ts", line: 4, side: "RIGHT", body: "Note" }],
    });

    expect(result.ok).toBe(true);
    expect(calls.map((args) => args[0])).toEqual(["api", "pr", "api"]);
    expect(payloads).toEqual([{
      event: "APPROVE",
      body: "Looks good",
      commit_id: "abc123",
      comments: [{ path: "src/app.ts", line: 4, side: "RIGHT", body: "Note" }],
    }]);
  });

  it("fails closed on target drift and malformed submission responses", async () => {
    const driftExec = vi.fn(async (_command: string, args: string[]) => isIdentity(args) ? identityResponse() : { code: 0, stdout: JSON.stringify({ state: "open", head: "new-head" }), stderr: "", killed: false });
    const drift = await submitPullRequestReview({ exec: driftExec } as never, { ...input("secondary") });
    expect(drift).toMatchObject({ ok: false, status: "rejected", steps: [{ status: "pending" }], journalStatus: "saved" });
    expect(drift.message).toContain("head changed from abc123 to new-head");

    const malformedExec = vi.fn(async (_command: string, args: string[]) => isIdentity(args) ? identityResponse() : args[0] === "change"
      ? { code: 0, stdout: JSON.stringify({ state: "open", head: "abc123" }), stderr: "", killed: false }
      : { code: 0, stdout: "{}", stderr: "", killed: false });
    const malformed = await submitPullRequestReview({ exec: malformedExec } as never, { ...input("secondary") });
    expect(malformed).toMatchObject({ ok: false });
    expect(malformed.message).toContain("Malformed Secondary code host response after review submission");
  });

  it("returns accepted scope and remote IDs with a durable shared receipt", async () => {
    const exec = vi.fn(async (_command: string, args: string[]) => isIdentity(args) ? identityResponse() : args[0] === "change"
      ? { code: 0, stdout: JSON.stringify({ state: "open", head: "abc123" }), stderr: "" }
      : { code: 0, stdout: `HTTP/2.0 200 OK\r\ncontent-type: application/json\r\n\r\n${JSON.stringify({ id: 9, state: "COMMENTED", commit_id: "abc123", user: { login: "reviewer" }, html_url: "https://secondary.code.example/example/widgets/change/12#review-9" })}`, stderr: "" });
    const result = await submitPullRequestReview({ exec } as never, {
      ...input("secondary"), body: "Summary",
      comments: [{ path: "src/app.ts", line: 4, side: "RIGHT", body: "Note" }],
    });
    expect(result).toMatchObject({
      status: "submitted", ok: true, reviewedCommitId: "abc123", receiptStatus: "saved",
      steps: [{ kind: "review", status: "submitted", reviewId: "9", reviewIdSource: "write_response", commitId: "abc123", bodyIncluded: true, commentIndexes: [0] }],
      receipt: { reviewIds: ["9"], selfPrincipalId: "reviewer", verdict: "comment", outcome: "submitted", commentsTotal: 1 },
    });
    expect(loadReviewReceipt("secondary", "example/widgets", "12")).toEqual(result.receipt);
  });

  it.each([
    ["malformed JSON", "{"], ["missing evidence", "{}"],
    ["pending review", JSON.stringify({ id: 9, state: "PENDING" })],
    ["unexpected verdict", JSON.stringify({ id: 9, state: "APPROVED" })],
    ["terminal control state", JSON.stringify({ id: 9, state: "\x1b]52;c;bad\x07" })],
    ["different commit", JSON.stringify({ id: 9, state: "COMMENTED", commit_id: "other-head" })],
    ["empty identity", JSON.stringify({ id: "", state: "COMMENTED" })],
    ["unsafe numeric identity", '{"id":9007199254740993,"state":"COMMENTED"}'],
  ])("keeps %s after a write unknown rather than claiming rejection or acceptance", async (_label, stdout) => {
    const exec = vi.fn(async (_command: string, args: string[]) => isIdentity(args) ? identityResponse() : { code: 0, stdout, stderr: "" });
    const result = await submitPullRequestReview({ exec } as never, input("primary"));
    expect(result).toMatchObject({ status: "unknown", ok: false, steps: [{ status: "unknown" }], receiptStatus: "not_applicable" });
    expect(result.message).not.toMatch(/[\x1b\x07]/);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it.each(["throw", "killed", "ambiguous exit"] as const)("retains uncertainty when the write has a %s outcome", async (mode) => {
    const exec = vi.fn(async (_command: string, args: string[]) => {
      if (isIdentity(args)) return identityResponse();
      if (mode === "throw") throw new Error("Timed out after sending request");
      return { code: mode === "ambiguous exit" ? 1 : 0, stdout: JSON.stringify({ id: 9, state: "COMMENTED" }), stderr: "connection lost", killed: mode === "killed" };
    });
    expect(await submitPullRequestReview({ exec } as never, input())).toMatchObject({ status: "unknown", ok: false });
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("verifies GitHub's returned commit and requests HTTP response evidence", async () => {
    const exec = vi.fn(async (_command: string, args: string[]) => isIdentity(args) ? identityResponse() : args[0] === "pr"
      ? { code: 0, stdout: JSON.stringify({ state: "OPEN", headRefOid: "abc123" }), stderr: "" }
      : { code: 0, stdout: JSON.stringify({ id: 9, state: "COMMENTED", commit_id: "new-head" }), stderr: "" });
    expect(await submitPullRequestReview({ exec } as never, input("github"))).toMatchObject({ status: "unknown" });
    expect(exec.mock.calls.at(-1)?.[1]).toContain("--include");
  });

  it("distinguishes explicit HTTP permission rejection from uncertain transport failures", async () => {
    const exec = vi.fn(async (_command: string, args: string[]) => isIdentity(args) ? identityResponse() : { code: 1, stdout: 'HTTP/2.0 403 Forbidden\r\ncontent-type: application/json\r\n\r\n{"message":"Forbidden"}', stderr: "Forbidden" });
    expect(await submitPullRequestReview({ exec } as never, input())).toMatchObject({ status: "rejected", steps: [{ status: "rejected" }], receiptStatus: "not_applicable" });
  });

  it("stops a multi-step submission on uncertainty and retains its direct review link", async () => {
    const url = "https://primary.code.example/example/widgets/change/12#review-9";
    const exec = vi.fn(async (_command: string, args: string[]) => args[0] === "identity"
      ? { code: 0, stdout: JSON.stringify({ actor: { name: "reviewer" } }), stderr: "" }
      : { code: 0, stdout: JSON.stringify({ id: 9, state: "PENDING", html_url: url }), stderr: "" });
    const result = await submitPullRequestReview({ exec } as never, {
      ...input(), verdict: "approve", body: "Looks good", prAuthorLogin: "author",
      comments: [{ path: "src/app.ts", line: 4, side: "RIGHT", body: "Note" }],
    });
    expect(result).toMatchObject({ status: "unknown", url, steps: [{ status: "unknown", reviewId: "9", url }, { status: "pending" }] });
    expect(result.message).toContain(url);
    expect(exec.mock.calls.filter(([, args]) => args[0] === "review")).toHaveLength(1);
  });

  it("preserves exact confirmed comments when a separate approval is rejected", async () => {
    let writes = 0;
    const exec = vi.fn(async (_command: string, args: string[]) => {
      if (args[0] === "identity") return { code: 0, stdout: JSON.stringify({ actor: { name: "reviewer" } }), stderr: "" };
      writes++;
      return writes === 1
        ? { code: 0, stdout: JSON.stringify({ id: 11, state: "COMMENTED", commit_id: "abc123" }), stderr: "" }
        : { code: 1, stdout: 'HTTP/2.0 403 Forbidden\r\n\r\n{"message":"Forbidden"}', stderr: "Forbidden" };
    });
    const result = await submitPullRequestReview({ exec } as never, {
      ...input(), verdict: "approve", body: "Looks good", prAuthorLogin: "author",
      comments: [{ path: "src/app.ts", line: 4, side: "RIGHT", body: "Note" }],
    });
    expect(result).toMatchObject({
      status: "partial", ok: false, receiptStatus: "saved",
      steps: [
        { kind: "comments", status: "submitted", reviewId: "11", commentIndexes: [0], bodyIncluded: false },
        { kind: "verdict", status: "rejected", commentIndexes: [], bodyIncluded: true },
      ],
      receipt: { verdict: "comment", intendedVerdict: "approve", outcome: "partial", reviewIds: ["11"], selfPrincipalId: "reviewer" },
    });
    expect(result.receipt?.bodyHash).toBeUndefined();
    expect(loadReviewReceipt("primary", "example/widgets", "12")).toEqual(result.receipt);
    expect(writes).toBe(2);
  });

  it("reports local receipt failure without turning confirmed remote acceptance into a retryable failure", async () => {
    const blocked = join(directory, "not-a-directory");
    writeFileSync(blocked, "blocked");
    process.env.PI_CODE_DIFF_RECEIPTS_DIR = blocked;
    const exec = vi.fn(async (_command: string, args: string[]) => isIdentity(args) ? identityResponse() : { code: 0, stdout: JSON.stringify({ id: 9, state: "COMMENTED" }), stderr: "" });
    expect(await submitPullRequestReview({ exec } as never, { ...input(), body: "Summary" })).toMatchObject({ status: "submitted", ok: true, receiptStatus: "failed", receipt: null });
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("rejects missing write configuration before executing any provider command", async () => {
    const configured = settings();
    Reflect.deleteProperty(configured.providers.primary.operations, "submitReview");
    writeFileSync(settingsPath, JSON.stringify(configured));
    const exec = vi.fn();
    expect(await submitPullRequestReview({ exec } as never, input())).toMatchObject({ status: "rejected", ok: false });
    expect(exec).not.toHaveBeenCalled();
  });

  it("rejects unsupported file comments and bodyless change requests", async () => {
    const unsupported = await submitPullRequestReview({ exec: vi.fn() } as never, {
      ...input("primary"),
      comments: [{ path: "src/app.ts", subject_type: "file", body: "File note" }],
    });
    expect(unsupported.message).toContain("not supported by Primary code host");

    const bodyless = await submitPullRequestReview({ exec: vi.fn() } as never, {
      ...input("secondary"),
      verdict: "request_changes",
      comments: [{ path: "src/app.ts", line: 4, side: "RIGHT", body: "Note" }],
    });
    expect(bodyless.message).toContain("Secondary code host request changes needs a review body");
  });
});
