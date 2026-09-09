import { lstatSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { withReviewCompositionStore } from "./review-session.js";
import { writeReviewSessionFileAtomic } from "./review-session-persistence.js";
import type { ReviewComposition, ReviewCompositionTarget } from "./types.js";

export const COMPOSITION_FLUSH_MS = 2_000;
export const COMPOSITION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const COMPOSITION_MAX_BYTES = 256 * 1024;
export const COMPOSITION_MAX_RECORDS = 64;
export const COMPOSITION_STORE_MAX_BYTES = 16 * 1024 * 1024;

interface StoredComposition extends ReviewComposition {
  version: 1;
  identity: string;
  sessionId: string;
  updatedAt: string;
}
const validId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
const record = (value: unknown): value is Record<string, unknown> => value != null && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const scope = (value: unknown) => value === "git-diff" || value === "last-commit" || value === "all-files";
const hash = (value: unknown) => record(value) && value.algorithm === "sha256" && typeof value.value === "string" && /^[0-9a-f]{64}$/.test(value.value);

function validTarget(value: unknown): value is ReviewCompositionTarget {
  if (!record(value) || typeof value.initialBody !== "string" || !["discuss", "comment", "modify"].includes(String(value.intent))) return false;
  if (value.kind === "all") return value.intent !== "modify";
  if (typeof value.fileId !== "string" || !scope(value.scope)) return false;
  if (value.kind === "file") return value.intent !== "modify" && (value.fileTarget === "file" || value.fileTarget === "all-lines")
    && (value.label == null || typeof value.label === "string");
  return value.kind === "line" && (value.side === "added" || value.side === "deleted")
    && integer(value.startLine) && value.startLine > 0 && integer(value.endLine) && value.endLine >= value.startLine
    && (value.originalText == null || typeof value.originalText === "string")
    && (value.captureHash == null || hash(value.captureHash))
    && (value.anchorStatus == null || value.anchorStatus === "mapped" || value.anchorStatus === "stale")
    && (value.existingComment == null || (record(value.existingComment) && typeof value.existingComment.id === "string"
      && typeof value.existingComment.body === "string" && value.existingComment.fileId === value.fileId
      && value.existingComment.scope === value.scope && value.existingComment.side === value.side
      && (value.existingComment.startLine === null || (integer(value.existingComment.startLine) && value.existingComment.startLine > 0))
      && (value.existingComment.endLine === null || (integer(value.existingComment.endLine) && value.existingComment.endLine > 0))
      && ["discuss", "comment", "modify"].includes(String(value.existingComment.intent))
      && (value.existingComment.originalText == null || typeof value.existingComment.originalText === "string")
      && (value.existingComment.captureHash == null || hash(value.existingComment.captureHash))
      && (value.existingComment.anchorStatus == null || value.existingComment.anchorStatus === "mapped" || value.existingComment.anchorStatus === "stale")));
}
function validComposition(value: unknown): value is ReviewComposition {
  return record(value) && typeof value.id === "string" && validId(value.id) && typeof value.repoRoot === "string"
    && (value.path == null || typeof value.path === "string") && validTarget(value.target)
    && typeof value.baseBody === "string" && typeof value.text === "string" && record(value.cursor) && integer(value.cursor.line) && integer(value.cursor.col)
    && (value.selection == null || (record(value.selection) && (value.selection.side === "added" || value.selection.side === "deleted")
      && integer(value.selection.line) && value.selection.line > 0 && (value.selection.endLine == null || (integer(value.selection.endLine) && value.selection.endLine > 0))));
}
function validStored(value: unknown): value is StoredComposition {
  return validComposition(value) && "version" in value && value.version === 1
    && "identity" in value && typeof value.identity === "string" && "sessionId" in value && typeof value.sessionId === "string"
    && "updatedAt" in value && typeof value.updatedAt === "string" && Number.isFinite(Date.parse(value.updatedAt));
}

/** Caller holds the snapshot store mutex. Unknown files count against capacity and are never evicted. */
function scan(directory: string): Array<{ name: string; bytes: number; value?: StoredComposition }> {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    const stats = lstatSync(path);
    const bytes = stats.size;
    let value: StoredComposition | undefined;
    if (stats.isFile() && bytes <= COMPOSITION_MAX_BYTES && name.endsWith(".json")) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
        if (validStored(parsed) && name === `${parsed.id}.json`) value = parsed;
      } catch { /* Unknown content is retained, not treated as expired. */ }
    }
    if (value != null && Date.now() - Date.parse(value.updatedAt) > COMPOSITION_TTL_MS) {
      unlinkSync(path);
      return [];
    }
    return [{ name, bytes, value }];
  });
}

/** Independent UUIDs are writer-owned. Recovery forks a new UUID rather than updating a selected copy. */
export function saveReviewComposition(identity: string, sessionId: string, composition: ReviewComposition): void {
  if (!validComposition(composition)) throw new Error("Invalid composition identity, target, or cursor");
  const value: StoredComposition = { ...composition, version: 1, identity, sessionId, updatedAt: new Date().toISOString() };
  const text = `${JSON.stringify(value)}\n`;
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > COMPOSITION_MAX_BYTES) throw new Error(`Composition exceeds ${COMPOSITION_MAX_BYTES} bytes; text was not truncated`);
  withReviewCompositionStore(identity, sessionId, (directory, active) => {
    if (!active) throw new Error("Composition requires an active review snapshot; missing or terminal instances cannot be recovered");
    const files = scan(directory);
    const name = `${composition.id}.json`;
    const previous = files.find((file) => file.name === name);
    if (previous != null && (previous.value?.identity !== identity || previous.value?.sessionId !== sessionId)) throw new Error("Composition identity conflicts with stored recovery");
    const retained = files.filter((file) => file.name !== name);
    if (retained.length >= COMPOSITION_MAX_RECORDS || files.reduce((sum, file) => sum + file.bytes, 0) + bytes > COMPOSITION_STORE_MAX_BYTES) {
      // Include the old record while reserving space for atomic replacement's temporary file.
      throw new Error("Composition recovery capacity reached; existing text was retained");
    }
    writeReviewSessionFileAtomic(join(directory, name), text);
  });
}

export function listReviewCompositions(identity: string, sessionId: string): ReviewComposition[] {
  return withReviewCompositionStore(identity, sessionId, (directory, active) => {
    if (!active) return [];
    const files = scan(directory);
    if (files.some((file) => file.name.endsWith(".json") && file.value == null)) throw new Error("Invalid composition recovery file; retained for manual inspection");
    return files.flatMap(({ value }) => value?.identity === identity && value.sessionId === sessionId ? [value] : [])
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  });
}

export function removeReviewComposition(identity: string, sessionId: string, id: string): void {
  if (!validId(id)) throw new Error("Invalid composition identity");
  withReviewCompositionStore(identity, sessionId, (directory, active) => {
    if (!active) throw new Error("Composition requires an active review snapshot");
    const file = scan(directory).find((candidate) => candidate.name === `${id}.json`);
    if (file == null) return;
    if (file.value?.identity !== identity || file.value?.sessionId !== sessionId) throw new Error("Composition identity conflicts with stored recovery");
    unlinkSync(join(directory, file.name));
  });
}
