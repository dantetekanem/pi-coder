import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareSubmissionHandoff, submitPullRequestReview, type SubmitReviewInput } from "../review-submit.js";
import { createSubmissionJournal, submissionDraftSourceFingerprint, submissionFingerprint } from "../review-submission-journal.js";
import { loadReviewSession, saveReviewSession, type ReviewSessionData } from "../review-session.js";
import { requireProviderSettings } from "../provider-settings.js";
import { hasConsumableConfirmedSubmissionDraft } from "../review-submission-consumption.js";

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "submission-handoff-"));
  vi.stubEnv("PI_CODE_DIFF_SETTINGS_PATH", join(directory, "settings.json"));
  vi.stubEnv("PI_CODE_DIFF_SUBMISSIONS_DIR", join(directory, "journal"));
  vi.stubEnv("PI_CODE_DIFF_RECEIPTS_DIR", join(directory, "receipts"));
  vi.stubEnv("PI_CODE_DIFF_SESSIONS_DIR", join(directory, "sessions"));
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });
const input = (): SubmitReviewInput => ({ provider: "github", repo: "example/widgets", prNumber: "12", commitId: "a".repeat(40), verdict: "comment", body: "Raw body", comments: [4, 8].map((line) => ({ path: "src/app.ts", line, side: "RIGHT", body: `Raw comment ${line}` })) });
const context = () => ({ sourceDigest: submissionFingerprint("raw source"), draft: {
  identity: "pr|github|example/widgets|12", sessionId: "instance",
  comments: ["one", "two"].map((id) => ({ id, fingerprint: submissionFingerprint(id) })),
  bodyComments: [{ id: "file-note", fingerprint: submissionFingerprint("file-note") }], allCommentFingerprint: submissionFingerprint("overall"),
} });
function client() {
  const payloads: unknown[] = [];
  const exec = vi.fn(async (_command: string, args: string[]) => {
    let value: unknown;
    if (args[1] === "user") value = { id: 42, login: "reviewer" };
    else if (args[0] === "pr") value = { state: "OPEN", headRefOid: input().commitId };
    else {
      const payload = JSON.parse(readFileSync(args.at(-1)!, "utf8"));
      payloads.push(payload);
      value = { id: payloads.length, state: payload.event === "APPROVE" ? "APPROVED" : "COMMENTED", commit_id: input().commitId, user: { id: 42, login: "reviewer" } };
    }
    return { code: 0, stdout: JSON.stringify(value), stderr: "", killed: false };
  });
  return { exec, payloads };
}

describe("trusted unconfirmed grammar handoff", () => {
  it("persists immutable raw context without making a confirmed submission attempt", () => {
    const raw = input();
    const binding = context();
    const handoff = prepareSubmissionHandoff(raw, binding);
    raw.comments![0]!.body = "Caller mutation";
    binding.draft.comments[0]!.id = "different";
    const journal = createSubmissionJournal();
    expect(journal.load(handoff.id)).toBeNull();
    expect(journal.loadHandoff(handoff.id)).toMatchObject({ kind: "handoff", input: { comments: [{ body: "Raw comment 4" }, { body: "Raw comment 8" }] }, draft: { comments: [{ id: "one" }, { id: "two" }] } });
    expect(journal.findHandoffForDraft(context().draft.identity, "instance", context().sourceDigest)?.id).toBe(handoff.id);
    expect(journal.findHandoffForDraft(context().draft.identity, "other-instance", context().sourceDigest)).toBeNull();
    expect(prepareSubmissionHandoff(input(), context()).id).toBe(handoff.id);
  });

  it("binds final grammar text and retained original indexes to the trusted raw draft", async () => {
    const handoff = prepareSubmissionHandoff(input(), context());
    const api = client();
    const final = { ...input(), body: "Corrected body", comments: [{ ...input().comments![1]!, body: "Corrected second comment" }] };
    const result = await submitPullRequestReview(api as never, final, { handoffId: handoff.id, handoffCommentIndexes: [1] });
    expect(result.status).toBe("submitted");
    expect(createSubmissionJournal().load(result.attemptId!)).toMatchObject({ handoffId: handoff.id, sourceDigest: context().sourceDigest, draft: { comments: [context().draft.comments[1]] }, input: { body: "Corrected body", comments: final.comments } });
    expect(api.payloads).toHaveLength(1);
    expect(JSON.stringify(api.payloads)).not.toMatch(/handoff|fingerprint|sessionId/);
  });

  it("consumes confirmed comments and later the verdict body through real service and stores", async () => {
    const { id: _id, ...provider } = structuredClone(requireProviderSettings("github"));
    provider.capabilities.atomicReview = false;
    writeFileSync(join(directory, "settings.json"), JSON.stringify({ version: 1, providers: { github: provider }, repositories: {} }));
    const review = { ...input(), verdict: "approve" as const, prAuthorLogin: "author", comments: [input().comments![0]!] };
    const line = { id: "one", fileId: "src/app.ts", scope: "all-files" as const, side: "added" as const, intent: "comment" as const, startLine: 4, endLine: 4, body: review.comments[0]!.body, anchorStatus: "mapped" as const, captureHash: { algorithm: "sha256" as const, value: "1".repeat(64) } };
    const raw = { allComment: review.body!, allIntent: "comment" as const, comments: [line] };
    const session: ReviewSessionData = { state: { activeScope: "all-files", activeFileId: line.fileId, searchQuery: "", focus: "diff", wrapLines: true, hideUnchanged: false, selectedCommentIndex: 0, selectedLineTargetByScopeFile: {}, draft: raw }, diffViewMode: "unified", navigatorTreeMode: false, contextLineNavigation: true, commentsGlobal: false, reviewedFileIds: [], navigatorScroll: 0, diffScroll: 0, commentsScroll: 0 };
    const association = { sourceDigest: submissionFingerprint("original source"), draft: { ...context().draft, comments: [{ id: line.id, fingerprint: submissionFingerprint(line) }], bodyComments: [], allCommentFingerprint: submissionFingerprint({ allComment: raw.allComment, allIntent: raw.allIntent }), sourceFingerprint: submissionDraftSourceFingerprint(review, raw) } };
    saveReviewSession(association.draft.identity, session, { id: "instance", revision: review.commitId });
    const handoff = prepareSubmissionHandoff(review, association);
    const api = client();
    const execute = api.exec.getMockImplementation()!;
    const events: string[] = [];
    api.exec.mockImplementation(async (command, args) => {
      if (args.includes("POST")) {
        events.push(JSON.parse(readFileSync(args.at(-1)!, "utf8")).event);
        if (events.length === 2) return { code: 1, stdout: "HTTP/2.0 403 Forbidden\r\n\r\n{}", stderr: "Forbidden", killed: false };
      }
      return execute(command, args);
    });
    const partial = await submitPullRequestReview(api as never, review, { handoffId: handoff.id, handoffCommentIndexes: [0] });
    expect(partial).toMatchObject({ status: "partial", draftConsumption: { status: "saved", remainingItems: 1 } });
    const remaining = loadReviewSession(association.draft.identity, "instance")!;
    expect(remaining.state.draft).toEqual({ allComment: raw.allComment, allIntent: "comment", comments: [] });
    expect(createSubmissionJournal().findForDraft(association.draft.identity, "instance", "changed source", submissionDraftSourceFingerprint(review, remaining.state.draft))?.id).toBe(partial.attemptId);
    const complete = await submitPullRequestReview(api as never, review, { attemptId: partial.attemptId });
    expect(complete).toMatchObject({ status: "submitted", draftConsumption: { status: "saved", remainingItems: 0 } });
    expect(loadReviewSession(association.draft.identity, "instance")).toBeNull();
    expect(events).toEqual(["COMMENT", "APPROVE", "APPROVE"]);
  });

  it("binds a handoff once instead of turning changed retry text into another write", async () => {
    const handoff = prepareSubmissionHandoff(input(), context());
    const api = client();
    const options = { handoffId: handoff.id, handoffCommentIndexes: [0, 1] };
    const first = await submitPullRequestReview(api as never, input(), options);
    expect(first.status).toBe("submitted");
    expect(await submitPullRequestReview(api as never, input(), options)).toMatchObject({ status: "submitted", attemptId: first.attemptId });
    expect(await submitPullRequestReview(api as never, { ...input(), body: "Different decision" }, options)).toMatchObject({ status: "rejected" });
    expect(api.payloads).toHaveLength(1);
  });

  it("does not leave a second handoff falsely bound through another intent's identical payload", async () => {
    const first = prepareSubmissionHandoff(input(), context());
    const second = prepareSubmissionHandoff({ ...input(), body: "Different unconfirmed optional body" }, context());
    const api = client();
    expect((await submitPullRequestReview(api as never, input(), { handoffId: first.id, handoffCommentIndexes: [0, 1] })).status).toBe("submitted");
    expect(await submitPullRequestReview(api as never, input(), { handoffId: second.id, handoffCommentIndexes: [0, 1] })).toMatchObject({ status: "rejected", message: expect.stringContaining("existing attempt") });
    expect(api.payloads).toHaveLength(1);
    const deliberate = await submitPullRequestReview(api as never, input(), { handoffId: second.id, handoffCommentIndexes: [0, 1], newIntent: true });
    expect(deliberate.status).toBe("submitted");
    expect(createSubmissionJournal().load(deliberate.attemptId!)?.handoffId).toBe(second.id);
    expect(api.payloads).toHaveLength(2);
  });

  it.each([undefined, [], [0], [0, 0], [-1, 1], [0, 2], [0.5, 1]].map((indexes) => ({ indexes })))("rejects an invalid original-index selection $indexes before provider reads or writes", async ({ indexes }) => {
    const handoff = prepareSubmissionHandoff(input(), context());
    const api = client();
    expect(await submitPullRequestReview(api as never, input(), { handoffId: handoff.id, handoffCommentIndexes: indexes })).toMatchObject({ status: "rejected" });
    expect(api.exec).not.toHaveBeenCalled();
  });

  it.each(["target", "revision", "anchor", "execution directory"])("rejects changed handoff %s instead of consuming unrelated context", async (changed) => {
    const handoff = prepareSubmissionHandoff(input(), context());
    const final = input();
    if (changed === "target") final.prNumber = "13";
    if (changed === "revision") final.commitId = "b".repeat(40);
    if (changed === "anchor") final.comments![0]!.line = 5;
    if (changed === "execution directory") final.gitRoot = "/another-provider-context";
    const api = client();
    expect(await submitPullRequestReview(api as never, final, { handoffId: handoff.id, handoffCommentIndexes: [0, 1] })).toMatchObject({ status: "rejected" });
    expect(api.exec).not.toHaveBeenCalled();
  });

  it.each(["records", "bytes"])("shares the journal %s limit without evicting unconfirmed context", (limit) => {
    const handoff = prepareSubmissionHandoff(input(), context());
    const bytes = statSync(join(directory, "journal", `${handoff.id}.handoff.json`)).size;
    const journal = createSubmissionJournal(limit === "records" ? { maxRecords: 1 } : { maxBytes: bytes });
    expect(() => journal.create({ input: input(), actor: { kind: "id", value: "42", login: "reviewer" }, providerDigest: handoff.providerDigest, sourceDigest: handoff.sourceDigest, draft: handoff.draft, handoffId: handoff.id,
      steps: [{ kind: "review", verdict: "comment", bodyIncluded: true, commentIndexes: [0, 1], status: "pending" }],
    })).toThrow(/capacity/);
    expect(journal.loadHandoff(handoff.id)).toEqual(handoff);
  });

  it("fails closed on changed stored handoff context rather than recreating it", () => {
    const handoff = prepareSubmissionHandoff(input(), context());
    handoff.input.comments![0]!.line = 99;
    writeFileSync(join(directory, "journal", `${handoff.id}.handoff.json`), JSON.stringify(handoff));
    expect(() => createSubmissionJournal().loadHandoff(handoff.id)).toThrow(/captured context changed/);
    expect(() => prepareSubmissionHandoff(input(), context())).toThrow(/captured context changed/);
  });

  it("does not use an unconfirmed handoff ID as an approved attempt", async () => {
    const handoff = prepareSubmissionHandoff(input(), context());
    const api = client();
    expect(await submitPullRequestReview(api as never, input(), { attemptId: handoff.id })).toMatchObject({ status: "rejected" });
    expect(api.exec).not.toHaveBeenCalled();
  });

  it("restores an unbound handoff after an all-omitted completed decision leaves the exact original source", async () => {
    const line = { id: "one", fileId: "src/app.ts", scope: "all-files" as const, side: "added" as const, intent: "comment" as const, startLine: 4, endLine: 4, body: input().comments![0]!.body, anchorStatus: "mapped" as const, captureHash: { algorithm: "sha256" as const, value: "1".repeat(64) } };
    const raw = { allComment: input().body!, allIntent: "comment" as const, comments: [line] };
    const session: ReviewSessionData = { state: { activeScope: "all-files", activeFileId: line.fileId, searchQuery: "", focus: "diff", wrapLines: true, hideUnchanged: false, selectedCommentIndex: 0, selectedLineTargetByScopeFile: {}, draft: raw }, diffViewMode: "unified", navigatorTreeMode: false, contextLineNavigation: true, commentsGlobal: false, reviewedFileIds: [], navigatorScroll: 0, diffScroll: 0, commentsScroll: 0 };
    const review = { ...input(), comments: [input().comments![0]!] };
    const association = { sourceDigest: context().sourceDigest, draft: { ...context().draft, comments: [{ id: line.id, fingerprint: submissionFingerprint(line) }], bodyComments: [], allCommentFingerprint: submissionFingerprint({ allComment: raw.allComment, allIntent: raw.allIntent }), sourceFingerprint: submissionDraftSourceFingerprint(review, raw) } };
    saveReviewSession(association.draft.identity, session, { id: "instance", revision: review.commitId });
    const handoff = prepareSubmissionHandoff(review, association);
    const api = client();
    const result = await submitPullRequestReview(api as never, { ...input(), verdict: "approve", body: undefined, comments: [] }, { handoffId: handoff.id, handoffCommentIndexes: [] });
    expect(result).toMatchObject({ status: "submitted", draftConsumption: { status: "retained", remainingItems: 2 } });
    const journal = createSubmissionJournal(), remaining = loadReviewSession(association.draft.identity, "instance")!;
    expect(remaining.state.draft).toEqual(raw);
    const completed = journal.findForDraft(association.draft.identity, "instance", association.sourceDigest)!;
    expect(completed.id).toBe(result.attemptId);
    expect(completed.draft).toEqual({ ...association.draft, comments: [], bodyComments: [], allCommentFingerprint: undefined });
    expect(journal.findHandoffForDraft(association.draft.identity, "instance", association.sourceDigest)).toBeNull();
    expect(hasConsumableConfirmedSubmissionDraft(completed, remaining.state.draft)).toBe(false);
    const fresh = prepareSubmissionHandoff(review, association);
    expect(fresh.id).not.toBe(handoff.id);
    expect(prepareSubmissionHandoff(review, association).id).toBe(fresh.id);
    expect(journal.findHandoffForDraft(association.draft.identity, "instance", association.sourceDigest)?.id).toBe(fresh.id);
    const next = await submitPullRequestReview(api as never, { ...input(), verdict: "approve", body: undefined, comments: [] }, { handoffId: fresh.id, handoffCommentIndexes: [], newIntent: true });
    expect(next).toMatchObject({ status: "submitted" });
    expect(next.attemptId).not.toBe(result.attemptId);
    expect(journal.load(next.attemptId!)?.handoffId).toBe(fresh.id);
    expect(api.payloads).toHaveLength(2);
  });
});
