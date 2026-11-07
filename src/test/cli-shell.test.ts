import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { Terminal } from "@earendil-works/pi-tui";
import { createRunRecorder } from "../cli/host.js";
import { createTerminalShell, formatOsc52Clipboard, type TerminalShell, type TerminalShellOptions } from "../cli/shell.js";
import { createDarkTestTheme } from "./helpers/cli-theme.js";

class FakeTerminal implements Terminal {
  output = "";
  started = 0;
  stopped = 0;
  drained = 0;
  columns = 80;
  rows = 24;
  kittyProtocolActive = false;
  private onInput: (data: string) => void = () => undefined;
  start(onInput: (data: string) => void): void {
    this.started += 1;
    this.onInput = onInput;
  }
  stop(): void {
    this.stopped += 1;
  }
  async drainInput(): Promise<void> {
    this.drained += 1;
  }
  write(data: string): void {
    this.output += data;
  }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  type(data: string): void {
    this.onInput(data);
  }
}

const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

function harness(extra: Partial<TerminalShellOptions> = {}) {
  const terminal = new FakeTerminal();
  const signals = new EventEmitter();
  const recorder = createRunRecorder();
  const shell: TerminalShell = createTerminalShell({
    theme: createDarkTestTheme(),
    recorder,
    createTerminal: () => terminal,
    signalSource: signals,
    noticeMs: 60_000,
    ...extra,
  });
  return { shell, terminal, signals, recorder };
}

const component = (lines: string[], onInput?: (data: string) => void) => ({ render: () => lines, invalidate() {}, handleInput: onInput });

describe("terminal shell", () => {
  it("starts lazily and records notices without starting", async () => {
    const { shell, terminal, recorder } = harness();
    shell.notify("quiet", "warning");
    shell.setStatus("k", "status");
    expect(terminal.started).toBe(0);
    expect(recorder.notices).toEqual([{ level: "warning", text: "quiet" }]);
    await shell.stop();
    expect(terminal.stopped).toBe(0);
  });

  it("select picks with Enter and navigates with arrows and j/k", async () => {
    const { shell, terminal } = harness();
    const picked = shell.select("Choose", ["one", "two", "three"]);
    await tick();
    expect(terminal.output).toContain("Choose");
    terminal.type("\u001b[B");
    terminal.type("j");
    terminal.type("k");
    terminal.type("\r");
    await expect(picked).resolves.toBe("two");
    await shell.stop();
  });

  it("select resolves undefined on Escape, abort, and an already aborted signal", async () => {
    const { shell, terminal } = harness();
    const escaped = shell.select("t", ["a"]);
    await tick();
    terminal.type("\u001b");
    await expect(escaped).resolves.toBeUndefined();

    const controller = new AbortController();
    const aborted = shell.select("t", ["a"], { signal: controller.signal });
    await tick();
    controller.abort();
    await expect(aborted).resolves.toBeUndefined();
    await expect(shell.select("t", ["a"], { signal: AbortSignal.abort() })).resolves.toBeUndefined();
    await shell.stop();
  });

  it("select times out as a cancel", async () => {
    const { shell } = harness();
    await expect(shell.select("t", ["a"], { timeout: 30 })).resolves.toBeUndefined();
    await shell.stop();
  });

  it("editor submits typed text with Enter, keeps the prefill, and cancels with Escape", async () => {
    const { shell, terminal } = harness();
    const submitted = shell.editor("Note", "hello");
    await tick();
    terminal.type(" world");
    terminal.type("\r");
    await expect(submitted).resolves.toBe("hello world");

    const cancelled = shell.editor("Note");
    await tick();
    terminal.type("\u001b");
    await expect(cancelled).resolves.toBeUndefined();
    await shell.stop();
  });

  it("custom mounts a component, forwards input, and resolves with done", async () => {
    const { shell, terminal } = harness();
    const result = shell.custom<string>((_tui, _theme, keybindings, done) =>
      component(["custom body"], (data) => {
        if (keybindings.matches(data, "tui.input.submit")) done("finished");
      }),
    );
    await tick();
    expect(terminal.output).toContain("custom body");
    terminal.type("\r");
    await expect(result).resolves.toBe("finished");
    await shell.stop();
  });

  it("keybindings match pi-tui input actions", async () => {
    const { shell } = harness();
    expect(shell.keybindings.matches("\r", "tui.input.submit")).toBe(true);
    expect(shell.keybindings.matches("\x1b[13;2u", "tui.input.newLine")).toBe(true);
    expect(shell.keybindings.matches("a", "tui.input.submit")).toBe(false);
    expect(shell.keybindings.matches("a", "app.unknown")).toBe(false);
  });

  it("custom overlay shows with the given options, exposes the handle, and hides on done", async () => {
    const { shell, terminal } = harness();
    const onHandle = vi.fn();
    let finish!: (value: number) => void;
    let hasOverlay!: () => boolean;
    const result = shell.custom<number>(
      (tui, _theme, _keys, done) => {
        finish = done;
        hasOverlay = () => tui.hasOverlay();
        return component(["overlay body"]);
      },
      { overlay: true, overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", minWidth: 40, margin: 0 }, onHandle },
    );
    await tick();
    expect(onHandle).toHaveBeenCalledTimes(1);
    expect(hasOverlay()).toBe(true);
    expect(terminal.output).toContain("overlay body");
    finish(7);
    await expect(result).resolves.toBe(7);
    expect(hasOverlay()).toBe(false);
    await shell.stop();
  });

  it("disposes the component and ignores a second done", async () => {
    const { shell } = harness();
    const dispose = vi.fn();
    let finish!: (value: string) => void;
    const result = shell.custom<string>((_tui, _theme, _keys, done) => {
      finish = done;
      return { ...component(["x"]), dispose };
    });
    await tick();
    finish("a");
    finish("b");
    await expect(result).resolves.toBe("a");
    expect(dispose).toHaveBeenCalledTimes(1);
    await shell.stop();
  });

  it("rejects when the factory throws and survives a done before the component exists", async () => {
    const { shell } = harness();
    await expect(shell.custom(() => Promise.reject(new Error("factory failed")))).rejects.toThrow("factory failed");
    const dispose = vi.fn();
    await expect(shell.custom<string>(async (_tui, _theme, _keys, done) => (done("early"), { ...component(["x"]), dispose }))).resolves.toBe("early");
    expect(dispose).toHaveBeenCalled();
    await shell.stop();
  });

  it("survives two customs in sequence and a select between them", async () => {
    const { shell, terminal } = harness();
    for (const label of ["first", "second"]) {
      const result = shell.custom<string>((_tui, _theme, _keys, done) => component([label], () => done(label)));
      await tick();
      expect(terminal.output).toContain(label);
      terminal.type("x");
      await expect(result).resolves.toBe(label);
      const picked = shell.select("between", ["ok"]);
      await tick();
      terminal.type("\r");
      await expect(picked).resolves.toBe("ok");
    }
    expect(terminal.started).toBe(1);
    await shell.stop();
    expect(terminal.stopped).toBe(1);
    expect(terminal.drained).toBe(1);
  });

  it("nests an overlay custom inside another and returns to the first", async () => {
    const { shell, terminal } = harness();
    const outer = shell.custom<string>(
      async (_tui, _theme, _keys, done) => component(["outer"], () => done("outer done")),
      { overlay: true },
    );
    await tick();
    const inner = shell.custom<string>(async (_tui, _theme, _keys, done) => component(["inner"], () => done("inner done")), { overlay: true });
    await tick();
    terminal.type("x");
    await expect(inner).resolves.toBe("inner done");
    terminal.type("x");
    await expect(outer).resolves.toBe("outer done");
    await shell.stop();
  });

  it("runs an external command between customs: stops the TUI, runs the child, restarts, re-renders", async () => {
    const spawnProcess = vi.fn(() => {
      const child = new EventEmitter();
      setTimeout(() => child.emit("close", 0, null), 5);
      return child;
    });
    const { shell, terminal } = harness({ spawnProcess: spawnProcess as never });
    const first = shell.custom<string>((_tui, _theme, _keys, done) => component(["first"], () => done("one")));
    await tick();
    terminal.type("x");
    await first;
    expect(terminal.stopped).toBe(0);

    const outcome = await shell.runExternal("vim", ["a.txt"], "/repo");
    expect(outcome).toEqual({ kind: "exit", code: 0 });
    expect(spawnProcess).toHaveBeenCalledWith("vim", ["a.txt"], { cwd: "/repo", stdio: "inherit", shell: false });
    expect(terminal.stopped).toBe(1);
    expect(terminal.started).toBe(2);

    const second = shell.custom<string>((_tui, _theme, _keys, done) => component(["second"], () => done("two")));
    await tick();
    expect(terminal.output).toContain("second");
    terminal.type("x");
    await expect(second).resolves.toBe("two");
    await shell.stop();
  });

  it("reports signals and spawn errors from external commands", async () => {
    const make = (event: string, ...args: unknown[]) => vi.fn(() => {
      const child = new EventEmitter();
      setTimeout(() => child.emit(event, ...args), 5);
      return child;
    });
    const signalled = harness({ spawnProcess: make("close", null, "SIGKILL") as never });
    expect(await signalled.shell.runExternal("x", [], "/")).toEqual({ kind: "signal", signal: "SIGKILL" });
    const failed = harness({ spawnProcess: make("error", new Error("ENOENT")) as never });
    expect(await failed.shell.runExternal("x", [], "/")).toEqual({ kind: "exit", code: 127 });
    expect(failed.recorder.notices[0]).toMatchObject({ level: "error", text: expect.stringContaining("Could not run x") });
  });

  it("shows status, widgets, and the latest notice on the idle screen in order", async () => {
    const { shell, terminal, recorder } = harness();
    shell.setWidget("progress", () => component(["widget line"]));
    await tick();
    shell.setStatus("pi-coder", "status line");
    shell.notify("first");
    shell.notify("second", "error");
    await tick();
    expect(terminal.output).toContain("widget line");
    expect(terminal.output).toContain("status line");
    expect(terminal.output).toContain("second");
    expect(recorder.notices.map((notice) => notice.text)).toEqual(["first", "second"]);
    shell.setWidget("progress", undefined);
    shell.setStatus("pi-coder", undefined);
    await shell.stop();
  });

  it("disposes widgets on removal and on stop", async () => {
    const { shell } = harness();
    const dispose = vi.fn();
    shell.setWidget("a", () => ({ ...component(["a"]), dispose }));
    shell.setWidget("a", undefined);
    expect(dispose).toHaveBeenCalledTimes(1);
    shell.setWidget("b", () => ({ ...component(["b"]), dispose }));
    await shell.stop();
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it("records setEditorText as the prompt", () => {
    const { shell, recorder } = harness();
    shell.setEditorText("handoff");
    expect(recorder.prompt).toBe("handoff");
  });

  it("writes OSC 52 through the terminal", async () => {
    const { shell, terminal } = harness();
    const done = shell.select("t", ["a"]);
    await tick();
    await shell.copyText("héllo");
    expect(terminal.output).toContain(formatOsc52Clipboard("héllo"));
    terminal.type("\r");
    await done;
    await shell.stop();
  });

  it("interrupts on signals, on Ctrl+C at the idle screen, and not during an external command", async () => {
    const onInterrupt = vi.fn();
    const { shell, terminal, signals } = harness({
      onInterrupt,
      spawnProcess: (() => {
        const child = new EventEmitter();
        setTimeout(() => child.emit("close", 0, null), 20);
        return child;
      }) as never,
    });
    shell.setWidget("w", () => component(["idle"]));
    await tick();
    terminal.type("\u0003");
    expect(onInterrupt).toHaveBeenLastCalledWith("ctrl+c");
    signals.emit("SIGTERM");
    expect(onInterrupt).toHaveBeenLastCalledWith("SIGTERM");
    signals.emit("SIGHUP");
    expect(onInterrupt).toHaveBeenLastCalledWith("SIGHUP");
    const external = shell.runExternal("x", [], "/");
    signals.emit("SIGINT");
    expect(onInterrupt).toHaveBeenCalledTimes(3);
    await external;
    await shell.stop();
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
    expect(signals.listenerCount("SIGHUP")).toBe(0);
  });

  it("restarts cleanly after stop", async () => {
    const { shell, terminal } = harness();
    const first = shell.select("t", ["a"]);
    await tick();
    terminal.type("\r");
    await first;
    await shell.stop();
    await shell.stop();
    const second = shell.select("t", ["b"]);
    await tick();
    terminal.type("\r");
    await expect(second).resolves.toBe("b");
    await shell.stop();
    expect(terminal.stopped).toBe(2);
  });
});
