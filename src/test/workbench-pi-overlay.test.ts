import { beforeEach, describe, expect, it, vi } from "vitest";
import { runPiWorkbench } from "../adapters/pi/index.js";
import { runReviewApp } from "../ui/review-app.js";

const mocks = vi.hoisted(() => ({
  createNodeWorkspace: vi.fn(),
  forWorkspace: vi.fn(),
}));

vi.mock("../workbench/node/workspace.js", () => ({
  createNodeWorkspace: mocks.createNodeWorkspace,
}));

vi.mock("../workbench/explorer-state.js", () => ({
  EXPLORER_STATE_VERSION: 2,
  processExplorerStateStore: { forWorkspace: mocks.forWorkspace },
}));

const fullScreenOptions = {
  overlay: true,
  overlayOptions: {
    anchor: "center",
    width: "100%",
    maxHeight: "100%",
    minWidth: 40,
    margin: { top: 1, right: 0, bottom: 1, left: 0 },
  },
};

describe("Pi full-screen workbench presentation", () => {
  beforeEach(() => {
    mocks.createNodeWorkspace.mockReset();
    mocks.forWorkspace.mockReset();
    mocks.forWorkspace.mockReturnValue({ load: vi.fn(() => undefined), save: vi.fn() });
    mocks.createNodeWorkspace.mockResolvedValue({
      workspaceKey: "/canonical/repo",
      listFiles: async () => "",
      readText: async () => ({ text: "", revision: "unused" }),
      saveText: async () => ({ status: "error", message: "unused" }),
      maxReadBytes: 1,
    });
  });

  it("mounts /code with the same full-screen overlay options as /diff", async () => {
    const workbenchCustom = vi.fn(async () => ({ status: "closed" as const, changedPaths: [] }));
    await expect(runPiWorkbench({
      hasUI: true,
      cwd: "/repo",
      ui: { custom: workbenchCustom, notify: vi.fn() },
    } as never, { cwd: "/repo", launch: {} })).resolves.toEqual({ status: "closed", changedPaths: [] });

    const reviewCustom = vi.fn(async () => ({ type: "cancel" as const }));
    await runReviewApp({ ui: { custom: reviewCustom } } as never, {} as never);

    expect(workbenchCustom).toHaveBeenCalledWith(expect.any(Function), fullScreenOptions);
    expect(mocks.forWorkspace).toHaveBeenCalledExactlyOnceWith("/canonical/repo");
    expect(reviewCustom).toHaveBeenCalledWith(expect.any(Function), fullScreenOptions);
  });

  it("injects Pi's clipboard writer without coupling the shared component to Pi", async () => {
    const copyText = vi.fn(async (_text: string) => undefined);
    let injectedClipboard: { writeText(text: string): Promise<void> } | undefined;
    const createComponent = vi.fn((...args: unknown[]) => {
      injectedClipboard = args[6] as typeof injectedClipboard;
      return { render: () => [], invalidate: vi.fn() };
    });
    await runPiWorkbench({
      hasUI: true,
      cwd: "/repo",
      ui: { custom: vi.fn(async (factory: (...args: never[]) => unknown) => { factory({} as never, {} as never, {} as never, vi.fn() as never); return { status: "closed", changedPaths: [] }; }) },
    } as never, { cwd: "/repo", launch: {} }, {
      createRepository: async () => ({ workspaceKey: "/repo" }) as never,
      createWorkbench: () => ({ start: vi.fn(), dispose: vi.fn() }) as never,
      explorerStateForWorkspace: () => undefined,
      createComponent: createComponent as never,
      copyText,
    });

    expect(injectedClipboard).toBeDefined();
    await injectedClipboard!.writeText("selected source");
    expect(copyText).toHaveBeenCalledExactlyOnceWith("selected source");
  });

  it("opens the exact initial target quietly after start and before overlay mount", async () => {
    const events: string[] = [];
    const target = { path: "src/app.ts", range: { startLine: 3, endLine: 3 } };
    const notify = vi.fn(() => events.push("notify"));
    await runPiWorkbench({
      hasUI: true,
      cwd: "/repo",
      ui: { custom: vi.fn(async () => { events.push("overlay"); return { status: "closed", changedPaths: [] }; }), notify },
    } as never, { cwd: "/repo", launch: { initialTarget: target } }, {
      createRepository: async () => ({ workspaceKey: "/repo" }) as never,
      createWorkbench: () => ({
        start: vi.fn(async () => events.push("start")),
        openTarget: vi.fn(async () => { events.push("target"); return { status: "opened", path: target.path, range: target.range, stale: false }; }),
        dispose: vi.fn(),
      }) as never,
      explorerStateForWorkspace: () => undefined,
      createComponent: vi.fn(() => ({ render: () => [], invalidate: vi.fn() })) as never,
    });

    expect(events).toEqual(["start", "target", "overlay"]);
    expect(notify).not.toHaveBeenCalled();
  });

  it.each([
    { status: "opened" as const, level: "warning" as const, path: "src/app.ts", range: { startLine: 3, endLine: 4 }, message: "Target range was clamped to the current file." },
    { status: "missing" as const, level: "warning" as const, path: "src/missing.ts", message: "Target file is not available in this repository." },
    { status: "unreadable" as const, level: "error" as const, path: "src/unreadable.ts", message: "Permission denied." },
  ])("reports a $status initial target without blocking overlay mount", async (result) => {
    const events: string[] = [];
    const notify = vi.fn((message: string, level: string) => events.push(`notify:${message}:${level}`));
    const target = { path: result.path, range: { startLine: 3, endLine: 3 } };
    await runPiWorkbench({
      hasUI: true,
      cwd: "/repo",
      ui: { custom: vi.fn(async () => { events.push("overlay"); return { status: "closed", changedPaths: [] }; }), notify },
    } as never, { cwd: "/repo", launch: { initialTarget: target } }, {
      createRepository: async () => ({ workspaceKey: "/repo" }) as never,
      createWorkbench: () => ({
        start: vi.fn(async () => events.push("start")),
        openTarget: vi.fn(async () => { events.push("target"); return result; }),
        dispose: vi.fn(),
      }) as never,
      explorerStateForWorkspace: () => undefined,
      createComponent: vi.fn(() => ({ render: () => [], invalidate: vi.fn() })) as never,
    });

    expect(events[0]).toBe("start");
    expect(events[1]).toBe("target");
    expect(events[2]).toMatch(/^notify:/);
    expect(events[3]).toBe("overlay");
    expect(notify).toHaveBeenCalledWith(expect.stringContaining(result.path), result.level);
    expect(notify.mock.calls[0]?.[0]).toContain(result.message);
    expect(notify.mock.calls[0]?.[0]).not.toContain("source bytes");
  });

  it("sanitizes and bounds malicious startup notices to one safe line", async () => {
    const path = `src/visible location ${"\r\n\t\u001b\u0000\u001f\u0085"}${"界".repeat(400)}.ts`;
    const message = `visible reason ${"\r\n\t\u001b\u0000\u001f\u0085"}${"界".repeat(400)}`;
    const notify = vi.fn();
    await runPiWorkbench({
      hasUI: true,
      cwd: "/repo",
      ui: { custom: vi.fn(async () => ({ status: "closed", changedPaths: [] })), notify },
    } as never, { cwd: "/repo", launch: { initialTarget: { path, range: { startLine: 3, endLine: 3 } } } }, {
      createRepository: async () => ({ workspaceKey: "/repo" }) as never,
      createWorkbench: () => ({
        start: vi.fn(async () => undefined),
        openTarget: vi.fn(async () => ({ status: "missing" as const, path, message })),
        dispose: vi.fn(),
      }) as never,
      explorerStateForWorkspace: () => undefined,
      createComponent: vi.fn(() => ({ render: () => [], invalidate: vi.fn() })) as never,
    });

    const notice = notify.mock.calls[0]?.[0] as string;
    expect(notice).toContain("src/visible location");
    expect(notice).toContain("visible reason");
    expect(notice).toMatch(/…/);
    expect(notice).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(Buffer.byteLength(notice, "utf8")).toBeLessThanOrEqual(512);
  });

  it("returns only after overlay and owned workbench cleanup", async () => {
    const events: string[] = [];
    const workbench = {
      start: vi.fn(async () => events.push("start")),
      openTarget: vi.fn(),
      dispose: vi.fn(() => events.push("dispose")),
    };
    const outcome = await runPiWorkbench({
      hasUI: true,
      cwd: "/repo",
      ui: { custom: vi.fn(async () => { events.push("overlay-closed"); return { status: "closed", changedPaths: [] }; }) },
    } as never, { cwd: "/repo", launch: {} }, {
      createRepository: async () => ({ workspaceKey: "/repo" }) as never,
      createWorkbench: () => workbench as never,
      explorerStateForWorkspace: () => ({ load: vi.fn(), save: vi.fn() }),
      createComponent: vi.fn(() => ({ render: () => [], invalidate: vi.fn() })) as never,
    });

    expect(outcome).toEqual({ status: "closed", changedPaths: [] });
    expect(events).toEqual(["start", "overlay-closed", "dispose"]);
  });

  it("preserves terminal child failure over cleanup failure", async () => {
    const terminal = { status: "failed" as const, message: "child did not close", code: "CHILD_CLOSURE_UNCONFIRMED" };
    const outcome = await runPiWorkbench({
      hasUI: true,
      cwd: "/repo",
      ui: { custom: vi.fn(async () => terminal) },
    } as never, { cwd: "/repo", launch: {} }, {
      createRepository: async () => ({ workspaceKey: "/repo" }) as never,
      createWorkbench: () => ({ start: vi.fn(), dispose: vi.fn(() => { throw new Error("cleanup"); }) }) as never,
      explorerStateForWorkspace: () => ({ load: vi.fn(), save: vi.fn() }),
      createComponent: vi.fn(() => ({ render: () => [], invalidate: vi.fn() })) as never,
    });

    expect(outcome).toEqual(terminal);
  });
});
