import { spawn } from "node:child_process";
import type { HostApi, HostContext, HostExecOptions, HostExecResult, HostTheme, HostUI, ModelGateway } from "../host/types.js";
import type { CliNotice } from "./contract.js";

export interface RunRecorder {
  messages: string[];
  notices: CliNotice[];
  prompt?: string;
}

export function createRunRecorder(): RunRecorder {
  return { messages: [], notices: [] };
}

const KILL_GRACE_MS = 5000;

export function execCommand(command: string, args: string[], options: HostExecOptions = {}): Promise<HostExecResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let killed = false;
    let settled = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    const child = spawn(command, args, { cwd: options.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });

    const settle = (result: HostExecResult) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", kill);
      resolve(result);
    };

    function kill() {
      if (killed) return;
      killed = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
      killTimer.unref();
    }

    if (options.signal) {
      if (options.signal.aborted) kill();
      else options.signal.addEventListener("abort", kill, { once: true });
    }
    if (options.timeout !== undefined && options.timeout > 0) timeoutTimer = setTimeout(kill, options.timeout);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", () => settle({ stdout, stderr, code: 1, killed }));
    child.on("close", (code) => settle({ stdout, stderr, code: code ?? 0, killed }));
  });
}

export function createTerminalApi(recorder: RunRecorder, exec: HostApi["exec"] = execCommand): HostApi {
  return {
    exec,
    sendUserMessage(message) {
      recorder.messages.push(message);
    },
  };
}

export interface InteractiveContextOptions {
  cwd: string;
  ui: HostUI;
  models: ModelGateway;
}

export function createInteractiveContext(options: InteractiveContextOptions): HostContext {
  return {
    cwd: options.cwd,
    hasUI: true,
    mode: "tui",
    ui: options.ui,
    models: options.models,
    isIdle: () => true,
  };
}

export interface HeadlessContextOptions {
  cwd: string;
  recorder: RunRecorder;
  models: ModelGateway;
  theme: HostTheme;
}

export function createHeadlessUi(recorder: RunRecorder, theme: HostTheme): HostUI {
  return {
    notify(message, type = "info") {
      recorder.notices.push({ level: type, text: message });
    },
    select: async () => undefined,
    editor: async () => undefined,
    setStatus() {},
    setWidget() {},
    custom: () => Promise.reject(new Error("This action needs a terminal. Run it with pi-coder in a terminal, or open it through a pane.")),
    setEditorText(text) {
      recorder.prompt = text;
    },
    theme,
  };
}

export function createHeadlessContext(options: HeadlessContextOptions): HostContext {
  return {
    cwd: options.cwd,
    hasUI: false,
    ui: createHeadlessUi(options.recorder, options.theme),
    models: options.models,
    isIdle: () => true,
  };
}
