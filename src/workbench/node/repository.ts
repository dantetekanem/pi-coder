import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, rename, rm, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { SaveTextResult, TextFileSnapshot, WorkbenchRepository } from "../contracts.js";

export interface NodeFileAccessOptions {
  /** Injectable only so atomic rename and cleanup outcomes can be proven deterministically. */
  renameFile?: (from: string, to: string) => Promise<void>;
  removeFile?: (path: string) => Promise<void>;
  openLockFile?: (path: string) => Promise<FileHandle>;
  removeLockFile?: (path: string) => Promise<void>;
}

type NodeFileAccess = Pick<WorkbenchRepository, "canReadFile" | "maxReadBytes" | "readText" | "saveText">;

interface OpenedFileSnapshot {
  snapshot: TextFileSnapshot;
  bytes: Buffer;
  mode: number;
  resolvedPath: string;
}

function isContained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function revisionFor(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function resolveContainedFile(root: string, path: string): Promise<string | null> {
  const candidate = resolve(root, path);
  if (!isContained(root, candidate)) return null;
  try {
    const resolvedPath = await realpath(candidate);
    return isContained(root, resolvedPath) ? resolvedPath : null;
  } catch {
    return null;
  }
}

async function readBounded(handle: FileHandle, maxBytes: number): Promise<Buffer> {
  const buffer = Buffer.alloc(maxBytes + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > maxBytes) throw new Error("Selected file exceeds the workbench read limit.");
  return buffer.subarray(0, offset);
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error("Selected file is not valid UTF-8 text.");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function appendCleanupFailures(message: string, failures: readonly string[]): string {
  return failures.length === 0 ? message : `${message}; temporary save cleanup failed: ${failures.join("; ")}`;
}

function appendLockCleanupFailures(message: string, failures: readonly string[]): string {
  return failures.length === 0 ? message : `${message}; save lock cleanup failed: ${failures.join("; ")}`;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error == null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function lockPathFor(canonicalTarget: string): string {
  const digest = createHash("sha256").update(canonicalTarget).digest("hex");
  return resolve(dirname(canonicalTarget), `.pi-workbench-${digest}.lock`);
}

async function openSnapshot(root: string, path: string, maxBytes: number): Promise<OpenedFileSnapshot> {
  const resolvedPath = await resolveContainedFile(root, path);
  if (resolvedPath == null) throw new Error("Selected file is outside the repository.");
  const handle = await open(resolvedPath, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const details = await handle.stat();
    if (!details.isFile()) throw new Error("Selected path is not a regular file.");
    if (details.size > maxBytes) throw new Error("Selected file exceeds the workbench read limit.");
    const bytes = await readBounded(handle, maxBytes);
    return {
      snapshot: { text: decodeUtf8(bytes), revision: revisionFor(bytes) },
      bytes,
      mode: details.mode & 0o7777,
      resolvedPath,
    };
  } finally {
    await handle.close();
  }
}

async function writeAtomic(
  root: string,
  path: string,
  text: string,
  expectedRevision: string,
  maxBytes: number,
  renameFile: (from: string, to: string) => Promise<void>,
  removeFile: (path: string) => Promise<void>,
  openLockFile: (path: string) => Promise<FileHandle>,
  removeLockFile: (path: string) => Promise<void>,
): Promise<SaveTextResult> {
  const canonicalTarget = await resolveContainedFile(root, path);
  if (canonicalTarget == null) throw new Error("Selected file is outside the repository.");
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length > maxBytes) return { status: "error", message: "Edited file exceeds the workbench write limit." };
  if (decodeUtf8(bytes) !== text) return { status: "error", message: "Edited text cannot be represented exactly as UTF-8." };

  const lockPath = lockPathFor(canonicalTarget);
  let lockHandle: FileHandle;
  try {
    lockHandle = await openLockFile(lockPath);
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      return { status: "error", message: "Another save is already in progress for this file; retry." };
    }
    throw new Error(`save lock acquisition failed: ${errorMessage(error)}`);
  }

  let tempHandle: FileHandle | null = null;
  let tempPath: string | null = null;
  let ownsTempPath = false;
  let outcome: SaveTextResult | null = null;
  let committedOutcome: Extract<SaveTextResult, { status: "success" }> | null = null;
  let primaryError: Error | null = null;
  try {
    const loaded = await openSnapshot(root, path, maxBytes);
    if (loaded.resolvedPath !== canonicalTarget || loaded.snapshot.revision !== expectedRevision) {
      outcome = { status: "conflict", message: "File changed outside the workbench; reload before saving." };
    } else {
      const revision = revisionFor(bytes);
      if (bytes.equals(loaded.bytes)) {
        outcome = { status: "success", effect: "unchanged", revision };
      } else {
        const directory = dirname(loaded.resolvedPath);
        tempPath = resolve(directory, `${basename(lockPath, ".lock")}-${process.pid}-${randomUUID()}.tmp`);
        tempHandle = await open(tempPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, loaded.mode);
        ownsTempPath = true;
        await tempHandle.writeFile(bytes);
        await tempHandle.chmod(loaded.mode);
        await tempHandle.sync();
        await tempHandle.close();
        tempHandle = null;

        const rechecked = await openSnapshot(root, path, maxBytes);
        if (rechecked.resolvedPath !== loaded.resolvedPath || rechecked.snapshot.revision !== expectedRevision) {
          outcome = { status: "conflict", message: "File changed outside the workbench; reload before saving." };
        } else {
          await renameFile(tempPath, loaded.resolvedPath);
          ownsTempPath = false;
          committedOutcome = { status: "success", effect: "saved", revision };
          outcome = committedOutcome;
        }
      }
    }
  } catch (error) {
    primaryError = error instanceof Error ? error : new Error(String(error));
  }

  const cleanupFailures: string[] = [];
  if (tempHandle != null) {
    try { await tempHandle.close(); } catch (error) { cleanupFailures.push(`close: ${errorMessage(error)}`); }
  }
  if (ownsTempPath && tempPath != null) {
    try { await removeFile(tempPath); } catch (error) { cleanupFailures.push(`remove: ${errorMessage(error)}`); }
  }

  const lockCleanupFailures: string[] = [];
  let lockClosed = false;
  try {
    await lockHandle.close();
    lockClosed = true;
  } catch (error) {
    lockCleanupFailures.push(`close: ${errorMessage(error)}`);
  }
  if (lockClosed) {
    try {
      await removeLockFile(lockPath);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") lockCleanupFailures.push(`remove: ${errorMessage(error)}`);
    }
  }

  if (primaryError != null) {
    const withTempCleanup = appendCleanupFailures(primaryError.message, cleanupFailures);
    throw new Error(appendLockCleanupFailures(withTempCleanup, lockCleanupFailures));
  }
  if (outcome == null) {
    const withTempCleanup = appendCleanupFailures("Atomic save did not produce a result.", cleanupFailures);
    throw new Error(appendLockCleanupFailures(withTempCleanup, lockCleanupFailures));
  }
  if (committedOutcome != null) {
    if (lockCleanupFailures.length === 0) return committedOutcome;
    return {
      ...committedOutcome,
      warning: `Save committed, but save lock cleanup failed: ${lockCleanupFailures.join("; ")}`,
    };
  }
  if (cleanupFailures.length > 0) {
    const message = outcome.status === "success" ? "No-op save cleanup failed." : outcome.message;
    return { status: "error", message: appendCleanupFailures(message, cleanupFailures) };
  }
  if (lockCleanupFailures.length > 0) {
    const message = outcome.status === "success" ? "No-op save completed." : outcome.message;
    return { status: "error", message: appendLockCleanupFailures(message, lockCleanupFailures) };
  }
  return outcome;
}

/**
 * Creates revision-aware Node file access. Containment and file limits are checked
 * again on every read/save; writes hold an exclusive target-directory lock through
 * an fsynced same-directory temp file, final revision recheck, rename, and cleanup.
 */
export async function createNodeFileAccess(rootPath: string, maxReadBytes: number, options: NodeFileAccessOptions = {}): Promise<NodeFileAccess> {
  const root = await realpath(rootPath);
  const renameFile = options.renameFile ?? rename;
  const removeFile = options.removeFile ?? (async (path: string) => { await rm(path, { force: true }); });
  const openLockFile = options.openLockFile ?? (async (path: string) => open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  ));
  const removeLockFile = options.removeLockFile ?? (async (path: string) => { await rm(path); });
  return {
    maxReadBytes,
    async canReadFile(path) {
      try {
        await openSnapshot(root, path, maxReadBytes);
        return true;
      } catch {
        return false;
      }
    },
    async readText(path, maxBytes) {
      const loaded = await openSnapshot(root, path, Math.min(maxBytes, maxReadBytes));
      return loaded.snapshot;
    },
    async saveText(path, text, expectedRevision) {
      try {
        return await writeAtomic(root, path, text, expectedRevision, maxReadBytes, renameFile, removeFile, openLockFile, removeLockFile);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message === "Selected file is outside the repository."
          || message === "Selected path is not a regular file."
          || message === "Selected file exceeds the workbench read limit."
          || message === "Selected file is not valid UTF-8 text.") {
          return { status: "error", message };
        }
        return { status: "error", message: `Could not atomically save ${path}: ${message}` };
      }
    },
  };
}
