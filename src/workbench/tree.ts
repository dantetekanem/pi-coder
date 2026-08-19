import { filterRepositoryFiles } from "./navigator.js";

export const TREE_FILE_CAP = 20;
export const TREE_RESTORED_FILE_CAP = TREE_FILE_CAP * 2;

export type RepositoryTreeKey = `folder:${string}` | `file:${string}` | `more:${string}`;

export interface FolderTreeRow {
  type: "folder";
  key: `folder:${string}`;
  path: string;
  name: string;
  depth: number;
  expanded: boolean;
}

export interface FileTreeRow {
  type: "file";
  key: `file:${string}`;
  path: string;
  name: string;
  depth: number;
}

export interface MoreTreeRow {
  type: "more";
  key: `more:${string}`;
  /** The expanded folder whose remaining immediate files this row reveals. */
  path: string;
  depth: number;
  remaining: number;
}

export type RepositoryTreeRow = FolderTreeRow | FileTreeRow | MoreTreeRow;

/** Structural state only: selection belongs to the owning Explorer session. */
export interface RevealedFolderSnapshot {
  readonly key: `folder:${string}`;
  readonly visibleFileCount: number;
}

export interface RepositoryTreeSnapshot {
  readonly expandedFolderKeys: readonly `folder:${string}`[];
  readonly revealedFolders: readonly RevealedFolderSnapshot[];
}

interface FolderNode {
  readonly path: string;
  readonly name: string;
  readonly folders: Map<string, FolderNode>;
  readonly files: string[];
  sortedFolders: readonly FolderNode[] | null;
  sortedFiles: readonly string[] | null;
  expanded: boolean;
  visibleFileCount: number;
  preferredFile: string | null;
}

export interface RepositoryTree {
  /** Root is always the first row and is permanently expanded. */
  rows(): readonly RepositoryTreeRow[];
  /** O(1) lookup derived and cached with rows(). */
  indexOfKey(key: RepositoryTreeKey): number | undefined;
  /** Captures valid expanded folders and bounded per-folder file counts without traversing rendered rows. */
  snapshot(): RepositoryTreeSnapshot;
  /** Restores structural flags and returns the visible preferred key or nearest folder fallback. */
  restore(snapshot: RepositoryTreeSnapshot, preferredKey?: RepositoryTreeKey): RepositoryTreeKey;
  /** Expands or collapses a folder and returns its resulting expanded state. */
  toggleFolder(path: string): boolean;
  /** Expands a folder; returns false when the path is not a folder. */
  expandFolder(path: string): boolean;
  /** Collapses a non-root folder; the root remains open. */
  collapseFolder(path: string): boolean;
  /** Returns a file or folder's containing folder, or null for the root. */
  parentFolder(path: string): string | null;
  /** Reveals one bounded page of immediate files without changing other folders. */
  revealFolder(path: string): boolean;
  /**
   * Returns up to 200 fuzzy-matched files. A blank query returns null so callers
   * can restore the unchanged tree rather than treating every file as a result.
   */
  searchFiles(query: string): readonly FileTreeRow[] | null;
}

function folderKey(path: string): `folder:${string}` { return `folder:${path}`; }
function fileKey(path: string): `file:${string}` { return `file:${path}`; }
function moreKey(path: string): `more:${string}` { return `more:${path}`; }
function lexical(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }

function sortedIndexOf(values: readonly string[], target: string): number {
  let low = 0;
  let high = values.length - 1;
  while (low <= high) {
    const middle = low + Math.floor((high - low) / 2);
    const comparison = lexical(values[middle]!, target);
    if (comparison === 0) return middle;
    if (comparison < 0) low = middle + 1;
    else high = middle - 1;
  }
  return -1;
}

function parentPath(path: string): string | null {
  if (path.length === 0) return null;
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

function folderPathFromKey(key: RepositoryTreeKey): string | undefined {
  if (key.startsWith("folder:")) return key.slice("folder:".length);
  if (key.startsWith("more:")) return key.slice("more:".length);
  if (key.startsWith("file:")) return parentPath(key.slice("file:".length)) ?? "";
  return undefined;
}

/**
 * Builds a metadata-only repository tree. The root is open; all other folders
 * start collapsed so large repositories never require an eager full flatten.
 */
export function createRepositoryTree(paths: readonly string[]): RepositoryTree {
  const root: FolderNode = { path: "", name: ".", folders: new Map(), files: [], sortedFolders: null, sortedFiles: null, expanded: true, visibleFileCount: TREE_FILE_CAP, preferredFile: null };
  const folders = new Map<string, FolderNode>([["", root]]);
  const files: string[] = [];
  const filePaths = new Set<string>();
  // These sets are the bounded structural state. Never scan every folder to save or reset it.
  const expandedFolderPaths = new Set<string>([""]);
  const revealedFolderPaths = new Set<string>();
  let preferredFolder: FolderNode | null = null;

  for (const path of paths) {
    if (path.length === 0) continue;
    const segments = path.split("/");
    segments.pop();
    let parent = root;
    let parentFolderPath = "";
    for (const segment of segments) {
      const pathForFolder = parentFolderPath.length === 0 ? segment : `${parentFolderPath}/${segment}`;
      let folder = folders.get(pathForFolder);
      if (folder == null) {
        folder = { path: pathForFolder, name: segment, folders: new Map(), files: [], sortedFolders: null, sortedFiles: null, expanded: false, visibleFileCount: TREE_FILE_CAP, preferredFile: null };
        folders.set(pathForFolder, folder);
        parent.folders.set(segment, folder);
      }
      parent = folder;
      parentFolderPath = pathForFolder;
    }
    parent.files.push(path);
    files.push(path);
    filePaths.add(path);
  }

  let cachedRows: readonly RepositoryTreeRow[] | null = null;
  let cachedKeyIndexes: ReadonlyMap<RepositoryTreeKey, number> | null = null;
  const invalidateRows = (): void => { cachedRows = null; cachedKeyIndexes = null; };

  const deriveRows = (): readonly RepositoryTreeRow[] => {
    if (cachedRows != null) return cachedRows;
    const rows: RepositoryTreeRow[] = [];
    const indexes = new Map<RepositoryTreeKey, number>();
    const add = (row: RepositoryTreeRow): void => { indexes.set(row.key, rows.length); rows.push(row); };
    const pending: Array<{ type: "folder"; folder: FolderNode; depth: number } | { type: "files"; folder: FolderNode; depth: number }> = [{ type: "folder", folder: root, depth: 0 }];
    while (pending.length > 0) {
      const task = pending.pop()!;
      if (task.type === "files") {
        const filePaths = task.folder.sortedFiles ??= [...task.folder.files].sort(lexical);
        const visibleFileCount = Math.min(filePaths.length, task.folder.visibleFileCount);
        const addFile = (path: string): void => {
          const slash = path.lastIndexOf("/");
          add({ type: "file", key: fileKey(path), path, name: slash === -1 ? path : path.slice(slash + 1), depth: task.depth + 1 });
        };
        for (const path of filePaths.slice(0, visibleFileCount)) addFile(path);
        const preferredFile = task.folder.preferredFile;
        const preferredIsExtra = preferredFile != null && sortedIndexOf(filePaths, preferredFile) >= visibleFileCount;
        if (preferredIsExtra) addFile(preferredFile);
        const remaining = filePaths.length - visibleFileCount - (preferredIsExtra ? 1 : 0);
        if (remaining > 0) add({ type: "more", key: moreKey(task.folder.path), path: task.folder.path, depth: task.depth + 1, remaining });
        continue;
      }
      const { folder, depth } = task;
      add({ type: "folder", key: folderKey(folder.path), path: folder.path, name: folder.name, depth, expanded: folder.expanded });
      if (!folder.expanded) continue;
      pending.push({ type: "files", folder, depth });
      const childFolders = folder.sortedFolders ??= [...folder.folders.values()].sort((left, right) => lexical(left.name, right.name));
      for (let index = childFolders.length - 1; index >= 0; index -= 1) pending.push({ type: "folder", folder: childFolders[index]!, depth: depth + 1 });
    }
    cachedRows = rows;
    cachedKeyIndexes = indexes;
    return cachedRows;
  };

  const setExpanded = (folder: FolderNode, expanded: boolean): boolean => {
    const next = folder === root || expanded;
    const changed = folder.expanded !== next;
    folder.expanded = next;
    if (next) expandedFolderPaths.add(folder.path);
    else expandedFolderPaths.delete(folder.path);
    return changed;
  };

  const setVisibleFileCount = (folder: FolderNode, visibleFileCount: number): boolean => {
    const next = Math.min(folder.files.length, Math.max(TREE_FILE_CAP, Math.floor(visibleFileCount)));
    const changed = folder.visibleFileCount !== next;
    folder.visibleFileCount = next;
    if (next > TREE_FILE_CAP) revealedFolderPaths.add(folder.path);
    else revealedFolderPaths.delete(folder.path);
    return changed;
  };

  const expandAncestors = (key: RepositoryTreeKey | undefined): void => {
    if (key == null) return;
    const path = folderPathFromKey(key);
    if (path == null) return;
    const includeContainingFolder = !key.startsWith("folder:");
    for (let candidate: string | null = includeContainingFolder ? path : parentPath(path); candidate != null; candidate = parentPath(candidate)) {
      const folder = folders.get(candidate);
      if (folder != null) setExpanded(folder, true);
    }
  };

  const visibleFallback = (preferredKey: RepositoryTreeKey | undefined): RepositoryTreeKey => {
    if (preferredKey != null && cachedKeyIndexes?.has(preferredKey)) return preferredKey;
    let path = preferredKey == null ? "" : folderPathFromKey(preferredKey) ?? "";
    while (true) {
      const key = folderKey(path);
      if (cachedKeyIndexes?.has(key)) return key;
      const parent = parentPath(path);
      if (parent == null) return folderKey("");
      path = parent;
    }
  };

  return {
    rows: deriveRows,
    indexOfKey(key) { deriveRows(); return cachedKeyIndexes?.get(key); },
    snapshot() {
      const expandedFolderKeys = [...expandedFolderPaths].sort(lexical).map(folderKey);
      const revealedFolders = [...revealedFolderPaths].sort(lexical).map((path) => ({
        key: folderKey(path),
        visibleFileCount: folders.get(path)!.visibleFileCount,
      }));
      return { expandedFolderKeys, revealedFolders };
    },
    restore(snapshot, preferredKey) {
      for (const path of expandedFolderPaths) folders.get(path)!.expanded = false;
      for (const path of revealedFolderPaths) folders.get(path)!.visibleFileCount = TREE_FILE_CAP;
      expandedFolderPaths.clear();
      revealedFolderPaths.clear();
      if (preferredFolder != null) preferredFolder.preferredFile = null;
      preferredFolder = null;
      setExpanded(root, true);
      for (const key of snapshot.expandedFolderKeys) {
        if (!key.startsWith("folder:")) continue;
        const folder = folders.get(key.slice("folder:".length));
        if (folder != null) setExpanded(folder, true);
      }
      for (const revealed of snapshot.revealedFolders) {
        if (revealed == null || typeof revealed.key !== "string" || !revealed.key.startsWith("folder:") || !Number.isFinite(revealed.visibleFileCount)) continue;
        const folder = folders.get(revealed.key.slice("folder:".length));
        if (folder != null) setVisibleFileCount(folder, Math.min(revealed.visibleFileCount, TREE_RESTORED_FILE_CAP));
      }
      expandAncestors(preferredKey);
      if (preferredKey?.startsWith("file:") && filePaths.has(preferredKey.slice("file:".length))) {
        const preferredPath = preferredKey.slice("file:".length);
        const folder = folders.get(parentPath(preferredPath) ?? "");
        if (folder != null) {
          folder.preferredFile = preferredPath;
          preferredFolder = folder;
        }
      }
      invalidateRows();
      deriveRows();
      return visibleFallback(preferredKey);
    },
    toggleFolder(path) {
      const folder = folders.get(path);
      if (folder == null) return false;
      if (folder === root) return true;
      setExpanded(folder, !folder.expanded);
      invalidateRows();
      return folder.expanded;
    },
    expandFolder(path) {
      const folder = folders.get(path);
      if (folder == null) return false;
      if (setExpanded(folder, true)) invalidateRows();
      return true;
    },
    collapseFolder(path) {
      const folder = folders.get(path);
      if (folder == null || folder === root) return false;
      if (setExpanded(folder, false)) invalidateRows();
      return true;
    },
    parentFolder: parentPath,
    revealFolder(path) {
      const folder = folders.get(path);
      if (folder == null || folder.visibleFileCount >= folder.files.length) return false;
      setVisibleFileCount(folder, folder.visibleFileCount + TREE_FILE_CAP);
      invalidateRows();
      return true;
    },
    searchFiles(query) {
      if (query.trim().length === 0) return null;
      return filterRepositoryFiles(files, query).map((path) => {
        const slash = path.lastIndexOf("/");
        return { type: "file", key: fileKey(path), path, name: slash === -1 ? path : path.slice(slash + 1), depth: 0 };
      });
    },
  };
}
