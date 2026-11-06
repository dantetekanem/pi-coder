import { describe, expect, it } from "vitest";
import { parseCliSettings } from "../cli/settings.js";

const path = "/agent/pi-coder-settings.json";

describe("parseCliSettings", () => {
  it("returns empty sections when absent", () => {
    expect(parseCliSettings({}, path)).toEqual({ models: {}, terminal: {}, path });
  });

  it("accepts valid models and terminal commands", () => {
    const parsed = parseCliSettings(
      { models: { default: { command: ["claude", "-p"] }, story: { command: ["pi", "{model}"] } }, terminal: { command: ["wezterm", "cli"] } },
      path,
    );
    expect(parsed.models.default?.command).toEqual(["claude", "-p"]);
    expect(parsed.terminal.command).toEqual(["wezterm", "cli"]);
  });

  it.each([
    [{ models: [] }, /models must be an object in \/agent/],
    [{ models: { grammer: { command: ["x"] } } }, /unknown key "grammer"/],
    [{ models: { story: { command: [] } } }, /models\.story\.command must be a non-empty array/],
    [{ models: { story: { command: ["", "-p"] } } }, /models\.story\.command\[0\] must be a non-empty string/],
    [{ models: { story: { command: ["ok", 1] } } }, /models\.story\.command\[1\] must be a string/],
    [{ models: { story: { command: "claude -p" } } }, /non-empty array of strings/],
    [{ models: { story: { cmd: ["x"], command: ["x"] } } }, /models\.story has an unknown key "cmd"/],
    [{ models: { story: "claude" } }, /models\.story must be an object/],
    [{ terminal: { command: [1] } }, /terminal\.command\[0\]/],
    [{ terminal: { cmd: [] } }, /terminal has an unknown key "cmd"/],
    [{ terminal: "tmux" }, /terminal must be an object/],
  ])("rejects %j", (raw, message) => {
    expect(() => parseCliSettings(raw, path)).toThrow(message);
  });

  it("keeps empty arguments after the executable, such as claude --tools \"\"", () => {
    expect(parseCliSettings({ models: { grammar: { command: ["claude", "-p", "--tools", ""] } } }, path).models.grammar?.command).toEqual(["claude", "-p", "--tools", ""]);
  });
});
