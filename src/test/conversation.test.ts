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
