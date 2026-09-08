import { deleteReviewSession, loadReviewSession, saveReviewSessionWithStatus, type ReviewSessionData } from "./review-session.js";
import { createSubmissionJournal, submissionDraftSourceFingerprint, submissionFingerprint, type SubmissionAttempt } from "./review-submission-journal.js";

export type SubmissionDraftConsumption = {
  status: "not_applicable" | "saved" | "retained" | "unavailable" | "failed";
  remainingItems?: number;
  message?: string;
};

type ReviewDraft = ReviewSessionData["state"]["draft"];

function projectConfirmedDraft(attempt: SubmissionAttempt, draft: ReviewDraft): { retained: ReviewDraft; message?: string } {
  const binding = attempt.draft;
  const confirmed = attempt.steps.filter((step) => step.status === "submitted");
  if (binding == null || confirmed.length === 0) return { retained: draft };
  const sourceItems = [...binding.comments, ...binding.bodyComments];
  // Even identical duplicate IDs make attribution ambiguous. Never choose one arbitrarily.
  if (new Set(sourceItems.map((item) => item.id)).size !== sourceItems.length
    || new Set(draft.comments.map((item) => item.id)).size !== draft.comments.length) {
    return { retained: draft, message: "Duplicate source or saved comment IDs prevent safe draft consumption." };
  }
  const eligible = confirmed.flatMap((step) => step.commentIndexes.map((index) => binding.comments[index]));
  if (eligible.some((item) => item == null)) return { retained: draft, message: "Confirmed comment scope has no exact source binding; the draft was retained." };
  const bodyIncluded = confirmed.some((step) => step.bodyIncluded);
  const fingerprints = new Map([...eligible, ...(bodyIncluded ? binding.bodyComments : [])].map((item) => [item!.id, item!.fingerprint]));
  const comments = draft.comments.filter((comment) => fingerprints.get(comment.id) !== submissionFingerprint(comment));
  const clearOverall = bodyIncluded && draft.allComment.length > 0 && binding.allCommentFingerprint === submissionFingerprint({ allComment: draft.allComment, allIntent: draft.allIntent });
  return { retained: comments.length === draft.comments.length && !clearOverall ? draft : { ...draft, comments, allComment: clearOverall ? "" : draft.allComment } };
}

/** Uses the very same exact accepted-scope projection as cleanup, without changing either store. */
export function hasConsumableConfirmedSubmissionDraft(attempt: SubmissionAttempt, draft: ReviewDraft): boolean {
  return projectConfirmedDraft(attempt, draft).retained !== draft;
}

/** Only a successfully persisted attempt may authorize consumption; receipts and UI state do not. */
export function consumeConfirmedSubmissionDraft(attempt: SubmissionAttempt): SubmissionDraftConsumption {
  const binding = attempt.draft;
  const confirmed = attempt.steps.filter((step) => step.status === "submitted");
  if (binding == null || confirmed.length === 0) return { status: "not_applicable" };
  try {
    const session = loadReviewSession(binding.identity, binding.sessionId);
    if (session == null) return { status: "unavailable", message: "The saved draft is unavailable; no local draft was changed." };
    const draft = session.state.draft;
    const count = (value: typeof draft) => value.comments.length + (value.allComment.length > 0 ? 1 : 0);
    const remainingBefore = count(draft);
    const { retained, message } = projectConfirmedDraft(attempt, draft);
    if (message != null) return { status: "retained", remainingItems: remainingBefore, message };
    const remainingItems = count(retained);
    const currentFingerprint = submissionDraftSourceFingerprint(attempt.input, draft);
    const capturedSource = binding.sourceFingerprint != null
      && [binding.sourceFingerprint, attempt.remainingSourceFingerprint, attempt.previousSourceFingerprint].includes(currentFingerprint);
    const complete = attempt.steps.every((step) => step.status === "submitted");
    const changed = retained !== draft;
    // A completed retry may retire the empty snapshot left by an earlier partial cleanup.
    const terminal = complete && remainingItems === 0 && (changed || capturedSource);
    if (!changed && !terminal) return { status: "retained", remainingItems };

    // Retain the prior checkpoint until its projected snapshot is committed, including on retries.
    // A terminal deletion needs the current fingerprint, not an empty snapshot that will never exist.
    if (capturedSource) {
      try {
        createSubmissionJournal().update(attempt.id, attempt.generation, attempt.steps, terminal ? currentFingerprint : submissionDraftSourceFingerprint(attempt.input, retained));
      } catch (error) {
        return { status: "failed", remainingItems: remainingBefore, message: `Draft consumption checkpoint failed; the draft was retained: ${error instanceof Error ? error.message : String(error)}` };
      }
    }
    if (terminal) {
      const result = deleteReviewSession(binding.identity, binding.sessionId, session.generation);
      if (!result.deleted) return {
        status: result.status === "conflict" || result.status === "locked" ? "retained" : "failed",
        remainingItems: remainingBefore,
        message: `Draft delete failed (${result.status}); the saved draft was retained.${result.status === "error" ? ` ${result.message}` : ""}`,
      };
      return { status: "saved", remainingItems: 0, ...(result.indexUpdated ? {} : { message: "Draft deletion committed, but the local session index could not be updated." }) };
    }
    const result = saveReviewSessionWithStatus(binding.identity, { ...session, state: { ...session.state, draft: retained } }, {
      id: binding.sessionId, expectedGeneration: session.generation, revision: session.revision,
      fileSignatures: session.fileSignatures, meta: session.meta,
    });
    if (!result.saved) return {
      status: result.status === "conflict" || result.status === "locked" ? "retained" : "failed",
      remainingItems: remainingBefore,
      message: `Draft save failed (${result.status}); the saved draft was retained.${result.status === "error" ? ` ${result.message}` : ""}`,
    };
    return { status: "saved", remainingItems, ...(result.indexUpdated ? {} : { message: "Draft consumption committed, but the local session index could not be updated." }) };
  } catch (error) {
    return { status: "failed", message: `Draft consumption failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}
