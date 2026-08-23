import { access, readFile, realpath, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { CodeTarget } from "../workbench/contracts.js";
import { hashTargetSlice, logicalLineCount } from "../workbench/target.js";

export const PI_CODE_SETTINGS_VERSION = 1;
export const MAX_CODE_EDITOR_ARGS = 64;
export const MAX_CODE_EDITOR_ARG_BYTES = 8_192;
const MAX_ANCHORED_TARGET_BYTES = 256 * 1024;

export type CodeHostPreference = "auto" | "current-terminal" | "tmux-auto" | "herdr-auto";

export interface WorkbenchCodeOpenerSettings {
  kind: "workbench";
}

export interface ExternalCodeOpenerSettings {
  kind: "external";
  executable: string;
  args: readonly string[];
  targetArgs?: readonly string[];
  host: CodeHostPreference;
}

export type CodeOpenerSettings = WorkbenchCodeOpenerSettings | ExternalCodeOpenerSettings;

export interface CodeSettings {
  version: typeof PI_CODE_SETTINGS_VERSION;
  opener: CodeOpenerSettings;
}

export interface ResolvedExternalCodeTarget {
  file: string;
  line: number;
  endLine: number;
}

export interface RenderedExternalEditorCommand {
  executable: string;
  args: string[];
  host: CodeHostPreference;
}

const PLACEHOLDERS = new Set(["cwd", "file", "line", "endLine"]);
const ALWAYS_PLACEHOLDERS = new Set(["cwd"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], context: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${context} has unsupported fields: ${unknown.join(", ")}.`);
}

function readSingleLineString(value: unknown, context: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || /[\0\r\n]/.test(value)) {
    throw new Error(`${context} must be a non-empty single-line string.`);
  }
  return value.trim();
}

function validateExecutable(value: unknown): string {
  const executable = readSingleLineString(value, "code.opener.executable");
  if (!isAbsolute(executable) && (executable.includes("/") || executable.includes("\\"))) {
    throw new Error("code.opener.executable must be an absolute path or a bare program name.");
  }
  return executable;
}

function validateTemplate(template: string, context: string, allowed: ReadonlySet<string>): string {
  if (Buffer.byteLength(template, "utf8") > MAX_CODE_EDITOR_ARG_BYTES) {
    throw new Error(`${context} must be at most ${MAX_CODE_EDITOR_ARG_BYTES} UTF-8 bytes.`);
  }
  if (/[\0\r\n]/.test(template)) throw new Error(`${context} must be a single-line argument template.`);

  const seen = new Set<string>();
  template.replace(/\{([^{}]+)\}/g, (_match, name: string) => {
    seen.add(name);
    return "";
  });
  const unknown = [...seen].filter((name) => !PLACEHOLDERS.has(name));
  if (unknown.length > 0) throw new Error(`${context} contains an unsupported placeholder: {${unknown[0]}}.`);
  const disallowed = [...seen].filter((name) => !allowed.has(name));
  if (disallowed.length > 0) throw new Error(`${context} cannot use the {${disallowed[0]}} placeholder.`);
  if (template.replace(/\{[^{}]+\}/g, "").includes("{") || template.replace(/\{[^{}]+\}/g, "").includes("}")) {
    throw new Error(`${context} contains a malformed placeholder.`);
  }
  return template;
}

function readTemplates(value: unknown, context: string, allowed: ReadonlySet<string>): string[] {
  if (!Array.isArray(value)) throw new Error(`${context} must be an array of argument templates.`);
  return value.map((entry, index) => {
    if (typeof entry !== "string") throw new Error(`${context}[${index}] must be a string argument template.`);
    return validateTemplate(entry, `${context}[${index}]`, allowed);
  });
}

function readHost(value: unknown): CodeHostPreference {
  if (value == null) return "auto";
  if (value === "auto" || value === "current-terminal" || value === "tmux-auto" || value === "herdr-auto") return value;
  throw new Error("code.opener.host must be auto, current-terminal, tmux-auto, or herdr-auto.");
}

export function defaultCodeSettings(): CodeSettings {
  return { version: PI_CODE_SETTINGS_VERSION, opener: { kind: "workbench" } };
}

export function parseCodeSettings(value: unknown): CodeSettings {
  if (value == null) return defaultCodeSettings();
  if (!isRecord(value)) throw new Error("code must be an object.");
  rejectUnknownKeys(value, ["version", "opener"], "code");
  if (value.version !== PI_CODE_SETTINGS_VERSION) throw new Error(`Code version must be ${PI_CODE_SETTINGS_VERSION}.`);
  if (!isRecord(value.opener)) throw new Error("code.opener must be an object.");

  const opener = value.opener;
  if (opener.kind === "workbench") {
    rejectUnknownKeys(opener, ["kind"], "code.opener");
    return { version: PI_CODE_SETTINGS_VERSION, opener: { kind: "workbench" } };
  }
  if (opener.kind !== "external") throw new Error("code.opener.kind must be workbench or external.");

  rejectUnknownKeys(opener, ["kind", "executable", "args", "targetArgs", "host"], "code.opener");
  const args = opener.args == null ? [] : readTemplates(opener.args, "code.opener.args", ALWAYS_PLACEHOLDERS);
  const targetArgs = opener.targetArgs == null ? undefined : readTemplates(opener.targetArgs, "code.opener.targetArgs", PLACEHOLDERS);
  if (args.length + (targetArgs?.length ?? 0) > MAX_CODE_EDITOR_ARGS) {
    throw new Error(`code.opener args and targetArgs may contain at most ${MAX_CODE_EDITOR_ARGS} arguments combined.`);
  }

  return {
    version: PI_CODE_SETTINGS_VERSION,
    opener: {
      kind: "external",
      executable: validateExecutable(opener.executable),
      args,
      ...(targetArgs == null ? {} : { targetArgs }),
      host: readHost(opener.host),
    },
  };
}

function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{([^{}]+)\}/g, (_match, name: string) => {
    const value = values[name];
    if (value == null) throw new Error(`Missing code editor template value: ${name}.`);
    return value;
  });
}

export function renderExternalEditorCommand(
  opener: ExternalCodeOpenerSettings,
  request: { cwd: string; resolvedTarget?: ResolvedExternalCodeTarget },
): RenderedExternalEditorCommand {
  const values: Record<string, string> = { cwd: request.cwd };
  if (request.resolvedTarget != null) {
    values.file = request.resolvedTarget.file;
    values.line = String(request.resolvedTarget.line);
    values.endLine = String(request.resolvedTarget.endLine);
  }
  const targetTemplates = request.resolvedTarget == null ? [] : opener.targetArgs;
  if (request.resolvedTarget != null && targetTemplates == null) {
    throw new Error("The configured external code opener does not define targetArgs for file targets.");
  }
  return {
    executable: opener.executable,
    args: [...opener.args, ...(targetTemplates ?? [])].map((template) => renderTemplate(template, values)),
    host: opener.host,
  };
}

function isContained(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function validateRange(target: CodeTarget): void {
  const { startLine, endLine } = target.range;
  if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine < 1 || endLine < startLine) {
    throw new Error("External code target range must use ordered positive integers.");
  }
}

export async function resolveExternalCodeTarget(request: {
  cwd: string;
  target: CodeTarget;
}): Promise<ResolvedExternalCodeTarget> {
  validateRange(request.target);
  if (isAbsolute(request.target.path)) throw new Error("External code target path must be workspace-relative.");

  const canonicalCwd = await realpath(request.cwd);
  const cwdStat = await stat(canonicalCwd);
  if (!cwdStat.isDirectory()) throw new Error("External code workspace must be a directory.");
  const candidate = resolve(canonicalCwd, request.target.path);
  let canonicalFile: string;
  try {
    canonicalFile = await realpath(candidate);
    await access(canonicalFile, fsConstants.R_OK);
  } catch {
    throw new Error(`External code target does not exist or is unreadable: ${request.target.path}`);
  }
  if (!isContained(canonicalCwd, canonicalFile)) throw new Error("External code target resolves outside the workspace.");
  const fileStat = await stat(canonicalFile);
  if (!fileStat.isFile()) throw new Error("External code target must be a regular file.");

  if (request.target.anchor != null) {
    if (request.target.anchor.algorithm !== "sha256" || !/^[0-9a-f]{64}$/.test(request.target.anchor.value)) {
      throw new Error("External code target anchor must be a lowercase SHA-256 hash.");
    }
    if (fileStat.size > MAX_ANCHORED_TARGET_BYTES) throw new Error("External code target is too large to verify its anchor.");
    const text = await readFile(canonicalFile, "utf8");
    if (request.target.range.endLine > logicalLineCount(text)) throw new Error("External code target range is outside the file.");
    if (hashTargetSlice(text, request.target.range).value !== request.target.anchor.value) {
      throw new Error("External code target anchor no longer matches the file.");
    }
  }

  return {
    file: canonicalFile,
    line: request.target.range.startLine,
    endLine: request.target.range.endLine,
  };
}
