import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CliRunResult, LaunchRecord, LaunchRequest, LaunchWaitOptions, Launcher, LauncherOptions } from "./contract.js";
import { PI_CODER_RESULT_VERSION } from "./contract.js";

const HERDR_SPLIT_RATIO = "0.5";
const RESULT_POLL_MS = 250;
const LIVENESS_POLL_MS = 1000;
const PANE_RUN_ATTEMPTS = 5;
const PANE_RUN_RETRY_MS = 200;
const EXEC_TIMEOUT_MS = 15_000;
const FORWARDED_ENV = /^(?:PI_CODER_[A-Z0-9_]+|NO_COLOR)$/;
const LAUNCH_ID = /^[A-Za-z0-9-]+$/;
const CONTROL_CHARACTER = /[\x00-\x1f\x7f]/;
const PRUNE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export interface LauncherDependencies {
  exec(file: string, args: string[]): Promise<string>;
  spawnDetached(file: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): Promise<void>;
  randomId(): string;
  now(): Date;
  delay(ms: number): Promise<void>;
  /** Reports whether a process id still runs, for the pid the pane child writes at start. */
  processAlive(pid: number): boolean;
  resultPollMs: number;
  livenessPollMs: number;
}

const defaultDependencies: LauncherDependencies = {
  exec: (file, args) =>
    new Promise((resolve, reject) => {
      execFile(file, args, { timeout: EXEC_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) reject(Object.assign(error, { stdout: String(stdout), stderr: String(stderr) }));
        else resolve(String(stdout));
      });
    }),
  spawnDetached: (file, args, options) =>
    new Promise((resolve, reject) => {
      const child = spawn(file, args, { cwd: options.cwd, env: options.env, detached: true, stdio: "ignore" });
      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    }),
  randomId: randomUUID,
  now: () => new Date(),
  delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  processAlive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  },
  resultPollMs: RESULT_POLL_MS,
  livenessPollMs: LIVENESS_POLL_MS,
};

type PaneInfo = NonNullable<LaunchRecord["pane"]>;

interface StoredRequest {
  id: string;
  argv: string[];
  cwd: string;
  mode: LaunchRequest["mode"];
  createdAt: string;
  hasInput: boolean;
}

interface StoredState {
  state: "closed" | "failed";
  error?: string;
}

export function scriptQuote(text: string): string {
  if (text.includes("\0")) throw new Error("pi-coder cannot pass a NUL character to the pane.");
  return `'${text.replaceAll("'", "'\\''")}'`;
}

/** The pane runs this file with /bin/sh, so no value reaches a line editor or the user's login shell. */
export function runScript(argv: readonly string[], pidFile: string): string {
  return `#!/bin/sh\n(umask 077 && echo $$ > ${scriptQuote(pidFile)})\nexec ${argv.map(scriptQuote).join(" ")}\n`;
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function isRunResult(value: unknown): value is CliRunResult {
  return typeof value === "object" && value !== null && (value as { piCoder?: unknown }).piCoder === PI_CODER_RESULT_VERSION;
}

function failureText(error: unknown): string {
  if (error && typeof error === "object") {
    const { stdout, stderr } = error as { stdout?: unknown; stderr?: unknown };
    for (const stream of [stderr, stdout]) {
      const reason = typeof stream === "string" ? /"message":"((?:[^"\\]|\\.)*)"/.exec(stream)?.[1] : undefined;
      if (reason) return reason;
    }
  }
  return error instanceof Error ? error.message : String(error);
}

function noPaneOptions(): string {
  return "Run pi-coder inside Herdr (HERDR_ENV=1) or tmux, or set terminal.command in pi-coder-settings.json to an argv that opens a terminal, for example [\"ghostty\", \"-e\"].";
}

export function createLauncher(options: LauncherOptions, overrides: Partial<LauncherDependencies> = {}): Launcher {
  const deps: LauncherDependencies = { ...defaultDependencies, ...overrides };
  const env = options.env ?? process.env;
  const root = join(options.agentDir, "cache", "pi-coder", "launches");

  const dirOf = (id: string) => join(root, id);

  function read(id: string): LaunchRecord | undefined {
    if (!LAUNCH_ID.test(id)) return undefined;
    const dir = dirOf(id);
    const request = readJson<StoredRequest>(join(dir, "request.json"));
    if (!request) return undefined;
    const record: LaunchRecord = { id: request.id, state: "open", cwd: request.cwd, argv: request.argv, createdAt: request.createdAt };
    const pane = readJson<PaneInfo>(join(dir, "pane.json"));
    if (pane) record.pane = pane;
    const result = readJson<unknown>(join(dir, "result.json"));
    if (isRunResult(result)) return { ...record, state: "finished", result };
    const stored = readJson<StoredState>(join(dir, "state.json"));
    if (stored) {
      record.state = stored.state;
      if (stored.error) record.error = stored.error;
    }
    return record;
  }

  function settle(id: string, state: StoredState): LaunchRecord {
    writeJson(join(dirOf(id), "state.json"), state);
    return read(id) as LaunchRecord;
  }

  async function herdrAvailable(): Promise<boolean> {
    const paneId = env.HERDR_PANE_ID;
    if (env.HERDR_ENV !== "1" || !paneId) return false;
    try {
      await deps.exec("herdr", ["pane", "get", paneId]);
      return true;
    } catch {
      return false;
    }
  }

  async function resolveMode(mode: LaunchRequest["mode"]): Promise<PaneInfo["kind"]> {
    if (mode === "herdr") {
      if (!env.HERDR_PANE_ID) throw new Error(`Cannot open a Herdr pane: HERDR_PANE_ID is not set. ${noPaneOptions()}`);
      return "herdr";
    }
    if (mode === "tmux") {
      if (!env.TMUX) throw new Error(`Cannot open a tmux pane: TMUX is not set. ${noPaneOptions()}`);
      return "tmux";
    }
    if (mode === "command") {
      if (!options.settings.command?.length) throw new Error("terminal.command is not set in pi-coder-settings.json. Set it to an argv that opens a terminal, for example [\"ghostty\", \"-e\"].");
      return "command";
    }
    if (await herdrAvailable()) return "herdr";
    if (env.TMUX) return "tmux";
    if (options.settings.command?.length) return "command";
    throw new Error(`pi-coder has no terminal to open. ${noPaneOptions()}`);
  }

  function forwardedEnv(): string[] {
    const settings = Object.entries(env)
      .filter((entry): entry is [string, string] => entry[1] !== undefined && FORWARDED_ENV.test(entry[0]))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => `${name}=${value}`);
    return [`PI_CODING_AGENT_DIR=${options.agentDir}`, ...settings];
  }

  function childArgv(request: LaunchRequest, dir: string, hasInput: boolean): string[] {
    return [
      "env",
      ...forwardedEnv(),
      options.nodePath,
      options.binPath,
      ...request.argv,
      "--terminal",
      "inline",
      "--cwd",
      request.cwd,
      "--result-file",
      join(dir, "result.json"),
      ...(hasInput ? ["--input-file", join(dir, "input.json")] : []),
    ];
  }

  function paneCommand(script: string): string {
    if (CONTROL_CHARACTER.test(script)) throw new Error("The launch folder path holds a control character.");
    return `exec /bin/sh ${scriptQuote(script)}`;
  }

  async function openHerdr(request: LaunchRequest, script: string): Promise<PaneInfo> {
    const caller = env.HERDR_PANE_ID as string;
    const line = paneCommand(script);
    const split = await deps.exec("herdr", ["pane", "split", caller, "--direction", "right", "--ratio", HERDR_SPLIT_RATIO, "--cwd", request.cwd, "--focus"]);
    const id = (JSON.parse(split) as { result?: { pane?: { pane_id?: string } } }).result?.pane?.pane_id;
    if (!id) throw new Error("Herdr did not report the new pane.");
    for (let attempt = 1; ; attempt += 1) {
      try {
        await deps.exec("herdr", ["pane", "run", id, line]);
        return { kind: "herdr", id };
      } catch (error) {
        if (attempt >= PANE_RUN_ATTEMPTS) {
          await deps.exec("herdr", ["pane", "close", id]).catch(() => undefined);
          throw error;
        }
        await deps.delay(PANE_RUN_RETRY_MS);
      }
    }
  }

  async function openTmux(request: LaunchRequest, script: string): Promise<PaneInfo> {
    const target = env.TMUX_PANE ? ["-t", env.TMUX_PANE] : [];
    const out = await deps.exec("tmux", ["split-window", "-h", ...target, "-c", request.cwd, "-P", "-F", "#{pane_id}", paneCommand(script)]);
    const id = out.trim();
    if (!id) throw new Error("tmux did not report the new pane.");
    const socket = env.TMUX?.split(",")[0];
    return { kind: "tmux", id, ...(socket ? { socket } : {}) };
  }

  async function openCommand(request: LaunchRequest, script: string): Promise<PaneInfo> {
    const [file, ...rest] = (options.settings.command as string[]).map((part) => part.replaceAll("{cwd}", request.cwd));
    await deps.spawnDetached(file as string, [...rest, "/bin/sh", script], { cwd: request.cwd, env: { ...process.env, ...env, PI_CODING_AGENT_DIR: options.agentDir } });
    return { kind: "command" };
  }

  function childAlive(id: string): boolean | undefined {
    let text: string;
    try {
      text = readFileSync(join(dirOf(id), "pid"), "utf8").trim();
    } catch {
      return undefined;
    }
    const pid = Number(text);
    return Number.isSafeInteger(pid) && pid > 0 ? deps.processAlive(pid) : undefined;
  }

  function prune(): void {
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      return;
    }
    const cutoff = deps.now().getTime() - PRUNE_AFTER_MS;
    for (const entry of entries) {
      if (!LAUNCH_ID.test(entry)) continue;
      const createdAt = Date.parse(readJson<StoredRequest>(join(root, entry, "request.json"))?.createdAt ?? "");
      if (Number.isFinite(createdAt) && createdAt < cutoff) rmSync(join(root, entry), { recursive: true, force: true });
    }
  }

  async function paneGone(pane: PaneInfo): Promise<boolean> {
    if (!pane.id) return false;
    if (pane.kind === "herdr") {
      try {
        await deps.exec("herdr", ["pane", "get", pane.id]);
        return false;
      } catch (error) {
        const { stdout, stderr } = error as { stdout?: unknown; stderr?: unknown };
        return `${stdout ?? ""}${stderr ?? ""}`.includes("pane_not_found");
      }
    }
    if (pane.kind === "tmux") {
      try {
        const panes = await deps.exec("tmux", [...(pane.socket ? ["-S", pane.socket] : []), "list-panes", "-a", "-F", "#{pane_id}"]);
        return !panes.split("\n").some((line) => line.trim() === pane.id);
      } catch (error) {
        const { stdout, stderr } = error as { stdout?: unknown; stderr?: unknown };
        return /no server running|error connecting/.test(`${stdout ?? ""}${stderr ?? ""}`);
      }
    }
    return false;
  }

  async function closeHerdrPane(pane: PaneInfo | undefined): Promise<void> {
    if (pane?.kind !== "herdr" || !pane.id) return;
    await deps.exec("herdr", ["pane", "close", pane.id]).catch(() => undefined);
  }

  async function start(request: LaunchRequest): Promise<LaunchRecord> {
    const kind = await resolveMode(request.mode);
    prune();
    const id = deps.randomId();
    const dir = dirOf(id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const hasInput = request.toolInput !== undefined;
    const stored: StoredRequest = { id, argv: request.argv, cwd: request.cwd, mode: request.mode, createdAt: deps.now().toISOString(), hasInput };
    writeJson(join(dir, "request.json"), stored);
    if (hasInput) writeJson(join(dir, "input.json"), request.toolInput);
    const script = join(dir, "run.sh");
    try {
      writeFileSync(script, runScript(childArgv(request, dir, hasInput), join(dir, "pid")), { mode: 0o700 });
      const pane = kind === "herdr" ? await openHerdr(request, script) : kind === "tmux" ? await openTmux(request, script) : await openCommand(request, script);
      writeJson(join(dir, "pane.json"), pane);
    } catch (error) {
      const message = failureText(error);
      settle(id, { state: "failed", error: message });
      throw new Error(`Could not open a ${kind} pane for pi-coder: ${message}`);
    }
    return read(id) as LaunchRecord;
  }

  async function wait(id: string, waitOptions: LaunchWaitOptions = {}): Promise<LaunchRecord> {
    const { timeoutSeconds, signal } = waitOptions;
    let record = read(id);
    if (!record) throw new Error(`Unknown pi-coder launch ${id}.`);
    if (record.state !== "open") return record;

    const deadline = timeoutSeconds === undefined ? Number.POSITIVE_INFINITY : Date.now() + timeoutSeconds * 1000;
    let wake: (() => void) | undefined;
    const watcher = (() => {
      try {
        return existsSync(dirOf(id)) ? watch(dirOf(id), () => wake?.()) : undefined;
      } catch {
        return undefined;
      }
    })();
    watcher?.on("error", () => undefined);
    const onAbort = () => wake?.();
    signal?.addEventListener("abort", onAbort);
    let nextLiveness = 0;
    try {
      for (;;) {
        record = read(id) as LaunchRecord;
        if (record.state !== "open") break;
        if (Date.now() >= nextLiveness) {
          nextLiveness = Date.now() + deps.livenessPollMs;
          const alive = childAlive(id);
          if (alive === false || (alive === undefined && record.pane && (await paneGone(record.pane)))) {
            record = read(id) as LaunchRecord;
            if (record.state === "open") record = settle(id, { state: "closed" });
            break;
          }
        }
        if (signal?.aborted || Date.now() >= deadline) break;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, Math.max(0, Math.min(deps.resultPollMs, deadline - Date.now())));
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        wake = undefined;
      }
    } finally {
      watcher?.close();
      signal?.removeEventListener("abort", onAbort);
    }
    if (record.state === "finished") await closeHerdrPane(record.pane);
    return record;
  }

  return { start, wait, get: read };
}
