import { createHash } from "node:crypto";
import type { CodeStory, CodeTarget, LineRange, TextAnchorHash, WorkbenchLaunch } from "./contracts.js";
import { isRepositoryRelativePath } from "./navigator.js";

export const MAX_STORIES = 50;
export const MAX_STORY_ID_BYTES = 128;
export const MAX_STORY_PROSE_BYTES = 2 * 1024;
export const MAX_NORMALIZED_LAUNCH_BYTES = 128 * 1024;

function fail(message: string): never { throw new Error(`Invalid workbench launch: ${message}`); }

function byteLength(text: string): number { return Buffer.byteLength(text, "utf8"); }

export function logicalLineCount(text: string): number {
  return text.split(/\r\n|\r|\n/).length;
}

export function clampLineRange(range: LineRange, text: string): LineRange {
  const lastLine = logicalLineCount(text);
  const startLine = Math.max(1, Math.min(range.startLine, lastLine));
  const endLine = Math.max(startLine, Math.min(range.endLine, lastLine));
  return { startLine, endLine };
}

/** Returns the exact source characters whose UTF-8 bytes form a target anchor. */
export function rawTextSliceForRange(text: string, range: LineRange): string {
  const starts = [0];
  const ends: number[] = [];
  const separators = /\r\n|\r|\n/g;
  for (let match = separators.exec(text); match != null; match = separators.exec(text)) {
    ends.push(match.index);
    starts.push(match.index + match[0].length);
  }
  ends.push(text.length);
  return text.slice(starts[range.startLine - 1]!, ends[range.endLine - 1]!);
}

export function hashTargetSlice(text: string, range: LineRange): TextAnchorHash {
  return { algorithm: "sha256", value: createHash("sha256").update(Buffer.from(rawTextSliceForRange(text, range), "utf8")).digest("hex") };
}

function normalizeRange(value: LineRange): LineRange {
  if (!Number.isFinite(value.startLine) || !Number.isInteger(value.startLine) || !Number.isFinite(value.endLine) || !Number.isInteger(value.endLine) || value.startLine < 1 || value.endLine < value.startLine) fail("target range must use ordered positive finite integers.");
  return { startLine: value.startLine, endLine: value.endLine };
}

function normalizeTarget(value: CodeTarget): CodeTarget {
  if (typeof value.path !== "string" || !isRepositoryRelativePath(value.path)) fail("target path must be normalized and repository-relative.");
  const range = normalizeRange(value.range);
  if (value.anchor == null) return { path: value.path, range };
  if (value.anchor.algorithm !== "sha256" || !/^[0-9a-f]{64}$/.test(value.anchor.value)) fail("anchor must be a lowercase SHA-256 hash.");
  return { path: value.path, range, anchor: { algorithm: "sha256", value: value.anchor.value } };
}

/** Validates caller-owned launch data and returns the canonical JSON-size-limited form. */
export function normalizeWorkbenchLaunch(value: WorkbenchLaunch = {}): WorkbenchLaunch {
  if (typeof value !== "object" || value == null) fail("launch must be an object.");
  const initialTarget = value.initialTarget == null ? undefined : normalizeTarget(value.initialTarget);
  let stories: readonly CodeStory[] | undefined;
  if (value.stories != null) {
    if (!Array.isArray(value.stories) || value.stories.length > MAX_STORIES) fail(`stories must contain at most ${MAX_STORIES} entries.`);
    const inputStories = value.stories;
    for (let index = 0; index < inputStories.length; index += 1) {
      if (!Object.hasOwn(inputStories, index)) fail("stories must not contain missing entries.");
    }
    const ids = new Set<string>();
    stories = inputStories.map((story) => {
      if (typeof story.id !== "string" || byteLength(story.id) > MAX_STORY_ID_BYTES || ids.has(story.id)) fail("story IDs must be unique and at most 128 UTF-8 bytes.");
      if (typeof story.prose !== "string" || byteLength(story.prose) > MAX_STORY_PROSE_BYTES) fail("story prose must be at most 2048 UTF-8 bytes.");
      ids.add(story.id);
      return { id: story.id, target: normalizeTarget(story.target), prose: story.prose };
    });
  }
  let capabilities: { discuss: boolean } | undefined;
  if (value.capabilities != null) {
    if (typeof value.capabilities.discuss !== "boolean") fail("capabilities.discuss must be boolean.");
    capabilities = { discuss: value.capabilities.discuss };
  }
  const normalized: WorkbenchLaunch = {};
  if (initialTarget != null) normalized.initialTarget = initialTarget;
  if (stories != null) normalized.stories = stories;
  if (capabilities != null) normalized.capabilities = capabilities;
  if (byteLength(JSON.stringify(normalized)) > MAX_NORMALIZED_LAUNCH_BYTES) fail(`normalized launch exceeds ${MAX_NORMALIZED_LAUNCH_BYTES} bytes.`);
  return normalized;
}
