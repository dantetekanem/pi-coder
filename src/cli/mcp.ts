import { statSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import type { PiCoderToolName } from "../host/engine.js";
import { PI_CODER_TOOLS } from "../tool-definitions.js";
import type { LaunchRecord, McpServerDependencies, McpServerOptions } from "./contract.js";
import { formatToolInputErrors, toolInputErrors } from "./tool-input.js";

const SUPPORTED_PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;
const PROGRESS_INTERVAL_MS = 15_000;
const WAIT_TOOL = "pi_coder_wait";

type RequestId = string | number;

interface RpcMessage {
  id?: RequestId | null;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

interface ToolResult {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textResult(text: string, structuredContent?: Record<string, unknown>, isError = false): ToolResult {
  return { content: [{ type: "text", text }], ...(structuredContent ? { structuredContent } : {}), ...(isError ? { isError: true } : {}) };
}

function toJsonSchema(parameters: unknown): Record<string, unknown> {
  const schema = JSON.parse(JSON.stringify(parameters ?? {})) as Record<string, unknown>;
  return { type: "object", ...schema };
}

function describe(tool: { description: string; promptGuidelines: readonly string[] }): string {
  return tool.promptGuidelines.length ? `${tool.description}\n\nGuidelines:\n${tool.promptGuidelines.map((line) => `- ${line}`).join("\n")}` : tool.description;
}

const WAIT_TOOL_DEFINITION = {
  name: WAIT_TOOL,
  title: "Wait for pi-coder",
  description:
    "Collect the result of a pi-coder UI that an earlier open_code, open_code_diff, or open_code_diff_story call left open because the user was still working. Pass the launchId from that call. Returns the same result once the user finishes, or says the UI is still open.",
  inputSchema: {
    type: "object",
    properties: {
      launchId: { type: "string", description: "The launchId returned while the pi-coder UI was still open." },
      waitSeconds: { type: "number", description: "Seconds to wait for the user. 0 waits until the user finishes. Defaults to the server wait." },
    },
    required: ["launchId"],
    additionalProperties: false,
  },
};

export async function runMcpServer(options: McpServerOptions, deps: McpServerDependencies): Promise<void> {
  const tools = new Map(PI_CODER_TOOLS.map((tool) => [tool.name as string, tool]));
  const inflight = new Map<RequestId, AbortController>();
  const cancelled = new Set<RequestId>();
  const pending = new Set<Promise<void>>();

  let outputClosed = false;
  const lines = createInterface({ input: options.input, crlfDelay: Number.POSITIVE_INFINITY });
  options.output.on("error", () => {
    outputClosed = true;
    lines.close();
  });
  const send = (message: Record<string, unknown>) => {
    if (outputClosed) return;
    options.output.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  };
  const reply = (id: RequestId | null, result: unknown) => send({ id, result });
  const fail = (id: RequestId | null, code: number, message: string) => send({ id, error: { code, message } });
  const log = (text: string) => process.stderr.write(`pi-coder mcp: ${text}\n`);

  function listTools() {
    return {
      tools: [
        ...PI_CODER_TOOLS.map((tool) => ({ name: tool.name, title: tool.label, description: describe(tool), inputSchema: toJsonSchema(tool.parameters) })),
        WAIT_TOOL_DEFINITION,
      ],
    };
  }

  function launchResult(record: LaunchRecord): ToolResult {
    const pane = record.pane?.id ? `${record.pane.kind} pane ${record.pane.id}` : record.pane ? `a ${record.pane.kind} terminal` : "a terminal pane";
    if (record.state === "finished" && record.result) {
      const { result } = record;
      const failure = result.ok ? undefined : `pi-coder could not finish: ${result.error ?? "unknown error"}.`;
      const primary = [result.text, failure].filter((part): part is string => part !== undefined && part.length > 0).join("\n\n");
      return {
        content: [primary, ...result.messages].map((text) => ({ type: "text" as const, text })),
        ...(result.details ? { structuredContent: result.details } : {}),
        ...(result.ok ? {} : { isError: true }),
      };
    }
    if (record.state === "closed") return textResult(`The pi-coder pane (${pane}) was closed without a result. The user closed it before finishing. Open it again if the user still wants it.`, { launchId: record.id, state: record.state }, true);
    if (record.state === "failed") return textResult(`pi-coder could not run: ${record.error ?? "unknown error"}.`, { launchId: record.id, state: record.state }, true);
    return textResult(
      `pi-coder is open in ${pane} and the user is still working. Call ${WAIT_TOOL} with {"launchId":"${record.id}"} to collect the result. Do not open another pi-coder UI for this.`,
      { launchId: record.id, state: record.state },
    );
  }

  async function waitWithProgress(id: string, seconds: number, progressToken: unknown, signal: AbortSignal): Promise<LaunchRecord> {
    let ticks = 0;
    const timer =
      typeof progressToken === "string" || typeof progressToken === "number"
        ? setInterval(() => {
            ticks += 1;
            send({ method: "notifications/progress", params: { progressToken, progress: ticks, message: "Waiting for the pi-coder UI." } });
          }, PROGRESS_INTERVAL_MS)
        : undefined;
    try {
      return await deps.launcher.wait(id, { timeoutSeconds: seconds > 0 ? seconds : undefined, signal });
    } finally {
      if (timer) clearInterval(timer);
    }
  }

  function waitSecondsOf(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : options.waitSeconds;
  }

  async function callTool(params: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult> {
    const name = params.name;
    const args = isObject(params.arguments) ? params.arguments : {};
    const progressToken = isObject(params._meta) ? params._meta.progressToken : undefined;
    if (typeof name !== "string") throw new RpcError(INVALID_PARAMS, "tools/call needs a tool name.");

    if (name === WAIT_TOOL) {
      if (typeof args.launchId !== "string" || !args.launchId) return textResult("pi_coder_wait needs a launchId.", undefined, true);
      if (!deps.launcher.get(args.launchId)) return textResult(`Unknown pi-coder launch ${args.launchId}.`, undefined, true);
      return launchResult(await waitWithProgress(args.launchId, waitSecondsOf(args.waitSeconds), progressToken, signal));
    }

    const tool = tools.get(name);
    if (!tool) return textResult(`Unknown tool ${name}. Available: ${[...tools.keys(), WAIT_TOOL].join(", ")}.`, undefined, true);
    const invalid = toolInputErrors(tool.parameters, args);
    if (invalid.length > 0) return textResult(formatToolInputErrors(name, invalid), undefined, true);

    if (!tool.needsTerminal) {
      try {
        const result = await deps.runHeadlessTool(name as PiCoderToolName, args, signal);
        return textResult(result.text, result.details);
      } catch (error) {
        return textResult(error instanceof Error ? error.message : String(error), undefined, true);
      }
    }

    let record: LaunchRecord;
    try {
      const cwd = resolve(options.cwd, typeof args.cwd === "string" && args.cwd ? args.cwd : ".");
      if (!isDirectory(cwd)) return textResult(`cwd ${JSON.stringify(cwd)} is not a directory.`, undefined, true);
      record = await deps.launcher.start({ argv: ["tool", name], toolInput: { ...args, cwd }, cwd, mode: deps.terminal });
    } catch (error) {
      return textResult(error instanceof Error ? error.message : String(error), undefined, true);
    }
    return launchResult(await waitWithProgress(record.id, options.waitSeconds, progressToken, signal));
  }

  async function handleRequest(id: RequestId, method: string, params: Record<string, unknown>): Promise<void> {
    const controller = new AbortController();
    inflight.set(id, controller);
    try {
      let result: unknown;
      if (method === "initialize") {
        const asked = params.protocolVersion;
        const protocolVersion = SUPPORTED_PROTOCOLS.find((version) => version === asked) ?? SUPPORTED_PROTOCOLS[0];
        result = { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "pi-coder", version: options.version } };
      } else if (method === "ping") result = {};
      else if (method === "tools/list") result = listTools();
      else if (method === "tools/call") result = await callTool(params, controller.signal);
      else throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${method}`);
      if (!cancelled.has(id)) reply(id, result);
    } catch (error) {
      if (cancelled.has(id)) return;
      if (error instanceof RpcError) fail(id, error.code, error.message);
      else {
        log(error instanceof Error ? (error.stack ?? error.message) : String(error));
        fail(id, -32603, error instanceof Error ? error.message : String(error));
      }
    } finally {
      inflight.delete(id);
      cancelled.delete(id);
    }
  }

  function handleLine(line: string): void {
    if (!line.trim()) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      fail(null, PARSE_ERROR, "Parse error");
      return;
    }
    if (!isObject(message)) {
      fail(null, INVALID_REQUEST, "Invalid Request");
      return;
    }
    const { id, method } = message as RpcMessage;
    const params = isObject(message.params) ? message.params : {};
    const hasId = typeof id === "string" || typeof id === "number";
    if (typeof method !== "string") {
      if (!("result" in message) && !("error" in message)) fail(hasId ? id : null, INVALID_REQUEST, "Invalid Request");
      return;
    }
    if (!hasId) {
      if (method === "notifications/cancelled") {
        const requestId = params.requestId;
        const controller = typeof requestId === "string" || typeof requestId === "number" ? inflight.get(requestId) : undefined;
        if (controller) {
          cancelled.add(requestId as RequestId);
          controller.abort();
        }
      }
      return;
    }
    const task = handleRequest(id, method, params);
    pending.add(task);
    void task.finally(() => pending.delete(task));
  }

  await new Promise<void>((done) => {
    lines.on("line", handleLine);
    lines.once("close", done);
  });
  for (const controller of inflight.values()) controller.abort();
  await Promise.allSettled([...pending]);
}
