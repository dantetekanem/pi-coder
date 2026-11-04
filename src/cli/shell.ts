import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Editor,
  getKeybindings,
  matchesKey,
  ProcessTerminal,
  TUI,
  truncateToWidth,
  type Component,
  type Focusable,
  type Keybinding,
  type OverlayHandle,
  type Terminal,
} from "@earendil-works/pi-tui";
import type { ExternalEditorLauncher, ExternalEditorOutcome } from "../host/engine.js";
import type {
  HostComponent,
  HostComponentFactory,
  HostCustomOptions,
  HostKeybindings,
  HostNotifyLevel,
  HostSelectOptions,
  HostTheme,
  HostUI,
  HostWidgetFactory,
} from "../host/types.js";
import type { RunRecorder } from "./host.js";

interface SignalSource {
  on(signal: "SIGINT" | "SIGTERM" | "SIGHUP", listener: () => void): unknown;
  off(signal: "SIGINT" | "SIGTERM" | "SIGHUP", listener: () => void): unknown;
}

type SpawnProcess = (command: string, args: string[], options: SpawnOptions) => ReturnType<typeof nodeSpawn>;

export type InterruptReason = "SIGINT" | "SIGTERM" | "SIGHUP" | "ctrl+c";

export interface TerminalShellOptions {
  theme: HostTheme;
  recorder: RunRecorder;
  createTerminal?: () => Terminal;
  signalSource?: SignalSource;
  onInterrupt?: (reason: InterruptReason) => void;
  spawnProcess?: SpawnProcess;
  noticeMs?: number;
  writeOutput?: (data: string) => void;
}

export interface TerminalShell extends HostUI {
  readonly active: boolean;
  readonly keybindings: HostKeybindings;
  runExternal: ExternalEditorLauncher;
  copyText(text: string): Promise<void>;
  stop(): Promise<void>;
}

const NOTICE_MS = 10_000;

export function formatOsc52Clipboard(text: string): string {
  return `\u001b]52;c;${Buffer.from(text, "utf8").toString("base64")}\u0007`;
}

export const terminalKeybindings: HostKeybindings = {
  matches: (data, keybinding) => getKeybindings().matches(data, keybinding as Keybinding),
};

function exitCodeFor(reason: InterruptReason): number {
  if (reason === "SIGHUP") return 129;
  return reason === "SIGTERM" ? 143 : 130;
}

class BorderLine implements Component {
  constructor(private readonly theme: HostTheme) {}
  invalidate(): void {}
  render(width: number): string[] {
    return [this.theme.fg("border", "─".repeat(Math.max(0, width)))];
  }
}

class IdleScreen implements Component {
  constructor(
    private readonly theme: HostTheme,
    private readonly statuses: Map<string, string>,
    private readonly widgets: Map<string, HostComponent>,
    private readonly notice: () => { text: string; level: HostNotifyLevel } | undefined,
    private readonly onInterrupt: () => void,
  ) {}

  invalidate(): void {
    for (const widget of this.widgets.values()) widget.invalidate();
  }

  handleInput(data: string): void {
    if (matchesKey(data, "ctrl+c")) this.onInterrupt();
  }

  render(width: number): string[] {
    const lines: string[] = [];
    for (const text of this.statuses.values()) lines.push(this.theme.fg("muted", text));
    for (const widget of this.widgets.values()) lines.push(...widget.render(width));
    const notice = this.notice();
    if (notice) {
      const color = notice.level === "error" ? "error" : notice.level === "warning" ? "warning" : "text";
      if (lines.length > 0) lines.push("");
      lines.push(this.theme.fg(color, notice.text));
    }
    return lines.flatMap((line) => line.split("\n")).map((line) => truncateToWidth(line, width));
  }
}

class SelectDialog implements Component {
  private selected = 0;

  constructor(
    private readonly theme: HostTheme,
    private readonly title: string,
    private readonly options: string[],
    private readonly rows: () => number,
    private readonly done: (value: string | undefined) => void,
  ) {}

  invalidate(): void {}

  handleInput(data: string): void {
    const keys = getKeybindings();
    if (keys.matches(data, "tui.select.up") || data === "k") this.selected = Math.max(0, this.selected - 1);
    else if (keys.matches(data, "tui.select.down") || data === "j") this.selected = Math.min(this.options.length - 1, this.selected + 1);
    else if (keys.matches(data, "tui.select.pageUp")) this.selected = Math.max(0, this.selected - this.visibleCount());
    else if (keys.matches(data, "tui.select.pageDown")) this.selected = Math.min(this.options.length - 1, this.selected + this.visibleCount());
    else if (keys.matches(data, "tui.select.confirm") || data === "\n") {
      const choice = this.options[this.selected];
      if (choice !== undefined) this.done(choice);
    } else if (keys.matches(data, "tui.select.cancel")) this.done(undefined);
  }

  private visibleCount(): number {
    return Math.max(3, this.rows() - 10);
  }

  render(width: number): string[] {
    const border = this.theme.fg("border", "─".repeat(Math.max(0, width)));
    const count = this.visibleCount();
    const start = Math.max(0, Math.min(this.selected - Math.floor(count / 2), this.options.length - count));
    const visible = this.options.slice(start, start + count);
    const lines = [border, ""];
    for (const line of this.title.split("\n")) lines.push(` ${this.theme.fg("accent", this.theme.bold(line))}`);
    lines.push("");
    visible.forEach((option, offset) => {
      const selected = start + offset === this.selected;
      lines.push(selected ? ` ${this.theme.fg("accent", `→ ${option}`)}` : `   ${this.theme.fg("text", option)}`);
    });
    if (this.options.length > visible.length) lines.push(this.theme.fg("dim", `   (${this.selected + 1}/${this.options.length})`));
    lines.push("", this.theme.fg("dim", " ↑↓ navigate  enter select  esc cancel"), "", border);
    return lines.map((line) => truncateToWidth(line, width));
  }
}

class EditorDialog implements Component, Focusable {
  private readonly editor: Editor;
  private focusedValue = false;

  constructor(
    tui: TUI,
    private readonly theme: HostTheme,
    private readonly title: string,
    prefill: string | undefined,
    private readonly done: (value: string | undefined) => void,
    private readonly openExternal: (text: string) => Promise<string | undefined>,
  ) {
    this.editor = new Editor(tui, {
      borderColor: (text) => theme.fg("border", text),
      selectList: {
        selectedPrefix: (text) => theme.fg("accent", text),
        selectedText: (text) => theme.fg("accent", text),
        description: (text) => theme.fg("muted", text),
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: (text) => theme.fg("muted", text),
      },
    });
    if (prefill) this.editor.setText(prefill);
    this.editor.onSubmit = (text) => this.done(text);
  }

  get focused(): boolean {
    return this.focusedValue;
  }

  set focused(value: boolean) {
    this.focusedValue = value;
    this.editor.focused = value;
  }

  invalidate(): void {
    this.editor.invalidate();
  }

  handleInput(data: string): void {
    if (getKeybindings().matches(data, "tui.select.cancel")) {
      this.done(undefined);
      return;
    }
    if (matchesKey(data, "ctrl+g") && (process.env.VISUAL || process.env.EDITOR)) {
      void this.openExternal(this.editor.getText()).then((text) => {
        if (text !== undefined) this.editor.setText(text);
      });
      return;
    }
    this.editor.handleInput(data);
  }

  render(width: number): string[] {
    const border = this.theme.fg("border", "─".repeat(Math.max(0, width)));
    const hint = " enter submit  shift+enter newline  esc cancel" + (process.env.VISUAL || process.env.EDITOR ? "  ctrl+g external editor" : "");
    return [
      border,
      "",
      ` ${this.theme.fg("accent", this.title)}`,
      "",
      ...this.editor.render(width),
      "",
      this.theme.fg("dim", hint),
      "",
      border,
    ].map((line) => truncateToWidth(line, width));
  }
}

export function createTerminalShell(options: TerminalShellOptions): TerminalShell {
  const { theme, recorder } = options;
  const createTerminal = options.createTerminal ?? (() => new ProcessTerminal());
  const signalSource: SignalSource = options.signalSource ?? process;
  const spawnProcess: SpawnProcess = options.spawnProcess ?? ((command, args, spawnOptions) => nodeSpawn(command, args, spawnOptions));
  const noticeMs = options.noticeMs ?? NOTICE_MS;

  const statuses = new Map<string, string>();
  const widgetFactories = new Map<string, HostWidgetFactory>();
  const widgets = new Map<string, HostComponent>();
  const mounted: Component[] = [];
  let notice: { text: string; level: HostNotifyLevel } | undefined;
  let noticeTimer: NodeJS.Timeout | undefined;
  let terminal: Terminal | undefined;
  let tui: TUI | undefined;
  let external = false;

  const interrupt = (reason: InterruptReason) => {
    if (external) return;
    if (options.onInterrupt) {
      options.onInterrupt(reason);
      return;
    }
    void shell.stop().finally(() => process.exit(exitCodeFor(reason)));
  };
  const onSigint = () => interrupt("SIGINT");
  const onSigterm = () => interrupt("SIGTERM");
  const onSighup = () => interrupt("SIGHUP");

  const idle = new IdleScreen(theme, statuses, widgets, () => notice, () => interrupt("ctrl+c"));

  const layout = () => {
    if (!tui) return;
    const top = mounted.at(-1) ?? idle;
    tui.clear();
    tui.addChild(top);
    tui.setFocus(top);
    tui.requestRender();
  };

  const instantiateWidgets = () => {
    if (!tui) return;
    for (const [key, factory] of widgetFactories) {
      if (!widgets.has(key)) widgets.set(key, factory(tui, theme));
    }
  };

  const ensureStarted = (): TUI => {
    if (tui) return tui;
    terminal = createTerminal();
    tui = new TUI(terminal);
    signalSource.on("SIGINT", onSigint);
    signalSource.on("SIGTERM", onSigterm);
    signalSource.on("SIGHUP", onSighup);
    instantiateWidgets();
    layout();
    tui.start();
    return tui;
  };

  const disposeWidget = (key: string) => {
    const widget = widgets.get(key);
    widgets.delete(key);
    try {
      widget?.dispose?.();
    } catch {}
  };

  const runInherit = (command: string, args: string[], cwd: string): Promise<ExternalEditorOutcome> =>
    new Promise((resolve) => {
      const child = spawnProcess(command, args, { cwd, stdio: "inherit", shell: false });
      child.on("error", (error) => {
        recorder.notices.push({ level: "error", text: `Could not run ${command}: ${error.message}` });
        resolve({ kind: "exit", code: 127 });
      });
      child.on("close", (code, signal) => resolve(signal ? { kind: "signal", signal } : { kind: "exit", code: code ?? 0 }));
    });

  const runExternal: ExternalEditorLauncher = async (command, args, cwd) => {
    const running = tui;
    external = true;
    running?.stop();
    try {
      return await runInherit(command, args, cwd);
    } finally {
      external = false;
      if (running && tui === running) {
        running.start();
        running.requestRender(true);
      }
    }
  };

  const editInExternalEditor = async (text: string): Promise<string | undefined> => {
    const editorCommand = (process.env.VISUAL || process.env.EDITOR || "").trim();
    if (!editorCommand) return undefined;
    const directory = mkdtempSync(join(tmpdir(), "pi-coder-edit-"));
    const file = join(directory, "message.md");
    try {
      writeFileSync(file, text, { encoding: "utf8", mode: 0o600 });
      const [command = "", ...rest] = editorCommand.split(/\s+/);
      const outcome = await runExternal(command, [...rest, file], process.cwd());
      return outcome.kind === "exit" && outcome.code === 0 ? readFileSync(file, "utf8").replace(/\n$/, "") : undefined;
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };

  function openCustom<T>(factory: HostComponentFactory<T>, customOptions?: HostCustomOptions, signal?: AbortSignal, timeout?: number): Promise<T> {
    const running = ensureStarted();
    const overlay = customOptions?.overlay === true;
    return new Promise<T>((resolve, reject) => {
      let component: HostComponent | undefined;
      let handle: OverlayHandle | undefined;
      let closed = false;
      let timer: NodeJS.Timeout | undefined;

      const close = (result: unknown) => {
        if (closed) return;
        closed = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (overlay) handle?.hide();
        else if (component) {
          const index = mounted.indexOf(component);
          if (index >= 0) mounted.splice(index, 1);
          layout();
        }
        resolve(result as T);
        try {
          component?.dispose?.();
        } catch {}
      };
      const onAbort = () => close(undefined);

      signal?.addEventListener("abort", onAbort, { once: true });
      if (timeout !== undefined && timeout > 0) {
        timer = setTimeout(() => close(undefined), timeout);
        timer.unref();
      }

      Promise.resolve(factory(running, theme, terminalKeybindings, close))
        .then((created) => {
          if (closed) {
            created.dispose?.();
            return;
          }
          component = created;
          if (overlay) {
            const resolved = typeof customOptions?.overlayOptions === "function" ? customOptions.overlayOptions() : customOptions?.overlayOptions;
            handle = running.showOverlay(created, resolved);
            customOptions?.onHandle?.(handle);
          } else {
            mounted.push(created);
            layout();
          }
        })
        .catch((error: unknown) => {
          if (closed) return;
          closed = true;
          if (timer) clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        });
    });
  }

  const mountDialog = <T>(build: (done: (value: T) => void, running: TUI) => Component, signal?: AbortSignal, timeout?: number): Promise<T> =>
    openCustom<T>((running, _theme, _keys, done) => build(done, running), undefined, signal, timeout);

  const shell: TerminalShell = {
    theme,
    keybindings: terminalKeybindings,
    get active() {
      return tui !== undefined;
    },

    notify(message, type = "info") {
      recorder.notices.push({ level: type, text: message });
      notice = { text: message, level: type };
      if (noticeTimer) clearTimeout(noticeTimer);
      noticeTimer = setTimeout(() => {
        notice = undefined;
        tui?.requestRender();
      }, noticeMs);
      noticeTimer.unref();
      tui?.requestRender();
    },

    select(title, choices, selectOptions?: HostSelectOptions) {
      if (selectOptions?.signal?.aborted) return Promise.resolve(undefined);
      return mountDialog<string | undefined>(
        (done) => new SelectDialog(theme, title, choices, () => terminal?.rows ?? 24, done),
        selectOptions?.signal,
        selectOptions?.timeout,
      );
    },

    editor(title, prefill) {
      return mountDialog<string | undefined>((done, running) => new EditorDialog(running, theme, title, prefill, done, editInExternalEditor));
    },

    setStatus(key, text) {
      if (text === undefined) statuses.delete(key);
      else statuses.set(key, text);
      tui?.requestRender();
    },

    setWidget(key, content) {
      disposeWidget(key);
      if (content === undefined) {
        widgetFactories.delete(key);
        tui?.requestRender();
        return;
      }
      widgetFactories.set(key, content);
      ensureStarted();
      instantiateWidgets();
      tui?.requestRender();
    },

    custom: (factory, customOptions) => openCustom(factory, customOptions),

    setEditorText(text) {
      recorder.prompt = text;
    },

    runExternal,

    async copyText(text) {
      const sequence = formatOsc52Clipboard(text);
      if (terminal) {
        terminal.write(sequence);
        return;
      }
      if (options.writeOutput) {
        options.writeOutput(sequence);
        return;
      }
      if (!process.stdout.isTTY) throw new Error("No terminal is available to copy text.");
      process.stdout.write(sequence);
    },

    async stop() {
      const running = tui;
      const runningTerminal = terminal;
      if (noticeTimer) clearTimeout(noticeTimer);
      if (!running || !runningTerminal) return;
      tui = undefined;
      terminal = undefined;
      mounted.length = 0;
      signalSource.off("SIGINT", onSigint);
      signalSource.off("SIGTERM", onSigterm);
      signalSource.off("SIGHUP", onSighup);
      for (const key of [...widgets.keys()]) disposeWidget(key);
      widgetFactories.clear();
      try {
        await runningTerminal.drainInput();
      } catch {}
      try {
        running.stop();
      } catch {}
    },
  };

  return shell;
}
