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
  writeFileSync(settingsPath, JSON.stringify(settings()), "utf8");
});

afterEach(() => {
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
  it("includes the commit id only when comments or provider capability require it", () => {
    const primary = buildReviewPayload({ ...input("primary"), verdict: "approve", body: "Looks good" });
    const secondary = buildReviewPayload({ ...input("secondary"), verdict: "approve", body: "Looks good" });
    const withComments = buildReviewPayload({ ...input("primary"), comments: [{ path: "src/app.ts", line: 4, side: "RIGHT", body: "Note" }] });

    expect(primary).toEqual({ event: "APPROVE", body: "Looks good" });
    expect(secondary).toMatchObject({ event: "APPROVE", commit_id: "abc123" });
    expect(withComments).toMatchObject({ event: "COMMENT", commit_id: "abc123" });
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
      payloads.push(JSON.parse(readFileSync(args.at(-1)!, "utf8")) as unknown);
      return { code: 0, stdout: "{}", stderr: "", killed: false };
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
    expect(calls.map((args) => args[0])).toEqual(["change", "review"]);
    expect(result.message).toContain("https://secondary.code.example/example/widgets/change/12");
  });

  it("fails closed on target drift and malformed submission responses", async () => {
    const driftExec = vi.fn(async () => ({ code: 0, stdout: JSON.stringify({ state: "open", head: "new-head" }), stderr: "", killed: false }));
    const drift = await submitPullRequestReview({ exec: driftExec } as never, { ...input("secondary") });
    expect(drift).toMatchObject({ ok: false });
    expect(drift.message).toContain("head changed from abc123 to new-head");

    const malformedExec = vi.fn(async (_command: string, args: string[]) => args[0] === "change"
      ? { code: 0, stdout: JSON.stringify({ state: "open", head: "abc123" }), stderr: "", killed: false }
      : { code: 0, stdout: "{}", stderr: "", killed: false });
    const malformed = await submitPullRequestReview({ exec: malformedExec } as never, { ...input("secondary") });
    expect(malformed).toMatchObject({ ok: false });
    expect(malformed.message).toContain("Malformed Secondary code host response after review submission");
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
