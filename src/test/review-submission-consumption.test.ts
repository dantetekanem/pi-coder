import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as sessions from "../review-session.js";
import * as persistence from "../review-session-persistence.js";
import { consumeConfirmedSubmissionDraft, hasConsumableConfirmedSubmissionDraft } from "../review-submission-consumption.js";
import { createSubmissionJournal, submissionDraftSourceFingerprint, submissionFingerprint, type SubmissionAttempt } from "../review-submission-journal.js";
import type { DiffReviewComment } from "../types.js";

const identity = "pr|github|example/widgets|12", sessionId = "consumption-test";
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "submission-consumption-"));
  vi.stubEnv("PI_CODE_DIFF_SESSIONS_DIR", join(directory, "sessions"));
  vi.stubEnv("PI_CODE_DIFF_SUBMISSIONS_DIR", join(directory, "journal"));
  vi.stubEnv("PI_CODE_DIFF_SETTINGS_PATH", join(directory, "settings.json"));
  vi.stubEnv("PI_CODE_DIFF_RECEIPTS_DIR", join(directory, "receipts"));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });
const comment = (id: string): DiffReviewComment => ({ id, fileId: "src/app.ts", scope: "git-diff", side: "added", startLine: 4, endLine: 4, intent: "comment", body: "Same text", anchorStatus: "mapped", captureHash: { algorithm: "sha256", value: "a".repeat(64) } });
function current() { return sessions.loadReviewSession(identity, sessionId)!; }
function save(data: sessions.ReviewSessionData) {
  const old = current();
  const result = sessions.saveReviewSessionWithStatus(identity, data, { id: sessionId, expectedGeneration: old?.generation, revision: "head", fileSignatures: { "src/app.ts": "original signature" }, meta: { kind: "remote", label: "Review", cwd: "/repo" } });
  expect(result.status).toBe("saved");
}
function fixture(partial = false, bodyIncluded = true): SubmissionAttempt {
  save({ state: { activeScope: "git-diff", activeFileId: "src/app.ts", searchQuery: "keep", focus: "diff", wrapLines: true, hideUnchanged: false, selectedCommentIndex: 1, selectedLineTargetByScopeFile: {}, draft: { allComment: "Overall note", allIntent: "comment", comments: [comment("accepted"), comment("body")] } }, diffViewMode: "unified", navigatorTreeMode: true, contextLineNavigation: true, commentsGlobal: false, showAllLocales: true, reviewedFileIds: ["src/app.ts"], navigatorScroll: 3, diffScroll: 4, commentsScroll: 5 });
  const input = { provider: "github", repo: "example/widgets", prNumber: "12", commitId: "head", baseCommitId: "base", gitRoot: "/repo", verdict: "approve" as const, body: "Overall note", comments: [{ path: "src/app.ts", line: 4, side: "RIGHT" as const, body: "Same text" }] };
  const draft = current().state.draft;
  return createSubmissionJournal().create({ input, actor: { kind: "id", value: "42", login: "reviewer" }, providerDigest: submissionFingerprint("provider"), sourceDigest: submissionFingerprint("original source digest"), draft: { identity, sessionId, comments: [{ id: "accepted", fingerprint: submissionFingerprint(draft.comments[0]) }], bodyComments: [{ id: "body", fingerprint: submissionFingerprint(draft.comments[1]) }], allCommentFingerprint: submissionFingerprint({ allComment: draft.allComment, allIntent: draft.allIntent }), sourceFingerprint: submissionDraftSourceFingerprint(input, draft) }, steps: [{ kind: partial ? "comments" : "review", verdict: "comment", status: "submitted", bodyIncluded, commentIndexes: [0], reviewId: "9", reviewIdSource: "write_response" }, ...(partial ? [{ kind: "verdict" as const, verdict: "approve" as const, status: "pending" as const, bodyIncluded: false, commentIndexes: [] }] : [])] }).attempt;
}
function failAtomic(predicate: (path: string, text: string) => boolean) {
  const write = persistence.writeReviewSessionFileAtomic;
  return vi.spyOn(persistence, "writeReviewSessionFileAtomic").mockImplementation((path, text) => {
    if (predicate(path, text)) throw new Error("injected storage failure");
    return write(path, text);
  });
}

describe("confirmed submission draft consumption", () => {
  it("terminally deletes only a fully accepted, truly empty draft and remains safe on repeat", () => {
    const attempt = fixture();
    expect(consumeConfirmedSubmissionDraft(attempt)).toMatchObject({ status: "saved", remainingItems: 0 });
    expect(current()).toBeNull();
    expect(JSON.parse(readFileSync(sessions.getReviewSessionPathForDiagnostics(sessionId), "utf8"))).toMatchObject({ deleted: true, generation: 2 });
    expect(consumeConfirmedSubmissionDraft(createSubmissionJournal().load(attempt.id)!)).toMatchObject({ status: "unavailable" });
  });

  it("keeps an empty partial session and its full snapshot metadata, with a resumable journal alias", () => {
    const attempt = fixture(true), before = current();
    expect(consumeConfirmedSubmissionDraft(attempt)).toMatchObject({ status: "saved", remainingItems: 0 });
    const after = current(), journal = createSubmissionJournal();
    expect(after).toEqual({ ...before, generation: 2, updatedAt: after.updatedAt, state: { ...before.state, draft: { ...before.state.draft, allComment: "", comments: [] } } });
    const remaining = submissionDraftSourceFingerprint(attempt.input, after.state.draft);
    const resumed = journal.findForDraft(identity, sessionId, submissionFingerprint("changed digest"), remaining)!;
    expect(resumed).toMatchObject({ id: attempt.id, remainingSourceFingerprint: remaining, generation: 2, steps: [{ status: "submitted" }, { status: "pending" }] });
    expect(consumeConfirmedSubmissionDraft(resumed)).toMatchObject({ status: "retained", remainingItems: 0 });
    expect(current().generation).toBe(2);
    const completed = journal.update(resumed.id, resumed.generation, resumed.steps.map((step) => ({ ...step, status: "submitted", reviewId: step.reviewId ?? "10", reviewIdSource: "write_response" })));
    expect(consumeConfirmedSubmissionDraft(completed)).toMatchObject({ status: "saved", remainingItems: 0 });
    expect(current()).toBeNull();
  });

  it.each(["discuss", "comment"] as const)("recognizes settled retained %s feedback through the real remaining-source lookup", (intent) => {
    const original = fixture(false, false), data = current(), journal = createSubmissionJournal();
    data.state.draft.comments[1]!.intent = intent;
    save(data);
    const attempt = journal.create({ ...original, draft: { ...original.draft!, sourceFingerprint: submissionDraftSourceFingerprint(original.input, data.state.draft) } }, true).attempt;
    expect(hasConsumableConfirmedSubmissionDraft(attempt, current().state.draft)).toBe(true);
    expect(consumeConfirmedSubmissionDraft(attempt)).toMatchObject({ status: "saved", remainingItems: 2 });
    const remaining = current().state.draft;
    const found = journal.findForDraft(identity, sessionId, submissionFingerprint("remaining digest"), submissionDraftSourceFingerprint(attempt.input, remaining))!;
    expect(found.id).toBe(attempt.id);
    expect(hasConsumableConfirmedSubmissionDraft(found, remaining)).toBe(false);
    expect(remaining.comments).toEqual([{ ...comment("body"), intent }]);
  });

  it("consumes comments in captured grammar order and only consumes body scope when accepted", () => {
    const attempt = fixture(true, false);
    expect(consumeConfirmedSubmissionDraft(attempt)).toMatchObject({ status: "saved", remainingItems: 2 });
    expect(current().state.draft).toMatchObject({ allComment: "Overall note", comments: [comment("body")] });
  });

  it.each(["pending", "unknown", "rejected"] as const)("consumes final grammar indexes while retaining %s comment/body scope", (status) => {
    const original = fixture(), journal = createSubmissionJournal();
    const attempt = journal.create({ ...original, input: { ...original.input, comments: [original.input.comments![0]!, original.input.comments![0]!] },
      draft: { ...original.draft!, comments: [original.draft!.bodyComments[0]!, original.draft!.comments[0]!], bodyComments: [] },
      steps: [{ ...original.steps[0]!, bodyIncluded: false, commentIndexes: [1] }, { kind: "review", verdict: "comment", status, bodyIncluded: true, commentIndexes: [0] }],
    }, true).attempt;
    expect(consumeConfirmedSubmissionDraft(attempt)).toMatchObject({ status: "saved", remainingItems: 2 });
    expect(current().state.draft).toMatchObject({ allComment: "Overall note", comments: [comment("body")] });
  });

  it.each(["pending", "unknown", "rejected"] as const)("retains %s scope and has no work without confirmed steps", (status) => {
    const attempt = fixture();
    attempt.steps[0]!.status = status;
    const before = current();
    expect(consumeConfirmedSubmissionDraft(attempt)).toMatchObject({ status: "not_applicable" });
    expect(current()).toEqual(before);
  });

  it("has no work without a bound draft", () => {
    const attempt = fixture();
    delete attempt.draft;
    expect(consumeConfirmedSubmissionDraft(attempt)).toMatchObject({ status: "not_applicable" });
  });

  it.each([
    { body: "Same text " }, { intent: "discuss" as const }, { startLine: 5 },
    { captureHash: { algorithm: "sha256" as const, value: "b".repeat(64) } },
  ])("retains exact item edits and same-text other IDs without aliasing new feedback: %j", (edit) => {
    const attempt = fixture(true), changed = current();
    changed.state.draft.comments[0] = { ...changed.state.draft.comments[0]!, ...edit };
    changed.state.draft.comments.push(comment("new"));
    save(changed);
    expect(consumeConfirmedSubmissionDraft(attempt)).toMatchObject({ status: "saved", remainingItems: 2 });
    expect(current().state.draft.comments).toEqual([changed.state.draft.comments[0], comment("new")]);
    const journal = createSubmissionJournal(), fingerprint = submissionDraftSourceFingerprint(attempt.input, current().state.draft);
    expect(journal.findForDraft(identity, sessionId, submissionFingerprint("new digest"), fingerprint)).toBeNull();
    expect(journal.load(attempt.id)!.generation).toBe(1);
  });

  it.each(["allComment", "allIntent"] as const)("retains edits to %s rather than treating normalized text as accepted", (field) => {
    const attempt = fixture();
    const changed = current();
    if (field === "allComment") changed.state.draft.allComment += " ";
    else changed.state.draft.allIntent = "discuss";
    save(changed);
    expect(consumeConfirmedSubmissionDraft(attempt)).toMatchObject({ status: "saved", remainingItems: 1 });
    expect(current().state.draft[field]).toBe(changed.state.draft[field]);
  });

  it.each(["source", "current"])("fails closed on duplicated/conflicting %s IDs", (where) => {
    const attempt = fixture();
    if (where === "source") attempt.draft!.bodyComments.push({ ...attempt.draft!.comments[0]!, fingerprint: submissionFingerprint("conflict") });
    else { const changed = current(); changed.state.draft.comments.push(comment("accepted")); save(changed); }
    const before = current();
    expect(hasConsumableConfirmedSubmissionDraft(attempt, before.state.draft)).toBe(false);
    expect(consumeConfirmedSubmissionDraft(attempt)).toMatchObject({ status: "retained" });
    expect(current()).toEqual(before);
  });

  it("does not rewrite a snapshot with no exact matching scope", () => {
    const attempt = fixture(), changed = current();
    changed.state.draft.comments = [comment("new")]; changed.state.draft.allComment = "New note";
    save(changed);
    const before = current();
    expect(consumeConfirmedSubmissionDraft(attempt)).toMatchObject({ status: "retained", remainingItems: 2 });
    expect(current()).toEqual(before);
  });

  it("retains a concurrent generation without retrying or merging", () => {
    const attempt = fixture(true), originalSave = sessions.saveReviewSessionWithStatus;
    const spy = vi.spyOn(sessions, "saveReviewSessionWithStatus").mockImplementationOnce((identity, data, context) => {
      const concurrent = current(); concurrent.state.draft.allComment = "Concurrent note";
      originalSave(identity, concurrent, { id: sessionId, expectedGeneration: concurrent.generation, revision: concurrent.revision });
      return originalSave(identity, data, context);
    });
    expect(consumeConfirmedSubmissionDraft(attempt)).toMatchObject({ status: "retained", message: expect.stringMatching(/conflict/i) });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(current().state.draft).toMatchObject({ allComment: "Concurrent note", comments: [comment("accepted"), comment("body")] });
  });

  it("retains drafts if the pre-consumption checkpoint cannot be persisted", () => {
    const attempt = fixture(true), before = current();
    mkdirSync(join(directory, "journal", ".write-lock"));
    expect(consumeConfirmedSubmissionDraft(attempt)).toMatchObject({ status: "failed", message: expect.stringMatching(/checkpoint/i) });
    expect(current()).toEqual(before);
  });

  it("does not replay after a journal checkpoint generation conflict", () => {
    const attempt = fixture(true), before = current(), journal = createSubmissionJournal();
    journal.update(attempt.id, attempt.generation, attempt.steps);
    expect(consumeConfirmedSubmissionDraft(attempt)).toMatchObject({ status: "failed", message: expect.stringMatching(/checkpoint.*conflict/i) });
    expect(current()).toEqual(before);
  });

  it.each([false, true])("retries durable accepted evidence after local write failure (partial=%s), covering checkpoint-before-save", (partial) => {
    const attempt = fixture(partial), before = current();
    const spy = failAtomic((path) => path === sessions.getReviewSessionPathForDiagnostics(sessionId));
    expect(consumeConfirmedSubmissionDraft(attempt)).toMatchObject({ status: "failed", message: expect.stringMatching(partial ? /save/i : /delete/i) });
    expect(current()).toEqual(before);
    const journal = createSubmissionJournal(), reloaded = journal.load(attempt.id)!;
    expect(reloaded.generation).toBe(2);
    expect(journal.findForDraft(identity, sessionId, attempt.sourceDigest!)?.id).toBe(attempt.id);
    spy.mockRestore();
    expect(consumeConfirmedSubmissionDraft(reloaded)).toMatchObject({ status: "saved", remainingItems: 0 });
    expect(partial ? current().state.draft.comments : current()).toEqual(partial ? [] : null);
  });

  it.each([false, true])("keeps the current partial-source lookup through repeated cleanup failures (discussion remains=%s)", (keepDiscussion) => {
    const original = fixture(true, false), journal = createSubmissionJournal();
    if (keepDiscussion) {
      const data = current();
      data.state.draft.comments.push({ ...comment("discussion"), intent: "discuss" });
      save(data);
    }
    const attempt = journal.create({ ...original, draft: { ...original.draft!, sourceFingerprint: submissionDraftSourceFingerprint(original.input, current().state.draft) }, steps: [original.steps[0]!, { ...original.steps[1]!, bodyIncluded: true }] }, true).attempt;
    expect(consumeConfirmedSubmissionDraft(attempt).status).toBe("saved");
    const partial = current(), remaining = submissionDraftSourceFingerprint(attempt.input, partial.state.draft);
    const saved = journal.load(attempt.id)!;
    const completed = journal.update(saved.id, saved.generation, saved.steps.map((step) => ({ ...step, status: "submitted", reviewId: step.reviewId ?? "10", reviewIdSource: "write_response" })));
    const failure = failAtomic((path) => path === sessions.getReviewSessionPathForDiagnostics(sessionId));
    let retry = completed;
    for (let index = 0; index < 2; index++) {
      expect(consumeConfirmedSubmissionDraft(retry)).toMatchObject({ status: "failed" });
      expect(current()).toEqual(partial);
      expect(hasConsumableConfirmedSubmissionDraft(retry, current().state.draft)).toBe(true);
      const found = journal.findForDraft(identity, sessionId, submissionFingerprint("partial digest"), remaining);
      expect(found?.id).toBe(attempt.id);
      retry = found!;
    }
    failure.mockRestore();
    expect(consumeConfirmedSubmissionDraft(retry)).toMatchObject({ status: "saved", remainingItems: keepDiscussion ? 1 : 0 });
    if (keepDiscussion) {
      expect(current().state.draft.comments).toEqual([{ ...comment("discussion"), intent: "discuss" }]);
      expect(hasConsumableConfirmedSubmissionDraft(retry, current().state.draft)).toBe(false);
    }
  });

  it.each([false, true])("reports local index failure without erasing committed consumption (partial=%s)", (partial) => {
    const attempt = fixture(partial);
    failAtomic((path) => path === join(directory, "sessions", "index.json"));
    expect(consumeConfirmedSubmissionDraft(attempt)).toMatchObject({ status: "saved", remainingItems: 0, message: expect.stringMatching(/index/i) });
    expect(partial ? current().state.draft.comments : current()).toEqual(partial ? [] : null);
  });

  it("consumes old bindings exactly without creating a speculative remaining-source alias", () => {
    const attempt = fixture(true); delete attempt.draft!.sourceFingerprint;
    expect(consumeConfirmedSubmissionDraft(attempt)).toMatchObject({ status: "saved", remainingItems: 0 });
    expect(createSubmissionJournal().load(attempt.id)!.generation).toBe(1);
  });
});
