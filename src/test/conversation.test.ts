import { describe, expect, it, vi } from "vitest";
import { createConversationRead, createConversationReader } from "../conversation.js";

const result = (stdout = "{}", stderr = "", killed = false) => ({ stdout, stderr, killed, code: 0 });

describe("conversation read limits", () => {
  it("retains raw thread data alongside the generation without replacing IDs, full text or unknown values", async () => {
    const raw = { coverage: "partial" as const, threads: [{ id: "thread", resolved: null, comments: [
      { id: "comment", author: "unknown", authorUnknown: true, body: "é".repeat(2000) },
    ] }], contextRows: [{ body: "Legacy ID-less comment" }] };
    const reader = createConversationReader({} as never, { provider: "github", repo: "owner/repo" } as never,
      async () => ({ details: { threadRead: raw }, selfLogin: "reviewer", replies: [] }));
    const snapshot = await reader.load().snapshot;
    expect(snapshot.details.threadRead).toBe(raw);
    expect(snapshot).toMatchObject({ selfLogin: "reviewer", replies: [] });
    expect(snapshot.metadata.coverage.threads).toBe("partial");
  });

  it("keeps a generation's admitted data and ledger through validated retry attempts", async () => {
    const body = "x".repeat(2100);
    const partial = { details: { comments: [{ body }], unavailable: ["reviews"] }, selfLogin: "reviewer", replies: [] };
    const target = { provider: "github", repo: "owner/repo" } as never;
    let calls = 0;
    const acquire = async (_read: unknown, publish: (data: typeof partial) => void) => {
      if (++calls === 1) { publish(partial); throw new Error("interrupted"); }
      return { ...partial, details: { comments: [{ body: calls === 2 ? "unadmitted".repeat(3000) : body }], unavailable: [] } };
    };
    const reader = createConversationReader({} as never, target, acquire);
    const clock = vi.spyOn(Date.prototype, "toISOString").mockReturnValue("2026-09-10T00:00:00.000Z");
    try {
      const first = await reader.load({ budgets: { maxRetainedBytes: 4700 } }).snapshot;
      const token = first.metadata.continuation;
      expect(token).toBeDefined();
      const other = createConversationReader({} as never, target, acquire);
      expect(() => other.load({ continuation: token })).toThrow(/continuation/i);
      expect(() => reader.load({ continuation: token, refresh: true })).toThrow(/continuation/i);
      expect(() => reader.load({ continuation: token, budgets: { maxMs: -1 } })).toThrow("Invalid");
      expect(() => reader.load({ continuation: token })).toThrow(/retained/i);
      expect(calls).toBe(1);
      clock.mockReturnValue("2026-09-10T00:00:01.000Z");
      const rejected = await reader.load({ continuation: token, budgets: { maxRetainedBytes: 20_000 } }).snapshot;
      expect(rejected.details.comments?.[0]?.body).toBe(body);
      expect(rejected.metadata.fetchedAt).toBe(first.metadata.fetchedAt);
      expect(rejected.metadata.continuation).toBeDefined();
      const second = await reader.load({ continuation: rejected.metadata.continuation, budgets: { maxRetainedBytes: 50_000 } }).snapshot;
      expect(second.metadata.generation).toBe(first.metadata.generation);
      expect(second.metadata.attempt).toBeGreaterThan(first.metadata.attempt!);
      expect(second.details.comments?.[0]?.body).toBe(body);
      expect(first.details.unavailable).toEqual(["reviews"]);
      expect(second.metadata.continuation).toBeUndefined();
      expect(() => reader.load({ continuation: token })).toThrow(/continuation/i);
      const fresh = await reader.load({ refresh: true, budgets: { maxRetainedBytes: 4700 } }).snapshot;
      expect(fresh.metadata.generation).toBeGreaterThan(first.metadata.generation);
      expect(fresh.details.comments?.[0]?.body).toBe(body);
    } finally {
      clock.mockRestore();
    }
  });

  it("invalidates an issued continuation before an unchanged-head refresh finishes", async () => {
    const reader = createConversationReader({} as never, { provider: "github" } as never,
      async () => ({ details: { unavailable: ["reviews"] }, selfLogin: "reviewer" }));
    const first = await reader.load().snapshot;
    const refresh = reader.load({ refresh: true });
    expect(() => reader.load({ continuation: first.metadata.continuation })).toThrow(/continuation/i);
    await refresh.snapshot;
  });

  it("counts accepted UTF8 output across both channels and stops admission after exhaustion", async () => {
    const exec = vi.fn(async () => result("é", "!"));
    const read = createConversationRead({ exec } as never, { maxBytes: 5 });
    try {
      await expect(read.pi.exec("host", ["first"])).resolves.toEqual(result("é", "!"));
      await expect(read.pi.exec("host", ["second"])).rejects.toThrow("byte limit");
      await expect(read.pi.exec("host", ["third"])).rejects.toThrow("byte limit");
      expect(exec).toHaveBeenCalledTimes(2);
    } finally {
      read.close();
    }
  });

  it("bounds aggregate serialized retained data without admitting the rejected value", () => {
    const read = createConversationRead({} as never, { maxRetainedBytes: 20 });
    try {
      expect(read.retain({ body: "one" })).toEqual({ body: "one" });
      expect(() => read.retain({ body: "two" })).toThrow("retained data limit");
    } finally {
      read.close();
    }
  });

  it("rejects a killed command even when its exit code and JSON look successful", async () => {
    const read = createConversationRead({ exec: async () => result("{}", "", true) } as never);
    try {
      await expect(read.pi.exec("host", [])).rejects.toThrow("cancelled");
    } finally {
      read.close();
    }
  });

  it("enforces its deadline when exec ignores cancellation and never accepts late output", async () => {
    vi.useFakeTimers();
    let finish!: (value: ReturnType<typeof result>) => void;
    const exec = vi.fn((_command: string, _args: string[], _options?: { timeout?: number; signal?: AbortSignal }) => new Promise<ReturnType<typeof result>>((resolve) => { finish = resolve; }));
    const read = createConversationRead({ exec } as never, { maxMs: 40 });
    const accepted = vi.fn();
    const rejected = vi.fn();
    const pending = read.pi.exec("host", [], { timeout: 1000 }).then(accepted, rejected);
    try {
      await vi.advanceTimersByTimeAsync(41);
      expect(rejected).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("time limit") }));
      expect(exec.mock.calls[0]?.[2]).toMatchObject({ timeout: 40, signal: expect.objectContaining({ aborted: true }) });
      finish(result("late"));
      await pending;
      expect(accepted).not.toHaveBeenCalled();
    } finally {
      finish(result());
      read.close();
      vi.useRealTimers();
    }
  });
});
