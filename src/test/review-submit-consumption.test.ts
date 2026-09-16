import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireProviderSettings } from "../provider-settings.js";
import { submissionFingerprint } from "../review-submission-journal.js";
import { submitPullRequestReview, type SubmitReviewInput } from "../review-submit.js";

const consume = vi.hoisted(() => vi.fn());
vi.mock("../review-submission-consumption.js", () => ({ consumeConfirmedSubmissionDraft: consume }));
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "submit-consumption-"));
  vi.stubEnv("PI_CODE_DIFF_SETTINGS_PATH", join(directory, "settings.json"));
  vi.stubEnv("PI_CODE_DIFF_SUBMISSIONS_DIR", join(directory, "journal"));
  vi.stubEnv("PI_CODE_DIFF_SESSIONS_DIR", join(directory, "sessions"));
  vi.stubEnv("PI_CODE_DIFF_RECEIPTS_DIR", join(directory, "receipts"));
  consume.mockReset().mockReturnValue({ status: "saved", remainingItems: 1, message: "One draft item remains." });
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });
const input = (): SubmitReviewInput => ({ provider: "github", repo: "example/widgets", prNumber: "12", commitId: "a".repeat(40), verdict: "comment", body: "Approved body", comments: [{ path: "file.ts", line: 4, side: "RIGHT", body: "Approved comment" }], prAuthorLogin: "author" });
const binding = () => ({ identity: "pr|github|example/widgets|12", sessionId: "instance", comments: [{ id: "stable", fingerprint: submissionFingerprint("original") }], bodyComments: [], allCommentFingerprint: submissionFingerprint("overall") });
function client(mode: "submitted" | "partial" | "unknown" | "journal-failed") {
  let posts = 0;
  return { exec: vi.fn(async (_command: string, args: string[]) => {
    let value: unknown;
    if (args[1] === "user") value = { id: 42, login: "reviewer" };
    else if (args[0] === "pr") value = { state: "OPEN", headRefOid: input().commitId };
    else {
      posts++;
      if (mode === "unknown") return { code: 1, stdout: "", stderr: "Connection lost", killed: true };
      if (mode === "partial" && posts === 2) return { code: 1, stdout: "HTTP/2.0 403 Forbidden\r\n\r\n{}", stderr: "Forbidden", killed: false };
      if (mode === "journal-failed") mkdirSync(join(directory, "journal", ".write-lock"));
      value = { id: posts, state: "COMMENTED", commit_id: input().commitId, user: { id: 42, login: "reviewer" } };
    }
    return { code: 0, stdout: JSON.stringify(value), stderr: "", killed: false };
  }) };
}

describe("shared service draft-consumption boundary", () => {
  it.each(["submitted", "partial"] as const)("consumes durable confirmed scope for a %s result", async (mode) => {
    const review = input();
    if (mode === "partial") {
      const { id: _id, ...provider } = structuredClone(requireProviderSettings("github"));
      provider.capabilities.atomicReview = false;
      writeFileSync(join(directory, "settings.json"), JSON.stringify({ version: 1, providers: { github: provider }, repositories: {} }));
      review.verdict = "approve";
    }
    const result = await submitPullRequestReview(client(mode) as never, review, { draft: binding() });
    expect(result.status).toBe(mode);
    expect(consume).toHaveBeenCalledOnce();
    expect(consume.mock.calls[0]![0]).toMatchObject({ id: result.attemptId, draft: binding(), steps: [expect.objectContaining({ status: "submitted", commentIndexes: [0] }), ...(mode === "partial" ? [expect.objectContaining({ status: "rejected", commentIndexes: [] })] : [])] });
    expect(result.draftConsumption).toEqual({ status: "saved", remainingItems: 1, message: "One draft item remains." });
    expect(result.message).toContain("One draft item remains.");
  });

  it("retains drafts when confirmed response evidence could not be journaled", async () => {
    const result = await submitPullRequestReview(client("journal-failed") as never, input(), { draft: binding() });
    expect(result).toMatchObject({ status: "submitted", journalStatus: "failed", draftConsumption: { status: "retained" } });
    expect(consume).not.toHaveBeenCalled();
  });

  it("does not consume unknown scope", async () => {
    const result = await submitPullRequestReview(client("unknown") as never, input(), { draft: binding() });
    expect(result).toMatchObject({ status: "unknown", draftConsumption: { status: "not_applicable" } });
    expect(consume).not.toHaveBeenCalled();
  });

  it("preserves remote success and reports a local consumer failure without throwing", async () => {
    consume.mockImplementation(() => { throw new Error("Local save failed"); });
    const result = await submitPullRequestReview(client("submitted") as never, input(), { draft: binding() });
    expect(result).toMatchObject({ status: "submitted", draftConsumption: { status: "failed" } });
    expect(result.message).toContain("Local save failed");
    expect(consume).toHaveBeenCalledOnce();
  });
});
