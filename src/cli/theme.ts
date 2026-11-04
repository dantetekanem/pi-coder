import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { HostTheme, HostThemeBg, HostThemeColor } from "../host/types.js";

export type ColorMode = "truecolor" | "256" | "none";

export const THEME_FG_COLORS: readonly HostThemeColor[] = [
  "accent", "border", "borderAccent", "borderMuted", "success", "error", "warning", "muted", "dim", "text",
  "thinkingText", "userMessageText", "customMessageText", "customMessageLabel", "toolTitle", "toolOutput",
  "mdHeading", "mdLink", "mdLinkUrl", "mdCode", "mdCodeBlock", "mdCodeBlockBorder", "mdQuote", "mdQuoteBorder",
  "mdHr", "mdListBullet", "toolDiffAdded", "toolDiffRemoved", "toolDiffContext", "syntaxComment", "syntaxKeyword",
  "syntaxFunction", "syntaxVariable", "syntaxString", "syntaxNumber", "syntaxType", "syntaxOperator",
  "syntaxPunctuation", "thinkingOff", "thinkingMinimal", "thinkingLow", "thinkingMedium", "thinkingHigh",
  "thinkingXhigh", "bashMode",
];

export const THEME_BG_COLORS: readonly HostThemeBg[] = [
  "selectedBg", "userMessageBg", "customMessageBg", "toolPendingBg", "toolSuccessBg", "toolErrorBg",
];

export type ThemeColorValue = string | number;

export interface PiThemeFile {
  name?: string;
  vars?: Record<string, ThemeColorValue>;
  colors: Record<string, ThemeColorValue>;
}

export const DARK_THEME: PiThemeFile = {
  name: "dark",
  vars: {
    cyan: "#00d7ff",
    blue: "#5f87ff",
    green: "#b5bd68",
    red: "#cc6666",
    yellow: "#ffff00",
    text: "#d4d4d4",
    gray: "#808080",
    dimGray: "#666666",
    darkGray: "#505050",
    accent: "#8abeb7",
    selectedBg: "#3a3a4a",
    userMsgBg: "#343541",
    toolPendingBg: "#282832",
    toolSuccessBg: "#283228",
    toolErrorBg: "#3c2828",
    customMsgBg: "#2d2838",
  },
  colors: {
    accent: "accent",
    border: "blue",
    borderAccent: "cyan",
    borderMuted: "darkGray",
    success: "green",
    error: "red",
    warning: "yellow",
    muted: "gray",
    dim: "dimGray",
    text: "text",
    thinkingText: "gray",
    selectedBg: "selectedBg",
    userMessageBg: "userMsgBg",
    userMessageText: "text",
    customMessageBg: "customMsgBg",
    customMessageText: "text",
    customMessageLabel: "#9575cd",
    toolPendingBg: "toolPendingBg",
    toolSuccessBg: "toolSuccessBg",
    toolErrorBg: "toolErrorBg",
    toolTitle: "text",
    toolOutput: "gray",
    mdHeading: "#f0c674",
    mdLink: "#81a2be",
    mdLinkUrl: "dimGray",
    mdCode: "accent",
    mdCodeBlock: "green",
    mdCodeBlockBorder: "gray",
    mdQuote: "gray",
    mdQuoteBorder: "gray",
    mdHr: "gray",
    mdListBullet: "accent",
    toolDiffAdded: "green",
    toolDiffRemoved: "red",
    toolDiffContext: "gray",
    syntaxComment: "#6A9955",
    syntaxKeyword: "#569CD6",
    syntaxFunction: "#DCDCAA",
    syntaxVariable: "#9CDCFE",
    syntaxString: "#CE9178",
    syntaxNumber: "#B5CEA8",
    syntaxType: "#4EC9B0",
    syntaxOperator: "#D4D4D4",
    syntaxPunctuation: "#D4D4D4",
    thinkingOff: "darkGray",
    thinkingMinimal: "#6e6e6e",
    thinkingLow: "#5f87af",
    thinkingMedium: "#81a2be",
    thinkingHigh: "#b294bb",
    thinkingXhigh: "#d183e8",
    bashMode: "green",
  },
};

type Rgb = readonly [number, number, number];
type ResolvedColor = Rgb | number | "";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isColorValue(value: unknown): value is ThemeColorValue {
  return typeof value === "string" || (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255);
}

export function parsePiThemeFile(value: unknown, label: string): PiThemeFile {
  if (!isRecord(value)) throw new Error(`${label} must be a JSON object.`);
  if (!isRecord(value.colors)) throw new Error(`${label} must have a "colors" object.`);
  const vars = value.vars ?? {};
  if (!isRecord(vars)) throw new Error(`${label} "vars" must be an object.`);
  for (const [key, entry] of Object.entries(vars)) {
    if (!isColorValue(entry)) throw new Error(`${label} var "${key}" must be a color string or a number from 0 to 255.`);
  }
  for (const [key, entry] of Object.entries(value.colors)) {
    if (!isColorValue(entry)) throw new Error(`${label} color "${key}" must be a color string or a number from 0 to 255.`);
  }
  return {
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    vars: vars as Record<string, ThemeColorValue>,
    colors: value.colors as Record<string, ThemeColorValue>,
  };
}

function parseHex(value: string): Rgb | undefined {
  const match = /^#([0-9a-f]{6})$/i.exec(value);
  if (!match) return undefined;
  const hex = match[1]!;
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
}

function resolveValue(value: ThemeColorValue, vars: Record<string, ThemeColorValue>, label: string, seen: Set<string>): ResolvedColor {
  if (typeof value === "number") return value;
  if (value === "") return "";
  const rgb = parseHex(value);
  if (rgb) return rgb;
  if (value.startsWith("#")) throw new Error(`${label} has an invalid hex color "${value}".`);
  if (seen.has(value)) throw new Error(`${label} has a circular variable reference "${value}".`);
  const next = vars[value];
  if (next === undefined) throw new Error(`${label} references the unknown variable "${value}".`);
  return resolveValue(next, vars, label, new Set([...seen, value]));
}

export function resolvePiTheme(file: PiThemeFile, label: string): Map<string, ResolvedColor> {
  const merged = new Map<string, ResolvedColor>();
  const darkVars = DARK_THEME.vars ?? {};
  for (const [key, value] of Object.entries(DARK_THEME.colors)) {
    merged.set(key, resolveValue(value, darkVars, `${label} (built-in ${key})`, new Set()));
  }
  const vars = file.vars ?? {};
  for (const [key, value] of Object.entries(file.colors)) {
    merged.set(key, resolveValue(value, vars, `${label} color "${key}"`, new Set()));
  }
  return merged;
}

const CUBE_LEVELS = [0, 95, 135, 175, 215, 255] as const;

function nearestCubeIndex(channel: number): number {
  let best = 0;
  for (let index = 1; index < CUBE_LEVELS.length; index += 1) {
    if (Math.abs(CUBE_LEVELS[index]! - channel) < Math.abs(CUBE_LEVELS[best]! - channel)) best = index;
  }
  return best;
}

function distance(a: Rgb, b: Rgb): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
}

export function rgbTo256(rgb: Rgb): number {
  const indexes = rgb.map(nearestCubeIndex) as [number, number, number];
  const cubeRgb: Rgb = [CUBE_LEVELS[indexes[0]]!, CUBE_LEVELS[indexes[1]]!, CUBE_LEVELS[indexes[2]]!];
  const cubeIndex = 16 + 36 * indexes[0] + 6 * indexes[1] + indexes[2];
  const average = Math.round((rgb[0] + rgb[1] + rgb[2]) / 3);
  const grayStep = Math.min(23, Math.max(0, Math.round((average - 8) / 10)));
  const grayLevel = 8 + grayStep * 10;
  const grayDistance = distance(rgb, [grayLevel, grayLevel, grayLevel]);
  return grayDistance < distance(rgb, cubeRgb) ? 232 + grayStep : cubeIndex;
}

function ansiFor(color: ResolvedColor, mode: ColorMode, foreground: boolean): string {
  if (mode === "none") return "";
  const reset = foreground ? "\u001b[39m" : "\u001b[49m";
  if (color === "") return reset;
  const base = foreground ? 38 : 48;
  if (typeof color === "number") return `\u001b[${base};5;${color}m`;
  if (mode === "truecolor") return `\u001b[${base};2;${color[0]};${color[1]};${color[2]}m`;
  return `\u001b[${base};5;${rgbTo256(color)}m`;
}

export function detectColorMode(env: Readonly<Record<string, string | undefined>>, isTTY: boolean): ColorMode {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return "none";
  if (!isTTY && env.FORCE_COLOR === undefined) return "none";
  const colorTerm = env.COLORTERM?.toLowerCase();
  return colorTerm === "truecolor" || colorTerm === "24bit" ? "truecolor" : "256";
}

export function createHostTheme(file: PiThemeFile, mode: ColorMode, label = "Theme"): HostTheme {
  const resolved = resolvePiTheme(file, label);
  const fgOpen = new Map<HostThemeColor, string>();
  const bgOpen = new Map<HostThemeBg, string>();
  for (const key of THEME_FG_COLORS) fgOpen.set(key, ansiFor(resolved.get(key) ?? "", mode, true));
  for (const key of THEME_BG_COLORS) bgOpen.set(key, ansiFor(resolved.get(key) ?? "", mode, false));
  const plain = mode === "none";
  return {
    fg: (color, text) => (plain ? text : `${fgOpen.get(color) ?? ""}${text}\u001b[39m`),
    bg: (color, text) => (plain ? text : `${bgOpen.get(color) ?? ""}${text}\u001b[49m`),
    bold: (text) => `\u001b[1m${text}\u001b[22m`,
    italic: (text) => `\u001b[3m${text}\u001b[23m`,
    underline: (text) => `\u001b[4m${text}\u001b[24m`,
    inverse: (text) => `\u001b[7m${text}\u001b[27m`,
    strikethrough: (text) => `\u001b[9m${text}\u001b[29m`,
    getFgAnsi: (color) => fgOpen.get(color) ?? "",
    getBgAnsi: (color) => bgOpen.get(color) ?? "",
  };
}

export interface LoadedTheme {
  theme: HostTheme;
  name: string;
  mode: ColorMode;
  warning?: string;
}

export interface LoadThemeOptions {
  agentDir: string;
  env?: Readonly<Record<string, string | undefined>>;
  isTTY?: boolean;
}

function readConfiguredThemeName(agentDir: string): string | undefined {
  const path = join(agentDir, "settings.json");
  if (!existsSync(path)) return undefined;
  try {
    const settings: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(settings) && typeof settings.theme === "string" && settings.theme.trim() ? settings.theme.trim() : undefined;
  } catch {
    return undefined;
  }
}

export function loadTheme(options: LoadThemeOptions): LoadedTheme {
  const env = options.env ?? process.env;
  const mode = detectColorMode(env, options.isTTY ?? process.stdout.isTTY === true);
  const builtIn = (warning?: string): LoadedTheme => ({
    theme: createHostTheme(DARK_THEME, mode, "Built-in dark theme"),
    name: "dark",
    mode,
    ...(warning === undefined ? {} : { warning }),
  });
  const name = readConfiguredThemeName(options.agentDir);
  if (name === undefined || name === "dark" || name === "light") return builtIn();
  if (!/^[\w .-]+$/.test(name) || name.includes("..")) return builtIn(`Theme "${name}" is not a valid theme name. Using the built-in dark theme.`);
  const path = join(options.agentDir, "themes", `${name}.json`);
  if (!existsSync(path)) return builtIn(`Theme "${name}" was not found at ${path}. Using the built-in dark theme.`);
  try {
    const file = parsePiThemeFile(JSON.parse(readFileSync(path, "utf8")) as unknown, path);
    return { theme: createHostTheme(file, mode, path), name, mode };
  } catch (error) {
    return builtIn(`Could not load theme "${name}": ${error instanceof Error ? error.message : String(error)} Using the built-in dark theme.`);
  }
}
