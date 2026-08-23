import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createChildTermination, isChildClosureError, utf8Prefix } from "../workbench/node/process-termination.js";
import type { CodeHostPreference } from "./settings.js";

export type CodeHostLifecycle = "not-started" | "closed" | "unconfirmed";

export class CodeHostError extends Error {
  readonly lifecycle: CodeHostLifecycle;

  constructor(message: string, lifecycle: CodeHostLifecycle, options?: ErrorOptions) {
    super(message, options);
    this.name = "CodeHostError";
    this.lifecycle = lifecycle;
  }
}

export interface CodeHostProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | string | null;
  stdout?: string;
}

export interface CodeHostProcessOptions {
  cwd: string;
  shell: false;
  stdio?: "inherit";
  signal?: AbortSignal;
}

export interface CodeHostProcessRunner {
  run(command: string, args: readonly string[], options: CodeHostProcessOptions): Promise<CodeHostProcessResult>;
}

export interface CodeHostLaunchRequest {
  cwd: string;
  editor: { executable: string; args: readonly string[] };
  signal?: AbortSignal;
}

export type CodeHostCompletion =
  | { status: "completed"; paneId?: string; output?: string }
  | { status: "aborted"; paneId?: string };

function failureMessage(command: string, result: CodeHostProcessResult): string | null {
  if (result.signal != null) return `${command} was terminated by ${result.signal}.`;
  if (result.exitCode == null) return `${command} closed without an exit code or signal.`;
  if (result.exitCode !== 0) return `${command} exited with code ${result.exitCode}.`;
  return null;
}

function processError(error: unknown, command: string, lifecycle: CodeHostLifecycle): CodeHostError {
  if (error instanceof CodeHostError) return error;
  return new CodeHostError(
    error instanceof Error ? error.message : `Could not run ${command}: ${String(error)}`,
    lifecycle,
    error instanceof Error ? { cause: error } : undefined,
  );
}

const MAX_HOST_STDOUT_BYTES = 64 * 1024;

export const defaultCodeHostProcessRunner: CodeHostProcessRunner = {
  run(command, args, options) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let stdout = "";
      let stdoutBytes = 0;
      const child = spawn(command, [...args], {
        cwd: options.cwd,
        env: process.env,
        shell: false,
        stdio: options.stdio === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"],
      });
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener("abort", abort);
        termination.dispose();
        action();
      };
      const termination = createChildTermination(child, command, (error) => finish(() => reject(error)));
      const abort = () => termination.request();
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
      if (options.stdio !== "inherit") {
        child.stdout?.on("data", (chunk) => {
          const remaining = MAX_HOST_STDOUT_BYTES - stdoutBytes;
          if (remaining <= 0) return;
          const prefix = utf8Prefix(String(chunk), remaining);
          stdout += prefix.text;
          stdoutBytes += prefix.bytes;
        });
        child.stderr?.resume();
      }
      child.once("error", (error) => finish(() => reject(error)));
      child.once("close", (exitCode, signal) => {
        termination.markClosed();
        finish(() => resolve({ exitCode, signal, ...(options.stdio === "inherit" ? {} : { stdout }) }));
      });
    });
  },
};

function present(value: string | undefined): boolean {
  return value != null && value.length > 0;
}

function herdrIsApplicable(env: NodeJS.ProcessEnv): boolean {
  return present(env.HERDR_ENV) && present(env.HERDR_PANE_ID);
}

export function selectCodeHost(preference: CodeHostPreference, env: NodeJS.ProcessEnv): Exclude<CodeHostPreference, "auto"> {
  if (preference === "current-terminal") return preference;
  if (preference === "tmux-auto") return present(env.TMUX) ? "tmux-auto" : "current-terminal";
  if (preference === "herdr-auto") return herdrIsApplicable(env) ? "herdr-auto" : "current-terminal";
  if (herdrIsApplicable(env)) return "herdr-auto";
  if (present(env.TMUX)) return "tmux-auto";
  return "current-terminal";
}

export async function launchCurrentTerminal(
  request: CodeHostLaunchRequest,
  runner: CodeHostProcessRunner = defaultCodeHostProcessRunner,
): Promise<CodeHostCompletion> {
  if (request.signal?.aborted) throw new CodeHostError("External code editor launch was aborted before it started.", "not-started");
  let result: CodeHostProcessResult;
  try {
    result = await runner.run(request.editor.executable, request.editor.args, {
      cwd: request.cwd,
      shell: false,
      stdio: "inherit",
      ...(request.signal == null ? {} : { signal: request.signal }),
    });
  } catch (error) {
    throw processError(error, request.editor.executable, isChildClosureError(error) ? "unconfirmed" : "not-started");
  }
  const message = failureMessage(request.editor.executable, result);
  if (message != null) throw new CodeHostError(message, "closed");
  return { status: "completed" };
}

function defaultDelay(signal?: AbortSignal): Promise<void> {
  return new Promise((resolveDelay, rejectDelay) => {
    if (signal?.aborted) {
      rejectDelay(signal.reason ?? new Error("Code host launch aborted."));
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      rejectDelay(signal?.reason ?? new Error("Code host launch aborted."));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolveDelay();
    }, 100);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function validateTmuxPaneId(stdout: string | undefined): string {
  const paneId = stdout?.trim() ?? "";
  if (!/^%[0-9]+$/.test(paneId)) throw new CodeHostError("tmux did not return a valid pane id; pane closure is unconfirmed.", "unconfirmed");
  return paneId;
}

type TmuxPaneState = "alive" | "dead" | "absent";

async function tmuxPaneState(
  paneId: string,
  request: CodeHostLaunchRequest,
  runner: CodeHostProcessRunner,
): Promise<TmuxPaneState> {
  let result: CodeHostProcessResult;
  try {
    result = await runner.run("tmux", ["list-panes", "-a", "-F", "#{pane_id}\t#{pane_dead}"], { cwd: request.cwd, shell: false });
  } catch (error) {
    throw processError(error, "tmux list-panes", "unconfirmed");
  }
  const message = failureMessage("tmux list-panes", result);
  if (message != null) throw new CodeHostError(message, "unconfirmed");

  for (const line of (result.stdout ?? "").split("\n")) {
    if (line.length === 0) continue;
    const match = /^(%[0-9]+)\t([01])$/.exec(line);
    if (match == null) throw new CodeHostError("tmux returned an invalid pane list; pane closure is unconfirmed.", "unconfirmed");
    if (match[1] === paneId) return match[2] === "1" ? "dead" : "alive";
  }
  return "absent";
}

async function closeTmuxPane(
  paneId: string,
  request: CodeHostLaunchRequest,
  runner: CodeHostProcessRunner,
): Promise<void> {
  let result: CodeHostProcessResult;
  try {
    result = await runner.run("tmux", ["kill-pane", "-t", paneId], { cwd: request.cwd, shell: false });
  } catch (error) {
    throw processError(error, "tmux kill-pane", "unconfirmed");
  }
  const message = failureMessage("tmux kill-pane", result);
  if (message != null) {
    if (await tmuxPaneState(paneId, request, runner) === "absent") return;
    throw new CodeHostError(message, "unconfirmed");
  }
  if (await tmuxPaneState(paneId, request, runner) !== "absent") {
    throw new CodeHostError("tmux pane did not close after kill-pane; pane closure is unconfirmed.", "unconfirmed");
  }
}

async function tmuxPaneStateWithCleanup(
  paneId: string,
  request: CodeHostLaunchRequest,
  runner: CodeHostProcessRunner,
): Promise<TmuxPaneState> {
  try {
    return await tmuxPaneState(paneId, request, runner);
  } catch (error) {
    try {
      await closeTmuxPane(paneId, request, runner);
    } catch (cleanupError) {
      throw processError(cleanupError, "tmux pane cleanup", "unconfirmed");
    }
    throw new CodeHostError(
      error instanceof Error ? error.message : String(error),
      "closed",
      error instanceof Error ? { cause: error } : undefined,
    );
  }
}

export async function launchTmuxPane(
  request: CodeHostLaunchRequest,
  runner: CodeHostProcessRunner = defaultCodeHostProcessRunner,
  dependencies: { delay?: (signal?: AbortSignal) => Promise<void> } = {},
): Promise<CodeHostCompletion> {
  if (request.signal?.aborted) throw new CodeHostError("tmux pane launch was aborted before it started.", "not-started");
  let split: CodeHostProcessResult;
  try {
    split = await runner.run("tmux", [
      "split-window", "-h", "-P", "-F", "#{pane_id}", "-c", request.cwd,
      "/usr/bin/env", "--", request.editor.executable, ...request.editor.args,
    ], { cwd: request.cwd, shell: false });
  } catch (error) {
    throw processError(error, "tmux split-window", "not-started");
  }
  const splitFailure = failureMessage("tmux split-window", split);
  if (splitFailure != null) throw new CodeHostError(splitFailure, "not-started");
  const paneId = validateTmuxPaneId(split.stdout);
  const delay = dependencies.delay ?? defaultDelay;

  while (true) {
    const paneState = await tmuxPaneStateWithCleanup(paneId, request, runner);
    if (paneState === "absent") return { status: "completed", paneId };
    if (paneState === "dead") {
      await closeTmuxPane(paneId, request, runner);
      return { status: "completed", paneId };
    }
    if (request.signal?.aborted) {
      await closeTmuxPane(paneId, request, runner);
      return { status: "aborted", paneId };
    }
    try {
      await delay(request.signal);
    } catch (error) {
      if (!request.signal?.aborted) {
        await closeTmuxPane(paneId, request, runner);
        throw new CodeHostError(
          error instanceof Error ? error.message : "tmux pane wait failed.",
          "closed",
          error instanceof Error ? { cause: error } : undefined,
        );
      }
    }
    if (request.signal?.aborted) {
      await closeTmuxPane(paneId, request, runner);
      return { status: "aborted", paneId };
    }
  }
}

function quotePosixShellArgument(value: string): string {
  if (/[\0\r\n]/.test(value)) throw new CodeHostError("Herdr editor arguments must be single-line strings.", "not-started");
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function defaultSentinel(): string {
  return `__PI_CODE_DONE_${randomUUID().replace(/-/g, "")}__`;
}

function parseHerdrPaneId(stdout: string | undefined): string {
  try {
    const parsed = JSON.parse(stdout ?? "") as unknown;
    if (parsed == null || typeof parsed !== "object") throw new Error("not an object");
    const result = (parsed as Record<string, unknown>).result;
    if (result == null || typeof result !== "object") throw new Error("missing result");
    const pane = (result as Record<string, unknown>).pane;
    if (pane == null || typeof pane !== "object") throw new Error("missing pane");
    const paneId = (pane as Record<string, unknown>).pane_id;
    if (typeof paneId !== "string" || paneId.length === 0 || /[\0\r\n]/.test(paneId)) throw new Error("missing pane id");
    return paneId;
  } catch (error) {
    throw new CodeHostError("Herdr did not return a valid pane id; pane closure is unconfirmed.", "unconfirmed", error instanceof Error ? { cause: error } : undefined);
  }
}

async function runHerdr(
  args: readonly string[],
  request: CodeHostLaunchRequest,
  runner: CodeHostProcessRunner,
  lifecycle: CodeHostLifecycle,
  abortable = false,
): Promise<CodeHostProcessResult> {
  let result: CodeHostProcessResult;
  try {
    result = await runner.run("herdr", args, {
      cwd: request.cwd,
      shell: false,
      ...(abortable && request.signal != null ? { signal: request.signal } : {}),
    });
  } catch (error) {
    throw processError(error, `herdr ${args.slice(0, 2).join(" ")}`, lifecycle);
  }
  const message = failureMessage(`herdr ${args.slice(0, 2).join(" ")}`, result);
  if (message != null) throw new CodeHostError(message, lifecycle);
  return result;
}

export async function launchHerdrPane(
  request: CodeHostLaunchRequest,
  runner: CodeHostProcessRunner = defaultCodeHostProcessRunner,
  dependencies: { createSentinel?: () => string } = {},
): Promise<CodeHostCompletion> {
  if (request.signal?.aborted) throw new CodeHostError("Herdr pane launch was aborted before it started.", "not-started");
  const sentinel = (dependencies.createSentinel ?? defaultSentinel)();
  if (!/^[A-Za-z0-9_]+$/.test(sentinel)) throw new CodeHostError("Herdr completion sentinel is invalid.", "not-started");
  const command = `${[request.editor.executable, ...request.editor.args].map(quotePosixShellArgument).join(" ")}; printf '%s\\n' ${quotePosixShellArgument(sentinel)}`;
  if (request.signal?.aborted) throw new CodeHostError("Herdr pane launch was aborted before it started.", "not-started");

  const split = await runHerdr(
    ["pane", "split", "--current", "--direction", "right", "--cwd", request.cwd, "--focus"],
    request,
    runner,
    "not-started",
  );
  const paneId = parseHerdrPaneId(split.stdout);
  let closing = false;

  try {
    await runHerdr(["pane", "run", paneId, command], request, runner, "unconfirmed");
    await runHerdr(["pane", "wait-output", paneId, "--match", sentinel], request, runner, "unconfirmed", true);
    const read = await runHerdr(["pane", "read", paneId, "--source", "recent-unwrapped"], request, runner, "closed");
    closing = true;
    await runHerdr(["pane", "close", paneId], request, runner, "unconfirmed");
    return { status: "completed", paneId, output: read.stdout ?? "" };
  } catch (error) {
    if (closing) throw processError(error, "herdr pane close", "unconfirmed");
    try {
      await runHerdr(["pane", "close", paneId], request, runner, "unconfirmed");
    } catch (cleanupError) {
      throw processError(cleanupError, "herdr pane close", "unconfirmed");
    }
    if (request.signal?.aborted) return { status: "aborted", paneId };
    throw new CodeHostError(
      error instanceof Error ? error.message : String(error),
      "closed",
      error instanceof Error ? { cause: error } : undefined,
    );
  }
}

export async function launchCodeHost(
  preference: CodeHostPreference,
  request: CodeHostLaunchRequest,
  runner: CodeHostProcessRunner = defaultCodeHostProcessRunner,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CodeHostCompletion> {
  const host = selectCodeHost(preference, env);
  if (host === "tmux-auto") return launchTmuxPane(request, runner);
  if (host === "herdr-auto") return launchHerdrPane(request, runner);
  return launchCurrentTerminal(request, runner);
}
