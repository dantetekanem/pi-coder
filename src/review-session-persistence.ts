import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

export interface ReviewSessionLockInfo {
  path: string;
  ownerPid?: number;
  ownerStatus: "present-or-reused" | "dead" | "unknown";
  recovery: "manual-only";
}

export class ReviewSessionLockedError extends Error {
  readonly lock: ReviewSessionLockInfo;

  constructor(lock: ReviewSessionLockInfo) {
    super(`Review storage is locked at ${lock.path}; ownership is ${lock.ownerStatus}. Automatic recovery is unsupported.`);
    this.name = "ReviewSessionLockedError";
    this.lock = lock;
  }
}

function errorCode(error: unknown): string | undefined {
  return error != null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

function inspectLock(path: string): ReviewSessionLockInfo {
  const info: ReviewSessionLockInfo = { path, ownerStatus: "unknown", recovery: "manual-only" };
  try {
    const owner = JSON.parse(readFileSync(join(path, "owner.json"), "utf8"));
    if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0 || owner.host !== hostname()) return info;
    info.ownerPid = owner.pid;
    try {
      process.kill(owner.pid, 0);
      // A responding PID is not proof that it is the process which created this lock.
      info.ownerStatus = "present-or-reused";
    } catch (error) {
      if (errorCode(error) === "ESRCH") info.ownerStatus = "dead";
    }
  } catch {
    // A crash during creation/release or unreadable ownership also fails closed.
  }
  return info;
}

/**
 * One local-filesystem mutex covers snapshot comparisons, replacements, deletion and index updates.
 * Contention never waits. There is deliberately no age/PID-based lock stealing: Node has no portable
 * process-start identity or conditional unlink. Even confirmed dead owners require manual recovery
 * with all writers stopped. Network/shared filesystems and mixed older writers are not supported.
 */
export function withReviewSessionLock<T>(directory: string, operation: () => T): T {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, ".write-lock");
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (errorCode(error) === "EEXIST") throw new ReviewSessionLockedError(inspectLock(path));
    throw error;
  }
  const ownerPath = join(path, "owner.json");
  const owner = JSON.stringify({ pid: process.pid, host: hostname(), token: randomUUID(), createdAt: new Date().toISOString() });
  try {
    writeFileSync(ownerPath, owner, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    // No snapshot operation ran. Leave partial ownership in place rather than guessing at recovery.
    throw error;
  }
  try {
    return operation();
  } finally {
    // Never remove a replacement lock or recursively delete unexpected files.
    // A release failure leaves future writes blocked, without misreporting a completed replacement.
    try {
      if (readFileSync(ownerPath, "utf8") === owner) {
        unlinkSync(ownerPath);
        rmdirSync(path);
      }
    } catch { /* Fail closed; the next writer receives explicit lock diagnostics. */ }
  }
}

/** Atomic replacement for process interruption; no fsync/power-loss durability guarantee. */
export function writeReviewSessionFileAtomic(path: string, contents: string): void {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temporaryPath, path);
  } catch (error) {
    try { unlinkSync(temporaryPath); } catch { /* Preserve the original failure. */ }
    throw error;
  }
}
