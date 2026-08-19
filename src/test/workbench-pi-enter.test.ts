import { describe, expect, it, vi } from "vitest";
import { Key, isKittyProtocolActive, matchesKey, setKittyProtocolActive } from "@earendil-works/pi-tui";
import { createWorkbenchComponent } from "../workbench/ui/component.js";
import { runPiWorkbench } from "../adapters/pi/index.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  searchMatch: (text: string) => text,
};

const enterPayloads = [
  "\r",
  "\n",
  "\x1b[13;1u",
  "\x1b[57414;1u",
  "\x1bOM",
  "\r\n",
  "pi-host-enter",
];

describe("Pi /code Enter boundary", () => {
  it("uses the mounted Pi component instance for Enter variants and keeps INSERT edits", async () => {
    setKittyProtocolActive(true);
    expect(isKittyProtocolActive()).toBe(true);
    expect(matchesKey("\n", Key.enter)).toBe(false);
    let mounted: ReturnType<typeof createWorkbenchComponent> | undefined;
    let bufferText = "one";
    let selectedLine = 1;
    const tree = {
      rows: () => [{ type: "file" as const, key: "file:one.ts", path: "one.ts", name: "one.ts", depth: 0 }],
      searchFiles: () => [],
    };
    const workbench = {
      repositoryTree: tree,
      get bufferText() { return bufferText; },
      get selectedLine() { return selectedLine; },
      selectedPath: "one.ts",
      selectedRange: null,
      highlightedLines: ["one"],
      isDirty: false,
      selectFile: vi.fn(async () => ({ status: "opened" as const, path: "one.ts", line: 1 })),
      setSelectedLine: vi.fn((line: number) => { selectedLine = line; }),
      replaceBuffer: vi.fn((text: string) => { bufferText = text; }),
      requestExit: vi.fn(() => ({ status: "closed" as const, changedPaths: [] })),
      start: vi.fn(async () => undefined),
      dispose: vi.fn(),
    };
    const tui = { terminal: { rows: 24 }, requestRender: vi.fn() };
    const createComponent = vi.fn(createWorkbenchComponent);
    const done = vi.fn();
    const keybindings = {
      matches: (data: string, keybinding: string) => {
        if (keybinding === "tui.input.newLine") return data === "\n";
        if (keybinding === "tui.input.submit") return data !== "\r\n" && data !== "\n\r" && enterPayloads.includes(data);
        return false;
      },
    };

    try {
      const outcome = await runPiWorkbench({
        hasUI: true,
        cwd: "/repo",
        ui: {
          custom: vi.fn(async (factory: any) => {
            mounted = factory(tui, theme, keybindings, done);
            mounted!.focused = true;

            // Open the source through the same mounted component boundary.
            mounted!.handleInput("\x1b[13;1u");
            await Promise.resolve();
            await Promise.resolve();
            // NORMAL Enter enters INSERT, then every accepted payload inserts one EOL.
            mounted!.handleInput("\x1b[13;1u");
            expect(mounted!.render(100).join("\n")).toContain("INSERT");
            for (const payload of enterPayloads) mounted!.handleInput(payload);
            expect(bufferText).toBe(`one${"\n".repeat(enterPayloads.length)}`);
            expect(mounted!.render(100).join("\n")).toContain("INSERT");

            // The two-step INSERT→NORMAL→Explorer escape hierarchy never closes /code.
            mounted!.handleInput("\x1b");
            expect(mounted!.render(100).join("\n")).toContain("NORMAL SOURCE");
            mounted!.handleInput("\x1b");
            expect(mounted!.render(100).join("\n")).toContain("▶ EXPLORER");
            expect(done).not.toHaveBeenCalled();

            mounted!.handleInput("\r");
            await Promise.resolve();
            await Promise.resolve();
            expect(mounted!.render(100).join("\n")).toContain("NORMAL SOURCE");
            mounted!.handleInput("\r");
            expect(mounted!.render(100).join("\n")).toContain("INSERT SOURCE");
            mounted!.handleInput("\x1b");
            expect(mounted!.render(100).join("\n")).toContain("NORMAL SOURCE");
            mounted!.handleInput("\x1b");
            expect(mounted!.render(100).join("\n")).toContain("▶ EXPLORER");
            expect(done).not.toHaveBeenCalled();
            return { status: "closed" as const, changedPaths: [] };
          }),
        },
      } as never, { cwd: "/repo", launch: {} }, {
        createRepository: async () => ({ workspaceKey: "/repo" }) as never,
        createWorkbench: () => workbench as never,
        explorerStateForWorkspace: () => undefined,
        createComponent: createComponent as never,
      });
      expect(outcome).toEqual({ status: "closed", changedPaths: [] });
      expect(createComponent).toHaveBeenCalledOnce();
    } finally {
      setKittyProtocolActive(false);
    }

    expect(mounted).toBeDefined();
    expect(workbench.dispose).toHaveBeenCalledOnce();
  });

  it("keeps framed bracketed paste payload chunks opaque and resumes Enter normalization after the end marker", async () => {
    setKittyProtocolActive(true);
    let mounted: ReturnType<typeof createWorkbenchComponent> | undefined;
    let bufferText = "one";
    let selectedLine = 1;
    const tree = {
      rows: () => [{ type: "file" as const, key: "file:one.ts", path: "one.ts", name: "one.ts", depth: 0 }],
      searchFiles: () => [],
    };
    const workbench = {
      repositoryTree: tree,
      get bufferText() { return bufferText; },
      get selectedLine() { return selectedLine; },
      selectedPath: "one.ts",
      selectedRange: null,
      highlightedLines: ["one"],
      isDirty: false,
      selectFile: vi.fn(async () => ({ status: "opened" as const, path: "one.ts", line: 1 })),
      setSelectedLine: vi.fn((line: number) => { selectedLine = line; }),
      replaceBuffer: vi.fn((text: string) => { bufferText = text; }),
      requestExit: vi.fn(() => ({ status: "closed" as const, changedPaths: [] })),
      start: vi.fn(async () => undefined),
      dispose: vi.fn(),
    };
    const tui = { terminal: { rows: 24 }, requestRender: vi.fn() };
    const keybindings = {
      matches: (data: string, keybinding: string) => {
        if (keybinding === "tui.input.newLine") return data === "\n";
        if (keybinding === "tui.input.submit") return data === "\x1b[13;1u";
        return false;
      },
    };

    try {
      const outcome = await runPiWorkbench({
        hasUI: true,
        cwd: "/repo",
        ui: {
          custom: vi.fn(async (factory: any) => {
            mounted = factory(tui, theme, keybindings, vi.fn());
            mounted!.focused = true;
            mounted!.handleInput("\x1b[13;1u");
            await Promise.resolve();
            await Promise.resolve();
            mounted!.handleInput("\x1b[13;1u");
            expect(mounted!.render(100).join("\n")).toContain("INSERT");

            // Keep each framing marker whole while splitting the raw payload across calls.
            // The LF must reach the editor's paste buffer unchanged, rather than as a Kitty
            // new-line escape.
            mounted!.handleInput("\x1b[200~");
            mounted!.handleInput("\n");
            mounted!.handleInput("payload");
            mounted!.handleInput("\x1b[201~");
            expect(bufferText).toBe("one\npayload");
            expect(bufferText).not.toContain("[13;2u");

            // A complete paste and ordinary Enter can share one host chunk.
            mounted!.handleInput("\x1b[200~\n\x1b[201~\n");
            expect(bufferText).toBe("one\npayload\n\n");
            expect(bufferText).not.toContain("[13;2u");
            expect(mounted!.render(100).join("\n")).toContain("INSERT");
            return { status: "closed" as const, changedPaths: [] };
          }),
        },
      } as never, { cwd: "/repo", launch: {} }, {
        createRepository: async () => ({ workspaceKey: "/repo" }) as never,
        createWorkbench: () => workbench as never,
        explorerStateForWorkspace: () => undefined,
        createComponent: createWorkbenchComponent,
      });
      expect(outcome).toEqual({ status: "closed", changedPaths: [] });
    } finally {
      setKittyProtocolActive(false);
    }

    expect(mounted).toBeDefined();
    expect(workbench.dispose).toHaveBeenCalledOnce();
  });
});
