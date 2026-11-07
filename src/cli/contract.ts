import type { PiCoderToolName, PiCoderToolResult } from "../host/engine.js";
import type { HostNotifyLevel } from "../host/types.js";

export const PI_CODER_RESULT_VERSION = 1 as const;

export type CliCommandName = "diff" | "story" | "code" | "tool";

export interface CliNotice {
  level: HostNotifyLevel;
  text: string;
}

/** What every pi-coder terminal run prints with --json and writes with --output or --result-file. */
export interface CliRunResult {
  piCoder: typeof PI_CODER_RESULT_VERSION;
  command: CliCommandName;
  tool?: PiCoderToolName;
  /** False when pi-coder could not run the command at all: bad arguments, no terminal, a crash. */
  ok: boolean;
  /** True when a review, story, or workbench opened, or a setting changed. */
  started: boolean;
  /** For tools: the exact text a Pi tool call returns. For commands: a one-line summary. */
  text: string;
  /** Text for the calling agent: review feedback, a DISCUSS handoff, or a code discussion. */
  prompt?: string;
  message?: string;
  /** For tools: the exact details a Pi tool call returns. For commands: the review or workbench outcome. */
  details?: Record<string, unknown>;
  /** Messages pi-coder would have sent to the agent's conversation, in order. */
  messages: string[];
  notices: CliNotice[];
  error?: string;
}

export type TerminalMode = "auto" | "inline" | "herdr" | "tmux" | "command";

/** A command a terminal host runs in another pane because the caller has no terminal. */
export interface LaunchRequest {
  /** Arguments for the pi-coder binary, for example ["diff", "main...HEAD"] or ["tool", "open_code_diff"]. */
  argv: string[];
  cwd: string;
  /** Tool input written to request.json and passed with --input-file. */
  toolInput?: unknown;
  mode: Exclude<TerminalMode, "inline">;
}

export type LaunchState = "open" | "finished" | "closed" | "failed";

export interface LaunchRecord {
  id: string;
  state: LaunchState;
  cwd: string;
  argv: string[];
  createdAt: string;
  /** `socket` is the tmux server socket, so a later `wait` from another process checks the same server. */
  pane?: { kind: "herdr" | "tmux" | "command"; id?: string; socket?: string };
  result?: CliRunResult;
  error?: string;
}

export interface LaunchWaitOptions {
  /** Seconds to wait. Zero returns the current state at once. Undefined waits until the launch ends. */
  timeoutSeconds?: number;
  signal?: AbortSignal;
}

/** The `terminal` section of pi-coder-settings.json, validated in src/cli/settings.ts. */
export interface TerminalSettings {
  /** Argv that opens a new terminal pane. pi-coder replaces {cwd} and appends its own argv. */
  command?: string[];
}

export interface LauncherOptions {
  /** Agent dir; launches live in <agentDir>/cache/pi-coder/launches/<id>/. */
  agentDir: string;
  /** Node binary and bin/pi-coder.mjs path the pane runs. */
  nodePath: string;
  binPath: string;
  settings: TerminalSettings;
  env?: Readonly<Record<string, string | undefined>>;
}

/** Implemented in src/cli/launch.ts as `createLauncher(options: LauncherOptions): Launcher`. */
export interface Launcher {
  /** Opens pi-coder in another pane and returns once the pane runs. */
  start(request: LaunchRequest): Promise<LaunchRecord>;
  /** Resolves when the launch finishes, its pane closes, or the wait times out (state stays "open"). */
  wait(id: string, options?: LaunchWaitOptions): Promise<LaunchRecord>;
  /** Reads a launch without waiting. */
  get(id: string): LaunchRecord | undefined;
}

/** Implemented in src/cli/mcp.ts as `runMcpServer(options: McpServerOptions, deps: McpServerDependencies): Promise<void>`. */
export interface McpServerOptions {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  cwd: string;
  version: string;
  /** Seconds a UI tool waits before it returns a launch id. Zero waits until the user finishes. */
  waitSeconds: number;
}

export interface McpServerDependencies {
  launcher: Launcher;
  /** Pane mode for UI tools: "auto" picks herdr, tmux, then the configured command. */
  terminal: Exclude<TerminalMode, "inline">;
  /** Runs a tool without a terminal, for submit_pr_review. */
  runHeadlessTool(name: PiCoderToolName, params: unknown, signal?: AbortSignal): Promise<PiCoderToolResult>;
}
