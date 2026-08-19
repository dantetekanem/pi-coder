import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const PI_CODE_DIFF_SETTINGS_VERSION = 1;

export interface ProviderUrlPattern {
  host: string;
  path: string;
}

export interface ProviderUrlSettings {
  patterns: ProviderUrlPattern[];
  canonical: string;
  clone?: string;
}

export interface ProviderOperationSettings {
  args: string[];
  method?: string;
}

export interface ProviderSettings {
  id: string;
  label: string;
  executable: string;
  urls: ProviderUrlSettings;
  operations: Record<string, ProviderOperationSettings>;
  refs: Record<string, string>;
  fields: Record<string, string[]>;
  capabilities: Record<string, boolean>;
}

export interface RepositoryProfileSettings {
  cwd: string;
  subdir?: string;
  pathspecs?: string[];
  importAliases?: Record<string, string>;
}

export interface PiCodeDiffSettings {
  version: typeof PI_CODE_DIFF_SETTINGS_VERSION;
  providers: Record<string, ProviderSettings>;
  repositories: Record<string, RepositoryProfileSettings>;
}

const EMPTY_SETTINGS: PiCodeDiffSettings = {
  version: PI_CODE_DIFF_SETTINGS_VERSION,
  providers: {},
  repositories: {},
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: string[], context: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${context} has unsupported fields: ${unknown.join(", ")}.`);
}

function readNonEmptyString(value: unknown, context: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || /[\0\r\n]/.test(value)) {
    throw new Error(`${context} must be a non-empty single-line string.`);
  }
  return value.trim();
}

function readStringArray(value: unknown, context: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${context} must be a non-empty string array.`);
  return value.map((entry, index) => readNonEmptyString(entry, `${context}[${index}]`));
}

function readUrlPattern(value: unknown, context: string): ProviderUrlPattern {
  if (!isRecord(value)) throw new Error(`${context} must be an object.`);
  rejectUnknownKeys(value, ["host", "path"], context);
  const host = readNonEmptyString(value.host, `${context}.host`).toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(host) || host.startsWith(".") || host.endsWith(".")) {
    throw new Error(`${context}.host is invalid.`);
  }
  const path = readNonEmptyString(value.path, `${context}.path`);
  if (!path.startsWith("/") || path.includes("?") || path.includes("#")) throw new Error(`${context}.path is invalid.`);
  return { host, path };
}

function readUrlSettings(value: unknown, context: string): ProviderUrlSettings {
  if (!isRecord(value)) throw new Error(`${context} must be an object.`);
  rejectUnknownKeys(value, ["patterns", "canonical", "clone"], context);
  if (!Array.isArray(value.patterns) || value.patterns.length === 0) throw new Error(`${context}.patterns must be a non-empty array.`);
  const patterns = value.patterns.map((entry, index) => readUrlPattern(entry, `${context}.patterns[${index}]`));
  const canonical = readNonEmptyString(value.canonical, `${context}.canonical`);
  if (!canonical.startsWith("https://")) throw new Error(`${context}.canonical must use https.`);
  const clone = value.clone == null ? undefined : readNonEmptyString(value.clone, `${context}.clone`);
  if (clone != null && !clone.startsWith("https://")) throw new Error(`${context}.clone must use https.`);
  return { patterns, canonical, ...(clone == null ? {} : { clone }) };
}

function readOperation(value: unknown, context: string): ProviderOperationSettings {
  if (!isRecord(value)) throw new Error(`${context} must be an object.`);
  rejectUnknownKeys(value, ["args", "method"], context);
  const args = readStringArray(value.args, `${context}.args`);
  const method = value.method == null ? undefined : readNonEmptyString(value.method, `${context}.method`).toUpperCase();
  if (method != null && !/^[A-Z]+$/.test(method)) throw new Error(`${context}.method is invalid.`);
  return { args, ...(method == null ? {} : { method }) };
}

function readStringMap(value: unknown, context: string): Record<string, string> {
  if (value == null) return {};
  if (!isRecord(value)) throw new Error(`${context} must be an object.`);
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, readNonEmptyString(entry, `${context}.${key}`)]));
}

function readFieldMap(value: unknown, context: string): Record<string, string[]> {
  if (value == null) return {};
  if (!isRecord(value)) throw new Error(`${context} must be an object.`);
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    const paths = typeof entry === "string" ? [readNonEmptyString(entry, `${context}.${key}`)] : readStringArray(entry, `${context}.${key}`);
    if (paths.some((path) => !/^[A-Za-z0-9_.-]+$/.test(path))) throw new Error(`${context}.${key} contains an invalid field path.`);
    return [key, paths];
  }));
}

function readCapabilities(value: unknown, context: string): Record<string, boolean> {
  if (value == null) return {};
  if (!isRecord(value)) throw new Error(`${context} must be an object.`);
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    if (typeof entry !== "boolean") throw new Error(`${context}.${key} must be boolean.`);
    return [key, entry];
  }));
}

function readProvider(id: string, value: unknown): ProviderSettings {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) throw new Error(`Provider id ${id} is invalid.`);
  const context = `providers.${id}`;
  if (!isRecord(value)) throw new Error(`${context} must be an object.`);
  rejectUnknownKeys(value, ["label", "executable", "urls", "operations", "refs", "fields", "capabilities"], context);
  if (!isRecord(value.operations)) throw new Error(`${context}.operations must be an object.`);
  const operations = Object.fromEntries(Object.entries(value.operations).map(([key, entry]) => [key, readOperation(entry, `${context}.operations.${key}`)]));
  return {
    id,
    label: readNonEmptyString(value.label, `${context}.label`),
    executable: readNonEmptyString(value.executable, `${context}.executable`),
    urls: readUrlSettings(value.urls, `${context}.urls`),
    operations,
    refs: readStringMap(value.refs, `${context}.refs`),
    fields: readFieldMap(value.fields, `${context}.fields`),
    capabilities: readCapabilities(value.capabilities, `${context}.capabilities`),
  };
}

function readRepository(value: unknown, context: string): RepositoryProfileSettings {
  if (typeof value === "string") return { cwd: readNonEmptyString(value, context) };
  if (!isRecord(value)) throw new Error(`${context} must be a path or object.`);
  rejectUnknownKeys(value, ["cwd", "path", "subdir", "pathspecs", "importAliases"], context);
  const cwd = readNonEmptyString(value.cwd ?? value.path, `${context}.cwd`);
  const subdir = value.subdir == null ? undefined : readNonEmptyString(value.subdir, `${context}.subdir`);
  const pathspecs = value.pathspecs == null ? undefined : readStringArray(value.pathspecs, `${context}.pathspecs`);
  const importAliases = value.importAliases == null ? undefined : readStringMap(value.importAliases, `${context}.importAliases`);
  return {
    cwd,
    ...(subdir == null ? {} : { subdir }),
    ...(pathspecs == null ? {} : { pathspecs }),
    ...(importAliases == null ? {} : { importAliases }),
  };
}

export function parsePiCodeDiffSettings(value: unknown): PiCodeDiffSettings {
  if (!isRecord(value)) throw new Error("Settings must be an object.");
  rejectUnknownKeys(value, ["version", "providers", "repositories"], "settings");
  if (value.version !== PI_CODE_DIFF_SETTINGS_VERSION) throw new Error(`Settings version must be ${PI_CODE_DIFF_SETTINGS_VERSION}.`);
  if (!isRecord(value.providers)) throw new Error("settings.providers must be an object.");
  const providers = Object.fromEntries(Object.entries(value.providers).map(([id, entry]) => [id, readProvider(id, entry)]));
  const repositoriesValue = value.repositories ?? {};
  if (!isRecord(repositoriesValue)) throw new Error("settings.repositories must be an object.");
  const repositories = Object.fromEntries(Object.entries(repositoriesValue).map(([repo, entry]) => [repo.toLowerCase(), readRepository(entry, `repositories.${repo}`)]));
  return { version: PI_CODE_DIFF_SETTINGS_VERSION, providers, repositories };
}

export function getPiCodeDiffSettingsPath(): string {
  return process.env.PI_CODE_DIFF_SETTINGS_PATH ?? join(getAgentDir(), "pi-code-diff-settings.json");
}

export function loadPiCodeDiffSettings(): PiCodeDiffSettings {
  const path = getPiCodeDiffSettingsPath();
  if (!existsSync(path)) return EMPTY_SETTINGS;
  return parsePiCodeDiffSettings(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

export function getProviderSettings(id: string, settings = loadPiCodeDiffSettings()): ProviderSettings | undefined {
  return settings.providers[id];
}

export function requireProviderSettings(id: string, settings = loadPiCodeDiffSettings()): ProviderSettings {
  const provider = getProviderSettings(id, settings);
  if (provider == null) throw new Error(`Provider ${id} is not configured in ${getPiCodeDiffSettingsPath()}.`);
  return provider;
}

export function renderProviderTemplate(template: string, values: Record<string, string | number>): string {
  const rendered = template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_match, key: string) => {
    const value = values[key];
    if (value == null) throw new Error(`Missing provider template value: ${key}.`);
    const text = String(value);
    if (/[\0\r\n]/.test(text)) throw new Error(`Invalid provider template value: ${key}.`);
    return text;
  });
  if (/\{[^{}]+\}/.test(rendered)) throw new Error(`Unresolved provider template: ${rendered}.`);
  return rendered;
}

export function renderProviderOperation(
  provider: ProviderSettings,
  operation: string,
  values: Record<string, string | number>,
): ProviderOperationSettings {
  const configured = provider.operations[operation];
  if (configured == null) throw new Error(`Provider ${provider.id} does not configure operation ${operation}.`);
  return {
    args: configured.args.map((argument) => renderProviderTemplate(argument, values)),
    ...(configured.method == null ? {} : { method: configured.method }),
  };
}

export function getProviderCapability(provider: ProviderSettings, capability: string): boolean {
  return provider.capabilities[capability] === true;
}

export function readConfiguredField(provider: ProviderSettings, field: string, value: unknown): unknown {
  const paths = provider.fields[field] ?? [];
  for (const path of paths) {
    let current = value;
    for (const segment of path.split(".")) {
      if (!isRecord(current) && !Array.isArray(current)) {
        current = undefined;
        break;
      }
      current = (current as Record<string, unknown>)[segment];
    }
    if (current !== undefined && current !== null) return current;
  }
  return undefined;
}
