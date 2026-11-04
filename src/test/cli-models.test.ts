import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createCommandModelGateway, findOnPath } from "../cli/models.js";

const settingsPath = "/agent/pi-coder-settings.json";
const echoStdin = ["node", "-e", "process.stdin.pipe(process.stdout)"];
const binDir = mkdtempSync(join(tmpdir(), "pi-coder-models-"));
const fakePi = join(binDir, "pi");
writeFileSync(fakePi, `#!${process.execPath}\nlet input = "";\nprocess.stdin.on("data", (chunk) => { input += chunk; }).on("end", () => process.stdout.write(JSON.stringify({ args: process.argv.slice(2), input })));\n`);
chmodSync(fakePi, 0o755);

afterAll(() => rmSync(binDir, { recursive: true, force: true }));

function gateway(models: Parameters<typeof createCommandModelGateway>[0], pi?: string) {
  return createCommandModelGateway(models, { settingsPath, findExecutable: (name) => (name === "pi" ? pi : undefined) });
}

describe("command model gateway", () => {
  it("sends system instructions then the prompt on stdin and returns stdout", async () => {
    const models = gateway({ grammar: { command: echoStdin } });
    await expect(models.complete("grammar", { system: "SYS", prompt: "TASK" })).resolves.toBe("SYS\n\nTASK");
    await expect(models.complete("grammar", { prompt: "ONLY" })).resolves.toBe("ONLY");
  });

  it("falls back to the default command", async () => {
    const models = gateway({ default: { command: echoStdin } });
    await expect(models.complete("analysis", { prompt: "x" })).resolves.toBe("x");
    expect(models.label("story")).toBe("node");
  });

  it("puts system text in the {system} placeholder and only the prompt on stdin", async () => {
    const script = "process.stdout.write(process.argv[1] + '|'); process.stdin.pipe(process.stdout)";
    const models = gateway({ analysis: { command: ["node", "-e", script, "{system}"] } });
    await expect(models.complete("analysis", { system: "RULES", prompt: "P" })).resolves.toBe("RULES|P");
  });

  it("fills story placeholders and streams text", async () => {
    const script = "process.stdout.write(process.argv.slice(1).join(','))";
    const models = gateway({ story: { command: ["node", "-e", script, "{provider}/{model}", "{thinking}"] } });
    const seen: string[] = [];
    const text = await models.streamStory(
      { provider: "anthropic", model: "opus", thinking: "high" },
      { system: "s", prompt: "p", signal: new AbortController().signal, onText: (value) => seen.push(value) },
    );
    expect(text).toBe("anthropic/opus,high");
    expect(seen.at(-1)).toBe("anthropic/opus,high");
  });

  it("fails with the stderr tail on a non-zero exit", async () => {
    const models = gateway({ default: { command: ["node", "-e", "console.error('bad key'); process.exit(3)"] } });
    await expect(models.complete("grammar", { prompt: "x" })).rejects.toThrow(/exited with code 3: bad key/);
  });

  it("fails when the executable is missing", async () => {
    const models = gateway({ default: { command: ["pi-coder-no-such-binary"] } });
    await expect(models.complete("grammar", { prompt: "x" })).rejects.toThrow(/Could not run model command "pi-coder-no-such-binary"/);
  });

  it("honors the abort signal and the timeout", async () => {
    const hang = ["node", "-e", "setInterval(() => {}, 1000)"];
    const models = gateway({ default: { command: hang } });
    const controller = new AbortController();
    const pending = models.complete("grammar", { prompt: "x", signal: controller.signal });
    setTimeout(() => controller.abort(new Error("stop")), 50);
    await expect(pending).rejects.toThrow("stop");
    await expect(models.complete("grammar", { prompt: "x", timeoutMs: 50 })).rejects.toThrow(/timed out after 50ms/);
  });

  it("kills a command that ignores SIGTERM after the grace period", async () => {
    const stubborn = ["node", "-e", "process.on('SIGTERM', () => {}); process.stdout.write(String(process.pid)); setInterval(() => {}, 1000)"];
    let pid = 0;
    const models = createCommandModelGateway({ default: { command: stubborn } }, { settingsPath, findExecutable: () => undefined, killAfterMs: 100 });
    await expect(models.complete("grammar", { prompt: "x", timeoutMs: 300, onText: (text) => { pid = Number(text); } })).rejects.toThrow(/timed out/);
    expect(pid).toBeGreaterThan(0);

    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 3000, interval: 50 });
  });

  it("runs in the requested cwd", async () => {
    const models = gateway({ default: { command: ["node", "-e", "process.stdout.write(process.cwd())"] } });
    const cwd = process.platform === "darwin" ? "/private/tmp" : "/tmp";
    await expect(models.complete("grammar", { prompt: "x", cwd })).resolves.toBe(cwd);
  });

  it("explains an unconfigured purpose", async () => {
    const models = gateway({});
    await expect(models.complete("grammar", { prompt: "x" })).rejects.toThrow(
      `No model command is configured for grammar. Add models.grammar.command to ${settingsPath}, or install pi.`,
    );
    expect(models.label("grammar")).toBeUndefined();
    expect(models.storyAgents()).toEqual([]);
    expect(() => models.validateStoryAgent({ provider: "p", model: "m", thinking: "low" })).toThrow(/models\.story\.command/);
  });

  it("validates the story agent when a story or default command exists", () => {
    expect(() => gateway({ default: { command: ["x"] } }).validateStoryAgent({ provider: "p", model: "m", thinking: "low" })).not.toThrow();
  });

  it("falls back to pi print mode with the saved story agent when no command is configured", async () => {
    const models = gateway({}, fakePi);
    const text = await models.streamStory(
      { provider: "anthropic", model: "claude-opus-5-5", thinking: "low" },
      { system: "ORDER", prompt: "UNITS", signal: new AbortController().signal },
    );

    expect(JSON.parse(text)).toEqual({
      args: ["-p", "--no-session", "--no-tools", "--no-skills", "--no-prompt-templates", "--no-context-files", "--model", "anthropic/claude-opus-5-5", "--thinking", "low", "--system-prompt", "ORDER"],
      input: "UNITS",
    });
    expect(models.label("story")).toBe("pi");
    expect(() => models.validateStoryAgent({ provider: "anthropic", model: "claude-opus-5-5", thinking: "low" })).not.toThrow();
  });

  it("runs grammar and analysis through pi with its default model at low thinking", async () => {
    const models = gateway({}, fakePi);

    expect(JSON.parse(await models.complete("grammar", { system: "FIX", prompt: "TEXT" }))).toEqual({
      args: ["-p", "--no-session", "--no-tools", "--no-skills", "--no-prompt-templates", "--no-context-files", "--thinking", "low", "--system-prompt", "FIX"],
      input: "TEXT",
    });
    expect(JSON.parse(await models.complete("analysis", { prompt: "REPLY" })).args).not.toContain("--system-prompt");
  });

  it("prefers a configured command over the pi fallback", async () => {
    const models = gateway({ grammar: { command: echoStdin } }, fakePi);
    await expect(models.complete("grammar", { prompt: "mine" })).resolves.toBe("mine");
    expect(models.label("grammar")).toBe("node");
  });

  it("finds executables on PATH", () => {
    expect(findOnPath("pi", { PATH: `/nonexistent-dir:${binDir}` })).toBe(fakePi);
    expect(findOnPath("pi", { PATH: "/nonexistent-dir" })).toBeUndefined();
  });
});
