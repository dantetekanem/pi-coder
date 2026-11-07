import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPiCoderEngine } from "../engine.js";
import type { PiCoderEngine, PiCoderEngineOptions } from "../host/engine.js";
import type { HostApi, HostContext } from "../host/types.js";

const directory = mkdtempSync(join(tmpdir(), "pi-coder-engine-"));
const preferencesPath = join(directory, "preferences.json");
const environment = ["PI_CODER_PREFERENCES_PATH", "PI_CODER_SETTINGS_PATH", "PI_CODER_HERDR_FULLSCREEN", "PI_CODER_SESSIONS_DIR"] as const;
const originals = environment.map((key) => process.env[key]);

beforeEach(() => {
  process.env.PI_CODER_PREFERENCES_PATH = preferencesPath;
  process.env.PI_CODER_SETTINGS_PATH = join(directory, "settings.json");
  process.env.PI_CODER_SESSIONS_DIR = join(directory, "sessions");
  delete process.env.PI_CODER_HERDR_FULLSCREEN;
  rmSync(preferencesPath, { force: true });
});

const engines: PiCoderEngine[] = [];

afterEach(() => {
  for (const engine of engines.splice(0)) engine.shutdown();
});

afterAll(() => {
  environment.forEach((key, index) => {
    if (originals[index] == null) delete process.env[key];
    else process.env[key] = originals[index];
  });
  rmSync(directory, { recursive: true, force: true });
});

const terminalCommands = { diff: "pi-coder diff", diffStory: "pi-coder story", code: "pi-coder code" };

function api(exec: HostApi["exec"] = vi.fn(async () => ({ code: 1, stdout: "", stderr: "not a repository", killed: false }))): HostApi {
  return { exec, sendUserMessage: vi.fn() };
}

function host(overrides: Partial<HostContext> = {}) {
  const ui = {
    notify: vi.fn(),
    select: vi.fn(),
    editor: vi.fn(),
    setStatus: vi.fn(),
    setWidget: vi.fn(),
    custom: vi.fn(),
    setEditorText: vi.fn(),
    theme: {} as never,
  };
  const models = {
    label: vi.fn(),
    complete: vi.fn(),
    streamStory: vi.fn(),
    storyAgents: vi.fn(() => []),
    validateStoryAgent: vi.fn(),
  };
  return { cwd: "/repo", hasUI: true, mode: "tui", ui, models, isIdle: () => true, ...overrides } as HostContext & { ui: typeof ui; models: typeof models };
}

function engineFor(options?: PiCoderEngineOptions, host: HostApi = api()) {
  const engine = createPiCoderEngine(host, options);
  engines.push(engine);
  return engine;
}

describe("engine commands", () => {
  it.each([
    [undefined, "/diff"],
    [terminalCommands, "pi-coder diff"],
  ])("explains the fullscreen usage with the host's command name", async (commands, name) => {
    const ctx = host();

    const result = await engineFor({ commands }).diff("fullscreen maybe", ctx);

    expect(result).toEqual({ started: false, message: `Usage: ${name} fullscreen on|off` });
    expect(ctx.ui.notify).toHaveBeenCalledExactlyOnceWith(`Usage: ${name} fullscreen on|off`, "error");
  });

  it("saves the fullscreen preference without starting a review", async () => {
    const ctx = host();

    const result = await engineFor({ commands: terminalCommands }).diff("fullscreen off", ctx);

    expect(result).toEqual({ started: true, message: "pi-coder diff fullscreen: off" });
    expect(ctx.ui.notify).toHaveBeenCalledWith("pi-coder diff fullscreen: off", "info");
    expect(JSON.parse(readFileSync(preferencesPath, "utf8"))).toMatchObject({ herdrFullscreen: false });
  });

  it("stops a second review while one is open", async () => {
    const exec = vi.fn(() => new Promise<never>(() => {}));
    const engine = engineFor(undefined, api(exec as never));
    const ctx = host();

    void engine.diff("", ctx);
    const second = await engine.diff("", ctx);

    expect(second).toMatchObject({ started: false, message: "A review session is already open." });
    expect(ctx.ui.notify).toHaveBeenCalledWith("A review session is already open.", "warning");
  });

  it("returns the review outcome and reports the settled run", async () => {
    const onRunSettled = vi.fn();
    const ctx = host({ hasUI: false });

    const result = await engineFor({ onRunSettled }).diff("", ctx);

    expect(result).toMatchObject({ started: false, message: "Interactive review requires a TUI session.", review: { started: false } });
    expect(result.prompt).toBeUndefined();
    expect(onRunSettled).toHaveBeenCalledExactlyOnceWith(ctx);
  });

  it("refuses stories outside a terminal UI", async () => {
    const ctx = host({ mode: "print" });

    const result = await engineFor().diffStory("", ctx);

    expect(result).toEqual({ started: false, message: "Diff stories require a TUI session." });
    expect(ctx.ui.notify).toHaveBeenCalledWith("Diff stories require a TUI session.", "error");
  });

  it("tells the user how to configure story models when the host lists none", async () => {
    const ctx = host();

    const result = await engineFor().diffStory("agent", ctx);

    expect(result).toEqual({ started: false });
    expect(ctx.ui.select).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "No story models to choose from. In Pi, sign in to a model provider. Outside Pi, set models.story.command in pi-coder-settings.json; it can use {provider}, {model}, and {thinking}.",
      "warning",
    );
  });

  it("names the code command in argument and terminal errors", async () => {
    const engine = engineFor({ commands: terminalCommands });
    const invalid = host();
    const headless = host({ hasUI: false });

    expect(await engine.code("--wat value", invalid)).toEqual({ started: false, message: "Invalid pi-coder code arguments: unknown option --wat." });
    expect(invalid.ui.notify).toHaveBeenCalledWith("Invalid pi-coder code arguments: unknown option --wat.", "error");
    expect(await engine.code("syntax", headless)).toEqual({ started: false, message: "pi-coder code syntax requires a TUI session." });
  });

  it("keeps the Pi slash command names by default", async () => {
    const engine = engineFor();

    expect(await engine.code("--wat value", host())).toMatchObject({ message: "Invalid /code arguments: unknown option --wat." });
    expect(await engine.code("syntax", host({ hasUI: false }))).toMatchObject({ message: "/code syntax requires a TUI session." });
  });
});

describe("engine tools", () => {
  it("returns the Pi tool text and details for a review that did not start", async () => {
    const ctx = host({ hasUI: false });

    const result = await engineFor().runTool("open_code_diff", { args: "", cwd: "/repo" }, ctx);

    expect(result.text).toBe([
      "Code diff review did not start.",
      "Args: (empty — local working-tree/uncommitted changes)",
      "Cwd: /repo",
      "Message: Interactive review requires a TUI session.",
    ].join("\n"));
    expect(result.details).toEqual({ started: false, message: "Interactive review requires a TUI session.", args: "", cwd: "/repo" });
  });

  it("reports story tools that cannot open", async () => {
    const result = await engineFor().runTool("open_code_diff_story", { args: "main..HEAD" }, host({ mode: "json" }));

    expect(result.text).toContain("Code diff review did not start.");
    expect(result.text).toContain("Args: main..HEAD");
    expect(result.details).toMatchObject({ started: false, message: "Diff stories require a TUI session.", args: "main..HEAD", cwd: "/repo" });
  });

  it("rejects an open_code call that names both a path and a target", async () => {
    const result = await engineFor().runTool("open_code", {
      path: "a.ts",
      target: { path: "b.ts", range: { startLine: 1, endLine: 1 } },
    }, host());

    expect(result.text).toBe("Code workbench did not start: open_code path and target cannot be combined.");
    expect(result.details).toMatchObject({ cwd: "/repo", outcome: { status: "failed" } });
  });

  it("treats missing tool input as empty", async () => {
    const result = await engineFor().runTool("open_code_diff", undefined, host({ hasUI: false }));

    expect(result.details).toMatchObject({ args: "", cwd: "/repo" });
  });

  it("rejects an unknown tool", async () => {
    await expect(engineFor().runTool("open_everything" as never, {}, host())).rejects.toThrow("Unknown pi-coder tool: open_everything");
  });
});
