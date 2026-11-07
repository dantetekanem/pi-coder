import { describe, expect, it } from "vitest";
import { createHeadlessContext, createInteractiveContext, createRunRecorder, createTerminalApi, execCommand } from "../cli/host.js";
import { createDarkTestTheme } from "./helpers/cli-theme.js";

const models = { label: () => undefined, complete: async () => "", streamStory: async () => "", storyAgents: () => [], validateStoryAgent: () => undefined };

describe("execCommand", () => {
  it("captures stdout, stderr, and the exit code", async () => {
    const result = await execCommand("node", ["-e", "console.log('out'); console.error('err'); process.exit(3)"]);
    expect(result).toEqual({ stdout: "out\n", stderr: "err\n", code: 3, killed: false });
  });

  it("runs in the given cwd", async () => {
    const cwd = process.platform === "darwin" ? "/private/tmp" : "/tmp";
    expect((await execCommand("node", ["-e", "process.stdout.write(process.cwd())"], { cwd })).stdout).toBe(cwd);
  });

  it("does not use a shell", async () => {
    const result = await execCommand("node", ["-e", "process.stdout.write(process.argv[1])", "$HOME; echo hi"]);
    expect(result.stdout).toBe("$HOME; echo hi");
  });

  it("resolves code 1 with the reason when the command cannot start, like Pi's own exec", async () => {
    expect(await execCommand("pi-coder-no-such-binary", [])).toMatchObject({ code: 1, killed: false, stderr: expect.stringContaining("ENOENT") });
  });

  it("kills on timeout and on abort", async () => {
    const hang = ["-e", "setInterval(() => {}, 1000)"];
    expect(await execCommand("node", hang, { timeout: 50 })).toMatchObject({ killed: true });
    const controller = new AbortController();
    const pending = execCommand("node", hang, { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    expect(await pending).toMatchObject({ killed: true });
    expect(await execCommand("node", hang, { signal: AbortSignal.abort() })).toMatchObject({ killed: true });
  });

  it("gives stdin no data", async () => {
    expect((await execCommand("node", ["-e", "process.stdin.on('end', () => process.stdout.write('eof')).resume()"])).stdout).toBe("eof");
  });
});

describe("terminal host", () => {
  it("records follow-up messages in order", () => {
    const recorder = createRunRecorder();
    const api = createTerminalApi(recorder);
    api.sendUserMessage("one", { deliverAs: "followUp" });
    api.sendUserMessage("two");
    expect(recorder.messages).toEqual(["one", "two"]);
  });

  it("builds an interactive context", () => {
    const ui = {} as never;
    const ctx = createInteractiveContext({ cwd: "/repo", ui, models });
    expect(ctx).toMatchObject({ cwd: "/repo", hasUI: true, mode: "tui", ui });
    expect(ctx.isIdle()).toBe(true);
  });

  it("builds a headless context that records notices and refuses custom UI", async () => {
    const recorder = createRunRecorder();
    const ctx = createHeadlessContext({ cwd: "/repo", recorder, models, theme: createDarkTestTheme() });
    expect(ctx.hasUI).toBe(false);
    ctx.ui.notify("careful", "warning");
    ctx.ui.notify("fyi");
    ctx.ui.setEditorText("draft");
    expect(recorder.notices).toEqual([{ level: "warning", text: "careful" }, { level: "info", text: "fyi" }]);
    expect(recorder.prompt).toBe("draft");
    await expect(ctx.ui.select("t", ["a"])).resolves.toBeUndefined();
    await expect(ctx.ui.editor("t")).resolves.toBeUndefined();
    await expect(ctx.ui.custom(() => ({ render: () => [], invalidate() {} }))).rejects.toThrow("needs a terminal");
  });
});
