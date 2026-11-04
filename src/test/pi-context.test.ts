import { describe, expect, it, vi } from "vitest";
import { toHostContext } from "../pi/context.js";

function piContext(overrides: Record<string, unknown> = {}) {
  return {
    cwd: "/repo",
    hasUI: true,
    mode: "tui",
    ui: { notify: vi.fn() },
    model: { provider: "test-provider", id: "test-model" },
    modelRegistry: {},
    isIdle: vi.fn(() => true),
    ...overrides,
  };
}

describe("toHostContext", () => {
  it("reads the Pi context on every access", () => {
    const ctx = piContext();
    const host = toHostContext({ exec: vi.fn() } as never, ctx as never);

    expect(host.cwd).toBe("/repo");
    expect(host.hasUI).toBe(true);
    expect(host.mode).toBe("tui");
    expect(host.ui).toBe(ctx.ui);
    Object.assign(ctx, { cwd: "/other", hasUI: false, mode: "print" });
    expect(host.cwd).toBe("/other");
    expect(host.hasUI).toBe(false);
    expect(host.mode).toBe("print");
  });

  it("delegates idle checks to Pi", () => {
    const ctx = piContext();
    const host = toHostContext({ exec: vi.fn() } as never, ctx as never);

    expect(host.isIdle()).toBe(true);
    ctx.isIdle.mockReturnValue(false);
    expect(host.isIdle()).toBe(false);
  });

  it("creates the model gateway on first use and reuses it", () => {
    const ctx = piContext({ modelRegistry: new Proxy({}, { get() { throw new Error("registry touched"); } }) });
    const host = toHostContext({ exec: vi.fn() } as never, ctx as never);

    expect(host.models).toBe(host.models);
    expect(host.models.label("grammar")).toBe("test-model");
  });

  it("works with the partial contexts used outside a TUI", () => {
    const host = toHostContext({ exec: vi.fn() } as never, { hasUI: false, cwd: "/repo", ui: {} } as never);

    expect(host.hasUI).toBe(false);
    expect(host.mode).toBeUndefined();
    expect(host.models.label("grammar")).toBeUndefined();
  });
});
