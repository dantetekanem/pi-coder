import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ProcessTerminal, TUI, type Component, type Focusable, type Terminal } from "@earendil-works/pi-tui";
import { createWorkbench } from "./app.js";
import {
  WorkbenchCompletionError,
  type ClosedWorkbenchResult,
  type CodeStory,
  type Workbench,
  type WorkbenchCompletionResult,
  type WorkbenchLaunch,
  type TargetOpenResult,
  type WorkbenchRepository,
} from "./contracts.js";
import { processExplorerStateStore, type ExplorerStateSession, type ExplorerStateStore } from "./explorer-state.js";
import { cleanupWorkbench, formatTargetOpenIssue } from "./host-boundary.js";
import { normalizeWorkbenchLaunch } from "./target.js";
import { createNodeWorkspace } from "./node/workspace.js";
import { createWorkbenchComponent, type WorkbenchClipboard, type WorkbenchComponent, type WorkbenchTheme } from "./ui/component.js";

export type StandaloneArgs = { kind: "help" } | { kind: "run"; cwd: string; launch: WorkbenchLaunch };

function reportTargetOpenIssue(result: TargetOpenResult, report: (message: string) => void): void {
  if (result.status === "opened" && result.message == null) return;
  report(formatTargetOpenIssue(result));
}

interface StandaloneTui {
  addChild(component: Component): void;
  setFocus(component: Component | null): void;
  start(): void;
  stop(): void;
}

interface SignalSource {
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export interface StandaloneDependencies {
  createTerminal(): Terminal;
  createTui(terminal: Terminal): StandaloneTui;
  createRepository(cwd: string): Promise<WorkbenchRepository>;
  createWorkbench(repository: WorkbenchRepository): Workbench;
  createComponent(
    tui: StandaloneTui,
    theme: WorkbenchTheme,
    workbench: Workbench,
    done: (result: WorkbenchCompletionResult) => void,
    explorerState?: ExplorerStateSession,
    launch?: WorkbenchLaunch,
    clipboard?: WorkbenchClipboard,
  ): Component & Focusable & Pick<WorkbenchComponent, "requestClose">;
  explorerStateStore?: ExplorerStateStore;
  reportStartupIssue?(message: string): void;
  signalSource: SignalSource;
}

const defaultDependencies: StandaloneDependencies = {
  createTerminal: () => new ProcessTerminal(),
  createTui: (terminal) => new TUI(terminal),
  createRepository: createNodeWorkspace,
  createWorkbench,
  createComponent: (tui, theme, workbench, done, explorerState, launch, clipboard) => createWorkbenchComponent(tui as TUI, theme, workbench, done, explorerState, launch, clipboard),
  explorerStateStore: processExplorerStateStore,
  reportStartupIssue: (message) => process.stderr.write(`Could not open initial target: ${message}\n`),
  signalSource: process,
};

const VALUE_OPTIONS = new Set(["--cwd", "--path", "--line", "--end-line", "--anchor-sha256", "--story-json"]);

function parsePositiveInteger(name: string, value: string): number {
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`${name} must be a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

export function parseStandaloneArgs(argv: readonly string[], currentCwd = process.cwd()): StandaloneArgs {
  if (argv.length === 1 && argv[0] === "--help") return { kind: "help" };
  if (argv.includes("--help")) throw new Error("--help must be used alone.");

  const values = new Map<string, string>();
  const storyValues: string[] = [];
  let positionalCwd: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (!argument.startsWith("--")) {
      if (argument.startsWith("-") || positionalCwd != null) throw new Error(argument.startsWith("-") ? `Unknown option: ${argument}` : "Expected at most one optional cwd.");
      positionalCwd = argument;
      continue;
    }
    const equals = argument.indexOf("=");
    const name = equals < 0 ? argument : argument.slice(0, equals);
    if (!VALUE_OPTIONS.has(name)) throw new Error(`Unknown option: ${name}`);
    const value = equals < 0 ? argv[++index] : argument.slice(equals + 1);
    if (value == null || value.length === 0) throw new Error(`${name} requires a value.`);
    if (name === "--story-json") storyValues.push(value);
    else {
      if (values.has(name)) throw new Error(`${name} may only be provided once.`);
      values.set(name, value);
    }
  }

  if (positionalCwd != null && values.has("--cwd")) throw new Error("Positional cwd and --cwd cannot be used together.");
  const path = values.get("--path");
  const lineValue = values.get("--line");
  const endLineValue = values.get("--end-line");
  const anchorValue = values.get("--anchor-sha256");
  if ((path == null) !== (lineValue == null)) throw new Error("--path and --line require each other.");
  if (path == null && (endLineValue != null || anchorValue != null)) throw new Error("--end-line and --anchor-sha256 require --path and --line.");

  const stories: CodeStory[] = storyValues.map((json) => {
    let parsed: unknown;
    try { parsed = JSON.parse(json); } catch { throw new Error("--story-json must be a valid JSON object."); }
    if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) throw new Error("--story-json must decode to one CodeStory object.");
    return parsed as CodeStory;
  });
  const launch: WorkbenchLaunch = { capabilities: { discuss: false } };
  if (path != null && lineValue != null) {
    const startLine = parsePositiveInteger("--line", lineValue);
    const endLine = endLineValue == null ? startLine : parsePositiveInteger("--end-line", endLineValue);
    launch.initialTarget = {
      path,
      range: { startLine, endLine },
      ...(anchorValue == null ? {} : { anchor: { algorithm: "sha256" as const, value: anchorValue } }),
    };
  }
  if (stories.length > 0) launch.stories = stories;
  const normalizedLaunch = normalizeWorkbenchLaunch(launch);
  const cwdValue = values.get("--cwd") ?? positionalCwd;
  return { kind: "run", cwd: cwdValue == null ? currentCwd : resolve(currentCwd, cwdValue), launch: normalizedLaunch };
}

/** Exact OSC 52 payload used by the standalone terminal clipboard host. */
export function formatOsc52Clipboard(text: string): string {
  return `\u001b]52;c;${Buffer.from(text, "utf8").toString("base64")}\u0007`;
}

/** Minimal ANSI theme for the external terminal host. */
export function createStandaloneTheme(useAnsi = true): WorkbenchTheme {
  if (!useAnsi) return { fg: (_color, text) => text, bg: (_color, text) => text, searchMatch: (text) => text };
  const foreground = { accent: 35, border: 90, text: 37, muted: 90, warning: 33, error: 31, success: 32 } as const;
  return {
    fg: (color, text) => `\u001b[${foreground[color]}m${text}\u001b[0m`,
    bg: (_color, text) => `\u001b[44m${text}\u001b[0m`,
    searchMatch: (text, current) => `\u001b[${current ? "1;7;93" : "1;93"}m${text}\u001b[0m`,
  };
}

/** Mounts the shared component and owns only the external terminal lifecycle. */
export async function runStandaloneWorkbench(
  options: { cwd: string; launch?: WorkbenchLaunch },
  dependencies: StandaloneDependencies = defaultDependencies,
): Promise<ClosedWorkbenchResult> {
  if (options.launch?.capabilities?.discuss === true) throw new Error("Standalone workbench must disable DISCUSS.");
  const launch = normalizeWorkbenchLaunch({ ...options.launch, capabilities: { discuss: false } });
  let terminal: Terminal | undefined;
  let tui: StandaloneTui | undefined;
  const startupController = new AbortController();
  let workbench: Workbench | undefined;
  let component: (Component & Focusable & Pick<WorkbenchComponent, "requestClose">) | undefined;
  let mounted = false;
  let tuiStarted = false;
  let cleaned = false;
  let signalsRegistered = false;
  let result: ClosedWorkbenchResult | undefined;
  let failure: unknown;
  let complete!: (value: WorkbenchCompletionResult) => void;
  const completion = new Promise<WorkbenchCompletionResult>((resolveCompletion) => { complete = resolveCompletion; });
  const handleSignal = (signal: "SIGINT" | "SIGTERM") => {
    if (!mounted) startupController.abort(new Error(`Standalone startup aborted by ${signal}.`));
    else component?.requestClose();
  };
  const handleSigint = () => handleSignal("SIGINT");
  const handleSigterm = () => handleSignal("SIGTERM");
  const cleanup = async (): Promise<unknown[]> => {
    if (cleaned) return [];
    cleaned = true;
    if (signalsRegistered) {
      dependencies.signalSource.off("SIGINT", handleSigint);
      dependencies.signalSource.off("SIGTERM", handleSigterm);
    }
    const errors = cleanupWorkbench(workbench);
    if (tuiStarted && terminal != null && tui != null) {
      try { await terminal.drainInput(); } catch (error) { errors.push(error); }
      try { tui.stop(); } catch (error) { errors.push(error); }
    }
    return errors;
  };

  try {
    dependencies.signalSource.on("SIGINT", handleSigint);
    dependencies.signalSource.on("SIGTERM", handleSigterm);
    signalsRegistered = true;
    const repository = await dependencies.createRepository(options.cwd);
    const explorerState = (dependencies.explorerStateStore ?? processExplorerStateStore).forWorkspace(repository.workspaceKey);
    workbench = dependencies.createWorkbench(repository);
    await workbench.start(startupController.signal);
    startupController.signal.throwIfAborted();
    if (launch.initialTarget != null) {
      const opened = await workbench.openTarget(launch.initialTarget);
      reportTargetOpenIssue(opened, dependencies.reportStartupIssue ?? (() => undefined));
    }
    startupController.signal.throwIfAborted();
    terminal = dependencies.createTerminal();
    tui = dependencies.createTui(terminal);
    const clipboardTerminal = terminal;
    component = dependencies.createComponent(tui, createStandaloneTheme(process.stdout.isTTY && process.env.NO_COLOR == null), workbench, complete, explorerState, launch, {
      writeText: async (text) => { clipboardTerminal.write(formatOsc52Clipboard(text)); },
    });
    tui.addChild(component);
    tui.setFocus(component);
    mounted = true;
    tuiStarted = true;
    tui.start();
    const completionResult = await completion;
    if (completionResult.status === "failed") throw new WorkbenchCompletionError(completionResult);
    // Standalone has no agent delivery channel. A DISCUSS result is a host-contract violation.
    if (completionResult.status === "discuss") throw new Error("Standalone workbench cannot complete a DISCUSS request.");
    result = completionResult;
  } catch (error) {
    failure = error;
  } finally {
    const cleanupErrors = await cleanup();
    if (failure == null && cleanupErrors.length > 0) failure = new AggregateError(cleanupErrors, "Standalone workbench cleanup failed.");
  }

  if (failure != null) throw failure;
  if (result == null) throw new Error("Standalone workbench closed without a result.");
  return result;
}

const HELP = `Usage: pi-code-workbench [<cwd> | --cwd <cwd>] [--path <relative-path> --line <positive-int> [--end-line <positive-int>] [--anchor-sha256 <lowercase-64-hex>]] [--story-json <json-object>]...\n\nStandalone read/write terminal workbench for a filesystem workspace. Git is optional. DISCUSS is unavailable.\n\nOptions:\n  --cwd <cwd>                 Workspace directory (default: current directory)\n  --path <relative-path>      Initial workspace-relative file\n  --line <positive-int>       Initial one-based start line\n  --end-line <positive-int>   Optional one-based end line\n  --anchor-sha256 <hash>      Optional lowercase SHA-256 target anchor\n  --story-json <json-object>  Ordered story object; repeatable (maximum 50)\n  --help                      Show this help (must be alone)\n`;

function supportsRequiredNode(version: string): boolean {
  const [major = 0, minor = 0] = version.replace(/^v/, "").split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 19);
}

export async function standaloneMain(argv = process.argv.slice(2)): Promise<number> {
  let parsed: StandaloneArgs;
  try { parsed = parseStandaloneArgs(argv); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${HELP}`); return 2; }
  if (parsed.kind === "help") { process.stdout.write(HELP); return 0; }
  if (!supportsRequiredNode(process.version)) {
    process.stderr.write(`The standalone workbench requires Node >=22.19.0 (current: ${process.version}).\n`);
    return 1;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write("The standalone workbench requires interactive TTY stdin and stdout.\n");
    return 1;
  }
  try { await runStandaloneWorkbench({ cwd: parsed.cwd, launch: parsed.launch }); return 0; }
  catch (error) { process.stderr.write(`Could not open code workbench: ${error instanceof Error ? error.message : String(error)}\n`); return 1; }
}

if (process.argv[1] != null && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void standaloneMain().then((exitCode) => { process.exitCode = exitCode; });
}
