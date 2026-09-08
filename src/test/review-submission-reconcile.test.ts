import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireProviderSettings } from "../provider-settings.js";
import { matchesSubmissionActor, reconcileSubmissionStep } from "../review-submission-reconcile.js";
import type { ReviewSubmissionStep, SubmitReviewInput } from "../review-submit.js";

beforeEach(() => { vi.stubEnv("PI_CODE_DIFF_SETTINGS_PATH", "/nonexistent/submission-reconcile-settings.json"); });
afterEach(() => { vi.unstubAllEnvs(); });
const input: SubmitReviewInput = { provider: "github", repo: "example/widgets", prNumber: "12", commitId: "abc123", gitRoot: "/reviewed-checkout", verdict: "comment", body: " Summary ", comments: [{ path: "src/app.ts", line: 4, side: "RIGHT", body: "Exact note\n" }] };
const actor = { kind: "id" as const, value: "42", login: "reviewer" };
function step(): ReviewSubmissionStep { return { kind: "review", verdict: "comment", status: "unknown", reviewId: "9", reviewIdSource: "write_response", bodyIncluded: true, commentIndexes: [0] }; }
function review() { return { id: 9, state: "COMMENTED", commit_id: "abc123", body: "Summary", user: { id: 42, login: "reviewer" } }; }
function comment() { return { id: 101, pull_request_review_id: 9, body: "Exact note\n", user: { id: 42, login: "reviewer" }, path: "src/app.ts", subject_type: "line", commit_id: "abc123", original_commit_id: "abc123", line: 4, original_line: 4, side: "RIGHT", start_line: null, original_start_line: null, start_side: null }; }
function response(value: unknown, link?: string) { return { code: 0, stdout: `HTTP/2.0 200 OK\r\n${link == null ? "" : `Link: ${link}\r\n`}\r\n${JSON.stringify(value)}`, stderr: "" }; }
function reader(reviewData: unknown = review(), comments: unknown[] = [comment()]) {
  return vi.fn(async (_command: string, args: string[], _options?: { cwd?: string }) => response(args[1]?.includes("/comments?") ? comments : reviewData));
}
async function reconcile(exec: ReturnType<typeof vi.fn>, planned = step(), submittedInput = input) {
  return reconcileSubmissionStep({ exec } as never, submittedInput, requireProviderSettings("github"), planned, actor);
}

describe("write-bound review reconciliation", () => {
  it("confirms complete scope by the write's ID without listing unrelated reviews or writing", async () => {
    const exec = reader();
    expect(await reconcile(exec)).toMatchObject({ status: "submitted", reviewId: "9", reviewIdSource: "write_response" });
    expect(exec.mock.calls.map(([, args]) => args[1])).toEqual(["repos/example/widgets/pulls/12/reviews/9", "repos/example/widgets/pulls/12/reviews/9/comments?per_page=100&page=1"]);
    expect(exec.mock.calls.every(([, args]) => !args.includes("POST"))).toBe(true);
    expect(exec.mock.calls.every(([, , options]) => options?.cwd === input.gitRoot)).toBe(true);
  });

  it.each([
    ["actor", { user: { id: 43, login: "reviewer" } }], ["missing actor", { user: null }],
    ["review identity", { id: 10 }], ["commit", { commit_id: "different" }],
    ["pending state", { state: "PENDING" }], ["dismissed state", { state: "DISMISSED" }],
    ["raw body", { body: "Summary\n" }], ["missing body", { body: null }],
  ])("preserves uncertainty for mismatching %s", async (_name, override) => {
    expect(await reconcile(reader({ ...review(), ...override }))).toMatchObject({ status: "unknown", reviewId: "9" });
  });

  it("does not attribute an identical remote review to a no-ID attempt or an unproven ID", async () => {
    // This same read result could describe this write OR another client's identical write.
    const exec = reader();
    expect(await reconcile(exec, { ...step(), status: "unknown", reviewId: undefined, reviewIdSource: undefined })).toMatchObject({ status: "unknown" });
    expect(await reconcile(exec, { ...step(), reviewIdSource: undefined })).toMatchObject({ status: "unknown" });
    expect(exec).not.toHaveBeenCalled();
  });

  it("requires complete pagination, deduplicates identical IDs, and ignores explicit replies", async () => {
    const next = '<https://api.github.com/repos/example/widgets/pulls/12/reviews/9/comments?per_page=100&page=2>; rel="next"';
    const exec = vi.fn(async (_command: string, args: string[]) => {
      if (!args[1]?.includes("/comments?")) return response(review());
      if (args[1].endsWith("page=1")) return response([comment(), { ...comment(), id: 102, in_reply_to_id: 101, body: "A reply", user: { id: 43 } }], next);
      return response([comment()]);
    });
    expect(await reconcile(exec)).toMatchObject({ status: "submitted" });
    expect(exec).toHaveBeenCalledTimes(3);
  });

  it.each(["error", "extra", "conflict", "foreign", "malformed"])("does not confirm incomplete or contradictory pagination: %s", async (failure) => {
    const host = failure === "foreign" ? "other.example" : "api.github.com";
    const next = failure === "malformed" ? "broken" : `<https://${host}/repos/example/widgets/pulls/12/reviews/9/comments?page=2>; rel="next"`;
    const exec = vi.fn(async (_command: string, args: string[]) => {
      if (!args[1]?.includes("/comments?")) return response(review());
      if (args[1].endsWith("page=1")) return response([comment()], next);
      if (failure === "error") return { code: 1, stdout: "HTTP/2.0 429 Too Many Requests\r\n\r\n{}", stderr: "rate limited" };
      return response([{ ...comment(), ...(failure === "extra" ? { id: 102 } : { body: "Changed" }) }]);
    });
    expect(await reconcile(exec)).toMatchObject({ status: "unknown" });
    if (failure === "foreign" || failure === "malformed") expect(exec).toHaveBeenCalledTimes(2);
  });

  it.each([
    { side: "LEFT" }, { path: "src/App.ts" }, { body: "Exact note" }, { original_line: 3 },
    { original_commit_id: "old" }, { pull_request_review_id: 10 }, { subject_type: "file" },
    { user: { id: 43 } }, { original_line: null },
  ])("requires exact original comment scope: %j", async (override) => {
    expect(await reconcile(reader(review(), [{ ...comment(), ...override }]))).toMatchObject({ status: "unknown" });
  });

  it("counts duplicate intended comments with multiplicity and distinct remote IDs", async () => {
    const two = { ...input, comments: [input.comments![0]!, input.comments![0]!] };
    const planned = { ...step(), commentIndexes: [0, 1] };
    expect(await reconcile(reader(), planned, two)).toMatchObject({ status: "unknown" });
    expect(await reconcile(reader(review(), [comment(), { ...comment(), id: 102 }]), planned, two)).toMatchObject({ status: "submitted" });
  });

  it("matches full range endpoints instead of a matching end line alone", async () => {
    const ranged = { ...input, comments: [{ ...input.comments![0]!, start_line: 2, start_side: "RIGHT" as const }] };
    expect(await reconcile(reader(), step(), ranged)).toMatchObject({ status: "unknown" });
    expect(await reconcile(reader(review(), [{ ...comment(), start_line: 2, original_start_line: 2, start_side: "RIGHT" }]), step(), ranged)).toMatchObject({ status: "submitted" });
  });

  it("requires declared actor identity without falling back from ID to login", () => {
    expect(matchesSubmissionActor(actor, 42, "changed-login")).toBe(true);
    expect(matchesSubmissionActor(actor, "42", null)).toBe(true);
    expect(matchesSubmissionActor({ kind: "id", value: "actor:42", login: "reviewer" }, "actor:42", "renamed")).toBe(true);
    for (const id of [null, 43, 42.5, Number.MAX_SAFE_INTEGER + 1, "042", "42\n"]) expect(matchesSubmissionActor(actor, id, "reviewer")).toBe(false);
    expect(matchesSubmissionActor({ kind: "login", value: "Reviewer", login: null }, null, "reviewer")).toBe(true);
  });

  it("confirms native file comments only with explicit subject and no coordinates", async () => {
    const fileInput: SubmitReviewInput = { ...input, comments: [{ path: "src/app.ts", subject_type: "file", body: "Exact note\n" }] };
    const file = { ...comment(), subject_type: "file", line: null, original_line: null, side: null };
    expect(await reconcile(reader(review(), [file]), step(), fileInput)).toMatchObject({ status: "submitted" });
    for (const override of [{ subject_type: undefined }, { original_line: 4 }, { side: "RIGHT" }]) {
      expect(await reconcile(reader(review(), [{ ...file, ...override }]), step(), fileInput)).toMatchObject({ status: "unknown" });
    }
  });

  it("matches omitted body scope to an explicit empty remote body and still checks root comments", async () => {
    const planned = { ...step(), bodyIncluded: false, commentIndexes: [] };
    expect(await reconcile(reader({ ...review(), body: "" }, []), planned)).toMatchObject({ status: "submitted" });
    expect(await reconcile(reader({ ...review(), body: null }, []), planned)).toMatchObject({ status: "unknown" });
    expect(await reconcile(reader({ ...review(), body: "" }), planned)).toMatchObject({ status: "unknown" });
  });

  it.each([1, 3, 0, 1.5, 9007199254740992])("refuses cyclic, skipped or invalid next page %s", async (page) => {
    const link = `<https://api.github.com/repos/example/widgets/pulls/12/reviews/9/comments?page=${page}>; rel="next"`;
    const exec = vi.fn(async (_command: string, args: string[]) => args[1]?.includes("/comments?") ? response([comment()], args[1].endsWith("page=1") ? link : undefined) : response(review()));
    expect(await reconcile(exec)).toMatchObject({ status: "unknown" });
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it.each(["bad id!", 0, -1, 1.5])("refuses malformed reply evidence %j", async (in_reply_to_id) => {
    expect(await reconcile(reader(review(), [{ ...comment(), in_reply_to_id }]))).toMatchObject({ status: "unknown" });
  });

  it.each(["9/../10", "0", "-9", "9?x=1"])("does not read invalid GitHub review ID %s", async (reviewId) => {
    const exec = reader();
    expect(await reconcile(exec, { ...step(), reviewId })).toMatchObject({ status: "unknown" });
    expect(exec).not.toHaveBeenCalled();
  });

  it("requires field mappings that distinguish roots and optional range coordinates", async () => {
    for (const name of ["commentReplyToId", "commentStartLine", "commentOriginalStartLine", "commentStartSide"]) {
      const provider = structuredClone(requireProviderSettings("github"));
      delete provider.fields[name];
      expect(await reconcileSubmissionStep({ exec: reader() } as never, input, provider, step(), actor)).toMatchObject({ status: "unknown" });
    }
  });

  it("rejects partial-content HTTP evidence even with a complete-looking JSON body", async () => {
    const exec = vi.fn(async (_command: string, args: string[]) => {
      const result = response(args[1]?.includes("/comments?") ? [comment()] : review());
      return { ...result, stdout: result.stdout.replace("200 OK", "206 Partial Content") };
    });
    expect(await reconcile(exec)).toMatchObject({ status: "unknown" });
  });

  it("rejects malformed, killed and over-budget buffered responses", async () => {
    for (const result of [
      { code: 0, stdout: JSON.stringify(review()), stderr: "" },
      { code: 0, stdout: "HTTP/2.0 500 Error\r\n\r\n{}", stderr: "" },
      { ...response(review()), killed: true },
    ]) expect(await reconcile(vi.fn(async () => result))).toMatchObject({ status: "unknown" });
    for (const budgets of [{ bytes: 1 }, { milliseconds: 0 }, { requests: Number.NaN }]) {
      expect(await reconcileSubmissionStep({ exec: reader() } as never, input, requireProviderSettings("github"), step(), actor, budgets)).toMatchObject({ status: "unknown" });
    }
  });

  it("keeps unknown on unsupported recovery operations, absent scope, read failures or exhausted budgets", async () => {
    const provider = structuredClone(requireProviderSettings("github"));
    delete provider.operations.reviewCommentsForReview;
    expect(await reconcileSubmissionStep({ exec: reader() } as never, input, provider, step(), actor)).toMatchObject({ status: "unknown" });
    expect(await reconcile(reader(review(), []))).toMatchObject({ status: "unknown" });
    expect(await reconcile(vi.fn(async () => { throw new Error("timeout"); }))).toMatchObject({ status: "unknown" });
    expect(await reconcileSubmissionStep({ exec: reader() } as never, input, requireProviderSettings("github"), step(), actor, { requests: 1 })).toMatchObject({ status: "unknown" });
  });
});
