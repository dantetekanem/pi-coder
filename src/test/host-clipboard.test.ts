import { describe, expect, it, vi } from "vitest";
import { clipboardTools, copyWithEnvironment, type ClipboardEnvironment, type ClipboardTool } from "../host/clipboard.js";

function environment(overrides: Partial<ClipboardEnvironment> = {}): ClipboardEnvironment & { written: string[]; tried: string[] } {
  const written: string[] = [];
  const tried: string[] = [];
  return {
    platform: "linux",
    env: {},
    isTerminal: true,
    runTool: async (tool: ClipboardTool) => {
      tried.push(tool.command);
      return false;
    },
    writeTerminal: (sequence) => void written.push(sequence),
    ...overrides,
    written,
    tried,
  };
}

describe("clipboardTools", () => {
  it("uses the platform clipboard command on macOS and Windows", () => {
    expect(clipboardTools("darwin", {})).toEqual([{ command: "pbcopy", args: [] }]);
    expect(clipboardTools("win32", {})).toEqual([{ command: "clip", args: [] }]);
  });

  it("chooses Linux tools from the display environment", () => {
    expect(clipboardTools("linux", {})).toEqual([]);
    expect(clipboardTools("linux", { WAYLAND_DISPLAY: "wayland-0" }).map((tool) => tool.command)).toEqual(["wl-copy"]);
    expect(clipboardTools("linux", { DISPLAY: ":0" })).toEqual([
      { command: "xclip", args: ["-selection", "clipboard"] },
      { command: "xsel", args: ["--clipboard", "--input"] },
    ]);
    expect(clipboardTools("linux", { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" }).map((tool) => tool.command)).toEqual(["wl-copy", "xclip", "xsel"]);
    expect(clipboardTools("linux", { TERMUX_VERSION: "0.118", DISPLAY: ":0" })[0]!.command).toBe("termux-clipboard-set");
  });
});

describe("copyWithEnvironment", () => {
  it("stops at the first tool that copies", async () => {
    const host = environment({ platform: "linux", env: { WAYLAND_DISPLAY: "w", DISPLAY: ":0" }, runTool: vi.fn(async (tool: ClipboardTool) => tool.command === "xclip") });

    await copyWithEnvironment("selected", host);

    expect(host.runTool).toHaveBeenCalledTimes(2);
    expect(host.runTool).toHaveBeenLastCalledWith({ command: "xclip", args: ["-selection", "clipboard"] }, "selected");
    expect(host.written).toEqual([]);
  });

  it("writes an OSC 52 sequence when no tool works", async () => {
    const host = environment({ env: { DISPLAY: ":0" } });

    await copyWithEnvironment("héllo", host);

    expect(host.tried).toEqual(["xclip", "xsel"]);
    expect(host.written).toEqual([`\x1b]52;c;${Buffer.from("héllo").toString("base64")}\x07`]);
  });

  it("uses the terminal clipboard first in a remote session", async () => {
    const host = environment({ platform: "darwin", env: { SSH_CONNECTION: "10.0.0.1 22 10.0.0.2 22" } });

    await copyWithEnvironment("remote", host);

    expect(host.written).toHaveLength(1);
    expect(host.tried).toEqual([]);
  });

  it("falls back to the tools in a remote session when the payload is too large", async () => {
    const host = environment({ platform: "darwin", env: { SSH_CLIENT: "10.0.0.1 1 22" }, runTool: vi.fn(async () => true) });

    await copyWithEnvironment("x".repeat(80_000), host);

    expect(host.written).toEqual([]);
    expect(host.runTool).toHaveBeenCalledOnce();
  });

  it("fails when nothing can copy", async () => {
    await expect(copyWithEnvironment("text", environment({ isTerminal: false }))).rejects.toThrow("Failed to copy to clipboard");
    await expect(copyWithEnvironment("x".repeat(80_000), environment())).rejects.toThrow("Failed to copy to clipboard");
  });

  it("does not write terminal sequences when output is not a terminal", async () => {
    const host = environment({ isTerminal: false, env: { SSH_CONNECTION: "1 2 3 4" } });

    await expect(copyWithEnvironment("text", host)).rejects.toThrow("Failed to copy to clipboard");

    expect(host.written).toEqual([]);
  });
});
