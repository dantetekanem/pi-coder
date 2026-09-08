import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { submitPullRequestReview, type SubmitReviewInput } from "../review-submit.js";
import { requireProviderSettings } from "../provider-settings.js";
import { createSubmissionJournal, submissionDraftSourceFingerprint, submissionFingerprint } from "../review-submission-journal.js";
import { loadReviewSession, saveReviewSessionWithStatus } from "../review-session.js";
import type { DiffReviewComment } from "../types.js";
import * as persistence from "../review-session-persistence.js";

let directory: string;
let journalPath: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "submission-attempt-"));
  journalPath = join(directory, "attempts");
  vi.stubEnv("PI_CODE_DIFF_SETTINGS_PATH", join(directory, "settings.json"));
  vi.stubEnv("PI_CODE_DIFF_SUBMISSIONS_DIR", journalPath);
  vi.stubEnv("PI_CODE_DIFF_RECEIPTS_DIR", join(directory, "receipts"));
  vi.stubEnv("PI_CODE_DIFF_SESSIONS_DIR", join(directory, "sessions"));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });
function input(): SubmitReviewInput { return { provider: "github", repo: "example/widgets", prNumber: "12", commitId: "a".repeat(40), verdict: "comment", body: "Approved text" }; }
function response(value: unknown, code = 0) { return { code, stdout: JSON.stringify(value), stderr: "", killed: false }; }
function accepted(id = 9) { return response({ id, state: "COMMENTED", commit_id: input().commitId, user: { id: 42, login: "reviewer" } }); }
function api(write = async (_args: string[]) => accepted()) {
  const exec = vi.fn(async (_command: string, args: string[]) => {
    if (args[1] === "user") return response({ id: 42, login: "reviewer" });
    if (args[0] === "pr") return response({ state: "OPEN", headRefOid: input().commitId });
    return write(args);
  });
  return { exec };
}
const posts = (client: ReturnType<typeof api>) => client.exec.mock.calls.filter(([, args]) => args.includes("POST"));

describe("confirmed submission attempt lifecycle", () => {
  it("persists uncertainty and a frozen approved input before admitting the write", async () => {
    const original = input();
    const client = api(async (args) => {
      const name = readdirSync(journalPath).find((entry) => entry.endsWith(".json"))!;
      const stored = JSON.parse(readFileSync(join(journalPath, name), "utf8"));
      expect(stored).toMatchObject({ input: { body: "Approved text" }, actor: { kind: "id", value: "42" }, steps: [{ status: "unknown", startedAt: expect.any(String) }] });
      expect(JSON.parse(readFileSync(args.at(-1)!, "utf8")).body).toBe("Approved text");
      return accepted();
    });
    const pending = submitPullRequestReview(client as never, original);
    original.body = "Caller changed during preflight";
    const result = await pending;
    expect(result).toMatchObject({ status: "submitted", journalStatus: "saved", attemptId: expect.any(String) });
    expect(createSubmissionJournal().load(result.attemptId!)?.steps).toMatchObject([{ status: "submitted", reviewIdSource: "write_response", reviewId: "9" }]);
  });

  it("returns a completed explicit attempt without repeating a provider command", async () => {
    const client = api();
    const first = await submitPullRequestReview(client as never, input());
    const calls = client.exec.mock.calls.length;
    const again = await submitPullRequestReview(client as never, input(), { attemptId: first.attemptId });
    expect(again).toMatchObject({ status: "submitted", attemptId: first.attemptId });
    expect(again.message).toMatch(/already confirmed|previously confirmed/i);
    expect(client.exec).toHaveBeenCalledTimes(calls);
  });

  it("preserves an unknown no-ID attempt on repeated submission rather than issuing another POST", async () => {
    const client = api(async () => { throw new Error("Connection lost after request admission"); });
    const first = await submitPullRequestReview(client as never, input());
    expect(first).toMatchObject({ status: "unknown", attemptId: expect.any(String) });
    const again = await submitPullRequestReview(client as never, input(), { attemptId: first.attemptId });
    expect(again).toMatchObject({ status: "unknown", attemptId: first.attemptId });
    expect(posts(client)).toHaveLength(1);
  });

  it("recovers a write-bound ID through the real scoped adapter without repeating the POST", async () => {
    const client = api(async (args) => {
      if (args.includes("POST")) return { code: 1, stdout: 'HTTP/2.0 502 Bad Gateway\r\n\r\n{"id":9}', stderr: "Connection lost", killed: false };
      const value = args[1]?.includes("/comments?") ? [] : { ...JSON.parse(accepted().stdout), body: input().body };
      return { code: 0, stdout: `HTTP/2.0 200 OK\r\n\r\n${JSON.stringify(value)}`, stderr: "", killed: false };
    });
    const first = await submitPullRequestReview(client as never, input());
    expect(first).toMatchObject({ status: "unknown", steps: [{ reviewId: "9", reviewIdSource: "write_response" }] });
    const { id: _id, ...provider } = structuredClone(requireProviderSettings("github"));
    provider.operations.review!.args.push("-H", "Accept: application/vnd.github+json");
    writeFileSync(join(directory, "settings.json"), JSON.stringify({ version: 1, providers: { github: provider }, repositories: {} }));
    const recovered = await submitPullRequestReview(client as never, input(), { attemptId: first.attemptId });
    expect(recovered).toMatchObject({ status: "submitted", receiptStatus: "saved", reviewedCommitId: input().commitId, attemptId: first.attemptId });
    expect(createSubmissionJournal().load(first.attemptId!)?.steps).toMatchObject([{ status: "submitted", reviewId: "9" }]);
    expect(posts(client)).toHaveLength(1);
    expect(client.exec.mock.calls.slice(-2).map(([, args]) => args[1])).toEqual(["repos/example/widgets/pulls/12/reviews/9", "repos/example/widgets/pulls/12/reviews/9/comments?per_page=100&page=1"]);
  });

  it("rejects changed input on an explicit intent and permits a deliberate identical new intent", async () => {
    let id = 8;
    const client = api(async () => accepted(++id));
    const first = await submitPullRequestReview(client as never, input());
    expect(await submitPullRequestReview(client as never, { ...input(), body: "Changed approval" }, { attemptId: first.attemptId })).toMatchObject({ status: "rejected" });
    expect(posts(client)).toHaveLength(1);
    const next = await submitPullRequestReview(client as never, input(), { newIntent: true });
    expect(next).toMatchObject({ status: "submitted" });
    expect(next.attemptId).not.toBe(first.attemptId);
    expect(posts(client)).toHaveLength(2);
  });

  it("lets only one concurrent caller admit an identical write", async () => {
    let release!: () => void;
    let admitted!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { admitted = resolve; });
    let writes = 0;
    const client = api(async () => { if (++writes === 1) { admitted(); await gate; } return accepted(); });
    const first = submitPullRequestReview(client as never, input());
    await started;
    const concurrent = await submitPullRequestReview(client as never, input());
    release();
    expect(concurrent).toMatchObject({ status: "unknown" });
    expect(posts(client)).toHaveLength(1);
    expect(await first).toMatchObject({ status: "submitted" });
  });

  it("preserves observed approval when concurrent comment cleanup advances the journal", async () => {
    const { id: _id, ...provider } = structuredClone(requireProviderSettings("github"));
    provider.capabilities.atomicReview = false;
    writeFileSync(join(directory, "settings.json"), JSON.stringify({ version: 1, providers: { github: provider }, repositories: {} }));
    const identity = "pr|github|example/widgets|12", sessionId = "observed-approval";
    const comment: DiffReviewComment = { id: "note", fileId: "file.ts", scope: "git-diff", side: "added", startLine: 4, endLine: 4, intent: "comment", body: "Note", anchorStatus: "mapped", captureHash: { algorithm: "sha256", value: "a".repeat(64) } };
    const draft = { allComment: input().body!, allIntent: "comment" as const, comments: [comment] };
    expect(saveReviewSessionWithStatus(identity, {
      state: { activeScope: "git-diff", activeFileId: "file.ts", searchQuery: "", focus: "diff", wrapLines: true, hideUnchanged: false, selectedCommentIndex: 0, selectedLineTargetByScopeFile: {}, draft },
      diffViewMode: "unified", navigatorTreeMode: false, contextLineNavigation: false, commentsGlobal: false, showAllLocales: false, reviewedFileIds: [], navigatorScroll: 0, diffScroll: 0, commentsScroll: 0,
    }, { id: sessionId, revision: input().commitId }).status).toBe("saved");
    const review = { ...input(), verdict: "approve" as const, comments: [{ path: "file.ts", line: 4, side: "RIGHT" as const, body: "Note" }] };
    let release!: () => void, admitted!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { admitted = resolve; });
    const events: string[] = [];
    const client = api(async (args) => {
      const { event } = JSON.parse(readFileSync(args.at(-1)!, "utf8"));
      events.push(event);
      if (event === "APPROVE") { admitted(); await gate; }
      return response({ id: event === "APPROVE" ? 10 : 9, state: event === "APPROVE" ? "APPROVED" : "COMMENTED", commit_id: review.commitId, user: { id: 42, login: "reviewer" } });
    });
    const pending = submitPullRequestReview(client as never, review, { draft: {
      identity, sessionId, comments: [{ id: comment.id, fingerprint: submissionFingerprint(comment) }], bodyComments: [],
      allCommentFingerprint: submissionFingerprint({ allComment: draft.allComment, allIntent: draft.allIntent }), sourceFingerprint: submissionDraftSourceFingerprint(review, draft),
    } });
    await Promise.race([started, pending.then((result) => { throw new Error(`Approval was not admitted: ${result.message}`); })]);
    const name = readdirSync(journalPath).find((entry) => entry.endsWith(".json"))!;
    const concurrent = await submitPullRequestReview(client as never, review, { attemptId: name.slice(0, -5) });
    const journal = createSubmissionJournal(), durable = journal.load(concurrent.attemptId!)!;
    const remaining = loadReviewSession(identity, sessionId)!;
    release();
    const observed = await pending;
    expect(concurrent).toMatchObject({ status: "partial", journalStatus: "saved", draftConsumption: { status: "saved", remainingItems: 1 } });
    expect(remaining.state.draft).toEqual({ ...draft, comments: [] });
    expect(durable.generation).toBe(5);
    expect(observed).toMatchObject({ status: "submitted", journalStatus: "failed", receiptStatus: "saved", draftConsumption: { status: "retained" }, steps: [{ status: "submitted", reviewId: "9" }, { status: "submitted", reviewId: "10", reviewIdSource: "write_response" }] });
    expect(observed.receipt?.reviewIds).toEqual(["9", "10"]);
    expect(observed.message).toContain("Remote acceptance is confirmed");
    expect(journal.load(durable.id)).toEqual(durable);
    expect(durable.steps[1]).toMatchObject({ status: "unknown" });
    expect(durable.steps[1]?.reviewId).toBeUndefined();
    expect(loadReviewSession(identity, sessionId)).toEqual(remaining);
    expect(await submitPullRequestReview(client as never, review, { attemptId: durable.id })).toMatchObject({ status: "partial" });
    expect(events).toEqual(["COMMENT", "APPROVE"]);
  });

  it("preserves scoped read acceptance when its journal update conflicts", async () => {
    let attemptId: string;
    let durable: ReturnType<ReturnType<typeof createSubmissionJournal>["load"]>;
    const client = api(async (args) => {
      if (args.includes("POST")) return { code: 1, stdout: 'HTTP/2.0 502 Bad Gateway\r\n\r\n{"id":9}', stderr: "Connection lost", killed: false };
      const comments = args[1]?.includes("/comments?");
      if (comments) {
        const journal = createSubmissionJournal(), current = journal.load(attemptId)!;
        durable = journal.update(current.id, current.generation, current.steps);
      }
      const value = comments ? [] : { ...JSON.parse(accepted().stdout), body: input().body };
      return { code: 0, stdout: `HTTP/2.0 200 OK\r\n\r\n${JSON.stringify(value)}`, stderr: "", killed: false };
    });
    const first = await submitPullRequestReview(client as never, input());
    attemptId = first.attemptId!;
    const recovered = await submitPullRequestReview(client as never, input(), { attemptId });
    expect(recovered).toMatchObject({ status: "submitted", journalStatus: "failed", receiptStatus: "saved", steps: [{ status: "submitted", reviewId: "9", reviewIdSource: "write_response" }] });
    expect(createSubmissionJournal().load(attemptId)).toEqual(durable!);
    expect(durable!.steps[0]?.status).toBe("unknown");
    expect(posts(client)).toHaveLength(1);
  });

  it("adopts durable evidence on a pre-admission conflict without posting", async () => {
    const client = api();
    const ordinary = client.exec.getMockImplementation()!;
    client.exec.mockImplementation(async (command, args) => {
      if (args[0] === "pr") {
        const journal = createSubmissionJournal();
        const name = readdirSync(journalPath).find((entry) => entry.endsWith(".json"))!;
        const attempt = journal.load(name.slice(0, -5))!;
        journal.update(attempt.id, attempt.generation, [{ ...attempt.steps[0]!, status: "unknown" }]);
      }
      return ordinary(command, args);
    });
    expect(await submitPullRequestReview(client as never, input())).toMatchObject({ status: "unknown", journalStatus: "saved", steps: [{ status: "unknown" }] });
    expect(posts(client)).toHaveLength(0);
  });

  it("does not attribute another actor's response to the captured reviewer", async () => {
    const client = api(async () => response({ id: 9, state: "COMMENTED", commit_id: input().commitId, user: { id: 43, login: "other" } }));
    const result = await submitPullRequestReview(client as never, input());
    expect(result).toMatchObject({ status: "unknown", receiptStatus: "not_applicable" });
    expect(result.message).toMatch(/actor|reviewer/i);
  });

  it("blocks the external write when its intent cannot be persisted", async () => {
    writeFileSync(journalPath, "not a directory");
    const client = api();
    expect(await submitPullRequestReview(client as never, input())).toMatchObject({ status: "rejected" });
    expect(posts(client)).toHaveLength(0);
  });

  it("preserves known remote success if persisting the response fails", async () => {
    const client = api(async () => { mkdirSync(join(journalPath, ".write-lock")); return accepted(); });
    const result = await submitPullRequestReview(client as never, input());
    expect(result).toMatchObject({ status: "submitted", journalStatus: "failed", steps: [{ reviewId: "9", status: "submitted" }] });
    expect(result.message).toContain("Remote acceptance is confirmed");
    expect(createSubmissionJournal().load(result.attemptId!)?.steps[0]?.status).toBe("unknown");
    expect(posts(client)).toHaveLength(1);
  });

  it("does not report admission when the pre-write journal replacement fails", async () => {
    const original = persistence.writeReviewSessionFileAtomic;
    let writes = 0;
    vi.spyOn(persistence, "writeReviewSessionFileAtomic").mockImplementation((path, contents) => {
      if (++writes === 2) throw new Error("Admission save failed");
      original(path, contents);
    });
    const client = api();
    expect(await submitPullRequestReview(client as never, input())).toMatchObject({ status: "rejected", journalStatus: "failed", steps: [{ status: "pending" }] });
    expect(posts(client)).toHaveLength(0);
  });

  it.each(["actor", "head", "provider contract"])("rechecks %s before retrying a known-rejected step", async (changed) => {
    const client = api(async () => ({ code: 1, stdout: 'HTTP/2.0 403 Forbidden\r\n\r\n{}', stderr: "Forbidden", killed: false }));
    const first = await submitPullRequestReview(client as never, input());
    if (changed === "provider contract") {
      const { id: _id, ...provider } = structuredClone(requireProviderSettings("github"));
      provider.executable = "another-provider-command";
      writeFileSync(join(directory, "settings.json"), JSON.stringify({ version: 1, providers: { github: provider }, repositories: {} }));
    }
    const unchanged = client.exec.getMockImplementation()!;
    client.exec.mockImplementation(async (command, args) => {
      if (changed === "actor" && args[1] === "user") return response({ id: 43, login: "other" });
      if (changed === "head" && args[0] === "pr") return response({ state: "OPEN", headRefOid: "b".repeat(40) });
      return unchanged(command, args);
    });
    const retried = await submitPullRequestReview(client as never, input(), { attemptId: first.attemptId });
    expect(retried).toMatchObject({ status: "rejected", journalStatus: "saved" });
    expect(retried.message).toMatch(/reviewer differs|head changed|provider contract changed/);
    expect(posts(client)).toHaveLength(1);
  });

  it("does not treat a rejection-shaped response containing a possible created review as safely retryable", async () => {
    const client = api(async () => ({ code: 1, stdout: 'HTTP/2.0 403 Forbidden\r\n\r\n{"id":9,"state":"PENDING"}', stderr: "Forbidden", killed: false }));
    expect(await submitPullRequestReview(client as never, input())).toMatchObject({ status: "unknown", steps: [{ reviewId: "9", reviewIdSource: "write_response" }] });
  });

  it("does not emit provider diagnostic terminal controls through the shared result", async () => {
    const client = api(async () => ({ code: 1, stdout: "", stderr: "Lost connection\n\x1b]52;c;bad\x07", killed: false }));
    const result = await submitPullRequestReview(client as never, input());
    expect(result.status).toBe("unknown");
    expect(result.message).toContain("Lost connection\n");
    expect(result.message).not.toMatch(/[\x1b\x07]/);
  });

  it("resumes only a rejected verdict after separately confirmed comments", async () => {
    const { id: _id, ...provider } = structuredClone(requireProviderSettings("github"));
    provider.capabilities.atomicReview = false;
    writeFileSync(join(directory, "settings.json"), JSON.stringify({ version: 1, providers: { github: provider }, repositories: {} }));
    const events: string[] = [];
    const client = api(async (args) => {
      const payload = JSON.parse(readFileSync(args.at(-1)!, "utf8"));
      events.push(payload.event);
      if (events.length === 2) return { code: 1, stdout: 'HTTP/2.0 403 Forbidden\r\n\r\n{"message":"Forbidden"}', stderr: "Forbidden", killed: false };
      return response({ id: events.length, state: payload.event === "APPROVE" ? "APPROVED" : "COMMENTED", commit_id: input().commitId, user: { id: 42, login: "reviewer" } });
    });
    const reviewInput = { ...input(), verdict: "approve" as const, prAuthorLogin: "author", comments: [{ path: "file.ts", line: 4, side: "RIGHT" as const, body: "Note" }] };
    const first = await submitPullRequestReview(client as never, reviewInput);
    expect(first).toMatchObject({ status: "partial" });
    expect(await submitPullRequestReview(client as never, reviewInput, { attemptId: first.attemptId })).toMatchObject({ status: "submitted" });
    expect(events).toEqual(["COMMENT", "APPROVE", "APPROVE"]);
  });
});
