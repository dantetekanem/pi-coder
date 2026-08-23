import { describe, expect, it, vi } from "vitest";
import { CodeHostError } from "../code/hosts.js";
import { createCodeOpener } from "../code/opener.js";
import type { WorkbenchCompletionResult, WorkbenchLaunch } from "../workbench/contracts.js";

const ctx = { hasUI: true } as never;
const launch: WorkbenchLaunch = {
  initialTarget: { path: "src/app.ts", range: { startLine: 4, endLine: 6 } },
  capabilities: { discuss: true },
};
const closed: WorkbenchCompletionResult = { status: "closed", changedPaths: ["src/app.ts"] };
const identityResolution = {
  resolveWorkspace: async (cwd: string) => cwd,
  resolveExecutable: async (executable: string) => executable,
};

function settings(opener: Record<string, unknown>) {
  return { version: 1, code: { version: 1, opener }, providers: {}, repositories: {} } as never;
}

describe("configured code opener", () => {
  it("preserves the Workbench result when Workbench is selected", async () => {
    const runWorkbench = vi.fn(async () => closed);
    const launchHost = vi.fn();
    const openCode = createCodeOpener({
      loadSettings: () => settings({ kind: "workbench" }),
      runWorkbench,
      launchHost,
    });

    await expect(openCode("direct-code", ctx, "/repo", launch)).resolves.toEqual({ backend: "workbench", outcome: closed });
    expect(runWorkbench).toHaveBeenCalledWith(ctx, "/repo", launch);
    expect(launchHost).not.toHaveBeenCalled();
  });

  it("resolves and renders one external target before launching its selected host", async () => {
    const runWorkbench = vi.fn();
    const resolveTarget = vi.fn(async () => ({ file: "/repo/src/app.ts", line: 4, endLine: 6 }));
    const launchHost = vi.fn(async () => ({ status: "completed" as const, paneId: "%4" }));
    const openCode = createCodeOpener({
      loadSettings: () => settings({
        kind: "external",
        executable: "ttt",
        args: ["{cwd}"],
        targetArgs: ["{file}:{line}"],
        host: "auto",
      }),
      runWorkbench,
      resolveTarget,
      launchHost,
      ...identityResolution,
    });

    await expect(openCode("open-code", { hasUI: true, mode: "tui" } as never, "/repo", launch)).resolves.toEqual({
      backend: "external",
      outcome: { status: "closed", changes: "unknown" },
    });
    expect(resolveTarget).toHaveBeenCalledWith({ cwd: "/repo", target: launch.initialTarget });
    expect(launchHost).toHaveBeenCalledWith("auto", {
      cwd: "/repo",
      editor: { executable: "ttt", args: ["/repo", "/repo/src/app.ts:4"] },
    });
    expect(runWorkbench).not.toHaveBeenCalled();
  });

  it("rejects Workbench-only stories before starting an external editor", async () => {
    const launchHost = vi.fn();
    const openCode = createCodeOpener({
      loadSettings: () => settings({ kind: "external", executable: "ttt", args: [], host: "current-terminal" }),
      runWorkbench: vi.fn(),
      launchHost,
      ...identityResolution,
    });

    const outcome = await openCode("open-code", ctx, "/repo", {
      ...launch,
      stories: [{ id: "why", target: launch.initialTarget!, prose: "Explain this." }],
    });
    expect(outcome).toMatchObject({
      backend: "external",
      outcome: { status: "failed", lifecycle: "not-started", message: expect.stringMatching(/stories.*workbench-only/i) },
    });
    expect(launchHost).not.toHaveBeenCalled();
  });

  it.each([
    { name: "legacy RPC", context: { hasUI: false } },
    { name: "current RPC", context: { hasUI: true, mode: "rpc" } },
  ])("rejects external editors in $name before resolving or launching", async ({ context }) => {
    const launchHost = vi.fn();
    const resolveWorkspace = vi.fn(async (cwd: string) => cwd);
    const openCode = createCodeOpener({
      loadSettings: () => settings({ kind: "external", executable: "ttt", args: [], host: "current-terminal" }),
      runWorkbench: vi.fn(),
      launchHost,
      resolveWorkspace,
      resolveExecutable: identityResolution.resolveExecutable,
    });

    await expect(openCode("open-code", context as never, "/repo", launch)).resolves.toMatchObject({
      backend: "external",
      outcome: { status: "failed", lifecycle: "not-started", message: expect.stringMatching(/TUI session/i) },
    });
    expect(resolveWorkspace).not.toHaveBeenCalled();
    expect(launchHost).not.toHaveBeenCalled();
  });

  it.each(["not-started", "closed", "unconfirmed"] as const)("preserves the %s host failure lifecycle", async (lifecycle) => {
    const openCode = createCodeOpener({
      loadSettings: () => settings({ kind: "external", executable: "ttt", args: [], host: "current-terminal" }),
      runWorkbench: vi.fn(),
      launchHost: vi.fn(async () => { throw new CodeHostError("host failed", lifecycle); }),
      ...identityResolution,
    });

    await expect(openCode("review-bridge", ctx, "/repo", { capabilities: { discuss: true } })).resolves.toEqual({
      backend: "external",
      outcome: { status: "failed", message: "host failed", lifecycle },
    });
  });
});
