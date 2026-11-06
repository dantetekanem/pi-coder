import { accessSync, chmodSync, constants, readFileSync, statSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TSchema } from "typebox";
import type { PiCoderCommandResult, PiCoderEngine, PiCoderEngineOptions, PiCoderToolName, PiCoderToolResult } from "../host/engine.js";
import { getAgentDir } from "../host/runtime.js";
import type { HostApi, HostContext, HostTheme, ModelGateway } from "../host/types.js";
import {
  PI_CODER_RESULT_VERSION,
  type CliCommandName,
  type CliRunResult,
  type LaunchRecord,
  type Launcher,
  type LauncherOptions,
  type McpServerDependencies,
  type McpServerOptions,
  type TerminalMode,
} from "./contract.js";
import { createHeadlessContext, createInteractiveContext, createRunRecorder, createTerminalApi, type RunRecorder } from "./host.js";
import { createCommandModelGateway } from "./models.js";
import { loadCliSettings, type CliSettings } from "./settings.js";
import { createTerminalShell, type TerminalShell, type TerminalShellOptions } from "./shell.js";
import { loadTheme, type LoadedTheme } from "./theme.js";
import { formatToolInputErrors, toolInputErrors } from "./tool-input.js";

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

const CLI_COMMAND_NAMES = { diff: "pi-coder diff", diffStory: "pi-coder story", code: "pi-coder code" } as const;

export class UsageError extends Error {}

export interface CliFlags {
  cwd?: string;
  json: boolean;
  output?: string;
  terminal: TerminalMode;
  detach: boolean;
  resultFile?: string;
  input?: string;
  inputFile?: string;
  timeoutSeconds?: number;
  waitSeconds?: number;
}

export type ParsedCommand =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "run"; command: "diff" | "story" | "code"; targets: string[]; flags: CliFlags }
  | { kind: "tool"; name: string; flags: CliFlags }
  | { kind: "wait"; id: string; flags: CliFlags }
  | { kind: "mcp"; flags: CliFlags };

const TERMINAL_MODES: readonly TerminalMode[] = ["auto", "inline", "herdr", "tmux", "command"];

const COMMON_VALUE_FLAGS = ["--cwd", "--output", "--terminal", "--result-file"] as const;
const COMMON_BOOLEAN_FLAGS = ["--json", "--detach"] as const;

const EXTRA_VALUE_FLAGS: Record<string, readonly string[]> = {
  diff: [],
  story: [],
  code: [],
  tool: ["--input", "--input-file"],
  wait: ["--timeout"],
  mcp: ["--wait"],
};

const COMMAND_ALIASES: Record<string, string> = { review: "diff" };

function parseSeconds(name: string, value: string): number {
  if (!/^\d+(?:\.\d+)?$/.test(value)) throw new UsageError(`${name} must be a number of seconds.`);
  return Number(value);
}

export function parseArgs(argv: readonly string[]): ParsedCommand {
  const flags: CliFlags = { json: false, terminal: "auto", detach: false };
  const positionals: string[] = [];
  let command: string | undefined;
  let passthrough = false;
  let wantsHelp = false;
  let wantsVersion = false;

  const takesValues = (name: string) =>
    (COMMON_VALUE_FLAGS as readonly string[]).includes(name) || (command !== undefined && (EXTRA_VALUE_FLAGS[command] ?? []).includes(name));

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (passthrough) {
      positionals.push(argument);
      continue;
    }
    if (argument === "--") {
      passthrough = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      wantsHelp = true;
      continue;
    }
    if (argument === "--version") {
      wantsVersion = true;
      continue;
    }
    const equals = argument.startsWith("--") ? argument.indexOf("=") : -1;
    const name = equals < 0 ? argument : argument.slice(0, equals);
    if ((COMMON_BOOLEAN_FLAGS as readonly string[]).includes(name)) {
      if (equals >= 0) throw new UsageError(`${name} does not take a value.`);
      if (name === "--json") flags.json = true;
      else flags.detach = true;
      continue;
    }
    if (name.startsWith("--") && takesValues(name)) {
      const value = equals < 0 ? argv[++index] : argument.slice(equals + 1);
      if (value === undefined || value === "") throw new UsageError(`${name} requires a value.`);
      switch (name) {
        case "--cwd": flags.cwd = value; break;
        case "--output": flags.output = value; break;
        case "--result-file": flags.resultFile = value; break;
        case "--input": flags.input = value; break;
        case "--input-file": flags.inputFile = value; break;
        case "--timeout": flags.timeoutSeconds = parseSeconds(name, value); break;
        case "--wait": flags.waitSeconds = parseSeconds(name, value); break;
        case "--terminal":
          if (!(TERMINAL_MODES as readonly string[]).includes(value)) throw new UsageError(`--terminal must be one of ${TERMINAL_MODES.join(", ")}.`);
          flags.terminal = value as TerminalMode;
          break;
      }
      continue;
    }
    if (command === undefined) {
      if (argument.startsWith("-")) throw new UsageError(`Unknown option ${argument}. Run pi-coder help.`);
      command = COMMAND_ALIASES[argument] ?? argument;
      continue;
    }
    positionals.push(argument);
  }

  if (wantsHelp) return { kind: "help" };
  if (wantsVersion) return { kind: "version" };
  if (command === undefined || command === "help") return { kind: "help" };
  if (command === "version") return { kind: "version" };

  switch (command) {
    case "diff":
    case "story":
    case "code":
      return { kind: "run", command, targets: positionals, flags };
    case "tool": {
      const [name, ...extra] = positionals;
      if (name === undefined) throw new UsageError("pi-coder tool needs a tool name.");
      if (extra.length > 0) throw new UsageError(`Unexpected argument ${extra[0]}. Pass tool input with --input, --input-file, or --input -.`);
      if (flags.input !== undefined && flags.inputFile !== undefined) throw new UsageError("Use --input or --input-file, not both.");
      return { kind: "tool", name, flags };
    }
    case "wait": {
      const [id, ...extra] = positionals;
      if (id === undefined) throw new UsageError("pi-coder wait needs a launch id.");
      if (extra.length > 0) throw new UsageError(`Unexpected argument ${extra[0]}.`);
      return { kind: "wait", id, flags };
    }
    case "mcp":
      if (positionals.length > 0) throw new UsageError(`Unexpected argument ${positionals[0]}.`);
      return { kind: "mcp", flags };
    default:
      throw new UsageError(`Unknown command ${command}. Run pi-coder help.`);
  }
}

export const HELP_TEXT = `Usage: pi-coder <command> [options]

Commands:
  diff [target...]       Review a diff (alias: review). Also: fullscreen on|off
  story [target...]      Walk through a change as a story. Also: agent
  code [path|options]    Open the code workbench. Also: syntax
  tool <name>            Run an agent tool: open_code, open_code_diff, open_code_diff_story, submit_pr_review
  wait <launch-id>       Collect the result of a detached launch
  mcp                    Serve the agent tools over MCP on stdio
  help, version

Options:
  --cwd <dir>            Run in this directory
  --json                 Print the result as JSON
  --output <file>        Also write the JSON result to a file (mode 0600)
  --terminal <mode>      auto (default), inline, herdr, tmux, or command
  --detach               Open a pane and return a launch id at once
  --input <json|->       Tool input as JSON, or - for standard input
  --input-file <path>    Tool input from a file
  --timeout <seconds>    For wait: stop waiting after this long
  --wait <seconds>       For mcp: how long UI tools wait before returning a launch id
  --version, --help

Exit codes: 0 success, 1 failure, 2 usage error.
`;

export interface ToolInfo {
  name: string;
  needsTerminal: boolean;
  parameters?: TSchema;
}

export interface MainDependencies {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  nodePath: string;
  binPath: string;
  version(): string;
  agentDir(): string;
  chdir(directory: string): void;
  loadSettings(): CliSettings | Promise<CliSettings>;
  loadTheme(): LoadedTheme;
  createModels(settings: CliSettings, cwd: string): ModelGateway;
  createShell(options: TerminalShellOptions): TerminalShell;
  createEngine(api: HostApi, options: PiCoderEngineOptions): Promise<PiCoderEngine>;
  listTools(): Promise<readonly ToolInfo[]>;
  createLauncher(options: LauncherOptions): Promise<Launcher>;
  runMcpServer(options: McpServerOptions, deps: McpServerDependencies): Promise<void>;
  setupRuntime(theme: HostTheme, shell?: TerminalShell): Promise<void>;
  hasExecutable(name: string): boolean;
  readStdin(): Promise<string>;
  writePrivateFile(path: string, content: string): void;
}

function findOnPath(name: string, env: NodeJS.ProcessEnv): boolean {
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    try {
      accessSync(join(directory, name), constants.X_OK);
      return true;
    } catch {}
  }
  return false;
}

function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolveText, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    stream.on("end", () => resolveText(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", reject);
  });
}

export function defaultDependencies(): MainDependencies {
  const here = dirname(fileURLToPath(import.meta.url));
  return {
    cwd: process.cwd(),
    env: process.env,
    stdinIsTTY: process.stdin.isTTY === true,
    stdoutIsTTY: process.stdout.isTTY === true,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    nodePath: process.execPath,
    binPath: resolve(here, "../../bin/pi-coder.mjs"),
    version: () => (JSON.parse(readFileSync(resolve(here, "../../package.json"), "utf8")) as { version: string }).version,
    agentDir: () => getAgentDir(),
    chdir: (directory) => process.chdir(directory),
    loadSettings: loadCliSettings,
    loadTheme: () => loadTheme({ agentDir: getAgentDir(), env: process.env, isTTY: process.stdout.isTTY === true }),
    createModels: (settings, cwd) => createCommandModelGateway(settings.models, { settingsPath: settings.path, cwd }),
    createShell: createTerminalShell,
    createEngine: async (api, options) => (await import("../engine.js")).createPiCoderEngine(api, options),
    listTools: async () => (await import("../tool-definitions.js")).PI_CODER_TOOLS,
    createLauncher: async (options) => (await import("./launch.js")).createLauncher(options),
    runMcpServer: async (options, deps) => (await import("./mcp.js")).runMcpServer(options, deps),
    setupRuntime: async (theme) => {
      const { configureRuntime } = await import("../host/runtime.js");
      const { createHighlighter } = await import("../host/highlight.js");
      const highlighter = createHighlighter(theme);
      configureRuntime({ highlightLine: highlighter.highlightLine, languageForPath: highlighter.languageForPath });
    },
    hasExecutable: (name) => findOnPath(name, process.env),
    readStdin: () => readAll(process.stdin),
    writePrivateFile: (path, content) => {
      writeFileSync(path, content, { encoding: "utf8", mode: 0o600 });
      chmodSync(path, 0o600);
    },
  };
}

interface RunOutcome {
  started: boolean;
  text: string;
  prompt?: string;
  message?: string;
  details?: Record<string, unknown>;
}

type Job = (engine: PiCoderEngine, ctx: HostContext) => Promise<RunOutcome>;

const COMMAND_SUMMARIES: Record<"diff" | "story" | "code", [string, string]> = {
  diff: ["Code diff review finished.", "Code diff review did not start."],
  story: ["Diff story finished.", "Diff story did not start."],
  code: ["Code workbench closed.", "Code workbench did not start."],
};

export function outcomeFromCommand(command: "diff" | "story" | "code", result: PiCoderCommandResult): RunOutcome {
  const [finished, notStarted] = COMMAND_SUMMARIES[command];
  const details: Record<string, unknown> = {};
  if (result.review !== undefined) details.review = result.review;
  if (result.workbench !== undefined) details.workbench = result.workbench;
  return {
    started: result.started,
    text: result.message ?? result.review?.message ?? (result.started ? finished : notStarted),
    ...(result.prompt === undefined ? {} : { prompt: result.prompt }),
    ...(result.message === undefined ? {} : { message: result.message }),
    ...(Object.keys(details).length === 0 ? {} : { details }),
  };
}

export function outcomeFromTool(result: PiCoderToolResult): RunOutcome {
  const prompt = typeof result.details.prompt === "string" ? result.details.prompt : undefined;
  return {
    started: result.details.started !== false,
    text: result.text,
    ...(prompt === undefined ? {} : { prompt }),
    details: result.details,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildResult(command: CliCommandName, tool: PiCoderToolName | undefined, recorder: RunRecorder, outcome: RunOutcome | undefined, error: string | undefined): CliRunResult {
  const prompt = outcome?.prompt ?? recorder.prompt;
  return {
    piCoder: PI_CODER_RESULT_VERSION,
    command,
    ...(tool === undefined ? {} : { tool }),
    ok: error === undefined,
    started: outcome?.started ?? false,
    text: outcome?.text ?? "",
    ...(prompt === undefined ? {} : { prompt }),
    ...(outcome?.message === undefined ? {} : { message: outcome.message }),
    ...(outcome?.details === undefined ? {} : { details: outcome.details }),
    messages: recorder.messages,
    notices: recorder.notices,
    ...(error === undefined ? {} : { error }),
  };
}

export function failureResult(command: CliCommandName, error: string, tool?: PiCoderToolName): CliRunResult {
  return buildResult(command, tool, createRunRecorder(), undefined, error);
}

function mcpWaitSeconds(env: NodeJS.ProcessEnv): number {
  const configured = env.PI_CODER_MCP_WAIT_SECONDS;
  if (configured === undefined || configured.trim() === "") return 45;
  const parsed = Number(configured);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 45;
}

function resultFileArgument(argv: readonly string[]): string | undefined {
  const index = argv.findIndex((argument) => argument === "--result-file" || argument.startsWith("--result-file="));
  if (index < 0) return undefined;
  const argument = argv[index]!;
  return argument.includes("=") ? argument.slice(argument.indexOf("=") + 1) : argv[index + 1];
}

function writeFailureFile(deps: MainDependencies, path: string | undefined, error: string, command: CliCommandName = "tool", tool?: PiCoderToolName): void {
  if (path === undefined) return;
  try {
    deps.writePrivateFile(resolve(deps.cwd, path), `${JSON.stringify(failureResult(command, error, tool), null, 2)}\n`);
  } catch {}
}

/** Prompts carry PR titles, bodies, and comments; escape control characters other than newlines and tabs before they reach a terminal. */
function printable(text: string): string {
  return text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, (character) => `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

function formatNotice(level: string, text: string): string {
  return printable(level === "info" ? text : `${level}: ${text}`);
}

export async function main(argv: readonly string[], overrides: Partial<MainDependencies> = {}): Promise<number> {
  const deps: MainDependencies = { ...defaultDependencies(), ...overrides };

  let parsed: ParsedCommand;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    deps.stderr.write(`pi-coder: ${errorMessage(error)}\n`);
    writeFailureFile(deps, resultFileArgument(argv), errorMessage(error));
    return EXIT_USAGE;
  }

  if (parsed.kind === "help") {
    deps.stdout.write(HELP_TEXT);
    return EXIT_OK;
  }
  if (parsed.kind === "version") {
    deps.stdout.write(`${deps.version()}\n`);
    return EXIT_OK;
  }

  const originalCwd = deps.cwd;
  const flags = parsed.flags;
  const cwd = resolve(originalCwd, flags.cwd ?? ".");
  try {
    if (!statSync(cwd).isDirectory()) throw new Error("not a directory");
  } catch {
    deps.stderr.write(`pi-coder: --cwd ${cwd} is not a directory.\n`);
    writeFailureFile(deps, flags.resultFile === undefined ? undefined : resolve(originalCwd, flags.resultFile), `--cwd ${cwd} is not a directory.`);
    return EXIT_USAGE;
  }
  const outputPath = flags.output === undefined ? undefined : resolve(originalCwd, flags.output);
  const resultPath = flags.resultFile === undefined ? undefined : resolve(originalCwd, flags.resultFile);
  deps.chdir(cwd);

  const emit = (result: CliRunResult, kind: "run" | "tool" | "wait"): number => {
    const json = `${JSON.stringify(result, null, 2)}\n`;
    try {
      if (outputPath) deps.writePrivateFile(outputPath, json);
      if (resultPath) deps.writePrivateFile(resultPath, json);
    } catch (error) {
      deps.stderr.write(`pi-coder: could not write the result file: ${errorMessage(error)}\n`);
    }
    if (flags.json) {
      deps.stdout.write(json);
      return result.ok ? EXIT_OK : EXIT_FAILURE;
    }
    const isTool = kind === "tool" || (kind === "wait" && result.command === "tool");
    const primary = isTool ? result.text : result.prompt;
    const blocks = [...(primary ? [primary] : []), ...result.messages];
    if (blocks.length > 0) deps.stdout.write(`${printable(blocks.join("\n\n").replace(/\n*$/, ""))}\n`);
    for (const notice of result.notices) deps.stderr.write(`${formatNotice(notice.level, notice.text)}\n`);
    if (!result.ok) deps.stderr.write(`pi-coder: ${printable(result.error ?? "failed")}\n`);
    else if (!primary && result.text) deps.stderr.write(`${printable(result.text)}\n`);
    return result.ok ? EXIT_OK : EXIT_FAILURE;
  };

  const usageFail = (message: string, command: CliCommandName, tool?: PiCoderToolName): number => {
    deps.stderr.write(`pi-coder: ${message}\n`);
    if (resultPath) writeFailureFile(deps, resultPath, message, command, tool);
    return EXIT_USAGE;
  };

  const fail = (message: string, command: CliCommandName, tool?: PiCoderToolName): number => emit(failureResult(command, message, tool), "run");

  const runLocal = async (command: CliCommandName, tool: PiCoderToolName | undefined, interactive: boolean, job: Job, settings: CliSettings): Promise<CliRunResult> => {
    const recorder = createRunRecorder();
    let shell: TerminalShell | undefined;
    let engine: PiCoderEngine | undefined;
    let outcome: RunOutcome | undefined;
    let error: string | undefined;
    try {
      const loaded = deps.loadTheme();
      if (loaded.warning) recorder.notices.push({ level: "warning", text: loaded.warning });
      const models = deps.createModels(settings, cwd);
      let ctx: HostContext;
      let runExternalEditor: PiCoderEngineOptions["runExternalEditor"];
      if (interactive) {
        shell = deps.createShell({ theme: loaded.theme, recorder });
        runExternalEditor = shell.runExternal;
        ctx = createInteractiveContext({ cwd, ui: shell, models });
      } else {
        ctx = createHeadlessContext({ cwd, recorder, models, theme: loaded.theme });
      }
      await deps.setupRuntime(loaded.theme, shell);
      engine = await deps.createEngine(createTerminalApi(recorder), { ...(runExternalEditor ? { runExternalEditor } : {}), commands: CLI_COMMAND_NAMES });
      outcome = await job(engine, ctx);
    } catch (caught) {
      error = errorMessage(caught);
    } finally {
      try {
        engine?.shutdown();
      } catch {}
      await shell?.stop();
    }
    return buildResult(command, tool, recorder, outcome, error);
  };

  const resolveMode = (settings: CliSettings): Exclude<TerminalMode, "auto"> | { error: string } => {
    const stdinAndStdoutAreTerminals = deps.stdinIsTTY && deps.stdoutIsTTY;
    const commandConfigured = settings.terminal.command !== undefined;
    const noTerminal = `No terminal is available. Run pi-coder in a terminal, run it inside Herdr or tmux, or set terminal.command in ${settings.path}.`;
    switch (flags.terminal) {
      case "inline":
        if (flags.detach) return { error: "--detach needs a pane. Use --terminal herdr, tmux, or command." };
        return stdinAndStdoutAreTerminals ? "inline" : { error: "--terminal inline needs standard input and output to be terminals." };
      case "command":
        return commandConfigured ? "command" : { error: `--terminal command needs terminal.command in ${settings.path}.` };
      case "herdr":
      case "tmux":
        return flags.terminal;
      default:
        if (!flags.detach && stdinAndStdoutAreTerminals) return "inline";
        if (deps.env.HERDR_ENV === "1" && deps.hasExecutable("herdr")) return "herdr";
        if (deps.env.TMUX) return "tmux";
        return commandConfigured ? "command" : { error: noTerminal };
    }
  };

  const launchInPane = async (
    command: CliCommandName,
    tool: PiCoderToolName | undefined,
    argv: string[],
    toolInput: unknown,
    mode: "herdr" | "tmux" | "command",
    settings: CliSettings,
  ): Promise<number> => {
    let record: LaunchRecord;
    let launcher: Launcher;
    try {
      launcher = await deps.createLauncher({
        agentDir: deps.agentDir(),
        nodePath: deps.nodePath,
        binPath: deps.binPath,
        settings: settings.terminal,
        env: deps.env,
      });
      record = await launcher.start({ argv, cwd, mode, ...(toolInput === undefined ? {} : { toolInput }) });
      if (flags.detach) {
        deps.stdout.write(flags.json ? `${JSON.stringify(record, null, 2)}\n` : `${record.id}\n`);
        return EXIT_OK;
      }
      record = await launcher.wait(record.id);
    } catch (error) {
      return fail(errorMessage(error), command, tool);
    }
    return emit(resultFromLaunch(record, command, tool), "run");
  };

  const settingsOrFail = async (command: CliCommandName, tool?: PiCoderToolName): Promise<CliSettings | number> => {
    try {
      return await deps.loadSettings();
    } catch (error) {
      return fail(errorMessage(error), command, tool);
    }
  };

  switch (parsed.kind) {
    case "run": {
      const settings = await settingsOrFail(parsed.command);
      if (typeof settings === "number") return settings;
      const mode = resolveMode(settings);
      if (typeof mode !== "string") return fail(mode.error, parsed.command);
      if (mode !== "inline") return launchInPane(parsed.command, undefined, [parsed.command, ...parsed.targets], undefined, mode, settings);
      const args = parsed.targets.join(" ");
      const command = parsed.command;
      const job: Job = async (engine, ctx) => {
        const result = command === "diff" ? await engine.diff(args, ctx) : command === "story" ? await engine.diffStory(args, ctx) : await engine.code(args, ctx);
        return outcomeFromCommand(command, result);
      };
      return emit(await runLocal(command, undefined, true, job, settings), "run");
    }

    case "tool": {
      const settings = await settingsOrFail("tool");
      if (typeof settings === "number") return settings;
      let tools: readonly ToolInfo[];
      try {
        tools = await deps.listTools();
      } catch (error) {
        return fail(errorMessage(error), "tool");
      }
      const info = tools.find((tool) => tool.name === parsed.name);
      if (!info) {
        return usageFail(`unknown tool ${parsed.name}. Available: ${tools.map((tool) => tool.name).join(", ")}.`, "tool");
      }
      const name = info.name as PiCoderToolName;
      let input: unknown;
      try {
        const text = flags.inputFile !== undefined
          ? readFileSync(resolve(originalCwd, flags.inputFile), "utf8")
          : flags.input === "-" ? await deps.readStdin() : flags.input;
        input = text === undefined || text.trim() === "" ? {} : JSON.parse(text);
      } catch (error) {
        return usageFail(`could not read the tool input: ${errorMessage(error)}`, "tool", name);
      }
      const invalid = toolInputErrors(info.parameters, input);
      if (invalid.length > 0) return usageFail(formatToolInputErrors(name, invalid), "tool", name);
      const job: Job = async (engine, ctx) => outcomeFromTool(await engine.runTool(name, input, ctx));
      if (!info.needsTerminal) return emit(await runLocal("tool", name, false, job, settings), "tool");
      const mode = resolveMode(settings);
      if (typeof mode !== "string") return fail(mode.error, "tool", name);
      if (mode !== "inline") return launchInPane("tool", name, ["tool", name], input, mode, settings);
      return emit(await runLocal("tool", name, true, job, settings), "tool");
    }

    case "wait": {
      let settings: CliSettings;
      try {
        settings = await deps.loadSettings();
      } catch {
        settings = { models: {}, terminal: {}, path: "" };
      }
      let record: LaunchRecord;
      try {
        const launcher = await deps.createLauncher({
          agentDir: deps.agentDir(),
          nodePath: deps.nodePath,
          binPath: deps.binPath,
          settings: settings.terminal,
          env: deps.env,
        });
        record = await launcher.wait(parsed.id, { ...(flags.timeoutSeconds === undefined ? {} : { timeoutSeconds: flags.timeoutSeconds }) });
      } catch (error) {
        deps.stderr.write(`pi-coder: ${errorMessage(error)}\n`);
        return EXIT_FAILURE;
      }
      if (record.state === "open") {
        if (flags.json) deps.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
        deps.stderr.write(`pi-coder: launch ${record.id} is still open.\n`);
        return EXIT_FAILURE;
      }
      const command = (["diff", "story", "code", "tool"] as const).find((name) => name === record.argv[0]) ?? "diff";
      return emit(resultFromLaunch(record, command, undefined), "wait");
    }

    case "mcp": {
      const settings = await settingsOrFail("tool");
      if (typeof settings === "number") return settings;
      if (flags.terminal === "inline") {
        deps.stderr.write("pi-coder: --terminal inline cannot be used with mcp. MCP uses standard input and output.\n");
        return EXIT_USAGE;
      }
      try {
        const launcher = await deps.createLauncher({
          agentDir: deps.agentDir(),
          nodePath: deps.nodePath,
          binPath: deps.binPath,
          settings: settings.terminal,
          env: deps.env,
        });
        await deps.runMcpServer(
          { input: deps.stdin, output: deps.stdout, cwd, version: deps.version(), waitSeconds: flags.waitSeconds ?? mcpWaitSeconds(deps.env) },
          {
            launcher,
            terminal: flags.terminal,
            runHeadlessTool: async (name, params) => {
              const result = await runLocal("tool", name, false, async (engine, ctx) => {
                const toolResult = await engine.runTool(name, params, ctx);
                return { ...outcomeFromTool(toolResult), text: toolResult.text };
              }, settings);
              if (!result.ok) throw new Error(result.error ?? "The tool failed.");
              return { text: result.text, details: result.details ?? {} };
            },
          },
        );
        return EXIT_OK;
      } catch (error) {
        deps.stderr.write(`pi-coder: ${errorMessage(error)}\n`);
        return EXIT_FAILURE;
      }
    }
  }
}

function resultFromLaunch(record: LaunchRecord, command: CliCommandName, tool: PiCoderToolName | undefined): CliRunResult {
  if (record.state === "finished" && record.result) return record.result;
  if (record.state === "failed") return failureResult(command, record.error ?? "The pane failed to run pi-coder.", tool);
  if (record.state === "closed") return failureResult(command, "The pane closed before pi-coder finished.", tool);
  return failureResult(command, `Launch ${record.id} is still ${record.state}.`, tool);
}
