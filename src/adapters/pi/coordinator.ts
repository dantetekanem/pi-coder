import type { CodeStory, DiscussWorkbenchResult, WorkbenchCompletionResult, WorkbenchLaunch } from "../../workbench/contracts.js";
import { normalizeWorkbenchLaunch } from "../../workbench/target.js";

export const PI_WORKBENCH_ACTIVE = "PI_WORKBENCH_ACTIVE" as const;

export type PiWorkbenchOrigin = "direct-code" | "open-code" | "review-bridge";

let activeOrigin: PiWorkbenchOrigin | null = null;

function argumentError(message: string): never {
  throw new Error(`Invalid /code arguments: ${message}`);
}

export function tokenizeCodeArgs(input: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let started = false;
  let quote: "single" | "double" | null = null;

  const finish = () => {
    if (!started) return;
    tokens.push(token);
    token = "";
    started = false;
  };

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    if (quote === "single") {
      if (character === "'") quote = null;
      else token += character;
      continue;
    }
    if (quote === "double") {
      if (character === '"') { quote = null; continue; }
      if (character === "\\") {
        const escaped = input[++index];
        if (escaped !== '"' && escaped !== "\\") argumentError('double-quote escapes accept only \\" and \\\\.');
        token += escaped;
      } else token += character;
      continue;
    }
    if (/\s/.test(character)) { finish(); continue; }
    started = true;
    if (character === "'") quote = "single";
    else if (character === '"') quote = "double";
    else if (character === "\\") {
      const escaped = input[++index];
      if (escaped == null) argumentError("a trailing backslash has no character to escape.");
      token += escaped;
    } else token += character;
  }
  if (quote != null) argumentError(`unterminated ${quote} quote.`);
  finish();
  return tokens;
}

function parsePositiveInteger(value: string, option: string): number {
  if (!/^[0-9]+$/.test(value)) argumentError(`${option} must be a positive integer.`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) argumentError(`${option} must be a positive integer.`);
  return number;
}

function parseStory(value: string): CodeStory {
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { argumentError("--story-json must contain one JSON object."); }
  if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) argumentError("--story-json must contain one JSON object.");
  return parsed as CodeStory;
}

export function parseDirectCodeArgs(args: string): WorkbenchLaunch {
  const tokens = tokenizeCodeArgs(args);
  const values = new Map<string, string>();
  const stories: CodeStory[] = [];
  const repeatable = "--story-json";
  const known = new Set(["--path", "--line", "--end-line", "--anchor-sha256", repeatable]);

  for (let index = 0; index < tokens.length; index += 1) {
    const option = tokens[index]!;
    if (!known.has(option)) argumentError(`unknown option ${option}.`);
    const value = tokens[++index];
    if (value == null) argumentError(`${option} requires a value.`);
    if (option === repeatable) stories.push(parseStory(value));
    else {
      if (values.has(option)) argumentError(`${option} may appear only once.`);
      values.set(option, value);
    }
  }

  const path = values.get("--path");
  const lineText = values.get("--line");
  const endText = values.get("--end-line");
  const anchor = values.get("--anchor-sha256");
  if ((path == null) !== (lineText == null)) argumentError("--path and --line require each other.");
  if ((endText != null || anchor != null) && path == null) argumentError("--end-line and --anchor-sha256 require --path and --line.");

  const launch: WorkbenchLaunch = {};
  if (path != null && lineText != null) {
    const startLine = parsePositiveInteger(lineText, "--line");
    const endLine = endText == null ? startLine : parsePositiveInteger(endText, "--end-line");
    launch.initialTarget = {
      path,
      range: { startLine, endLine },
      ...(anchor == null ? {} : { anchor: { algorithm: "sha256", value: anchor } }),
    };
  }
  if (stories.length > 0) launch.stories = stories;
  launch.capabilities = { discuss: true };
  return normalizeWorkbenchLaunch(launch);
}

export async function runGuardedPiWorkbench(
  origin: PiWorkbenchOrigin,
  runner: () => Promise<WorkbenchCompletionResult>,
): Promise<WorkbenchCompletionResult> {
  if (activeOrigin != null) {
    return {
      status: "failed",
      code: PI_WORKBENCH_ACTIVE,
      message: `A Pi code workbench is already active (${activeOrigin}); ${origin} cannot start another one.`,
    };
  }
  activeOrigin = origin;
  try {
    return await runner();
  } catch (error) {
    return { status: "failed", message: error instanceof Error ? error.message : String(error) };
  } finally {
    activeOrigin = null;
  }
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let end = text.length;
  while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > maxBytes) end -= 1;
  return `${text.slice(0, end)}…`;
}

export function composeCodeDiscussionPrompt(cwd: string, result: DiscussWorkbenchResult): string {
  const range = result.target.range.startLine === result.target.range.endLine
    ? String(result.target.range.startLine)
    : `${result.target.range.startLine}-${result.target.range.endLine}`;
  const changed = result.changedPaths.slice(0, 50);
  return [
    "Discuss this code location with the user. Explain evidence, rationale, or a proposal. Do not edit files for this handoff.",
    "",
    `Canonical cwd: ${cwd}`,
    `Target: ${result.target.path}:${range}`,
    `Anchor SHA-256: ${result.target.anchor?.value ?? "none"}`,
    `Changed paths: ${changed.length === 0 ? "none" : changed.join(", ")}${result.changedPaths.length > changed.length ? ` (+${result.changedPaths.length - changed.length} more)` : ""}`,
    ...(result.note == null ? [] : ["", `User note: ${truncateUtf8(result.note, 4096)}`]),
    "",
    "Read the authoritative working-tree file if evidence is needed. No source bytes are included in this handoff.",
  ].join("\n");
}
