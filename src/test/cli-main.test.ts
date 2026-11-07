import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import type { PiCoderEngine } from "../host/engine.js";
import type { CliRunResult, LaunchRecord, Launcher } from "../cli/contract.js";
import { main, parseArgs, UsageError, type MainDependencies } from "../cli/main.js";
import { createDarkTestTheme } from "./helpers/cli-theme.js";

function sink() {
  const chunks: string[] = [];
  return { write: (data: string) => (chunks.push(data), true), text: () => chunks.join("") } as unknown as NodeJS.WritableStream & { text(): string };
}

function finishedRecord(result: CliRunResult): LaunchRecord {
  return { id: "launch-1", state: "finished", cwd: "/tmp", argv: ["diff"], createdAt: "now", result };
}

function setup(overrides: Partial<MainDependencies> = {}, engineOverrides: Partial<PiCoderEngine> = {}) {
  const stdout = sink();
  const stderr = sink();
  const engine: PiCoderEngine = {
    diff: vi.fn(async () => ({ started: true, prompt: "HANDOFF" })),
    diffStory: vi.fn(async () => ({ started: true })),
    code: vi.fn(async () => ({ started: true })),
    runTool: vi.fn(async () => ({ text: "tool text", details: { started: true } })),
    shutdown: vi.fn(),
    ...engineOverrides,
  };
  const shell = { stop: vi.fn(async () => undefined), runExternal: vi.fn(), copyText: vi.fn() };
  const launcher: Launcher = {
    start: vi.fn(async (request) => ({ id: "launch-1", state: "open", cwd: request.cwd, argv: request.argv, createdAt: "now" }) as LaunchRecord),
    wait: vi.fn(async () => finishedRecord({ piCoder: 1, command: "diff", ok: true, started: true, text: "done", prompt: "PANE PROMPT", messages: [], notices: [] })),
    get: vi.fn(),
  };
  const files = new Map<string, string>();
  const deps: Partial<MainDependencies> = {
    cwd: process.cwd(),
    env: {},
    stdinIsTTY: true,
    stdoutIsTTY: true,
    stdout,
    stderr,
    chdir: vi.fn(),
    version: () => "1.2.3",
    agentDir: () => "/tmp/agent",
    loadSettings: () => ({ models: {}, terminal: {}, path: "/tmp/agent/pi-coder-settings.json" }),
    loadTheme: () => ({ theme: createDarkTestTheme(), name: "dark", mode: "none" }),
    createModels: () => ({ label: () => undefined, complete: async () => "", streamStory: async () => "", storyAgents: () => [], validateStoryAgent: () => undefined }),
    createShell: vi.fn((options) => ({ ...shell, notify: (text: string, level = "info") => options.recorder.notices.push({ level, text }) }) as never),
    createEngine: vi.fn(async () => engine),
    listTools: async () => [
      { name: "open_code", needsTerminal: true },
      { name: "open_code_diff", needsTerminal: true },
      { name: "submit_pr_review", needsTerminal: false },
    ],
    createLauncher: vi.fn(async () => launcher),
    runMcpServer: vi.fn(async () => undefined),
    setupRuntime: vi.fn(async () => undefined),
    hasExecutable: () => true,
    readStdin: async () => '{"from":"stdin"}',
    writePrivateFile: (path, content) => void files.set(path, content),
    ...overrides,
  };
  return { deps, stdout, stderr, engine, shell, launcher, files };
}

describe("parseArgs", () => {
  it("parses commands, aliases, and passthrough targets", () => {
    expect(parseArgs(["review", "main...HEAD", "--resume"])).toMatchObject({ kind: "run", command: "diff", targets: ["main...HEAD", "--resume"] });
    expect(parseArgs(["story", "agent"])).toMatchObject({ kind: "run", command: "story", targets: ["agent"] });
    expect(parseArgs(["--json", "code", "src/a.ts", "--cwd=/x"])).toMatchObject({ kind: "run", command: "code", targets: ["src/a.ts"], flags: { json: true, cwd: "/x" } });
    expect(parseArgs(["diff", "--", "--json"])).toMatchObject({ targets: ["--json"], flags: { json: false } });
  });

  it("parses tool, wait, and mcp options", () => {
    expect(parseArgs(["tool", "open_code", "--input", "{}"])).toMatchObject({ kind: "tool", name: "open_code", flags: { input: "{}" } });
    expect(parseArgs(["wait", "abc", "--timeout", "2.5"])).toMatchObject({ kind: "wait", id: "abc", flags: { timeoutSeconds: 2.5 } });
    expect(parseArgs(["mcp", "--wait", "0", "--terminal", "tmux"])).toMatchObject({ kind: "mcp", flags: { waitSeconds: 0, terminal: "tmux" } });
  });

  it("returns help and version", () => {
    expect(parseArgs([])).toEqual({ kind: "help" });
    expect(parseArgs(["diff", "--help"])).toEqual({ kind: "help" });
    expect(parseArgs(["--version"])).toEqual({ kind: "version" });
  });

  it.each([
    [["frobnicate"]],
    [["--bogus"]],
    [["tool"]],
    [["wait"]],
    [["diff", "--terminal", "nope"]],
    [["diff", "--cwd"]],
    [["tool", "a", "--input", "{}", "--input-file", "x"]],
    [["wait", "id", "--timeout", "soon"]],
  ])("rejects %j as a usage error", (argv) => {
    expect(() => parseArgs(argv)).toThrow(UsageError);
  });
});

describe("main", () => {
  it("prints the version and help without loading anything", async () => {
    const { deps, stdout } = setup({ loadSettings: () => { throw new Error("must not load"); } });
    expect(await main(["--version"], deps)).toBe(0);
    expect(stdout.text()).toBe("1.2.3\n");
    expect(await main(["help"], deps)).toBe(0);
    expect(stdout.text()).toContain("Usage: pi-coder");
  });

  it("returns 2 for a usage error", async () => {
    const { deps, stderr } = setup();
    expect(await main(["wat"], deps)).toBe(2);
    expect(stderr.text()).toContain("Unknown command wat");
  });

  it("runs diff inline, joins the target, prints the prompt, and shuts down", async () => {
    const { deps, stdout, engine, shell } = setup();
    expect(await main(["diff", "main...HEAD", "--resume"], deps)).toBe(0);
    expect(engine.diff).toHaveBeenCalledWith("main...HEAD --resume", expect.objectContaining({ hasUI: true, mode: "tui" }));
    expect(stdout.text()).toBe("HANDOFF\n");
    expect(engine.shutdown).toHaveBeenCalled();
    expect(shell.stop).toHaveBeenCalled();
  });

  it("escapes terminal control characters from PR text in plain output, and keeps them exact in JSON", async () => {
    const hostile = "Title \x1b]52;c;ZXZpbA==\x07 with\ttab\nnext line";
    const plain = setup({}, { diff: vi.fn(async () => ({ started: true, prompt: hostile })) });
    await main(["diff"], plain.deps);
    expect(plain.stdout.text()).toBe("Title \\x1b]52;c;ZXZpbA==\\x07 with\ttab\nnext line\n");

    const json = setup({}, { diff: vi.fn(async () => ({ started: true, prompt: hostile })) });
    await main(["diff", "--json"], json.deps);
    expect(JSON.parse(json.stdout.text()).prompt).toBe(hostile);
  });

  it("prints a CliRunResult with --json and writes --output and --result-file", async () => {
    const { deps, stdout, files } = setup({ cwd: "/tmp" });
    expect(await main(["story", "--json", "--output", "out.json", "--result-file", "/tmp/r.json"], deps)).toBe(0);
    const result = JSON.parse(stdout.text()) as CliRunResult;
    expect(result).toMatchObject({ piCoder: 1, command: "story", ok: true, started: true, text: "Diff story finished.", messages: [], notices: [] });
    expect(files.get("/tmp/out.json")).toBe(stdout.text());
    expect(files.get("/tmp/r.json")).toBe(stdout.text());
  });

  it("reports an engine failure as ok:false with exit 1 and still stops the shell", async () => {
    const { deps, stdout, shell, files } = setup({}, { code: vi.fn(async () => { throw new Error("boom"); }) });
    expect(await main(["code", "--json", "--result-file", "/tmp/r.json"], deps)).toBe(1);
    expect(JSON.parse(stdout.text())).toMatchObject({ ok: false, started: false, error: "boom" });
    expect(JSON.parse(files.get("/tmp/r.json")!)).toMatchObject({ ok: false, error: "boom" });
    expect(shell.stop).toHaveBeenCalled();
  });

  it("records agent messages and notices in the result and prints them to stderr", async () => {
    const { deps, stdout, stderr } = setup();
    (deps.createEngine as ReturnType<typeof vi.fn>).mockImplementation(async (api: { sendUserMessage(m: string): void }, options: { commands?: unknown }) => ({
      diff: async (_args: string, ctx: { ui: { notify(m: string, l?: string): void } }) => {
        ctx.ui.notify("first", "warning");
        api.sendUserMessage("follow up 1");
        ctx.ui.notify("second");
        api.sendUserMessage("follow up 2");
        expect(options.commands).toEqual({ diff: "pi-coder diff", diffStory: "pi-coder story", code: "pi-coder code" });
        return { started: false, message: "No reviewable files found." };
      },
      shutdown: () => undefined,
    }));
    expect(await main(["diff"], deps)).toBe(0);
    expect(stdout.text()).toBe("follow up 1\n\nfollow up 2\n");
    expect(stderr.text()).toBe("warning: first\nsecond\nNo reviewable files found.\n");
  });

  it("writes a result file for a usage error in a pane child", async () => {
    const { deps, files } = setup({ cwd: "/tmp" });
    expect(await main(["diff", "--cwd", "/definitely/not/here", "--result-file", "r.json"], deps)).toBe(2);
    expect(JSON.parse(files.get("/tmp/r.json")!)).toMatchObject({ ok: false });
    expect(await main(["diff", "--terminal", "bogus", "--result-file", "r2.json"], deps)).toBe(2);
    expect(JSON.parse(files.get("/tmp/r2.json")!)).toMatchObject({ ok: false });
  });

  it("opens a Herdr pane when there is no terminal and prints the pane result", async () => {
    const { deps, stdout, launcher, engine } = setup({ stdinIsTTY: false, stdoutIsTTY: false, env: { HERDR_ENV: "1" } });
    expect(await main(["diff", "main...HEAD"], deps)).toBe(0);
    expect(launcher.start).toHaveBeenCalledWith({ argv: ["diff", "main...HEAD"], cwd: process.cwd(), mode: "herdr" });
    expect(launcher.wait).toHaveBeenCalledWith("launch-1");
    expect(stdout.text()).toBe("PANE PROMPT\n");
    expect(engine.diff).not.toHaveBeenCalled();
  });

  it("falls back to tmux, then the configured command, then fails clearly", async () => {
    const base = { stdinIsTTY: false, stdoutIsTTY: false };
    const tmux = setup({ ...base, env: { TMUX: "/tmp/tmux" } });
    await main(["story"], tmux.deps);
    expect(tmux.launcher.start).toHaveBeenCalledWith(expect.objectContaining({ mode: "tmux" }));

    const command = setup({ ...base, loadSettings: () => ({ models: {}, terminal: { command: ["term", "--"] }, path: "/s.json" }) });
    await main(["story"], command.deps);
    expect(command.launcher.start).toHaveBeenCalledWith(expect.objectContaining({ mode: "command" }));

    const none = setup(base);
    expect(await main(["story", "--json"], none.deps)).toBe(1);
    expect(JSON.parse(none.stdout.text())).toMatchObject({ ok: false, error: expect.stringContaining("/tmp/agent/pi-coder-settings.json") });
  });

  it("does not use Herdr when the herdr binary is missing", async () => {
    const { deps, launcher } = setup({ stdinIsTTY: false, stdoutIsTTY: false, env: { HERDR_ENV: "1", TMUX: "x" }, hasExecutable: () => false });
    await main(["diff"], deps);
    expect(launcher.start).toHaveBeenCalledWith(expect.objectContaining({ mode: "tmux" }));
  });

  it("returns the launch id with --detach and skips inline even in a terminal", async () => {
    const { deps, stdout, launcher } = setup({ env: { TMUX: "x" } });
    expect(await main(["diff", "--detach"], deps)).toBe(0);
    expect(stdout.text()).toBe("launch-1\n");
    expect(launcher.wait).not.toHaveBeenCalled();
    expect(await main(["diff", "--detach", "--terminal", "inline"], deps)).toBe(1);
  });

  it("rejects --terminal inline without terminals and --terminal command without settings", async () => {
    const noTty = setup({ stdinIsTTY: false });
    expect(await main(["diff", "--terminal", "inline"], noTty.deps)).toBe(1);
    const noCommand = setup();
    expect(await main(["diff", "--terminal", "command"], noCommand.deps)).toBe(1);
    expect(noCommand.stderr.text()).toContain("terminal.command");
  });

  it("reports a closed pane as a failure", async () => {
    const { deps, stdout, launcher } = setup({ stdinIsTTY: false, env: { TMUX: "x" } });
    (launcher.wait as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "launch-1", state: "closed", cwd: "/", argv: ["diff"], createdAt: "now" });
    expect(await main(["diff", "--json"], deps)).toBe(1);
    expect(JSON.parse(stdout.text())).toMatchObject({ ok: false, error: "The pane closed before pi-coder finished." });
  });

  it("runs submit_pr_review headless without a shell", async () => {
    const { deps, stdout, engine } = setup({ stdinIsTTY: false, stdoutIsTTY: false });
    expect(await main(["tool", "submit_pr_review", "--input", '{"a":1}'], deps)).toBe(0);
    expect(deps.createShell).not.toHaveBeenCalled();
    expect(engine.runTool).toHaveBeenCalledWith("submit_pr_review", { a: 1 }, expect.objectContaining({ hasUI: false }));
    expect(stdout.text()).toBe("tool text\n");
  });

  it("reads tool input from stdin and a file", async () => {
    const stdin = setup();
    await main(["tool", "submit_pr_review", "--input", "-"], stdin.deps);
    expect(stdin.engine.runTool).toHaveBeenCalledWith("submit_pr_review", { from: "stdin" }, expect.anything());
    const bad = setup();
    expect(await main(["tool", "submit_pr_review", "--input", "{nope"], bad.deps)).toBe(2);
    expect(bad.stderr.text()).toContain("could not read the tool input");
  });

  it("opens UI tools in a pane with the parsed input", async () => {
    const { deps, launcher } = setup({ stdinIsTTY: false, env: { TMUX: "x" } });
    await main(["tool", "open_code_diff", "--input", '{"args":"main"}'], deps);
    expect(launcher.start).toHaveBeenCalledWith({ argv: ["tool", "open_code_diff"], cwd: process.cwd(), mode: "tmux", toolInput: { args: "main" } });
  });

  it("runs UI tools inline in a terminal", async () => {
    const { deps, engine } = setup();
    await main(["tool", "open_code", "--input", '{"path":"a"}'], deps);
    expect(engine.runTool).toHaveBeenCalledWith("open_code", { path: "a" }, expect.objectContaining({ hasUI: true }));
  });

  it("rejects unknown tools", async () => {
    const { deps, stderr } = setup();
    expect(await main(["tool", "nope"], deps)).toBe(2);
    expect(stderr.text()).toContain("unknown tool nope");
  });

  it("checks tool input against the tool schema before it runs or opens a pane", async () => {
    const parameters = Type.Object({ provider: Type.String(), verdict: Type.Union([Type.Literal("approve"), Type.Literal("comment")]) });
    const { deps, stderr, engine, launcher, files } = setup({
      stdinIsTTY: false,
      env: { TMUX: "x" },
      listTools: async () => [{ name: "submit_pr_review", needsTerminal: false, parameters }, { name: "open_code_diff", needsTerminal: true, parameters: Type.Object({ args: Type.Optional(Type.String()) }) }],
    });

    expect(await main(["tool", "submit_pr_review", "--input", '{"verdict":"merge"}', "--result-file", "/tmp/r.json"], deps)).toBe(2);
    expect(stderr.text()).toContain("Invalid input for submit_pr_review: / must have required properties provider; /verdict must be equal to constant");
    expect(engine.runTool).not.toHaveBeenCalled();
    expect(JSON.parse(files.get("/tmp/r.json") ?? "{}")).toMatchObject({ ok: false, tool: "submit_pr_review" });

    expect(await main(["tool", "open_code_diff", "--input", '{"args":5}'], deps)).toBe(2);
    expect(launcher.start).not.toHaveBeenCalled();
  });

  it("waits for a launch and exits 1 while it is still open", async () => {
    const finished = setup();
    expect(await main(["wait", "launch-1", "--timeout", "5", "--json"], finished.deps)).toBe(0);
    expect(finished.launcher.wait).toHaveBeenCalledWith("launch-1", { timeoutSeconds: 5 });
    expect(JSON.parse(finished.stdout.text())).toMatchObject({ ok: true, prompt: "PANE PROMPT" });

    const open = setup();
    (open.launcher.wait as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "launch-1", state: "open", cwd: "/", argv: ["diff"], createdAt: "now" });
    expect(await main(["wait", "launch-1", "--json"], open.deps)).toBe(1);
    expect(JSON.parse(open.stdout.text())).toMatchObject({ state: "open" });
  });

  it("starts the MCP server with the configured wait", async () => {
    const { deps } = setup({ stdinIsTTY: false, stdoutIsTTY: false, env: { PI_CODER_MCP_WAIT_SECONDS: "7" } });
    expect(await main(["mcp"], deps)).toBe(0);
    const [options, mcpDeps] = (deps.runMcpServer as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(options).toMatchObject({ version: "1.2.3", waitSeconds: 7 });
    expect(mcpDeps.terminal).toBe("auto");
    const result = await mcpDeps.runHeadlessTool("submit_pr_review", { x: 1 });
    expect(result).toEqual({ text: "tool text", details: { started: true } });
  });

  it("defaults MCP waiting to 45 seconds and rejects inline", async () => {
    const { deps, stderr } = setup({ env: { PI_CODER_MCP_WAIT_SECONDS: "bad" } });
    await main(["mcp"], deps);
    expect((deps.runMcpServer as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({ waitSeconds: 45 });
    expect(await main(["mcp", "--terminal", "inline"], deps)).toBe(2);
    expect(stderr.text()).toContain("cannot be used with mcp");
  });
});
