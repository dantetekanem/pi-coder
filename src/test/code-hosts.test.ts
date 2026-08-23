import { describe, expect, it, vi } from "vitest";
import {
  launchCurrentTerminal,
  launchHerdrPane,
  launchTmuxPane,
  selectCodeHost,
  type CodeHostProcessRunner,
} from "../code/hosts.js";

type ProcessResult = { exitCode: number | null; signal: NodeJS.Signals | null; stdout?: string };
type ProcessCall = { command: string; args: string[]; options: { cwd: string; shell: false; stdio?: "inherit" } };

function processRunner(results: Array<ProcessResult | Error | (() => ProcessResult)>) {
  const calls: ProcessCall[] = [];
  const run = vi.fn(async (command: string, args: readonly string[], options: ProcessCall["options"]) => {
    calls.push({ command, args: [...args], options });
    const result = results.shift();
    if (result instanceof Error) throw result;
    if (typeof result === "function") return result();
    if (!result) throw new Error(`Unexpected process: ${command} ${args.join(" ")}`);
    return result;
  });
  return { calls, run, runner: { run } as unknown as CodeHostProcessRunner };
}

const editor = { executable: "nvim", args: ["+10", "src/file with spaces.ts"] };
const request = { cwd: "/workspace", editor };

function abortableRequest() {
  const controller = new AbortController();
  return { ...request, signal: controller.signal, abort: () => controller.abort() };
}

describe("current-terminal code host", () => {
  it("spawns direct editor argv with inherited stdio, and distinguishes exit, signal, and spawn errors", async () => {
    const clean = processRunner([{ exitCode: 0, signal: null }]);
    await expect(launchCurrentTerminal(request, clean.runner)).resolves.toEqual({ status: "completed" });
    expect(clean.calls).toEqual([{
      command: "nvim",
      args: ["+10", "src/file with spaces.ts"],
      options: { cwd: "/workspace", shell: false, stdio: "inherit" },
    }]);

    const failedExit = processRunner([{ exitCode: 23, signal: null }]);
    await expect(launchCurrentTerminal(request, failedExit.runner)).rejects.toThrow(/23/);

    const signaled = processRunner([{ exitCode: null, signal: "SIGTERM" }]);
    await expect(launchCurrentTerminal(request, signaled.runner)).rejects.toThrow(/SIGTERM/);

    const spawnFailure = processRunner([new Error("spawn nvim ENOENT")]);
    await expect(launchCurrentTerminal(request, spawnFailure.runner)).rejects.toThrow("spawn nvim ENOENT");

    const aborted = abortableRequest();
    aborted.abort();
    const didNotStart = processRunner([]);
    await expect(launchCurrentTerminal(aborted, didNotStart.runner)).rejects.toMatchObject({ lifecycle: "not-started" });
    expect(didNotStart.calls).toEqual([]);
  });
});

describe("code host selection", () => {
  it("prefers Herdr, then tmux, then the current terminal for auto without leaking environment", () => {
    expect(selectCodeHost("auto", { HERDR_ENV: "1", HERDR_PANE_ID: "pane-1", TMUX: "/tmp/tmux" })).toBe("herdr-auto");
    expect(selectCodeHost("auto", { HERDR_PANE_ID: "pane-1", TMUX: "/tmp/tmux" })).toBe("tmux-auto");
    expect(selectCodeHost("auto", { HERDR_ENV: "", HERDR_PANE_ID: "pane-1", TMUX: "/tmp/tmux" })).toBe("tmux-auto");
    expect(selectCodeHost("auto", { HERDR_ENV: "1", TMUX: "/tmp/tmux" })).toBe("tmux-auto");
    expect(selectCodeHost("auto", { HERDR_ENV: "1", HERDR_PANE_ID: "", TMUX: "/tmp/tmux" })).toBe("tmux-auto");
    expect(selectCodeHost("auto", { TMUX: "" })).toBe("current-terminal");
    expect(selectCodeHost("current-terminal", { HERDR_ENV: "1", HERDR_PANE_ID: "pane-1", TMUX: "/tmp/tmux" })).toBe("current-terminal");
    expect(selectCodeHost("tmux-auto", {})).toBe("current-terminal");
    expect(selectCodeHost("herdr-auto", {})).toBe("current-terminal");
  });
});

describe("tmux code host", () => {
  it("uses split-window process argv, requires its owned pane id, and waits until it is dead or gone", async () => {
    const fake = processRunner([
      { exitCode: 0, signal: null, stdout: "%42\n" },
      { exitCode: 0, signal: null, stdout: "%1\t0\n%42\t0\n" },
      { exitCode: 0, signal: null, stdout: "%1\t0\n" },
    ]);
    const delay = vi.fn(async () => undefined);

    await expect(launchTmuxPane(request, fake.runner, { delay })).resolves.toEqual({ status: "completed", paneId: "%42" });
    expect(fake.calls).toEqual([
      { command: "tmux", args: ["split-window", "-h", "-P", "-F", "#{pane_id}", "-c", "/workspace", "/usr/bin/env", "--", "nvim", "+10", "src/file with spaces.ts"], options: { cwd: "/workspace", shell: false } },
      { command: "tmux", args: ["list-panes", "-a", "-F", "#{pane_id}\t#{pane_dead}"], options: { cwd: "/workspace", shell: false } },
      { command: "tmux", args: ["list-panes", "-a", "-F", "#{pane_id}\t#{pane_dead}"], options: { cwd: "/workspace", shell: false } },
    ]);
    expect(delay).toHaveBeenCalledOnce();

    const noEditorArgs = processRunner([
      { exitCode: 0, signal: null, stdout: "%43\n" },
      { exitCode: 0, signal: null, stdout: "%1\t0\n%43\t1\n" },
      { exitCode: 0, signal: null },
      { exitCode: 0, signal: null, stdout: "%1\t0\n" },
    ]);
    await expect(launchTmuxPane({ cwd: "/workspace", editor: { executable: "nvim", args: [] } }, noEditorArgs.runner, { delay })).resolves.toEqual({ status: "completed", paneId: "%43" });
    expect(noEditorArgs.calls[0]).toEqual({
      command: "tmux",
      args: ["split-window", "-h", "-P", "-F", "#{pane_id}", "-c", "/workspace", "/usr/bin/env", "--", "nvim"],
      options: { cwd: "/workspace", shell: false },
    });
    expect(noEditorArgs.calls.slice(1).map(({ args }) => args[0])).toEqual(["list-panes", "kill-pane", "list-panes"]);

    const invalidPane = processRunner([{ exitCode: 0, signal: null, stdout: "not-a-pane\n" }]);
    await expect(launchTmuxPane(request, invalidPane.runner, { delay })).rejects.toThrow(/pane id/i);
    expect(invalidPane.calls).toHaveLength(1);
  });

  it("closes only its owned pane on abort and never reports cleanup failure or unconfirmed closure as success", async () => {
    const aborted = abortableRequest();
    const fake = processRunner([
      { exitCode: 0, signal: null, stdout: "%42\n" },
      { exitCode: 0, signal: null, stdout: "%1\t0\n%42\t0\n" },
      { exitCode: 0, signal: null },
      { exitCode: 0, signal: null, stdout: "%1\t0\n" },
    ]);
    const delay = vi.fn(async () => aborted.abort());

    await expect(launchTmuxPane(aborted, fake.runner, { delay })).resolves.toEqual({ status: "aborted", paneId: "%42" });
    expect(fake.calls.slice(1)).toEqual([
      { command: "tmux", args: ["list-panes", "-a", "-F", "#{pane_id}\t#{pane_dead}"], options: { cwd: "/workspace", shell: false } },
      { command: "tmux", args: ["kill-pane", "-t", "%42"], options: { cwd: "/workspace", shell: false } },
      { command: "tmux", args: ["list-panes", "-a", "-F", "#{pane_id}\t#{pane_dead}"], options: { cwd: "/workspace", shell: false } },
    ]);

    const cleanupFailed = processRunner([
      { exitCode: 0, signal: null, stdout: "%42\n" },
      { exitCode: 0, signal: null, stdout: "%42\t0\n" },
      new Error("kill-pane failed"),
    ]);
    const abortAgain = abortableRequest();
    await expect(launchTmuxPane(abortAgain, cleanupFailed.runner, { delay: async () => abortAgain.abort() })).rejects.toThrow("kill-pane failed");

    const closureUnconfirmed = processRunner([
      { exitCode: 0, signal: null, stdout: "%42\n" },
      { exitCode: 0, signal: null, stdout: "%42\t0\n" },
      { exitCode: 0, signal: null },
      { exitCode: 0, signal: null, stdout: "%42\t0\n" },
    ]);
    const abortOnceMore = abortableRequest();
    await expect(launchTmuxPane(abortOnceMore, closureUnconfirmed.runner, { delay: async () => abortOnceMore.abort() })).rejects.toThrow(/close|dead|pane/i);
  });

  it("closes its owned pane when waiting fails", async () => {
    const fake = processRunner([
      { exitCode: 0, signal: null, stdout: "%42\n" },
      { exitCode: 0, signal: null, stdout: "%42\t0\n" },
      { exitCode: 0, signal: null },
      { exitCode: 0, signal: null, stdout: "" },
    ]);

    await expect(launchTmuxPane(request, fake.runner, { delay: async () => { throw new Error("timer failed"); } })).rejects.toMatchObject({ lifecycle: "closed" });
    expect(fake.calls.slice(-2).map(({ args }) => args.slice(0, 2))).toEqual([["kill-pane", "-t"], ["list-panes", "-a"]]);
  });

  it.each([
    { name: "thrown", probe: new Error("probe crashed"), message: /probe crashed/ },
    { name: "signaled", probe: { exitCode: null, signal: "SIGTERM" as const }, message: /SIGTERM/ },
    { name: "failed", probe: { exitCode: 1, signal: null }, message: /code 1/ },
    { name: "malformed", probe: { exitCode: 0, signal: null, stdout: "garbage\n" }, message: /invalid pane list/ },
  ])("closes its owned pane after a $name pane-state probe failure", async ({ probe, message }) => {
    const fake = processRunner([
      { exitCode: 0, signal: null, stdout: "%42\n" },
      probe,
      { exitCode: 0, signal: null },
      { exitCode: 0, signal: null, stdout: "" },
    ]);

    await expect(launchTmuxPane(request, fake.runner, { delay: async () => undefined })).rejects.toMatchObject({
      lifecycle: "closed",
      message: expect.stringMatching(message),
    });
    expect(fake.calls.slice(-2)).toEqual([
      { command: "tmux", args: ["kill-pane", "-t", "%42"], options: { cwd: "/workspace", shell: false } },
      { command: "tmux", args: ["list-panes", "-a", "-F", "#{pane_id}\t#{pane_dead}"], options: { cwd: "/workspace", shell: false } },
    ]);
  });

  it("keeps pane closure unconfirmed when cleanup after a probe failure cannot be confirmed", async () => {
    const fake = processRunner([
      { exitCode: 0, signal: null, stdout: "%42\n" },
      { exitCode: null, signal: "SIGTERM" },
      new Error("kill failed"),
    ]);

    await expect(launchTmuxPane(request, fake.runner, { delay: async () => undefined })).rejects.toMatchObject({ lifecycle: "unconfirmed" });
  });
});

describe("Herdr code host", () => {
  it("splits current pane, runs a POSIX-quoted editor command with a unique sentinel, then waits, reads, and closes", async () => {
    const sentinel = "__PI_CODE_DONE_123__";
    const fake = processRunner([
      { exitCode: 0, signal: null, stdout: '{"result":{"pane":{"pane_id":"pane-99"}}}\n' },
      { exitCode: 0, signal: null },
      { exitCode: 0, signal: null },
      { exitCode: 0, signal: null, stdout: "editor output\n" },
      { exitCode: 0, signal: null },
    ]);
    const hostile = { cwd: "/workspace", editor: { executable: "nvim; touch pwned", args: ["a b", "$(whoami)", "quote'and;semi"] } };

    await expect(launchHerdrPane(hostile, fake.runner, { createSentinel: () => sentinel })).resolves.toEqual({ status: "completed", paneId: "pane-99", output: "editor output\n" });
    expect(fake.calls).toEqual([
      { command: "herdr", args: ["pane", "split", "--current", "--direction", "right", "--cwd", "/workspace", "--focus"], options: { cwd: "/workspace", shell: false } },
      {
        command: "herdr",
        args: ["pane", "run", "pane-99", "'nvim; touch pwned' 'a b' '$(whoami)' 'quote'\\''and;semi'; printf '%s\\n' '__PI_CODE_DONE_123__'"],
        options: { cwd: "/workspace", shell: false },
      },
      { command: "herdr", args: ["pane", "wait-output", "pane-99", "--match", sentinel], options: { cwd: "/workspace", shell: false } },
      { command: "herdr", args: ["pane", "read", "pane-99", "--source", "recent-unwrapped"], options: { cwd: "/workspace", shell: false } },
      { command: "herdr", args: ["pane", "close", "pane-99"], options: { cwd: "/workspace", shell: false } },
    ]);
  });

  it("closes its owned pane before settling an abort", async () => {
    const aborted = abortableRequest();
    const fake = processRunner([
      { exitCode: 0, signal: null, stdout: '{"result":{"pane":{"pane_id":"pane-99"}}}\n' },
      { exitCode: 0, signal: null },
      () => {
        aborted.abort();
        throw new Error("wait aborted");
      },
      { exitCode: 0, signal: null },
    ]);

    await expect(launchHerdrPane(aborted, fake.runner, { createSentinel: () => "done" })).resolves.toEqual({ status: "aborted", paneId: "pane-99" });
    expect(fake.calls.at(-1)).toMatchObject({ command: "herdr", args: ["pane", "close", "pane-99"] });

    const cleanupUnconfirmed = abortableRequest();
    const cleanupFailed = processRunner([
      { exitCode: 0, signal: null, stdout: '{"result":{"pane":{"pane_id":"pane-100"}}}\n' },
      { exitCode: 0, signal: null },
      () => {
        cleanupUnconfirmed.abort();
        throw new Error("wait aborted");
      },
      new Error("close failed"),
    ]);
    await expect(launchHerdrPane(cleanupUnconfirmed, cleanupFailed.runner, { createSentinel: () => "done" })).rejects.toMatchObject({ lifecycle: "unconfirmed" });
  });

  it("does not claim success when Herdr close fails or closure cannot be confirmed", async () => {
    const closeFailed = processRunner([
      { exitCode: 0, signal: null, stdout: '{"result":{"pane":{"pane_id":"pane-99"}}}\n' },
      { exitCode: 0, signal: null },
      { exitCode: 0, signal: null },
      { exitCode: 0, signal: null, stdout: "" },
      new Error("close failed"),
    ]);
    await expect(launchHerdrPane(request, closeFailed.runner, { createSentinel: () => "done" })).rejects.toMatchObject({ lifecycle: "unconfirmed" });

    const noPane = processRunner([{ exitCode: 0, signal: null, stdout: "\n" }]);
    await expect(launchHerdrPane(request, noPane.runner, { createSentinel: () => "done" })).rejects.toThrow(/pane id/i);
  });

  it("validates the raw-shell command before creating an owned pane", async () => {
    const fake = processRunner([]);
    const multiline = { ...request, editor: { ...request.editor, args: ["bad\npath"] } };

    await expect(launchHerdrPane(multiline, fake.runner, { createSentinel: () => "done" })).rejects.toMatchObject({ lifecycle: "not-started" });
    expect(fake.calls).toEqual([]);
  });

  it.each(["run", "wait-output", "read"] as const)("closes its owned pane after a %s failure", async (failureAt) => {
    const successfulSteps = { run: 0, "wait-output": 1, read: 2 }[failureAt];
    const successfulPrefix = Array.from({ length: successfulSteps }, () => ({ exitCode: 0, signal: null }));
    const fake = processRunner([
      { exitCode: 0, signal: null, stdout: '{"result":{"pane":{"pane_id":"pane-99"}}}\n' },
      ...successfulPrefix,
      new Error(`${failureAt} failed`),
      { exitCode: 0, signal: null },
    ]);

    await expect(launchHerdrPane(request, fake.runner, { createSentinel: () => "done" })).rejects.toMatchObject({
      lifecycle: "closed",
      message: expect.stringContaining(`${failureAt} failed`),
    });
    expect(fake.calls.at(-1)).toMatchObject({ command: "herdr", args: ["pane", "close", "pane-99"] });
  });
});
