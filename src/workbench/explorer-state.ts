import { TREE_FILE_CAP, TREE_RESTORED_FILE_CAP, type RepositoryTreeKey, type RepositoryTreeSnapshot } from "./tree.js";

export const EXPLORER_STATE_VERSION = 2 as const;
export const DEFAULT_EXPLORER_STATE_REPOSITORY_CAP = 32;
export const DEFAULT_EXPLORER_STATE_EXPANDED_FOLDER_CAP = 512;
export const DEFAULT_EXPLORER_STATE_REVEALED_FOLDER_CAP = 128;

/** Stable tree viewport coordinates retained with one Explorer snapshot. */
export interface ExplorerViewport {
  readonly topKey: RepositoryTreeKey;
  readonly selectedOffset: number;
}

/** Process-lifetime Explorer state for one canonical repository root. */
export interface ExplorerState extends RepositoryTreeSnapshot {
  readonly version: typeof EXPLORER_STATE_VERSION;
  readonly selectedKey?: RepositoryTreeKey;
  /** Required for every saved v2 snapshot; values are cloned at the store boundary. */
  readonly viewport: ExplorerViewport;
}

export interface ExplorerStateSession {
  load(): ExplorerState | undefined;
  save(state: ExplorerState): void;
}

export interface ExplorerStateStore {
  /** A missing workspace identity deliberately has no shared state. */
  forWorkspace(workspaceKey: string | undefined): ExplorerStateSession | undefined;
}

export interface ExplorerStateStoreOptions {
  maxRepositories?: number;
  maxExpandedFolders?: number;
  maxRevealedFolders?: number;
}

function bounded(value: number | undefined, fallback: number): number {
  return value == null || !Number.isFinite(value) ? fallback : Math.max(0, Math.floor(value));
}

function cloneState(state: ExplorerState, maxExpandedFolders: number, maxRevealedFolders: number): ExplorerState | undefined {
  if (state.version !== EXPLORER_STATE_VERSION || state.viewport == null || !Array.isArray(state.expandedFolderKeys) || !Array.isArray(state.revealedFolders)) return undefined;
  const revealedFolders = state.revealedFolders
    .filter((entry) => entry != null && typeof entry.key === "string" && entry.key.startsWith("folder:") && Number.isFinite(entry.visibleFileCount))
    .slice(0, maxRevealedFolders)
    .map((entry) => ({
      key: entry.key,
      visibleFileCount: Math.min(TREE_RESTORED_FILE_CAP, Math.max(TREE_FILE_CAP, Math.floor(entry.visibleFileCount))),
    }));
  return {
    version: EXPLORER_STATE_VERSION,
    expandedFolderKeys: [...state.expandedFolderKeys].slice(0, maxExpandedFolders),
    revealedFolders,
    ...(state.selectedKey == null ? {} : { selectedKey: state.selectedKey }),
    viewport: {
      topKey: state.viewport.topKey,
      selectedOffset: bounded(state.viewport.selectedOffset, 0),
    },
  };
}

/**
 * Creates a bounded, host-neutral LRU store. It intentionally has no persistence
 * hooks: entries disappear when this JavaScript process exits.
 */
export function createExplorerStateStore(options: ExplorerStateStoreOptions = {}): ExplorerStateStore {
  const maxRepositories = bounded(options.maxRepositories, DEFAULT_EXPLORER_STATE_REPOSITORY_CAP);
  const maxExpandedFolders = bounded(options.maxExpandedFolders, DEFAULT_EXPLORER_STATE_EXPANDED_FOLDER_CAP);
  const maxRevealedFolders = bounded(options.maxRevealedFolders, DEFAULT_EXPLORER_STATE_REVEALED_FOLDER_CAP);
  const states = new Map<string, ExplorerState>();

  const touch = (workspaceKey: string): ExplorerState | undefined => {
    const state = states.get(workspaceKey);
    if (state == null) return undefined;
    states.delete(workspaceKey);
    states.set(workspaceKey, state);
    return state;
  };

  return {
    forWorkspace(workspaceKey) {
      if (workspaceKey == null) return undefined;
      return {
        load() {
          const state = touch(workspaceKey);
          return state == null ? undefined : cloneState(state, maxExpandedFolders, maxRevealedFolders);
        },
        save(state) {
          const cloned = cloneState(state, maxExpandedFolders, maxRevealedFolders);
          if (cloned == null || maxRepositories === 0) return;
          states.delete(workspaceKey);
          states.set(workspaceKey, cloned);
          while (states.size > maxRepositories) states.delete(states.keys().next().value!);
        },
      };
    },
  };
}

/** Shared default for all workbenches mounted in this process. */
export const processExplorerStateStore = createExplorerStateStore();
