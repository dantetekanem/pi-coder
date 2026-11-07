import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliRunResult, LaunchRecord, LaunchRequest, LaunchWaitOptions, Launcher, McpServerDependencies, McpServerOptions } from "../cli/contract.js";
import { runMcpServer } from "../cli/mcp.js";

vi.mock("../tool-definitions.js", () => ({
  PI_CODER_TOOLS: [
    {
      name: "open_code_diff",
      label: "Open Code Diff",
      description: "Open a review.",
      promptSnippet: "review",
      promptGuidelines: ["Use for reviews.", "Pass a target."],
      parameters: { type: "object", properties: { cwd: { type: "string" }, target: { type: "string" } }, [Symbol("typebox")]: "Kind" },
      needsTerminal: true,
    },
    {
      name: "submit_pr_review",
      label: "Submit PR Review",
      description: "Submit a review.",
      promptSnippet: "submit",
      promptGuidelines: [],
      parameters: { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] },
      needsTerminal: false,
    },
  ],
}));

interface Rpc {
  jsonrpc: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, any>;
  result?: any;
  error?: { code: number; message: string };
}

const serverCwd = realpathSync(mkdtempSync(join(tmpdir(), "pi-coder-mcp-")));
const otherCwd = join(serverCwd, "other");
mkdirSync(otherCwd);

function runResult(overrides: Partial<CliRunResult> = {}): CliRunResult {
  return { piCoder: 1, command: "tool", tool: "open_code_diff", ok: true, started: true, text: "Review finished", details: { comments: 2 }, messages: [], notices: [], ...overrides };
}

function record(overrides: Partial<LaunchRecord> = {}): LaunchRecord {
  return { id: "L1", state: "open", cwd: "/work", argv: ["tool", "open_code_diff"], createdAt: "now", pane: { kind: "herdr", id: "w1:p2" }, ...overrides };
}

function harness(overrides: { wait?: (id: string, options?: LaunchWaitOptions) => Promise<LaunchRecord>; start?: (request: LaunchRequest) => Promise<LaunchRecord>; get?: (id: string) => LaunchRecord | undefined; waitSeconds?: number } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: Rpc[] = [];
  let buffer = "";
  output.on("data", (chunk) => {
    buffer += String(chunk);
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      lines.push(JSON.parse(buffer.slice(0, newline)));
      buffer = buffer.slice(newline + 1);
    }
  });
  const launcher = {
    start: vi.fn(overrides.start ?? (async () => record())),
    wait: vi.fn(overrides.wait ?? (async () => record({ state: "finished", result: runResult() }))),
    get: vi.fn(overrides.get ?? ((id: string) => (id === "L1" ? record() : undefined))),
  } satisfies Launcher;
  const runHeadlessTool = vi.fn(async (_name: string, _params: unknown, _signal?: AbortSignal) => ({ text: "Submitted", details: { submitted: true } }));
  const deps: McpServerDependencies = { launcher, terminal: "auto", runHeadlessTool };
  const options: McpServerOptions = { input, output, cwd: serverCwd, version: "1.2.3", waitSeconds: overrides.waitSeconds ?? 45 };
  const done = runMcpServer(options, deps);
  const send = (message: unknown) => input.write(`${typeof message === "string" ? message : JSON.stringify(message)}\n`);
  const reply = async (id: number | string): Promise<Rpc> => {
    await vi.waitFor(() => expect(lines.some((line) => line.id === id)).toBe(true));
    return lines.find((line) => line.id === id) as Rpc;
  };
  return { launcher, runHeadlessTool, send, reply, lines, input, output, done };
}

const call = (id: number, name: string, args: unknown, meta?: unknown) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) } });

describe("mcp protocol", () => {
  it("answers initialize with the client's protocol version when supported", async () => {
    const h = harness();
    h.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "x", version: "1" } } });

    expect((await h.reply(1)).result).toEqual({ protocolVersion: "2025-03-26", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "pi-coder", version: "1.2.3" } });
  });

  it("falls back to 2025-11-25 for an unknown protocol version", async () => {
    const h = harness();
    h.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } });

    expect((await h.reply(1)).result.protocolVersion).toBe("2025-11-25");
  });

  it("answers a server/discover probe with method-not-found so modern clients fall back to initialize", async () => {
    const h = harness();
    h.send({ jsonrpc: "2.0", id: 1, method: "server/discover", params: {} });

    expect((await h.reply(1)).error?.code).toBe(-32601);
  });

  it("does not reply to notifications and answers ping", async () => {
    const h = harness();
    h.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    h.send({ jsonrpc: "2.0", id: 2, method: "ping" });

    expect((await h.reply(2)).result).toEqual({});
    expect(h.lines).toHaveLength(1);
  });

  it("lists the tools as JSON Schema plus pi_coder_wait", async () => {
    const h = harness();
    h.send({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    const { tools } = (await h.reply(3)).result;

    expect(tools.map((tool: { name: string }) => tool.name)).toEqual(["open_code_diff", "submit_pr_review", "pi_coder_wait"]);
    expect(tools[0]).toMatchObject({ title: "Open Code Diff", description: "Open a review.\n\nGuidelines:\n- Use for reviews.\n- Pass a target.", inputSchema: { type: "object", properties: { target: { type: "string" } } } });
    expect(JSON.stringify(tools[0].inputSchema)).not.toContain("typebox");
    expect(tools[1].description).toBe("Submit a review.");
    expect(tools[2].inputSchema.required).toEqual(["launchId"]);
  });

  it("returns -32601 for an unknown method and -32700 for malformed JSON", async () => {
    const h = harness();
    h.send({ jsonrpc: "2.0", id: 4, method: "resources/list" });
    h.send("{not json");

    expect((await h.reply(4)).error).toMatchObject({ code: -32601 });
    await vi.waitFor(() => expect(h.lines.some((line) => line.id === null)).toBe(true));
    expect(h.lines.find((line) => line.id === null)?.error?.code).toBe(-32700);
  });

  it("returns -32600 for a message without a method and ignores blank lines and client responses", async () => {
    const h = harness();
    h.send("");
    h.send({ jsonrpc: "2.0", id: 9, result: {} });
    h.send({ jsonrpc: "2.0", id: 5 });

    expect((await h.reply(5)).error?.code).toBe(-32600);
    expect(h.lines).toHaveLength(1);
  });

  it("resolves when input ends", async () => {
    const h = harness();
    h.input.end();

    await expect(h.done).resolves.toBeUndefined();
  });

  it("waits for in-flight calls to settle when input ends", async () => {
    let release!: (value: LaunchRecord) => void;
    const h = harness({ wait: () => new Promise((resolve) => (release = resolve)) });
    h.send(call(1, "open_code_diff", {}));
    await vi.waitFor(() => expect(h.launcher.wait).toHaveBeenCalled());
    h.input.end();
    release(record({ state: "finished", result: runResult() }));
    await h.done;

    expect(h.lines.find((line) => line.id === 1)?.result.content[0].text).toBe("Review finished");
  });
});

describe("mcp tools/call", () => {
  it("opens a UI tool through the launcher and returns the finished result", async () => {
    const h = harness();
    h.send(call(1, "open_code_diff", { target: "main" }));
    const reply = await h.reply(1);

    expect(h.launcher.start).toHaveBeenCalledWith({ argv: ["tool", "open_code_diff"], toolInput: { target: "main", cwd: serverCwd }, cwd: serverCwd, mode: "auto" });
    expect(h.launcher.wait).toHaveBeenCalledWith("L1", expect.objectContaining({ timeoutSeconds: 45 }));
    expect(reply.result).toEqual({ content: [{ type: "text", text: "Review finished" }], structuredContent: { comments: 2 } });
  });

  it("appends the follow-up messages after the tool text", async () => {
    const result = runResult({ messages: ["pi-coder already submitted this review.", "Do not submit it again."] });
    const h = harness({ wait: async () => record({ state: "finished", result }) });
    h.send(call(1, "open_code_diff", {}));
    const reply = await h.reply(1);

    expect(reply.result.content).toEqual([
      { type: "text", text: "Review finished" },
      { type: "text", text: "pi-coder already submitted this review." },
      { type: "text", text: "Do not submit it again." },
    ]);
  });

  it("uses arguments.cwd over the server cwd, resolved against it, and passes the absolute path to the pane", async () => {
    const h = harness();
    h.send(call(1, "open_code_diff", { cwd: "other" }));
    await h.reply(1);

    expect(h.launcher.start).toHaveBeenCalledWith(expect.objectContaining({ cwd: otherCwd, toolInput: { cwd: otherCwd } }));
  });

  it("refuses a cwd that is not a directory before it opens a pane", async () => {
    const h = harness();
    h.send(call(1, "open_code_diff", { cwd: "/tmp/x\u0003touch /tmp/pwned" }));

    expect((await h.reply(1)).result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("is not a directory") }] });
    expect(h.launcher.start).not.toHaveBeenCalled();
  });

  it("stops quietly when the client closes its end of the output", async () => {
    const h = harness();
    h.output.destroy(new Error("write EPIPE"));
    h.send({ jsonrpc: "2.0", id: 1, method: "ping" });

    await expect(h.done).resolves.toBeUndefined();
  });

  it("waits without a limit when waitSeconds is zero", async () => {
    const h = harness({ waitSeconds: 0 });
    h.send(call(1, "open_code_diff", {}));
    await h.reply(1);

    expect(h.launcher.wait).toHaveBeenCalledWith("L1", expect.objectContaining({ timeoutSeconds: undefined }));
  });

  it("marks a failed CLI run as an error and names the failure", async () => {
    const h = harness({ wait: async () => record({ state: "finished", result: runResult({ ok: false, text: "Not a git repository" }) }) });
    h.send(call(1, "open_code_diff", {}));

    expect((await h.reply(1)).result).toMatchObject({ isError: true, content: [{ text: "Not a git repository\n\npi-coder could not finish: unknown error." }] });

    const crashed = harness({ wait: async () => record({ state: "finished", result: runResult({ ok: false, text: "", error: "module failed to load" }) }) });
    crashed.send(call(1, "open_code_diff", {}));

    expect((await crashed.reply(1)).result).toMatchObject({ isError: true, content: [{ text: "pi-coder could not finish: module failed to load." }] });
  });

  it("tells the agent the user is still working and how to collect the result", async () => {
    const h = harness({ wait: async () => record() });
    h.send(call(1, "open_code_diff", {}));
    const { result } = await h.reply(1);

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("herdr pane w1:p2");
    expect(result.content[0].text).toContain("still working");
    expect(result.content[0].text).toContain('pi_coder_wait with {"launchId":"L1"}');
    expect(result.content[0].text).toContain("Do not open another");
    expect(result.structuredContent).toEqual({ launchId: "L1", state: "open" });
  });

  it("reports a pane that closed without a result", async () => {
    const h = harness({ wait: async () => record({ state: "closed" }) });
    h.send(call(1, "open_code_diff", {}));
    const { result } = await h.reply(1);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("closed without a result");
  });

  it("returns a tool error when no terminal can be opened", async () => {
    const h = harness({
      start: async () => {
        throw new Error("pi-coder has no terminal to open.");
      },
    });
    h.send(call(1, "open_code_diff", {}));
    const reply = await h.reply(1);

    expect(reply.error).toBeUndefined();
    expect(reply.result).toMatchObject({ isError: true, content: [{ text: "pi-coder has no terminal to open." }] });
    expect(h.launcher.wait).not.toHaveBeenCalled();
  });

  it("runs submit_pr_review headless without opening a pane", async () => {
    const h = harness();
    h.send(call(1, "submit_pr_review", { verdict: "comment" }));
    const reply = await h.reply(1);

    expect(h.runHeadlessTool).toHaveBeenCalledWith("submit_pr_review", { verdict: "comment" }, expect.any(AbortSignal));
    expect(h.launcher.start).not.toHaveBeenCalled();
    expect(reply.result).toEqual({ content: [{ type: "text", text: "Submitted" }], structuredContent: { submitted: true } });
  });

  it("turns a headless failure into a tool error", async () => {
    const h = harness();
    h.runHeadlessTool.mockRejectedValueOnce(new Error("provider refused"));
    h.send(call(1, "submit_pr_review", { verdict: "comment" }));

    expect((await h.reply(1)).result).toMatchObject({ isError: true, content: [{ text: "provider refused" }] });
  });

  it("checks arguments against the tool schema before it runs or opens a pane", async () => {
    const h = harness();
    h.send(call(1, "submit_pr_review", {}));
    h.send(call(2, "open_code_diff", { cwd: 7 }));

    expect((await h.reply(1)).result).toMatchObject({ isError: true, content: [{ text: "Invalid input for submit_pr_review: / must have required properties verdict." }] });
    expect((await h.reply(2)).result).toMatchObject({ isError: true, content: [{ text: "Invalid input for open_code_diff: /cwd must be string." }] });
    expect(h.runHeadlessTool).not.toHaveBeenCalled();
    expect(h.launcher.start).not.toHaveBeenCalled();
  });

  it("returns an error result for an unknown tool", async () => {
    const h = harness();
    h.send(call(1, "nope", {}));
    const { result, error } = await h.reply(1);

    expect(error).toBeUndefined();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Unknown tool nope");
  });

  it("collects a left-open launch through pi_coder_wait", async () => {
    const h = harness({ wait: async () => record({ state: "finished", result: runResult({ text: "late result" }) }) });
    h.send(call(1, "pi_coder_wait", { launchId: "L1", waitSeconds: 5 }));

    expect((await h.reply(1)).result.content[0].text).toBe("late result");
    expect(h.launcher.wait).toHaveBeenCalledWith("L1", expect.objectContaining({ timeoutSeconds: 5 }));
  });

  it("uses the server wait for pi_coder_wait without waitSeconds", async () => {
    const h = harness();
    h.send(call(1, "pi_coder_wait", { launchId: "L1" }));
    await h.reply(1);

    expect(h.launcher.wait).toHaveBeenCalledWith("L1", expect.objectContaining({ timeoutSeconds: 45 }));
  });

  it("rejects pi_coder_wait for a missing or unknown launch", async () => {
    const h = harness();
    h.send(call(1, "pi_coder_wait", {}));
    h.send(call(2, "pi_coder_wait", { launchId: "ghost" }));

    expect((await h.reply(1)).result.isError).toBe(true);
    expect((await h.reply(2)).result.content[0].text).toContain("Unknown pi-coder launch ghost");
  });
});

describe("mcp progress and cancellation", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends a progress notification every 15 seconds while waiting and stops after", async () => {
    let release!: (value: LaunchRecord) => void;
    const h = harness({ wait: () => new Promise((resolve) => (release = resolve)) });
    h.send(call(1, "open_code_diff", {}, { progressToken: "tok" }));
    await vi.waitFor(() => expect(h.launcher.wait).toHaveBeenCalled());
    vi.advanceTimersByTime(15_000);
    vi.advanceTimersByTime(15_000);

    const progress = h.lines.filter((line) => line.method === "notifications/progress");
    expect(progress.map((line) => line.params)).toEqual([
      expect.objectContaining({ progressToken: "tok", progress: 1 }),
      expect.objectContaining({ progressToken: "tok", progress: 2 }),
    ]);
    release(record({ state: "finished", result: runResult() }));
    await h.reply(1);
    vi.advanceTimersByTime(60_000);
    expect(h.lines.filter((line) => line.method === "notifications/progress")).toHaveLength(2);
  });

  it("sends no progress without a progress token", async () => {
    let release!: (value: LaunchRecord) => void;
    const h = harness({ wait: () => new Promise((resolve) => (release = resolve)) });
    h.send(call(1, "open_code_diff", {}));
    await vi.waitFor(() => expect(h.launcher.wait).toHaveBeenCalled());
    vi.advanceTimersByTime(45_000);
    release(record());
    await h.reply(1);

    expect(h.lines.filter((line) => line.method === "notifications/progress")).toHaveLength(0);
  });

  it("aborts the wait on notifications/cancelled, sends no reply, and leaves the pane alone", async () => {
    let signal: AbortSignal | undefined;
    const h = harness({
      wait: (_id, options) =>
        new Promise((resolve) => {
          signal = options?.signal;
          options?.signal?.addEventListener("abort", () => resolve(record()));
        }),
    });
    h.send(call(7, "open_code_diff", {}));
    await vi.waitFor(() => expect(signal).toBeDefined());
    h.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7, reason: "user" } });
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    h.send({ jsonrpc: "2.0", id: 8, method: "ping" });
    await h.reply(8);

    expect(h.lines.some((line) => line.id === 7)).toBe(false);
    expect(h.launcher.start).toHaveBeenCalledTimes(1);
  });
});
