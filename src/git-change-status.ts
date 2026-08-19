import { execFile as nodeExecFile } from "node:child_process";
import { FILTER_CONFIG_ARGS, filterOverrideArgs, parseFilterConfigPrefixes } from "./git-filter-policy.js";

export const REPOSITORY_CHANGE_STATUS_KEY = "pi-code-diff-local-changes";
const COMMAND_TIMEOUT_MS = 3_000;
const OUTPUT_CAP_BYTES = 64 * 1024;
const STATUS_ARGS = ["status", "--porcelain=v1", "-z", "--untracked-files=normal", "--ignore-submodules=all"] as const;
const SHORTSTAT_ARGS = ["diff", "--shortstat", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", "HEAD", "--", "."] as const;
const ANSI_GREEN = "\x1b[32m";
const ANSI_RED = "\x1b[31m";
const ANSI_PINK = "\x1b[95m";
const ANSI_RESET = "\x1b[0m";

export interface RepositoryChangeSummary {
  files: number;
  filesCapped: boolean;
  additions: number | null;
  deletions: number | null;
  untrackedFiles: number;
}

export interface RepositoryGitCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  capped: boolean;
}

export type RepositoryGitCommand = (
  cwd: string,
  args: readonly string[],
  signal: AbortSignal,
) => Promise<RepositoryGitCommandResult>;

interface ExecFileError extends Error {
  code?: string | number;
  killed?: boolean;
  signal?: string | null;
}

interface BoundedExecFileOptions {
  cwd: string;
  encoding: "utf8";
  env: NodeJS.ProcessEnv;
  maxBuffer: number;
  timeout: number;
  killSignal: "SIGKILL";
  signal: AbortSignal;
  windowsHide: true;
}

export type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: BoundedExecFileOptions,
  callback: (error: ExecFileError | null, stdout: string, stderr: string) => void,
) => unknown;

const defaultExecFile = nodeExecFile as unknown as ExecFileLike;

/** Shell-free, bounded Git execution for a persistent best-effort footer. */
export function runBoundedGit(
  cwd: string,
  args: readonly string[],
  signal: AbortSignal,
  execFile: ExecFileLike = defaultExecFile,
): Promise<RepositoryGitCommandResult> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Git status refresh aborted."));
  return new Promise((resolve, reject) => {
    execFile("git", ["-c", "core.fsmonitor=false", ...args], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_NO_LAZY_FETCH: "1",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_PAGER: "cat",
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "never",
        LC_ALL: "C",
      },
      maxBuffer: OUTPUT_CAP_BYTES,
      timeout: COMMAND_TIMEOUT_MS,
      killSignal: "SIGKILL",
      signal,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      const safeStdout = typeof stdout === "string" ? stdout : "";
      const safeStderr = typeof stderr === "string" ? stderr : "";
      if (error == null) {
        resolve({ stdout: safeStdout, stderr: safeStderr, exitCode: 0, capped: false });
        return;
      }
      if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
        resolve({ stdout: safeStdout, stderr: safeStderr, exitCode: 2, capped: true });
        return;
      }
      if (signal.aborted || error.code === "ABORT_ERR" || error.killed === true || error.signal != null) {
        reject(signal.reason ?? error);
        return;
      }
      if (typeof error.code === "number") {
        resolve({ stdout: safeStdout, stderr: safeStderr, exitCode: error.code, capped: false });
        return;
      }
      reject(error);
    });
  });
}

export function parsePorcelainChangeCounts(
  output: string,
  capped: boolean,
): Pick<RepositoryChangeSummary, "files" | "filesCapped" | "untrackedFiles"> {
  if (!capped && output.length > 0 && !output.endsWith("\0")) throw new Error("Git returned malformed Git status output.");
  const fields = output.split("\0");
  const completeFieldCount = output.endsWith("\0") ? fields.length - 1 : Math.max(0, fields.length - 1);
  let files = 0;
  let untrackedFiles = 0;

  for (let index = 0; index < completeFieldCount; index += 1) {
    const record = fields[index]!;
    if (record.length < 4 || record[2] !== " ") throw new Error("Git returned malformed Git status output.");
    const indexStatus = record[0]!;
    const worktreeStatus = record[1]!;
    const renamedOrCopied = indexStatus === "R" || indexStatus === "C" || worktreeStatus === "R" || worktreeStatus === "C";
    if (renamedOrCopied) {
      if (index + 1 >= completeFieldCount || fields[index + 1]!.length === 0) {
        if (capped) break;
        throw new Error("Git returned malformed Git status output.");
      }
      index += 1;
    }
    files += 1;
    if (indexStatus === "?" && worktreeStatus === "?") untrackedFiles += 1;
  }

  if (capped && output.length > 0 && files === 0) files = 1;
  return { files, filesCapped: capped, untrackedFiles };
}

export function parseShortStat(output: string): { additions: number; deletions: number } {
  const text = output.trim();
  if (text.length === 0) return { additions: 0, deletions: 0 };
  if (!/^\d+ files? changed(?:, \d+ insertions?\(\+\))?(?:, \d+ deletions?\(-\))?$/.test(text)) {
    throw new Error("Git returned malformed Git shortstat output.");
  }
  const additions = Number.parseInt(/(?:^|, )(\d+) insertions?\(\+\)/.exec(text)?.[1] ?? "0", 10);
  const deletions = Number.parseInt(/(?:^|, )(\d+) deletions?\(-\)/.exec(text)?.[1] ?? "0", 10);
  if (!Number.isSafeInteger(additions) || !Number.isSafeInteger(deletions)) throw new Error("Git returned malformed Git shortstat output.");
  return { additions, deletions };
}

function parseFilterPrefixes(result: RepositoryGitCommandResult): string[] {
  if (result.capped) throw new Error("Git filter configuration exceeded its output cap.");
  if (result.exitCode === 1 && result.stdout.length === 0) return [];
  if (result.exitCode !== 0) throw new Error("Git filter configuration inspection failed.");
  const parsed = parseFilterConfigPrefixes(result.stdout);
  if (parsed.kind === "failure") {
    if (parsed.reason === "unsafe") throw new Error("Git returned an unsafe filter configuration key.");
    throw new Error("Git filter configuration inspection failed.");
  }
  return parsed.prefixes;
}

async function runStatusGroup(
  cwd: string,
  argsList: readonly (readonly string[])[],
  signal: AbortSignal,
  run: RepositoryGitCommand,
): Promise<RepositoryGitCommandResult[]> {
  const group = new AbortController();
  const relayAbort = () => group.abort(signal.reason ?? new Error("Git status refresh aborted."));
  signal.addEventListener("abort", relayAbort, { once: true });
  let firstFailure: unknown;
  const guardedRun = (args: readonly string[]) => run(cwd, args, group.signal).catch((error: unknown) => {
    firstFailure ??= error;
    if (!group.signal.aborted) group.abort(error);
    throw error;
  });
  try {
    const outcomes = await Promise.allSettled(argsList.map(guardedRun));
    if (firstFailure != null) throw firstFailure;
    return outcomes.map((outcome) => {
      if (outcome.status === "rejected") throw outcome.reason;
      return outcome.value;
    });
  } finally {
    signal.removeEventListener("abort", relayAbort);
  }
}

/** Best-effort local working-tree summary. No repository text reaches the terminal. */
export async function loadRepositoryChangeSummary(
  cwd: string,
  signal: AbortSignal,
  run: RepositoryGitCommand = runBoundedGit,
): Promise<RepositoryChangeSummary | null> {
  const prefixes = parseFilterPrefixes(await run(cwd, FILTER_CONFIG_ARGS, signal));
  const overrides = prefixes.flatMap(filterOverrideArgs);
  const [status, shortstat] = await runStatusGroup(cwd, [
    [...overrides, ...STATUS_ARGS],
    [...overrides, ...SHORTSTAT_ARGS],
  ], signal, run);
  if (status == null || shortstat == null || (status.exitCode !== 0 && !status.capped)) return null;

  const counts = parsePorcelainChangeCounts(status.stdout, status.capped);
  const lineStats = shortstat.exitCode === 0 && !shortstat.capped ? parseShortStat(shortstat.stdout) : null;
  return {
    ...counts,
    additions: lineStats?.additions ?? null,
    deletions: lineStats?.deletions ?? null,
  };
}

export function formatRepositoryChangeSummary(summary: RepositoryChangeSummary | null): string | undefined {
  if (summary == null || summary.files <= 0) return undefined;
  const fileCount = `${summary.files}${summary.filesCapped ? "+" : ""}`;
  const parts = [`${fileCount} ${summary.files === 1 && !summary.filesCapped ? "file" : "files"}`];
  if (summary.additions != null && summary.deletions != null && (summary.additions > 0 || summary.deletions > 0)) {
    parts.push(`${ANSI_GREEN}+${summary.additions}${ANSI_RESET} ${ANSI_RED}−${summary.deletions}${ANSI_RESET}`);
  }
  return `${parts.join(" · ")} · ${ANSI_PINK}/diff${ANSI_RESET} for details`;
}

export interface RepositoryChangeStatusContext {
  cwd: string;
  hasUI: boolean;
  ui: { setStatus(key: string, text: string | undefined): void };
}

export class RepositoryChangeStatusController {
  private generation = 0;
  private controller: AbortController | null = null;
  private readonly pending = new Set<Promise<void>>();
  private stopped = false;

  constructor(
    private readonly load: typeof loadRepositoryChangeSummary = loadRepositoryChangeSummary,
  ) {}

  refresh(ctx: RepositoryChangeStatusContext, options: { clear?: boolean } = {}): Promise<void> {
    if (!ctx.hasUI || this.stopped) return Promise.resolve();
    const task = this.refreshOnce(ctx, options);
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task));
    return task;
  }

  private async refreshOnce(ctx: RepositoryChangeStatusContext, options: { clear?: boolean }): Promise<void> {
    const generation = ++this.generation;
    this.controller?.abort(new Error("Superseded repository status refresh."));
    const controller = new AbortController();
    this.controller = controller;
    if (options.clear === true) {
      ctx.ui.setStatus(REPOSITORY_CHANGE_STATUS_KEY, undefined);
    }
    try {
      const summary = await this.load(ctx.cwd, controller.signal);
      if (this.stopped || generation !== this.generation || controller.signal.aborted) return;
      ctx.ui.setStatus(REPOSITORY_CHANGE_STATUS_KEY, formatRepositoryChangeSummary(summary));
    } catch {
      if (!this.stopped && generation === this.generation && !controller.signal.aborted) {
        ctx.ui.setStatus(REPOSITORY_CHANGE_STATUS_KEY, undefined);
      }
    } finally {
      if (generation === this.generation) this.controller = null;
    }
  }

  async shutdown(ctx: RepositoryChangeStatusContext): Promise<void> {
    this.stopped = true;
    this.generation += 1;
    this.controller?.abort(new Error("Repository status refresh shut down."));
    this.controller = null;
    if (ctx.hasUI) ctx.ui.setStatus(REPOSITORY_CHANGE_STATUS_KEY, undefined);
    await Promise.allSettled([...this.pending]);
  }
}
