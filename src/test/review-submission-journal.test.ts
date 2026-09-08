import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSubmissionJournal, submissionDraftSourceFingerprint, submissionFingerprint, type SubmissionAttemptSeed } from "../review-submission-journal.js";

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "submission-journal-")); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

function seed(): SubmissionAttemptSeed {
  return {
    input: { provider: "github", repo: "example/widgets", prNumber: "12", commitId: "abc123", verdict: "comment", body: "Confirmed body", comments: [{ path: "src/app.ts", line: 4, side: "RIGHT", body: "Exact note\n" }] },
    actor: { kind: "id", value: "42", login: "reviewer" },
    providerDigest: submissionFingerprint("provider contract"),
    sourceDigest: submissionFingerprint("original review draft"),
    draft: { identity: "pr|github|example/widgets|12", sessionId: "review-instance", comments: [{ id: "stable-comment", fingerprint: submissionFingerprint("original comment") }], bodyComments: [], allCommentFingerprint: submissionFingerprint("original note") },
    steps: [{ kind: "review", verdict: "comment", status: "pending", bodyIncluded: true, commentIndexes: [0] }],
  };
}

describe("submission intent journal", () => {
  it("checkpoints remaining raw source under CAS while preserving accepted evidence and original lookup", () => {
    const journal = createSubmissionJournal({ directory });
    const original = seed();
    original.draft!.sourceFingerprint = submissionFingerprint("raw source");
    const initial = journal.create(original).attempt;
    const remaining = submissionFingerprint("remaining source");
    const accepted = [{ ...initial.steps[0]!, status: "submitted" as const, reviewId: "9", reviewIdSource: "write_response" as const }];
    const checkpoint = journal.update(initial.id, initial.generation, accepted, remaining);
    expect(checkpoint.remainingSourceFingerprint).toBe(remaining);
    expect(journal.findForDraft(original.draft!.identity, original.draft!.sessionId, submissionFingerprint("different"), remaining)?.id).toBe(initial.id);
    expect(journal.findForDraft(original.draft!.identity, original.draft!.sessionId, original.sourceDigest!)?.id).toBe(initial.id);
    expect(journal.findForDraft("another identity", original.draft!.sessionId, original.sourceDigest!, remaining)).toBeNull();
    expect(journal.findForDraft(original.draft!.identity, "another session", original.sourceDigest!, remaining)).toBeNull();
    expect(journal.findForDraft(original.draft!.identity, original.draft!.sessionId, submissionFingerprint("different"))).toBeNull();
    expect(() => journal.update(initial.id, initial.generation, accepted, remaining)).toThrow(/generation conflict/i);
    expect(() => journal.update(initial.id, checkpoint.generation, accepted, "invalid")).toThrow(/invalid/i);
    const persisted = journal.update(initial.id, checkpoint.generation, accepted);
    expect(persisted.remainingSourceFingerprint).toBe(remaining);
    const after = submissionFingerprint("after final body");
    const next = journal.update(persisted.id, persisted.generation, accepted, after);
    const repeated = journal.update(next.id, next.generation, accepted, after);
    expect(repeated).toMatchObject({ previousSourceFingerprint: remaining, remainingSourceFingerprint: after });
    for (const fingerprint of [remaining, after]) expect(journal.findForDraft(original.draft!.identity, original.draft!.sessionId, "different", fingerprint)?.id).toBe(initial.id);
    const invalid = seed();
    invalid.draft!.sourceFingerprint = "invalid";
    expect(() => journal.create(invalid, true)).toThrow(/invalid/i);
    writeFileSync(join(directory, `${initial.id}.json`), JSON.stringify({ ...repeated, previousSourceFingerprint: "invalid" }));
    expect(() => journal.load(initial.id)).toThrow(/invalid submission/i);
  });

  it("fingerprints exact raw draft and review target, not the body or verdict decision", () => {
    const input = seed().input;
    const draft = { allComment: " note ", allIntent: "comment", comments: [{ id: "one", body: "Exact" }] };
    const hash = submissionDraftSourceFingerprint(input, draft);
    expect(submissionDraftSourceFingerprint({ ...input, repo: input.repo.toUpperCase() }, draft)).toBe(hash);
    for (const changed of [{ ...input, commitId: "new" }, { ...input, baseCommitId: "base" }, { ...input, gitRoot: "/other" }, { ...input, prNumber: "99" }, { ...input, provider: "other" }]) {
      expect(submissionDraftSourceFingerprint(changed, draft)).not.toBe(hash);
    }
    expect(submissionDraftSourceFingerprint(input, { ...draft, allComment: "note" })).not.toBe(hash);
    expect(submissionDraftSourceFingerprint(input, { ...draft, allIntent: "discuss" })).not.toBe(hash);
    expect(submissionDraftSourceFingerprint(input, { ...draft, comments: [{ id: "two", body: "Exact" }] })).not.toBe(hash);
  });

  it("persists an independent confirmed payload, actor and stable draft binding before any write", () => {
    const journal = createSubmissionJournal({ directory });
    const original = seed();
    const { attempt, created } = journal.create(original);
    original.input.body = "changed while awaiting provider";
    original.draft!.comments[0]!.id = "different";
    expect(created).toBe(true);
    expect(journal.load(attempt.id)).toMatchObject({ generation: 1, input: { body: "Confirmed body" }, actor: { kind: "id", value: "42" }, draft: { comments: [{ id: "stable-comment" }] } });
    expect(journal.findForDraft("pr|github|example/widgets|12", "review-instance", original.sourceDigest!)?.id).toBe(attempt.id);
    expect(journal.findForDraft("pr|github|other/repo|12", "review-instance", original.sourceDigest!)).toBeNull();
    expect(attempt.id).toMatch(/^[a-f0-9-]{36}$/);
  });

  it("reuses the confirmed intent unless a distinct identical intent is explicit", () => {
    const journal = createSubmissionJournal({ directory });
    const first = journal.create(seed()).attempt;
    expect(journal.create(seed())).toMatchObject({ created: false, attempt: { id: first.id } });
    const next = journal.create(seed(), true).attempt;
    expect(next.id).not.toBe(first.id);
    expect(next.ordinal).toBeGreaterThan(first.ordinal);
    expect(journal.create(seed()).attempt.id).toBe(next.id);
    expect(journal.load(first.id)?.id).toBe(first.id);
  });

  it("keeps changed payloads and collision-prone repository names independent", () => {
    const journal = createSubmissionJournal({ directory });
    const variants = [seed(), seed(), seed(), seed()];
    variants[1]!.input.body = "Changed approved text";
    variants[2]!.actor.value = "other-actor";
    variants[2]!.input.repo = "foo/bar-baz";
    variants[3]!.actor.value = "other-actor";
    variants[3]!.input.repo = "foo-bar/baz";
    expect(new Set(variants.map((value) => journal.create(value).attempt.id)).size).toBe(4);
  });

  it("does not redefine an existing intent when authentication changes", () => {
    const journal = createSubmissionJournal({ directory });
    const original = journal.create(seed()).attempt;
    const changed = seed();
    changed.actor = { kind: "id", value: "43", login: "other" };
    expect(journal.create(changed)).toMatchObject({ created: false, attempt: { id: original.id, actor: { value: "42" } } });
    expect(journal.create(changed, true).attempt).toMatchObject({ actor: { value: "43" } });
  });

  it("retains write-response ID provenance through reload and rejects a stale step writer", () => {
    const journal = createSubmissionJournal({ directory });
    const initial = journal.create(seed()).attempt;
    const started = journal.update(initial.id, initial.generation, [{ ...initial.steps[0]!, status: "unknown" }]);
    const observed = journal.update(started.id, started.generation, [{ ...started.steps[0]!, status: "unknown", reviewId: "9", reviewIdSource: "write_response" }]);
    expect(createSubmissionJournal({ directory }).load(initial.id)).toMatchObject({ generation: 3, steps: [{ status: "unknown", reviewId: "9", reviewIdSource: "write_response" }] });
    expect(() => journal.update(initial.id, initial.generation, initial.steps)).toThrow(/generation conflict/i);
    expect(journal.load(initial.id)).toEqual(observed);
  });

  it("preserves completed steps and refuses to change their planned scope", () => {
    const journal = createSubmissionJournal({ directory });
    const initial = journal.create(seed()).attempt;
    const completed = journal.update(initial.id, initial.generation, [{ ...initial.steps[0]!, status: "submitted", reviewId: "9", reviewIdSource: "write_response" }]);
    expect(() => journal.update(completed.id, completed.generation, [{ ...completed.steps[0]!, status: "unknown" }])).toThrow(/completed step/i);
    expect(() => journal.update(completed.id, completed.generation, [{ ...completed.steps[0]!, commentIndexes: [] }])).toThrow(/scope/i);
    expect(journal.load(initial.id)).toEqual(completed);
  });

  it("fails closed on corrupt or unsupported records rather than silently creating duplicate intents", () => {
    const journal = createSubmissionJournal({ directory });
    const initial = journal.create(seed()).attempt;
    const path = join(directory, `${initial.id}.json`);
    const raw = JSON.parse(readFileSync(path, "utf8"));
    raw.input.body = "tampered payload";
    writeFileSync(path, JSON.stringify(raw));
    expect(() => journal.load(initial.id)).toThrow(/invalid submission/i);
    expect(() => journal.create(seed())).toThrow(/invalid submission/i);
    raw.version = 99;
    writeFileSync(path, JSON.stringify(raw));
    expect(() => journal.load(initial.id)).toThrow(/invalid submission/i);
    expect(readdirSync(directory).filter((name) => name.endsWith(".json"))).toHaveLength(1);
    expect(() => journal.load("../outside")).toThrow(/attempt id/i);
  });

  it("retains readable evidence while another writer owns the mutex", () => {
    const journal = createSubmissionJournal({ directory });
    const initial = journal.create(seed()).attempt;
    mkdirSync(join(directory, ".write-lock"));
    expect(journal.load(initial.id)).toEqual(initial);
    expect(() => journal.create(seed())).toThrow(/storage is locked/i);
  });

  it("refuses new records or oversized payloads without truncating retained intents", () => {
    const journal = createSubmissionJournal({ directory, maxRecords: 1, maxRecordBytes: 4096 });
    const initial = journal.create(seed()).attempt;
    expect(() => journal.create(seed(), true)).toThrow(/capacity/i);
    const large = seed();
    large.input.body = "x".repeat(4096);
    expect(() => createSubmissionJournal({ directory, maxRecordBytes: 4096 }).create(large)).toThrow(/size limit/i);
    expect(journal.load(initial.id)).toEqual(initial);
  });
});
