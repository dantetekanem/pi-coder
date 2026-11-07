import type { TerminalSettings } from "./contract.js";

export const MODEL_PURPOSES = ["grammar", "story", "analysis", "default"] as const;

export type ModelCommandPurpose = (typeof MODEL_PURPOSES)[number];

export interface ModelCommandSettings {
  command: string[];
}

export type CliModelSettings = Partial<Record<ModelCommandPurpose, ModelCommandSettings>>;

export interface CliSettings {
  models: CliModelSettings;
  terminal: TerminalSettings;
  path: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readCommand(value: unknown, field: string, path: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${field} must be a non-empty array of strings in ${path}.`);
  }
  value.forEach((entry, index) => {
    if (typeof entry !== "string" || (index === 0 && entry.length === 0)) {
      throw new Error(`${field}[${index}] must be ${index === 0 ? "a non-empty string" : "a string"} in ${path}.`);
    }
  });
  return [...(value as string[])];
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], field: string, path: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw new Error(`${field} has an unknown key "${unknown}" in ${path}. Allowed: ${allowed.join(", ")}.`);
}

export function parseCliSettings(raw: { models?: unknown; terminal?: unknown }, path: string): CliSettings {
  const models: CliModelSettings = {};
  if (raw.models !== undefined && raw.models !== null) {
    if (!isRecord(raw.models)) throw new Error(`models must be an object in ${path}.`);
    rejectUnknownKeys(raw.models, MODEL_PURPOSES, "models", path);
    for (const purpose of MODEL_PURPOSES) {
      const entry = raw.models[purpose];
      if (entry === undefined) continue;
      if (!isRecord(entry)) throw new Error(`models.${purpose} must be an object with a command in ${path}.`);
      rejectUnknownKeys(entry, ["command"], `models.${purpose}`, path);
      models[purpose] = { command: readCommand(entry.command, `models.${purpose}.command`, path) };
    }
  }

  const terminal: TerminalSettings = {};
  if (raw.terminal !== undefined && raw.terminal !== null) {
    if (!isRecord(raw.terminal)) throw new Error(`terminal must be an object in ${path}.`);
    rejectUnknownKeys(raw.terminal, ["command"], "terminal", path);
    if (raw.terminal.command !== undefined) terminal.command = readCommand(raw.terminal.command, "terminal.command", path);
  }
  return { models, terminal, path };
}

export async function loadCliSettings(): Promise<CliSettings> {
  const { getPiCoderSettingsPath, loadPiCoderSettings } = await import("../provider-settings.js");
  const settings: ReturnType<typeof loadPiCoderSettings> & { models?: unknown; terminal?: unknown } = loadPiCoderSettings();
  return parseCliSettings(settings, getPiCoderSettingsPath());
}
