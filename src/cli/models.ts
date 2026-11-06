import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { basename, delimiter, join } from "node:path";
import type { ModelGateway, ModelPurpose, ModelTextRequest, StoryAgentSelection } from "../host/types.js";
import type { CliModelSettings, ModelCommandPurpose } from "./settings.js";

export type ModelSpawn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface ModelGatewayOptions {
  settingsPath: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  spawnProcess?: ModelSpawn;
  /** Finds an executable on PATH. Used to fall back to `pi -p` when no command is configured. */
  findExecutable?: (name: string) => string | undefined;
  /** Milliseconds between SIGTERM and SIGKILL when a command is stopped. */
  killAfterMs?: number;
}

const STDERR_TAIL = 800;
const KILL_AFTER_MS = 5000;
const OWN_PROCESS_GROUP = process.platform !== "win32";
const running = new Set<ChildProcess>();
let exitHookInstalled = false;

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (OWN_PROCESS_GROUP && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {}
  }
  child.kill(signal);
}

function track(child: ChildProcess): void {
  running.add(child);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const live of running) signalGroup(live, "SIGKILL");
  });
}
const PI_PRINT_ARGS = ["-p", "--no-session", "--no-tools", "--no-skills", "--no-prompt-templates", "--no-context-files"];

export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (directory.length === 0) continue;
    const candidate = join(directory, name);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

function piFallbackArgs(purpose: ModelPurpose, request: ModelTextRequest, selection: StoryAgentSelection | undefined): string[] {
  const model = purpose === "story" && selection != null
    ? ["--model", `${selection.provider}/${selection.model}`, "--thinking", selection.thinking]
    : ["--thinking", "low"];
  return [...PI_PRINT_ARGS, ...model, ...(request.system ? ["--system-prompt", request.system] : [])];
}

function fillPlaceholders(arg: string, selection: StoryAgentSelection | undefined, system: string | undefined): string {
  return arg
    .replaceAll("{provider}", selection?.provider ?? "")
    .replaceAll("{model}", selection?.model ?? "")
    .replaceAll("{thinking}", selection?.thinking ?? "")
    .replaceAll("{system}", system ?? "");
}

function tail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > STDERR_TAIL ? `...${trimmed.slice(-STDERR_TAIL)}` : trimmed;
}

export function createCommandModelGateway(settings: CliModelSettings, options: ModelGatewayOptions): ModelGateway {
  const spawnProcess = options.spawnProcess ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
  const findExecutable = options.findExecutable ?? ((name: string) => findOnPath(name, options.env ?? process.env));

  const commandFor = (purpose: ModelPurpose): string[] | undefined => (settings[purpose] ?? settings.default)?.command;
  const piFallback = (): string | undefined => findExecutable("pi");

  const requireCommand = (purpose: ModelPurpose): void => {
    if (commandFor(purpose) !== undefined || piFallback() !== undefined) return;
    throw new Error(`No model command is configured for ${purpose}. Add models.${purpose}.command to ${options.settingsPath}, or install pi.`);
  };

  const argvFor = (purpose: ModelPurpose, request: ModelTextRequest, selection: StoryAgentSelection | undefined): { argv: string[]; stdin: string } => {
    const template = commandFor(purpose);
    if (template !== undefined) {
      const usesSystemPlaceholder = template.some((arg) => arg.includes("{system}"));
      return {
        argv: template.map((arg) => fillPlaceholders(arg, selection, request.system)),
        stdin: usesSystemPlaceholder || !request.system ? request.prompt : `${request.system}\n\n${request.prompt}`,
      };
    }
    const pi = piFallback();
    if (pi === undefined) throw new Error(`No model command is configured for ${purpose}. Add models.${purpose}.command to ${options.settingsPath}, or install pi.`);
    return { argv: [pi, ...piFallbackArgs(purpose, request, selection)], stdin: request.prompt };
  };

  const run = (purpose: ModelPurpose, request: ModelTextRequest, selection?: StoryAgentSelection): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      let command: { argv: string[]; stdin: string };
      try {
        command = argvFor(purpose, request, selection);
      } catch (error) {
        reject(error);
        return;
      }
      if (request.signal?.aborted) {
        reject(request.signal.reason ?? new Error("Model command was aborted."));
        return;
      }
      const [executable = "", ...rest] = command.argv;
      const stdin = command.stdin;
      const label = basename(executable);

      let settled = false;
      let stdout = "";
      let stderr = "";
      let timer: NodeJS.Timeout | undefined;
      let killTimer: NodeJS.Timeout | undefined;
      const child = spawnProcess(executable, rest, {
        cwd: request.cwd ?? options.cwd,
        env: options.env ?? process.env,
        shell: false,
        detached: OWN_PROCESS_GROUP,
        stdio: ["pipe", "pipe", "pipe"],
      });
      track(child);

      const finish = (outcome: () => void) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        request.signal?.removeEventListener("abort", onAbort);
        outcome();
      };
      const terminate = () => {
        signalGroup(child, "SIGTERM");
        killTimer ??= setTimeout(() => signalGroup(child, "SIGKILL"), options.killAfterMs ?? KILL_AFTER_MS);
        killTimer.unref();
      };
      function onAbort() {
        terminate();
        finish(() => reject(request.signal?.reason ?? new Error("Model command was aborted.")));
      }

      request.signal?.addEventListener("abort", onAbort, { once: true });
      if (request.timeoutMs !== undefined && request.timeoutMs > 0) {
        timer = setTimeout(() => {
          terminate();
          finish(() => reject(new Error(`Model command "${label}" timed out after ${request.timeoutMs}ms.`)));
        }, request.timeoutMs);
      }

      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
        if (!settled) request.onText?.(stdout);
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", (error) => {
        running.delete(child);
        finish(() => reject(new Error(`Could not run model command "${label}": ${error.message}`)));
      });
      child.on("close", (code, signal) => {
        running.delete(child);
        if (killTimer) clearTimeout(killTimer);
        finish(() => {
          if (code === 0) resolve(stdout);
          else {
            const detail = tail(stderr);
            reject(new Error(`Model command "${label}" ${code === null ? `was stopped by ${signal}` : `exited with code ${code}`}${detail ? `: ${detail}` : "."}`));
          }
        });
      });
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(stdin);
    });

  return {
    label(purpose) {
      const command = commandFor(purpose);
      if (command !== undefined) return basename(command[0] ?? "");
      return piFallback() === undefined ? undefined : "pi";
    },
    complete: (purpose: Extract<ModelCommandPurpose, "grammar" | "analysis">, request) => run(purpose, request),
    streamStory: (selection, request) => run("story", request, selection),
    storyAgents: () => [],
    validateStoryAgent() {
      requireCommand("story");
    },
  };
}
