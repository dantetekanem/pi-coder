import { describe, expect, it, vi } from "vitest";
import { createConversationReader, groupConversationComments } from "../conversation.js";
import { collectRepliesToSelf } from "../review-replies.js";
import { parsePiCodeDiffSettings } from "../provider-settings.js";

const provider = parsePiCodeDiffSettings({ version: 1, providers: {}, repositories: {} }).providers.github!;
const target = { provider: "github", repo: "org/repo", gitRoot: "/repo", pullRequest: { number: "12", headRefOid: "same" } };
const page = (nodes: unknown[], endCursor: string | null = null) => ({ nodes, pageInfo: { hasNextPage: endCursor !== null, endCursor } });
const comment = (id: string, author: string | null = "alice", body = "reply") => ({ id, databaseId: id, author: author && { login: author }, body });
const thread = (id: string, comments = page([comment("c1", "self")])) => ({ id, isResolved: false, comments });
const payload = (threads = page([])) => ({ data: { repository: { pullRequest: { reviewThreads: threads } } } });
const result = (value: unknown) => ({ code: 0, stdout: JSON.stringify(value), stderr: "", killed: false });
function reader(responses: unknown[], budgets = {}) {
  const exec = vi.fn(async (_command: string, args: string[]) => args.includes("graphql")
    ? result(responses.shift())
    : { code: 0, stdout: "HTTP/2.0 200 OK\r\n\r\n[]", stderr: "", killed: false });
  return { exec, source: createConversationReader({ exec } as never, target as never, provider, budgets) };
}

describe("bounded shared conversation reader", () => {
  it("finds a reply on thread page two and nested comment page two, retaining full text", async () => {
    const { source, exec } = reader([
      payload(page([thread("unrelated", page([]))], "threads-2")),
      payload(page([thread("mine", page([comment("self", "self")], "comments-2"))])),
      { data: { node: { comments: page([comment("reply", null, "x".repeat(2000))]) } } },
    ]);
    const snapshot = await source.load();
    expect(snapshot.coverage).toBe("complete");
    expect(snapshot.threads[1]?.comments[1]).toMatchObject({ id: "reply", author: "unknown", body: "x".repeat(2000) });
    expect(collectRepliesToSelf(snapshot.threads, "self")).toEqual([expect.objectContaining({ commentId: "reply", bodyTruncated: true })]);
    expect(exec.mock.calls.map(([, args]) => args.join(" ")).join("\n")).toContain('after: "threads-2"');
    expect(exec.mock.calls.map(([, args]) => args.join(" ")).join("\n")).toContain('after: "comments-2"');
  });

  it("retains explicit anchor side and fetched head/base identity for code navigation", async () => {
    const { source, exec } = reader([{ data: { repository: { pullRequest: {
      headRefOid: "a".repeat(40), baseRefOid: "b".repeat(40),
      reviewThreads: page([{ ...thread("anchored"), diffSide: "LEFT", path: "old.ts", line: 4 }]),
    } } } }]);
    expect((await source.load()).threads[0]).toMatchObject({ side: "deleted", headRevision: "a".repeat(40), baseRevision: "b".repeat(40) });
    const query = exec.mock.calls.find(([, args]) => args.includes("graphql"))?.[1].join(" ");
    expect(query).toContain("diffSide");
    expect(query).toContain("headRefOid");
  });

  it("uses human-facing REST comment links and preserves their explicit anchor side", () => {
    const threads = groupConversationComments([{ id: 1, body: "Read me", url: "https://api.github.com/comment/1", html_url: "https://github.com/org/repo/pull/12#discussion_r1", side: "RIGHT", commit_id: "a".repeat(40), line: 2 }], provider);
    expect(threads[0]).toMatchObject({ side: "added", headRevision: "a".repeat(40) });
    expect(threads[0]?.comments[0]?.url).toBe("https://github.com/org/repo/pull/12#discussion_r1");
  });

  it("defers budget exhaustion with a resumable cursor, without losing earlier bodies", async () => {
    const { source } = reader([payload(page([thread("a")], "next")), payload(page([thread("b")]))], { maxRequests: 1 });
    const first = await source.load();
    expect(first.coverage).toBe("partial");
    expect(first.reasons.join()).toContain("request budget");
    expect(first.continuation).toBeDefined();
    const second = await source.load({ continuation: first.continuation });
    expect(second.threads.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(first.threads).toHaveLength(1);
    expect(second.generation).toBe(first.generation);
    const final = await source.load({ continuation: second.continuation, budgets: { maxRequests: 10 } });
    expect(final.coverage).toBe("complete");
    expect(final.continuation).toBeUndefined();
  });

  it("deduplicates stable IDs and stops repeated cursors explicitly", async () => {
    const { source } = reader([payload(page([thread("a")], "same")), payload(page([thread("a")], "same"))]);
    const snapshot = await source.load();
    expect(snapshot.threads).toHaveLength(1);
    expect(snapshot.threads[0]?.comments).toHaveLength(1);
    expect(snapshot.coverage).toBe("partial");
    expect(snapshot.reasons.join()).toContain("cursor");
  });

  it.each([
    ["HTTP success errors", { errors: [{ message: "rate limit", type: "RATE_LIMITED" }] }, "rate limit"],
    ["missing nested data", { data: { repository: null } }, "missing"],
    ["empty response", undefined, "empty"],
  ])("does not call %s an empty conversation", async (_label, response, reason) => {
    const { source } = reader([response]);
    const snapshot = await source.load();
    expect(snapshot.sections.threads).toBe("partial"); // REST succeeded, but cannot recover GraphQL resolution coverage.
    expect(snapshot.reasons.join()).toContain(reason);
  });

  it("keeps partial GraphQL data but never claims complete coverage", async () => {
    const { source } = reader([{ ...payload(page([thread("a")])), errors: [{ message: "field unavailable" }] }]);
    const snapshot = await source.load();
    expect(snapshot.threads).toHaveLength(1);
    expect(snapshot.coverage).toBe("partial");
  });

  it("retains a thread when its nested comment connection is missing", async () => {
    const { source } = reader([payload(page([{ id: "partial", isResolved: false, comments: null }]))]);
    const snapshot = await source.load();
    expect(snapshot.threads[0]?.id).toBe("partial");
    expect(snapshot.coverage).toBe("partial");
    expect(snapshot.reasons.join()).toContain("missing nested comment data");
  });

  it("labels entirely unavailable conversation separately from genuine empty", async () => {
    const exec = vi.fn(async () => ({ code: 1, stdout: "", stderr: "unavailable", killed: false }));
    const source = createConversationReader({ exec } as never, target as never, { ...provider, operations: { reviewThreads: provider.operations.reviewThreads! } });
    const snapshot = await source.load();
    expect(snapshot.coverage).toBe("unavailable");
    expect(snapshot.continuation).toBeDefined();
  });

  it("distinguishes genuine empty from unknown pagination", async () => {
    expect((await reader([payload()]).source.load()).coverage).toBe("complete");
    const snapshot = await reader([payload({ nodes: [] } as never)]).source.load();
    expect(snapshot.coverage).toBe("partial");
    expect(snapshot.reasons.join()).toContain("pageInfo");
  });

  it("paginates REST reviews and comments from Link headers without reusing remote hosts", async () => {
    const exec = vi.fn(async (_command: string, args: string[]) => {
      if (args.includes("graphql")) return result(payload());
      const endpoint = args.at(-1)!;
      const first = endpoint.endsWith("page=1");
      const rows = [{ id: first ? 1 : 2, body: first ? "first" : "second", user: null }];
      return { code: 0, stdout: `HTTP/2.0 200 OK\r\n${first ? 'Link: <https://untrusted.invalid/ignored?page=2>; rel="next"\r\n' : ""}\r\n${JSON.stringify(rows)}`, stderr: "", killed: false };
    });
    const source = createConversationReader({ exec } as never, target as never, provider);
    const snapshot = await source.load();
    expect(snapshot.comments.map((entry) => entry.body)).toEqual(["first", "second"]);
    expect(snapshot.reviews).toHaveLength(2);
    expect(snapshot.coverage).toBe("complete");
    expect(exec.mock.calls.flatMap(([, args]) => args).some((arg) => arg.includes("untrusted.invalid"))).toBe(false);
  });

  it("keeps failed HTTP pages unavailable even when the provider command exits successfully", async () => {
    const exec = vi.fn(async (_command: string, args: string[]) => args.includes("graphql")
      ? result(payload())
      : { code: 0, stdout: "HTTP/2.0 403 Forbidden\r\n\r\n[]", stderr: "", killed: false });
    const snapshot = await createConversationReader({ exec } as never, target as never, provider).load();
    expect(snapshot.sections).toEqual({ threads: "complete", comments: "unavailable", reviews: "unavailable" });
    expect(snapshot.coverage).toBe("partial");
    expect(snapshot.continuation).toBeDefined();
    expect(snapshot.reasons.join()).toContain("HTTP 403");
  });

  it("groups REST replies across pages without inventing an unresolved state", async () => {
    const exec = vi.fn(async (_command: string, args: string[]) => {
      const endpoint = args.at(-1)!;
      if (!endpoint.includes("/pulls/12/comments?")) return { code: 0, stdout: "HTTP/2.0 200 OK\n\n[]", stderr: "", killed: false };
      const first = endpoint.endsWith("page=1");
      const rows = first ? [{ id: 1, user: { login: "self" }, body: "Question" }] : [{ id: 2, in_reply_to_id: 1, user: null, body: "Answer" }];
      return { code: 0, stdout: `HTTP/2.0 200 OK\n${first ? 'Link: <https://api.github.com/ignored?page=2>; rel="next"\n' : ""}\n${JSON.stringify(rows)}`, stderr: "", killed: false };
    });
    const source = createConversationReader({ exec } as never, target as never, { ...provider, capabilities: { ...provider.capabilities, graphqlReviewThreads: false } });
    const snapshot = await source.load();
    expect(snapshot.coverage).toBe("complete");
    expect(snapshot.threads[0]?.resolved).toBeNull();
    expect(collectRepliesToSelf(snapshot.threads, "self")[0]).toMatchObject({ commentId: "2", resolved: null, author: "unknown" });
  });

  it("rejects an oversized page atomically and resumes with an explicit larger byte budget", async () => {
    const response = payload(page([thread("large", page([comment("long", "self", "x".repeat(4000))]))]));
    const { source } = reader([response, response], { maxBytes: 1000 });
    const first = await source.load();
    expect(first.threads).toEqual([]);
    expect(first.reasons.join()).toContain("byte budget");
    const next = await source.load({ continuation: first.continuation, budgets: { maxBytes: 10000 } });
    expect(next.threads[0]?.comments[0]?.body).toHaveLength(4000);
    expect(next.coverage).toBe("complete");
  });

  it("bounds retained data across resumes and keeps the rejected page reachable", async () => {
    const response = payload(page([thread("large", page([comment("long", "self", "x".repeat(4000))]))]));
    const { source } = reader([response, response], { maxRetainedBytes: 1000 });
    const first = await source.load();
    expect(first.threads).toEqual([]);
    expect(first.reasons.join()).toContain("retained byte limit");
    const next = await source.load({ continuation: first.continuation, budgets: { maxRetainedBytes: 10000 } });
    expect(next.threads).toHaveLength(1);
  });

  it("enforces elapsed time and retries unavailable pages without losing successful sections", async () => {
    let now = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const exec = vi.fn(async (_command: string, args: string[]) => {
      if (args.includes("graphql")) { now += 20; return result(payload()); }
      return { code: 0, stdout: "HTTP/2.0 200 OK\n\n[]", stderr: "", killed: false };
    });
    try {
      const source = createConversationReader({ exec } as never, target as never, provider, { maxTimeMs: 10 });
      const first = await source.load();
      expect(first.reasons.join()).toContain("time budget");
      const next = await source.load({ continuation: first.continuation, budgets: { maxTimeMs: 100 } });
      expect(next.coverage).toBe("complete");
    } finally { clock.mockRestore(); }
  });

  it("isolates no-fallback GraphQL failures and resumes after rate limiting", async () => {
    const { reviewComments: _legacy, reviewCommentsPage: _page, ...operations } = provider.operations;
    let failed = true;
    const exec = vi.fn(async (_command: string, args: string[]) => {
      if (!args.includes("graphql")) return { code: 0, stdout: "HTTP/2.0 200 OK\n\n[]", stderr: "", killed: false };
      if (failed) return result({ errors: [{ type: "RATE_LIMITED", message: "rate limit" }] });
      return result(payload());
    });
    const source = createConversationReader({ exec } as never, target as never, { ...provider, operations });
    const first = await source.load();
    expect(first.sections).toEqual({ threads: "unavailable", comments: "complete", reviews: "complete" });
    expect(first.reasons.join()).toContain("rate limit");
    failed = false;
    expect((await source.load({ continuation: first.continuation })).coverage).toBe("complete");
    await expect(source.load({ continuation: first.continuation })).rejects.toThrow("Stale");
  });

  it("coalesces loads but refreshes unchanged heads and supersedes older responses", async () => {
    let finishOld!: (value: ReturnType<typeof result>) => void;
    let calls = 0;
    const exec = vi.fn(async (_command: string, args: string[]) => {
      if (!args.includes("graphql")) return { code: 0, stdout: "HTTP/2.0 200 OK\n\n[]", stderr: "", killed: false };
      if (++calls === 1) return new Promise<ReturnType<typeof result>>((resolve) => { finishOld = resolve; });
      return result(payload(page([thread("new")])));
    });
    const source = createConversationReader({ exec } as never, target as never, provider);
    const old = source.load();
    expect(source.load()).toBe(old);
    await expect(source.load({ continuation: { generation: 99 } })).rejects.toThrow("Different");
    const fresh = await source.load({ refresh: true });
    finishOld(result(payload(page([thread("old")]))));
    expect((await old).generation).toBe(fresh.generation);
    expect(source.current?.threads[0]?.id).toBe("new");
    expect(calls).toBe(2);
    expect((await source.load()).generation).toBeGreaterThan(fresh.generation);
  });
});
