import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createHostTheme, DARK_THEME, detectColorMode, loadTheme, parsePiThemeFile, rgbTo256 } from "../cli/theme.js";

function agentDir(settings?: unknown, themes: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-coder-theme-"));
  if (settings !== undefined) writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
  mkdirSync(join(dir, "themes"));
  for (const [name, theme] of Object.entries(themes)) writeFileSync(join(dir, "themes", `${name}.json`), JSON.stringify(theme));
  return dir;
}

describe("detectColorMode", () => {
  it("picks truecolor, 256, or none", () => {
    expect(detectColorMode({ COLORTERM: "truecolor" }, true)).toBe("truecolor");
    expect(detectColorMode({ COLORTERM: "24bit" }, true)).toBe("truecolor");
    expect(detectColorMode({}, true)).toBe("256");
    expect(detectColorMode({ NO_COLOR: "1", COLORTERM: "truecolor" }, true)).toBe("none");
    expect(detectColorMode({}, false)).toBe("none");
  });
});

describe("createHostTheme", () => {
  it("emits truecolor, 256-color, and plain output", () => {
    expect(createHostTheme(DARK_THEME, "truecolor").fg("accent", "x")).toBe("\u001b[38;2;138;190;183mx\u001b[39m");
    expect(createHostTheme(DARK_THEME, "truecolor").bg("selectedBg", "x")).toBe("\u001b[48;2;58;58;74mx\u001b[49m");
    expect(createHostTheme(DARK_THEME, "256").fg("accent", "x")).toMatch(/^\u001b\[38;5;\d+mx\u001b\[39m$/);
    const plain = createHostTheme(DARK_THEME, "none");
    expect(plain.fg("accent", "x")).toBe("x");
    expect(plain.bg("selectedBg", "x")).toBe("x");
    expect(plain.getFgAnsi?.("accent")).toBe("");
    expect(plain.bold("x")).toBe("\u001b[1mx\u001b[22m");
    expect(plain.inverse("x")).toBe("\u001b[7mx\u001b[27m");
  });

  it("exposes ANSI openers", () => {
    const theme = createHostTheme(DARK_THEME, "truecolor");
    expect(theme.getFgAnsi?.("error")).toBe("\u001b[38;2;204;102;102m");
  });

  it("maps rgb to the 256 palette", () => {
    expect(rgbTo256([0, 0, 0])).toBe(16);
    expect(rgbTo256([255, 255, 255])).toBe(231);
    expect(rgbTo256([128, 128, 128])).toBeGreaterThanOrEqual(232);
  });

  it("handles numeric, default, and variable colors and fills gaps from the dark theme", () => {
    const file = parsePiThemeFile({ vars: { base: "#102030", alias: "base" }, colors: { accent: "alias", error: 196, muted: "" } }, "t");
    const theme = createHostTheme(file, "truecolor");
    expect(theme.getFgAnsi?.("accent")).toBe("\u001b[38;2;16;32;48m");
    expect(theme.getFgAnsi?.("error")).toBe("\u001b[38;5;196m");
    expect(theme.getFgAnsi?.("muted")).toBe("\u001b[39m");
    expect(theme.getFgAnsi?.("success")).toBe("\u001b[38;2;181;189;104m");
  });

  it("rejects broken themes", () => {
    expect(() => createHostTheme(parsePiThemeFile({ colors: { accent: "nope" } }, "t"), "256")).toThrow(/unknown variable "nope"/);
    expect(() => createHostTheme(parsePiThemeFile({ vars: { a: "b", b: "a" }, colors: { accent: "a" } }, "t"), "256")).toThrow(/circular/);
    expect(() => parsePiThemeFile({ colors: { accent: 300 } }, "t")).toThrow(/0 to 255/);
    expect(() => parsePiThemeFile([], "t")).toThrow(/JSON object/);
  });
});

describe("loadTheme", () => {
  const env = { COLORTERM: "truecolor" };

  it("uses the dark theme without settings", () => {
    const loaded = loadTheme({ agentDir: agentDir(), env, isTTY: true });
    expect(loaded).toMatchObject({ name: "dark", mode: "truecolor" });
    expect(loaded.warning).toBeUndefined();
  });

  it("loads the Pi theme named in settings.json", () => {
    const dir = agentDir({ theme: "mine" }, { mine: { name: "mine", vars: { p: "#bd93f9" }, colors: { accent: "p" } } });
    const loaded = loadTheme({ agentDir: dir, env, isTTY: true });
    expect(loaded.name).toBe("mine");
    expect(loaded.theme.getFgAnsi?.("accent")).toBe("\u001b[38;2;189;147;249m");
  });

  it("warns and falls back for a missing or broken theme", () => {
    const missing = loadTheme({ agentDir: agentDir({ theme: "ghost" }), env, isTTY: true });
    expect(missing).toMatchObject({ name: "dark", warning: expect.stringContaining('Theme "ghost" was not found') });
    const broken = loadTheme({ agentDir: agentDir({ theme: "bad" }, { bad: { colors: { accent: "zzz" } } }), env, isTTY: true });
    expect(broken.warning).toContain('Could not load theme "bad"');
    const traversal = loadTheme({ agentDir: agentDir({ theme: "../x" }), env, isTTY: true });
    expect(traversal.warning).toContain("not a valid theme name");
  });

  it("goes plain with NO_COLOR", () => {
    const dir = agentDir();
    expect(loadTheme({ agentDir: dir, env: { NO_COLOR: "1" }, isTTY: true }).theme.fg("accent", "x")).toBe("x");
  });

  it("ignores an unreadable settings.json", () => {
    const dir = agentDir();
    writeFileSync(join(dir, "settings.json"), "{not json");
    expect(loadTheme({ agentDir: dir, env, isTTY: true }).name).toBe("dark");
  });
});
