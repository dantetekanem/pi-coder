import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createStandaloneTheme, formatOsc52Clipboard, parseStandaloneArgs, runStandaloneWorkbench, standaloneMain } from "../workbench/standalone.js";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function TypeScriptFilesBelow(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = await Promise.all(entries.map(async (entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? TypeScriptFilesBelow(path) : entry.name.endsWith(".ts") ? [path] : [];
  }));
  return paths.flat();
}

describe("standalone workbench host boundary", () => {
  it("encodes exact UTF-8 source text for the terminal clipboard", () => {
    expect(formatOsc52Clipboard("line\n🙂")).toBe(`\u001b]52;c;${Buffer.from("line\n🙂", "utf8").toString("base64")}\u0007`);
  });

  it("uses bright yellow matches and an inverse current match", () => {
    const theme = createStandaloneTheme();
    expect(theme.searchMatch?.("needle", false)).toBe("\u001b[1;93mneedle\u001b[0m");
    expect(theme.searchMatch?.("needle", true)).toBe("\u001b[1;7;93mneedle\u001b[0m");
    expect(createStandaloneTheme(false).searchMatch?.("needle", true)).toBe("needle");
  });

  it("keeps every reusable workbench module independent of pi-coding-agent", async () => {
    const files = await TypeScriptFilesBelow(resolve(sourceRoot, "workbench"));
    for (const file of files) expect(await readFile(file, "utf8"), file).not.toContain("pi-coding-agent");
  });

  it("ships every source and document imported by the packed workbench extension", async () => {
    const manifest = JSON.parse(await readFile(resolve(sourceRoot, "../package.json"), "utf8")) as { files?: string[] };

    expect(manifest.files).toEqual(expect.arrayContaining([
      "src/workbench",
      "src/adapters",
      "src/git-change-status.ts",
      "src/git-filter-policy.ts",
      "scripts",
      "docs",
      "tsconfig.workbench.json",
    ]));
  });
});

describe("standalone arguments", () => {
  const target = { path: "src/file.ts", range: { startLine: 2, endLine: 4 }, anchor: { algorithm: "sha256" as const, value: "a".repeat(64) } };

  it("supports help alone and defaults cwd to the caller's cwd", () => {
    expect(parseStandaloneArgs([], "/repo")).toEqual({ kind: "run", cwd: "/repo", launch: { capabilities: { discuss: false } } });
    expect(parseStandaloneArgs(["--help"], "/repo")).toEqual({ kind: "help" });
    for (const argv of [["--help", "/repo"], ["-h"]]) expect(() => parseStandaloneArgs(argv, "/repo")).toThrow();
  });

  it("describes a Git-optional filesystem workspace in help", async () => {
    let help = "";
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      help += chunk.toString();
      return true;
    });
    try {
      await expect(standaloneMain(["--help"])).resolves.toBe(0);
    } finally {
      stdoutWrite.mockRestore();
    }

    expect(help).toContain("filesystem workspace");
    expect(help).toContain("Git is optional");
    expect(help).toContain("Workspace directory");
    expect(help).toContain("workspace-relative file");
    expect(help).not.toContain("repository");
  });

  it("accepts positional or named cwd and every named value form", () => {
    expect(parseStandaloneArgs(["packages/app"], "/repo")).toMatchObject({ kind: "run", cwd: "/repo/packages/app" });
    expect(parseStandaloneArgs(["--cwd=packages/app", "--path=src/file.ts", "--line=2", "--end-line=4", `--anchor-sha256=${"a".repeat(64)}`], "/repo"))
      .toEqual({ kind: "run", cwd: "/repo/packages/app", launch: { initialTarget: target, capabilities: { discuss: false } } });
    expect(parseStandaloneArgs(["--cwd", "-dash", "--path", "-dash", "--line", "1"], "/repo")).toMatchObject({
      cwd: "/repo/-dash",
      launch: { initialTarget: { path: "-dash", range: { startLine: 1, endLine: 1 } } },
    });
  });

  it("normalizes ordered repeated stories and rejects invalid JSON values", () => {
    const first = { id: "one", target: { path: "a.ts", range: { startLine: 1, endLine: 1 } }, prose: "First" };
    const second = { id: "two", target: { path: "b.ts", range: { startLine: 2, endLine: 2 } }, prose: "Second" };
    expect(parseStandaloneArgs(["--story-json", JSON.stringify(first), `--story-json=${JSON.stringify(second)}`], "/repo"))
      .toEqual({ kind: "run", cwd: "/repo", launch: { stories: [first, second], capabilities: { discuss: false } } });
    for (const value of ["not-json", "null", "[]", "1", JSON.stringify({ id: "bad" })]) {
      expect(() => parseStandaloneArgs(["--story-json", value], "/repo")).toThrow();
    }
  });

  it("rejects duplicates, unknowns, missing values, and partial or invalid targets", () => {
    const invalid = [
      ["one", "--cwd", "two"], ["one", "two"], ["--unknown"], ["--cwd"], ["--path"],
      ["--cwd", "a", "--cwd", "b"], ["--path", "a.ts", "--path", "b.ts", "--line", "1"],
      ["--path", "a.ts"], ["--line", "1"], ["--end-line", "2"], ["--anchor-sha256", "a".repeat(64)],
      ["--path", "a.ts", "--line", "0"], ["--path", "a.ts", "--line", "-1"], ["--path", "a.ts", "--line", "1.5"],
      ["--path", "a.ts", "--line", "3", "--end-line", "2"], ["--path", "../a.ts", "--line", "1"],
      ["--path", "a.ts", "--line", "1", "--anchor-sha256", "A".repeat(64)],
    ];
    for (const argv of invalid) expect(() => parseStandaloneArgs(argv, "/repo"), argv.join(" ")).toThrow();
  });

  it("applies the exact normalized 128-KiB launch boundary", () => {
    const story = { id: "id", target: { path: "a", range: { startLine: 1, endLine: 1 } }, prose: "" };
    const baseBytes = Buffer.byteLength(JSON.stringify({ stories: [story], capabilities: { discuss: false } }));
    const exactPath = "a".repeat(131_072 - baseBytes + 1);
    const exact = JSON.stringify({ ...story, target: { ...story.target, path: exactPath } });
    expect(parseStandaloneArgs(["--story-json", exact], "/repo")).toMatchObject({ kind: "run" });
    const over = JSON.stringify({ ...story, target: { ...story.target, path: `${exactPath}a` } });
    expect(() => parseStandaloneArgs(["--story-json", over], "/repo")).toThrow("131072");
  });
});

describe("standalone lifecycle", () => {
  it("opens the normalized initial target after app start and before terminal raw mode, reports failure, and disables DISCUSS", async () => {
    const events: string[] = [];
    let receivedLaunch: unknown;
    const workbench = {
      start: vi.fn(async () => { events.push("start"); }),
      openTarget: vi.fn(async () => { events.push("target"); return { status: "missing", path: "missing.ts", message: "missing.ts is unavailable" }; }),
      dispose: vi.fn(),
    };
    await expect(runStandaloneWorkbench({ cwd: "/repo", launch: { initialTarget: { path: "missing.ts", range: { startLine: 1, endLine: 1 } }, capabilities: { discuss: false } } }, {
      createTerminal: () => { events.push("terminal"); return { drainInput: async () => undefined } as never; },
      createTui: () => ({ addChild: vi.fn(), setFocus: vi.fn(), start: vi.fn(), stop: vi.fn() }) as never,
      createRepository: async () => ({ workspaceKey: "/repo" }) as never,
      createWorkbench: () => workbench as never,
      createComponent: (_tui, _theme, _workbench, done, _state, launch) => {
        receivedLaunch = launch;
        queueMicrotask(() => done({ status: "closed", changedPaths: [] }));
        return { requestClose: vi.fn(), render: () => [], invalidate: vi.fn(), focused: false } as never;
      },
      reportStartupIssue: (message) => events.push(`issue:${message}`),
      signalSource: { on: vi.fn(), off: vi.fn() },
    })).resolves.toEqual({ status: "closed", changedPaths: [] });
    expect(events.slice(0, 4)).toEqual(["start", "target", "issue:missing.ts: missing.ts is unavailable", "terminal"]);
    expect(receivedLaunch).toEqual({ initialTarget: { path: "missing.ts", range: { startLine: 1, endLine: 1 } }, capabilities: { discuss: false } });
  });

  it("sanitizes and bounds malicious startup notices to one safe line", async () => {
    const path = `src/visible location ${"\r\n\t\u001b\u0000\u001f\u0085"}${"界".repeat(400)}.ts`;
    const message = `visible reason ${"\r\n\t\u001b\u0000\u001f\u0085"}${"界".repeat(400)}`;
    const reportStartupIssue = vi.fn();
    const workbench = {
      start: vi.fn(async () => undefined),
      openTarget: vi.fn(async () => ({ status: "missing" as const, path, message })),
      dispose: vi.fn(),
    };
    await expect(runStandaloneWorkbench({ cwd: "/repo", launch: { initialTarget: { path, range: { startLine: 3, endLine: 3 } }, capabilities: { discuss: false } } }, {
      createTerminal: () => ({ drainInput: async () => undefined }) as never,
      createTui: () => ({ addChild: vi.fn(), setFocus: vi.fn(), start: vi.fn(), stop: vi.fn() }) as never,
      createRepository: async () => ({ workspaceKey: "/repo" }) as never,
      createWorkbench: () => workbench as never,
      createComponent: (_tui, _theme, _workbench, done) => {
        queueMicrotask(() => done({ status: "closed", changedPaths: [] }));
        return { requestClose: vi.fn(), render: () => [], invalidate: vi.fn(), focused: false } as never;
      },
      reportStartupIssue,
      signalSource: { on: vi.fn(), off: vi.fn() },
    })).resolves.toEqual({ status: "closed", changedPaths: [] });

    const notice = reportStartupIssue.mock.calls[0]?.[0] as string;
    expect(notice).toContain("src/visible location");
    expect(notice).toContain("visible reason");
    expect(notice).toMatch(/…/);
    expect(notice).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(Buffer.byteLength(notice, "utf8")).toBeLessThanOrEqual(512);
  });

  it("keeps an exact initial target quiet while still mounting the Explorer", async () => {
    const events: string[] = [];
    const reportStartupIssue = vi.fn(() => events.push("issue"));
    const workbench = {
      start: vi.fn(async () => { events.push("start"); }),
      openTarget: vi.fn(async () => { events.push("target"); return { status: "opened" as const, path: "src/file.ts", range: { startLine: 2, endLine: 2 }, stale: false }; }),
      dispose: vi.fn(),
    };
    await expect(runStandaloneWorkbench({ cwd: "/repo", launch: { initialTarget: { path: "src/file.ts", range: { startLine: 2, endLine: 2 } }, capabilities: { discuss: false } } }, {
      createTerminal: () => { events.push("terminal"); return { drainInput: async () => undefined } as never; },
      createTui: () => ({ addChild: vi.fn(), setFocus: vi.fn(), start: vi.fn(), stop: vi.fn() }) as never,
      createRepository: async () => ({ workspaceKey: "/repo" }) as never,
      createWorkbench: () => workbench as never,
      createComponent: (_tui, _theme, _workbench, done) => {
        queueMicrotask(() => done({ status: "closed", changedPaths: [] }));
        return { requestClose: vi.fn(), render: () => [], invalidate: vi.fn(), focused: false } as never;
      },
      reportStartupIssue,
      signalSource: { on: vi.fn(), off: vi.fn() },
    })).resolves.toEqual({ status: "closed", changedPaths: [] });

    expect(events.slice(0, 3)).toEqual(["start", "target", "terminal"]);
    expect(reportStartupIssue).not.toHaveBeenCalled();
  });

  it("reports a clamped initial target before terminal creation and still mounts", async () => {
    const events: string[] = [];
    const reportStartupIssue = vi.fn((message: string) => events.push(`issue:${message}`));
    const workbench = {
      start: vi.fn(async () => { events.push("start"); }),
      openTarget: vi.fn(async () => { events.push("target"); return { status: "opened" as const, path: "src/file.ts", range: { startLine: 2, endLine: 2 }, stale: true, message: "Target range was clamped to the current file." }; }),
      dispose: vi.fn(),
    };
    await expect(runStandaloneWorkbench({ cwd: "/repo", launch: { initialTarget: { path: "src/file.ts", range: { startLine: 9, endLine: 9 } }, capabilities: { discuss: false } } }, {
      createTerminal: () => { events.push("terminal"); return { drainInput: async () => undefined } as never; },
      createTui: () => ({ addChild: vi.fn(), setFocus: vi.fn(), start: vi.fn(), stop: vi.fn() }) as never,
      createRepository: async () => ({ workspaceKey: "/repo" }) as never,
      createWorkbench: () => workbench as never,
      createComponent: (_tui, _theme, _workbench, done) => {
        queueMicrotask(() => done({ status: "closed", changedPaths: [] }));
        return { requestClose: vi.fn(), render: () => [], invalidate: vi.fn(), focused: false } as never;
      },
      reportStartupIssue,
      signalSource: { on: vi.fn(), off: vi.fn() },
    })).resolves.toEqual({ status: "closed", changedPaths: [] });

    expect(events.slice(0, 4)).toEqual(["start", "target", "issue:src/file.ts:2: Target range was clamped to the current file.", "terminal"]);
    expect(reportStartupIssue).toHaveBeenCalledWith(expect.stringContaining("src/file.ts:2"));
    expect(reportStartupIssue.mock.calls[0]?.[0]).not.toContain("source bytes");
  });

  it("reports an unreadable initial target before terminal creation and still mounts", async () => {
    const events: string[] = [];
    const reportStartupIssue = vi.fn((message: string) => events.push(`issue:${message}`));
    const workbench = {
      start: vi.fn(async () => { events.push("start"); }),
      openTarget: vi.fn(async () => { events.push("target"); return { status: "unreadable" as const, path: "src/file.ts", message: "Permission denied." }; }),
      dispose: vi.fn(),
    };
    await expect(runStandaloneWorkbench({ cwd: "/repo", launch: { initialTarget: { path: "src/file.ts", range: { startLine: 2, endLine: 2 } }, capabilities: { discuss: false } } }, {
      createTerminal: () => { events.push("terminal"); return { drainInput: async () => undefined } as never; },
      createTui: () => ({ addChild: vi.fn(), setFocus: vi.fn(), start: vi.fn(), stop: vi.fn() }) as never,
      createRepository: async () => ({ workspaceKey: "/repo" }) as never,
      createWorkbench: () => workbench as never,
      createComponent: (_tui, _theme, _workbench, done) => {
        queueMicrotask(() => done({ status: "closed", changedPaths: [] }));
        return { requestClose: vi.fn(), render: () => [], invalidate: vi.fn(), focused: false } as never;
      },
      reportStartupIssue,
      signalSource: { on: vi.fn(), off: vi.fn() },
    })).resolves.toEqual({ status: "closed", changedPaths: [] });

    expect(events.slice(0, 4)).toEqual(["start", "target", "issue:src/file.ts: Permission denied.", "terminal"]);
  });

  it("passes the canonical workspace's process-memory Explorer session to the component", async () => {
    const session = { load: vi.fn(() => undefined), save: vi.fn() };
    const forWorkspace = vi.fn(() => session);
    let receivedSession: unknown;
    const component = { requestClose: vi.fn(), render: () => [], invalidate: vi.fn(), focused: false };

    await expect(runStandaloneWorkbench({ cwd: "/repo" }, {
      createTerminal: () => ({ drainInput: async () => undefined }) as never,
      createTui: () => ({ addChild: vi.fn(), setFocus: vi.fn(), start: vi.fn(), stop: vi.fn() }) as never,
      createRepository: async () => ({ workspaceKey: "/canonical/repo" }) as never,
      createWorkbench: () => ({ start: async () => undefined, dispose: vi.fn() }) as never,
      createComponent: (_tui, _theme, _workbench, done, explorerState) => {
        receivedSession = explorerState;
        queueMicrotask(() => done({ status: "closed", changedPaths: [] }));
        return component as never;
      },
      explorerStateStore: { forWorkspace },
      signalSource: { on: vi.fn(), off: vi.fn() },
    })).resolves.toEqual({ status: "closed", changedPaths: [] });

    expect(forWorkspace).toHaveBeenCalledExactlyOnceWith("/canonical/repo");
    expect(receivedSession).toBe(session);
  });

  it("fails closed if a host-contract-violating DISCUSS completion reaches standalone", async () => {
    let complete!: (result: import("../workbench/contracts.js").WorkbenchCompletionResult) => void;
    const promise = runStandaloneWorkbench({ cwd: "/repo" }, {
      createTerminal: () => ({ drainInput: async () => undefined }) as never,
      createTui: () => ({ addChild: vi.fn(), setFocus: vi.fn(), start: vi.fn(), stop: vi.fn() }) as never,
      createRepository: async () => ({}) as never,
      createWorkbench: () => ({ start: async () => undefined, dispose: vi.fn() }) as never,
      createComponent: (_tui, _theme, _workbench, done) => { complete = done; return { requestClose: vi.fn(), render: () => [], invalidate: vi.fn(), focused: false } as never; },
      signalSource: { on: vi.fn(), off: vi.fn() },
    });
    await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
    complete({ status: "discuss", changedPaths: [], target: { path: "file.ts", range: { startLine: 1, endLine: 1 }, anchor: { algorithm: "sha256", value: "0".repeat(64) } } });
    await expect(promise).rejects.toThrow("cannot complete a DISCUSS");
  });

  it("starts, waits for completion, cancels/disposes, drains input, then stops", async () => {
    const events: string[] = [];
    let complete!: (result: { status: "closed"; changedPaths: readonly string[] }) => void;
    const terminal = { drainInput: vi.fn(async () => { events.push("drain"); }) };
    const tui = {
      addChild: vi.fn(() => events.push("add")),
      setFocus: vi.fn(() => events.push("focus")),
      start: vi.fn(() => events.push("tui:start")),
      stop: vi.fn(() => events.push("tui:stop")),
      requestRender: vi.fn(),
    };
    const workbench = {
      start: vi.fn(async () => { events.push("app:start"); }),
      dispose: vi.fn(() => events.push("dispose")),
    };
    const component = { requestClose: vi.fn(), render: () => [], invalidate: vi.fn(), focused: false };
    const resultPromise = runStandaloneWorkbench({ cwd: "/repo" }, {
      createTerminal: () => terminal as never,
      createTui: () => tui as never,
      createRepository: async () => ({}) as never,
      createWorkbench: () => workbench as never,
      createComponent: (_tui, _theme, _workbench, done) => { complete = done; return component as never; },
      signalSource: { on: vi.fn(), off: vi.fn() },
    });
    await vi.waitFor(() => expect(tui.start).toHaveBeenCalledOnce());
    complete({ status: "closed", changedPaths: ["src/file.ts"] });

    await expect(resultPromise).resolves.toEqual({ status: "closed", changedPaths: ["src/file.ts"] });
    expect(events).toEqual(["app:start", "add", "focus", "tui:start", "dispose", "drain", "tui:stop"]);
  });

  it("routes SIGINT and SIGTERM through the component's safe close request", async () => {
    const listeners = new Map<string, () => void>();
    let complete!: (result: { status: "closed"; changedPaths: readonly string[] }) => void;
    const tui = { addChild: vi.fn(), setFocus: vi.fn(), start: vi.fn(), stop: vi.fn() };
    const component = { requestClose: vi.fn(), render: () => [], invalidate: vi.fn(), focused: false };
    const promise = runStandaloneWorkbench({ cwd: "/repo" }, {
      createTerminal: () => ({ drainInput: async () => undefined }) as never,
      createTui: () => tui as never,
      createRepository: async () => ({}) as never,
      createWorkbench: () => ({ start: async () => undefined, dispose: vi.fn() }) as never,
      createComponent: (_tui, _theme, _workbench, done) => { complete = done; return component as never; },
      signalSource: {
        on: vi.fn((signal: string, listener: () => void) => listeners.set(signal, listener)),
        off: vi.fn((signal: string) => listeners.delete(signal)),
      },
    });
    await vi.waitFor(() => expect(tui.start).toHaveBeenCalledOnce());
    expect(listeners.size).toBe(2);
    listeners.get("SIGINT")?.();
    listeners.get("SIGTERM")?.();
    expect(component.requestClose).toHaveBeenCalledTimes(2);
    complete({ status: "closed", changedPaths: [] });
    await promise;
    expect(listeners.size).toBe(0);
  });

  it("aborts repository listing when a signal arrives before UI mount", async () => {
    const listeners = new Map<string, () => void>();
    const tui = { addChild: vi.fn(), setFocus: vi.fn(), start: vi.fn(), stop: vi.fn() };
    const component = { requestClose: vi.fn(), render: () => [], invalidate: vi.fn(), focused: false };
    let startupSignal: AbortSignal | undefined;
    const workbench = {
      start: vi.fn((signal?: AbortSignal) => {
        startupSignal = signal;
        return new Promise<void>((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
      }),
      dispose: vi.fn(),
    };
    const promise = runStandaloneWorkbench({ cwd: "/repo" }, {
      createTerminal: () => ({ drainInput: vi.fn() }) as never,
      createTui: () => tui as never,
      createRepository: async () => ({}) as never,
      createWorkbench: () => workbench as never,
      createComponent: () => component as never,
      signalSource: {
        on: vi.fn((signal: string, listener: () => void) => listeners.set(signal, listener)),
        off: vi.fn((signal: string) => listeners.delete(signal)),
      },
    });
    await vi.waitFor(() => expect(workbench.start).toHaveBeenCalledOnce());

    listeners.get("SIGTERM")?.();

    await expect(promise).rejects.toThrow("SIGTERM");
    expect(startupSignal?.aborted).toBe(true);
    expect(component.requestClose).not.toHaveBeenCalled();
    expect(tui.addChild).not.toHaveBeenCalled();
    expect(tui.start).not.toHaveBeenCalled();
    expect(workbench.dispose).toHaveBeenCalledOnce();
    expect(listeners.size).toBe(0);
  });
});
