import { opendir, realpath } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** Hard bounds for the non-Git listing path; source reads remain lazy. */
export const FILESYSTEM_LIST_MAX_FILES = 100_000;
export const FILESYSTEM_LIST_MAX_DIRECTORIES = 100_000;
export const FILESYSTEM_LIST_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

// Keep the fallback useful for source trees without crawling dependency, VCS,
// generated, or build/cache output. Git remains authoritative when available.
const IGNORED_DIRECTORY_NAMES = new Set([
  ".git", ".hg", ".svn", "node_modules", "coverage", ".vitest",
  "dist", "build", "out", "target", "generated", "cache", ".cache",
  ".next", ".nuxt", ".turbo", "tmp",
]);

export type FilesystemFileLister = (signal: AbortSignal) => Promise<string>;
export type FilesystemDirectoryHandle = AsyncIterable<Dirent> & { close(): Promise<void> };
export type FilesystemDirectoryOpener = (path: string) => Promise<FilesystemDirectoryHandle>;

/** Optional bounded seams used by focused callers/tests; defaults preserve production limits. */
export interface FilesystemListingOptions {
  maxFiles?: number;
  maxDirectories?: number;
  maxOutputBytes?: number;
  openDirectory?: FilesystemDirectoryOpener;
}

function isContained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("Filesystem file listing aborted.");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function ignoredDirectory(entry: Dirent): boolean {
  return entry.isDirectory() && IGNORED_DIRECTORY_NAMES.has(entry.name);
}

function relativePath(root: string, candidate: string): string | null {
  if (!isContained(root, candidate)) return null;
  const path = relative(root, candidate).split(sep).join("/");
  return path.length === 0 || path.includes("\0") || path.startsWith("/") || path.split("/").includes("..") ? null : path;
}

interface Candidate {
  readonly entry: Dirent;
  readonly candidate: string;
  readonly path: string;
}

/** Paths, rather than per-directory names, define the deterministic global order. */
function compareCandidates(left: Candidate, right: Candidate): number {
  if (left.path < right.path) return -1;
  if (left.path > right.path) return 1;
  // A malformed injected directory/file tie must still expand the directory first.
  if (left.entry.isDirectory() !== right.entry.isDirectory()) return left.entry.isDirectory() ? -1 : 1;
  return 0;
}

/** Keeps only the lexicographically smallest entries without materializing a directory. */
function retainCandidate(heap: Candidate[], candidate: Candidate, limit: number): void {
  if (limit <= 0) return;
  if (heap.length < limit) {
    heap.push(candidate);
    let index = heap.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (compareCandidates(heap[parent], heap[index]) >= 0) break;
      [heap[parent], heap[index]] = [heap[index], heap[parent]];
      index = parent;
    }
    return;
  }
  if (compareCandidates(candidate, heap[0]) >= 0) return;
  heap[0] = candidate;
  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    const right = left + 1;
    let largest = index;
    if (left < heap.length && compareCandidates(heap[left], heap[largest]) > 0) largest = left;
    if (right < heap.length && compareCandidates(heap[right], heap[largest]) > 0) largest = right;
    if (largest === index) break;
    [heap[index], heap[largest]] = [heap[largest], heap[index]];
    index = largest;
  }
}

interface DirectoryCursor {
  readonly files: Candidate[];
  readonly directories: Candidate[];
  fileIndex: number;
  directoryIndex: number;
}

interface FrontierItem {
  readonly cursor: DirectoryCursor;
  readonly candidate: Candidate;
}

function nextCursorCandidate(cursor: DirectoryCursor): Candidate | undefined {
  const file = cursor.files[cursor.fileIndex];
  const directory = cursor.directories[cursor.directoryIndex];
  if (file == null) return directory;
  if (directory == null) return file;
  return compareCandidates(file, directory) <= 0 ? file : directory;
}

function advanceCursor(cursor: DirectoryCursor, candidate: Candidate): void {
  if (candidate.entry.isDirectory()) cursor.directoryIndex += 1;
  else cursor.fileIndex += 1;
}

function pushFrontier(heap: FrontierItem[], item: FrontierItem): void {
  heap.push(item);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (compareCandidates(heap[parent].candidate, heap[index].candidate) <= 0) break;
    [heap[parent], heap[index]] = [heap[index], heap[parent]];
    index = parent;
  }
}

function popFrontier(heap: FrontierItem[]): FrontierItem {
  const first = heap[0];
  const last = heap.pop()!;
  if (heap.length > 0) {
    heap[0] = last;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (left < heap.length && compareCandidates(heap[left].candidate, heap[smallest].candidate) < 0) smallest = left;
      if (right < heap.length && compareCandidates(heap[right].candidate, heap[smallest].candidate) < 0) smallest = right;
      if (smallest === index) break;
      [heap[index], heap[smallest]] = [heap[smallest], heap[index]];
      index = smallest;
    }
  }
  return first;
}

/**
 * Creates an abortable, read-only fallback listing. Directory handles stream
 * entries incrementally, symlinks are never followed, and all ordinary
 * filesystem failures are skipped so a broken subtree cannot block launch.
 *
 * Every visited directory is a bounded cursor: it retains only the smallest
 * maxFiles files and maxDirectories directories. A global min-heap merges one
 * next candidate from each cursor by complete relative path. Thus a directory
 * is counted only when its candidate is popped, and descendants are admitted
 * to the same global order before any file cap or byte cap is applied.
 */
export function createFilesystemFileLister(rootPath: string, options: FilesystemListingOptions = {}): FilesystemFileLister {
  const cap = (value: number | undefined, fallback: number): number => {
    if (value == null || !Number.isFinite(value)) return fallback;
    return Math.max(0, Math.floor(value));
  };
  const maxFiles = cap(options.maxFiles, FILESYSTEM_LIST_MAX_FILES);
  const maxDirectories = cap(options.maxDirectories, FILESYSTEM_LIST_MAX_DIRECTORIES);
  const maxOutputBytes = cap(options.maxOutputBytes, FILESYSTEM_LIST_MAX_OUTPUT_BYTES);
  const openDirectory: FilesystemDirectoryOpener = options.openDirectory
    ?? ((path) => opendir(path, { bufferSize: 32 }));

  return async (signal) => {
    const root = rootPath;
    const files: string[] = [];
    const frontier: FrontierItem[] = [];
    let directoryCount = 0;
    let outputBytes = 0;
    let limitReached = false;

    const visitDirectory = async (directory: string): Promise<DirectoryCursor | undefined> => {
      throwIfAborted(signal);
      let canonicalDirectory: string;
      try {
        canonicalDirectory = await realpath(directory);
      } catch (error) {
        if (signal.aborted) throw abortReason(signal);
        return undefined;
      }
      if (!isContained(root, canonicalDirectory)) return undefined;

      let handle: FilesystemDirectoryHandle | undefined;
      try {
        handle = await openDirectory(canonicalDirectory);
        const fileCandidates: Candidate[] = [];
        const directoryCandidates: Candidate[] = [];
        for await (const entry of handle) {
          throwIfAborted(signal);
          if (entry.name.includes("\0") || entry.isSymbolicLink() || entry.name === "." || entry.name === ".." || entry.name === ".git") continue;
          if (ignoredDirectory(entry)) continue;

          const candidate = resolve(canonicalDirectory, entry.name);
          const path = relativePath(root, candidate);
          if (path == null || (!entry.isDirectory() && !entry.isFile())) continue;
          const candidateEntry = { entry, candidate, path };
          if (entry.isDirectory()) retainCandidate(directoryCandidates, candidateEntry, maxDirectories);
          else retainCandidate(fileCandidates, candidateEntry, maxFiles);
        }
        fileCandidates.sort(compareCandidates);
        directoryCandidates.sort(compareCandidates);
        return { files: fileCandidates, directories: directoryCandidates, fileIndex: 0, directoryIndex: 0 };
      } catch (error) {
        if (signal.aborted) throw abortReason(signal);
        // Permission races, disappearing directories, and malformed entries
        // are ordinary fallback misses; continue with the bounded frontier.
        return undefined;
      } finally {
        try { await handle?.close(); } catch (error) {
          if (signal.aborted) throw abortReason(signal);
        }
      }
    };

    // The root itself consumes one directory slot when it is visited.
    if (maxFiles > 0 && maxDirectories > 0) {
      throwIfAborted(signal);
      directoryCount = 1;
      const rootCursor = await visitDirectory(root);
      const rootCandidate = rootCursor == null ? undefined : nextCursorCandidate(rootCursor);
      if (rootCursor != null && rootCandidate != null) pushFrontier(frontier, { cursor: rootCursor, candidate: rootCandidate });
    }

    while (!limitReached && frontier.length > 0 && files.length < maxFiles) {
      throwIfAborted(signal);
      const item = popFrontier(frontier);
      const candidate = item.candidate;
      advanceCursor(item.cursor, candidate);
      const next = nextCursorCandidate(item.cursor);
      if (next != null) pushFrontier(frontier, { cursor: item.cursor, candidate: next });

      if (candidate.entry.isDirectory()) {
        // A slot is consumed only now, when this directory is the global next
        // candidate, never when its entry was retained or queued in a cursor.
        if (directoryCount >= maxDirectories) continue;
        directoryCount += 1;
        const cursor = await visitDirectory(candidate.candidate);
        const first = cursor == null ? undefined : nextCursorCandidate(cursor);
        if (cursor != null && first != null) pushFrontier(frontier, { cursor, candidate: first });
        continue;
      }

      // This is the globally next eligible file, so caps are checked only now.
      const bytes = Buffer.byteLength(candidate.path, "utf8") + 1;
      if (outputBytes + bytes > maxOutputBytes) {
        limitReached = true;
        break;
      }
      files.push(candidate.path);
      outputBytes += bytes;
      if (files.length >= maxFiles) limitReached = true;
    }

    throwIfAborted(signal);
    files.sort();
    return files.length === 0 ? "" : `${files.join("\0")}\0`;
  };
}
