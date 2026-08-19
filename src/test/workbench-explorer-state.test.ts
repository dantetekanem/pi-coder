import { describe, expect, it } from "vitest";
import { EXPLORER_STATE_VERSION, createExplorerStateStore } from "../workbench/explorer-state.js";

describe("explorer state store", () => {
  it("returns no session without a canonical workspace key and isolates cloned states", () => {
    const store = createExplorerStateStore();
    expect(store.forWorkspace(undefined)).toBeUndefined();

    const session = store.forWorkspace("/repo");
    if (session == null) throw new Error("workspace session expected");
    const expandedFolderKeys: `folder:${string}`[] = ["folder:src"];
    const state = {
      version: EXPLORER_STATE_VERSION,
      expandedFolderKeys,
      revealedFolders: [{ key: "folder:src" as const, visibleFileCount: 22 }],
      selectedKey: "file:src/app.ts" as const,
      viewport: { topKey: "folder:src" as const, selectedOffset: 3 },
    };
    session.save(state);
    expandedFolderKeys.push("folder:mutated");

    const loaded = session.load();
    expect(loaded).toEqual({
      version: EXPLORER_STATE_VERSION,
      expandedFolderKeys: ["folder:src"],
      revealedFolders: [{ key: "folder:src", visibleFileCount: 22 }],
      selectedKey: "file:src/app.ts",
      viewport: { topKey: "folder:src", selectedOffset: 3 },
    });
    if (loaded == null) throw new Error("saved state expected");
    (loaded.expandedFolderKeys as string[]).push("folder:consumer-mutation");
    (loaded.viewport as { selectedOffset: number }).selectedOffset = 99;
    expect(session.load()?.expandedFolderKeys).toEqual(["folder:src"]);
    expect(session.load()?.viewport).toEqual({ topKey: "folder:src", selectedOffset: 3 });
  });

  it("uses LRU repository eviction, caps state lists, and rejects unknown versions", () => {
    const store = createExplorerStateStore({ maxRepositories: 2, maxExpandedFolders: 2, maxRevealedFolders: 1 });
    const save = (key: string, selectedKey: `file:${string}`) => {
      const session = store.forWorkspace(key);
      if (session == null) throw new Error("workspace session expected");
      session.save({
        version: EXPLORER_STATE_VERSION,
        expandedFolderKeys: ["folder:a", "folder:b", "folder:c"],
        revealedFolders: [
          { key: "folder:a", visibleFileCount: 1_000 },
          { key: "folder:b", visibleFileCount: 60 },
        ],
        selectedKey,
        viewport: { topKey: "folder:a", selectedOffset: 0 },
      });
      return session;
    };

    const first = save("/one", "file:one.ts");
    save("/two", "file:two.ts");
    expect(first.load()?.expandedFolderKeys).toEqual(["folder:a", "folder:b"]);
    expect(first.load()?.revealedFolders).toEqual([{ key: "folder:a", visibleFileCount: 40 }]);
    save("/three", "file:three.ts");

    expect(store.forWorkspace("/two")?.load()).toBeUndefined();
    expect(store.forWorkspace("/one")?.load()?.selectedKey).toBe("file:one.ts");
    expect(store.forWorkspace("/three")?.load()?.selectedKey).toBe("file:three.ts");

    const session = store.forWorkspace("/one");
    if (session == null) throw new Error("workspace session expected");
    session.save({ version: 99 as 2, expandedFolderKeys: [], revealedFolders: [], viewport: { topKey: "folder:", selectedOffset: 0 } });
    expect(session.load()?.selectedKey).toBe("file:one.ts");
  });

  it("normalizes the required versioned viewport to an isolated nonnegative integer offset", () => {
    const store = createExplorerStateStore();
    const session = store.forWorkspace("/repo");
    if (session == null) throw new Error("workspace session expected");

    session.save({
      version: EXPLORER_STATE_VERSION,
      expandedFolderKeys: [],
      revealedFolders: [],
      viewport: { topKey: "file:src/app.ts", selectedOffset: -2.5 },
    });

    expect(session.load()?.viewport).toEqual({ topKey: "file:src/app.ts", selectedOffset: 0 });
  });
});
