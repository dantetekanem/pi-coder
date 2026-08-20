import { spawn, type ChildProcess } from "node:child_process";
import { realpath } from "node:fs/promises";
import { CHILD_CLOSURE_UNCONFIRMED, type WorkbenchRepository } from "../contracts.js";
import { filterDeletedGitFiles, isRepositoryRelativePath } from "../navigator.js";
import { createFilesystemFileLister, type FilesystemFileLister } from "./filesystem-list.js";
import { createNodeShikiHighlighter, DEFAULT_SHIKI_THEME } from "./shiki.js";
import { buildHermeticGitInvocation, type HermeticGitInvocation } from "./git-process.js";
import { createChildTermination, DEFAULT_TERMINATION_GRACE_MS, isChildClosureError, utf8Prefix } from "./process-termination.js";
import { createNodeFileAccess } from "./repository.js";

export const DEFAULT_MAX_READ_BYTES = 256 * 1024;
const GIT_LIST_TIMEOUT_MS = 5_000;
const GIT_LIST_MAX_BUFFER = 16 * 1024 * 1024;
const STDERR_CAP = 8 * 1024;

// `--exclude` applies only to untracked `--others`; tracked same-shaped paths stay visible.
const LIST_FILES_ARGS = ["ls-files", "--cached", "--others", "--exclude=.pi-workbench-*", "--exclude-standard", "-z"] as const;
const LIST_DELETED_ARGS = ["ls-files", "--deleted", "-z"] as const;
const GIT_LIST_COMMANDS = [LIST_FILES_ARGS, LIST_DELETED_ARGS] as const;

export type GitListingSpawn = (args: readonly string[]) => ChildProcess;
export type FileListing = (signal: AbortSignal) => Promise<string>;

function hasUnconfirmedChildClosureCode(error: unknown): boolean {
  return isChildClosureError(error)
    || (typeof error === "object" && error !== null && "code" in error && error.code === CHILD_CLOSURE_UNCONFIRMED);
}

function validateGitListingOutput(output: string): void {
  if (output.length === 0) return;
  if (!output.endsWith("\0")) throw new Error("Git file listing returned malformed output.");
  const paths = output.slice(0, -1).split("\0");
  if (paths.some((path) => !isRepositoryRelativePath(path))) throw new Error("Git file listing returned an unsafe path.");
}

export function buildGitListingInvocation(cwd: string, args: readonly string[]): HermeticGitInvocation {
  return buildHermeticGitInvocation(cwd, args, GIT_LIST_COMMANDS, "Git listing command is not allowlisted.");
}

function runGitListingCommand(
  spawnGit: GitListingSpawn,
  args: readonly string[],
  signal: AbortSignal,
  timeoutMs: number,
  maxBuffer: number,
  terminationGraceMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    buildHermeticGitInvocation(".", args, GIT_LIST_COMMANDS, "Git listing command is not allowlisted.");
    if (signal.aborted) { reject(signal.reason ?? new Error("Git file listing aborted.")); return; }
    const child = spawnGit(args);
    let stdout = "";
    let stdoutBytes = 0;
    let stderr = "";
    let stderrBytes = 0;
    let settled = false;
    let pendingError: unknown;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      termination.dispose();
      callback();
    };
    const termination = createChildTermination(child, "Git file listing command", (error) => finish(() => reject(error)), terminationGraceMs);
    const terminateWithError = (error: unknown) => {
      pendingError = error;
      termination.request();
    };
    const abort = () => terminateWithError(signal.reason ?? new Error("Git file listing aborted."));
    const timeout = setTimeout(() => terminateWithError(new Error("Git file listing timed out.")), timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (settled || pendingError != null) return;
      const prefix = utf8Prefix(chunk, Math.max(0, maxBuffer - stdoutBytes));
      stdout += prefix.text;
      stdoutBytes += prefix.bytes;
      if (prefix.text.length < chunk.length || stdoutBytes >= maxBuffer) {
        terminateWithError(new Error("Git file listing output exceeded its maxBuffer byte limit."));
      }
    });
    child.stderr?.on("data", (chunk: string) => {
      if (settled || stderrBytes >= STDERR_CAP) return;
      const prefix = utf8Prefix(chunk, STDERR_CAP - stderrBytes);
      stderr += prefix.text;
      stderrBytes += prefix.bytes;
    });
    child.on("error", (error) => {
      if (settled) return;
      if (pendingError == null) pendingError = error;
      termination.request();
    });
    child.on("close", (exitCode) => {
      termination.markClosed();
      if (pendingError != null) { finish(() => reject(pendingError)); return; }
      if (exitCode !== 0) {
        finish(() => reject(new Error(`Git file listing failed: ${stderr.trim() || `exit ${exitCode ?? 2}`}`)));
        return;
      }
      finish(() => resolve(stdout));
    });
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** Runs both exact listing vectors and cancels/joins the sibling on any failure. */
export function createGitFileLister(
  spawnGit: GitListingSpawn,
  timeoutMs = GIT_LIST_TIMEOUT_MS,
  maxBuffer = GIT_LIST_MAX_BUFFER,
  terminationGraceMs = DEFAULT_TERMINATION_GRACE_MS,
): (signal: AbortSignal) => Promise<string> {
  return async (signal) => {
    if (signal.aborted) throw signal.reason ?? new Error("Git file listing aborted.");
    const group = new AbortController();
    let firstFailure: unknown;
    let callerAborted = false;
    let callerAbortReason: unknown;
    const relayAbort = () => {
      callerAborted = true;
      callerAbortReason = signal.reason ?? new Error("Git file listing aborted.");
      if (!group.signal.aborted) group.abort(callerAbortReason);
    };
    signal.addEventListener("abort", relayAbort, { once: true });
    const run = (args: readonly string[]) => runGitListingCommand(spawnGit, args, group.signal, timeoutMs, maxBuffer, terminationGraceMs)
      .catch((error: unknown) => {
        if (firstFailure == null) firstFailure = error;
        if (!group.signal.aborted) group.abort(error);
        throw error;
      });

    try {
      const outcomes = await Promise.allSettled([run(LIST_FILES_ARGS), run(LIST_DELETED_ARGS)]);
      for (const outcome of outcomes) {
        if (outcome.status === "rejected" && hasUnconfirmedChildClosureCode(outcome.reason)) throw outcome.reason;
      }
      if (callerAborted) throw callerAbortReason;
      if (firstFailure != null) throw firstFailure;
      const files = outcomes[0];
      const deleted = outcomes[1];
      if (files.status !== "fulfilled" || deleted.status !== "fulfilled") throw new Error("Git file listing failed.");
      validateGitListingOutput(files.value);
      validateGitListingOutput(deleted.value);
      return filterDeletedGitFiles(files.value, deleted.value);
    } finally {
      signal.removeEventListener("abort", relayAbort);
    }
  };
}

/** Uses Git when its bounded read-only listing succeeds, otherwise discovers files safely from disk. */
export function createGitOptionalFileLister(
  filesystemLister: FilesystemFileLister,
  gitLister: FileListing,
): FileListing {
  return async (signal) => {
    if (signal.aborted) throw signal.reason ?? new Error("Git file listing aborted.");
    try {
      const listing = await gitLister(signal);
      validateGitListingOutput(listing);
      return listing;
    } catch (error) {
      if (signal.aborted || hasUnconfirmedChildClosureCode(error)) throw error;
      return filesystemLister(signal);
    }
  };
}

/** Assembles the shared Node repository services used by every terminal host. */
export async function createNodeWorkspace(cwd: string, syntaxTheme = DEFAULT_SHIKI_THEME): Promise<WorkbenchRepository> {
  const root = await realpath(cwd);
  const fileAccess = await createNodeFileAccess(root, DEFAULT_MAX_READ_BYTES);
  const spawnGit: GitListingSpawn = (args) => {
    const invocation = buildGitListingInvocation(root, args);
    return spawn(invocation.command, invocation.args, invocation.options);
  };
  const listGitFiles = createGitFileLister(spawnGit);
  const listFiles = createGitOptionalFileLister(createFilesystemFileLister(root), listGitFiles);
  return {
    ...fileAccess,
    workspaceKey: root,
    sourceHighlighter: createNodeShikiHighlighter(syntaxTheme),
    listFiles(signal = new AbortController().signal) { return listFiles(signal); },
  };
}
