import { describe, expect, it } from "vitest";
import { createRepositoryTree } from "../workbench/tree.js";

describe("repository folder tree", () => {
  it("builds a nested hierarchy with root files and collapsed directories", () => {
    const tree = createRepositoryTree(["README.md", "src/app/main.ts", "src/index.ts"]);

    expect(tree.rows()).toEqual([
      { type: "folder", key: "folder:", path: "", name: ".", depth: 0, expanded: true },
      { type: "folder", key: "folder:src", path: "src", name: "src", depth: 1, expanded: false },
      { type: "file", key: "file:README.md", path: "README.md", name: "README.md", depth: 1 },
    ]);

    tree.expandFolder("src");
    tree.expandFolder("src/app");
    expect(tree.rows().map((row) => row.path)).toEqual(["", "src", "src/app", "src/app/main.ts", "src/index.ts", "README.md"]);
  });

  it("toggles folders and finds their parent folders", () => {
    const tree = createRepositoryTree(["src/app/main.ts"]);

    expect(tree.toggleFolder("src")).toBe(true);
    expect(tree.rows().find((row) => row.path === "src")?.type).toBe("folder");
    expect(tree.toggleFolder("src")).toBe(false);
    expect(tree.parentFolder("src/app")).toBe("src");
    expect(tree.parentFolder("src")).toBe("");
    expect(tree.parentFolder("")).toBeNull();
    expect(tree.parentFolder("src/app/main.ts")).toBe("src/app");
  });

  it("sorts folders before files with stable lexical ordering at every level", () => {
    const tree = createRepositoryTree(["z.ts", "b/a.ts", "a.ts", "a/z.ts", "a/a.ts", "b.ts"]);
    tree.expandFolder("a");
    tree.expandFolder("b");

    expect(tree.rows().map((row) => row.path)).toEqual(["", "a", "a/a.ts", "a/z.ts", "b", "b/a.ts", "a.ts", "b.ts", "z.ts"]);
  });

  it("caps immediate files at 20 and provides a stable more row with remaining count", () => {
    const tree = createRepositoryTree(Array.from({ length: 23 }, (_, index) => `file-${String(index).padStart(2, "0")}.ts`));
    const rows = tree.rows();

    expect(rows.filter((row) => row.type === "file")).toHaveLength(20);
    expect(rows.at(-1)).toEqual({ type: "more", key: "more:", path: "", depth: 1, remaining: 3 });
  });

  it("reveals only one bounded page in a huge flat folder", () => {
    const fileCount = 100_000;
    const tree = createRepositoryTree(Array.from({ length: fileCount }, (_, index) => `bulk/file-${String(index).padStart(6, "0")}.ts`));
    tree.expandFolder("bulk");

    expect(tree.revealFolder("bulk")).toBe(true);
    const rows = tree.rows();
    expect(rows.filter((row) => row.type === "file")).toHaveLength(40);
    expect(rows.at(-1)).toEqual({ type: "more", key: "more:bulk", path: "bulk", depth: 2, remaining: fileCount - 40 });
  });

  it("restores at most two visible pages per folder", () => {
    const paths = Array.from({ length: 100 }, (_, index) => `bulk/file-${String(index).padStart(3, "0")}.ts`);
    const source = createRepositoryTree(paths);
    source.expandFolder("bulk");
    source.revealFolder("bulk");
    source.revealFolder("bulk");
    source.revealFolder("bulk");
    expect(source.snapshot().revealedFolders).toEqual([{ key: "folder:bulk", visibleFileCount: 80 }]);

    const restored = createRepositoryTree(paths);
    restored.restore(source.snapshot());
    expect(restored.rows().filter((row) => row.type === "file")).toHaveLength(40);
    expect(restored.snapshot().revealedFolders).toEqual([{ key: "folder:bulk", visibleFileCount: 40 }]);
  });

  it("reveals files for only the activated folder", () => {
    const files = Array.from({ length: 22 }, (_, index) => `a/file-${index}.ts`)
      .concat(Array.from({ length: 21 }, (_, index) => `b/file-${index}.ts`));
    const tree = createRepositoryTree(files);
    tree.expandFolder("a");
    tree.expandFolder("b");

    expect(tree.revealFolder("a")).toBe(true);
    const rows = tree.rows();
    expect(rows.filter((row) => row.type === "file" && row.path.startsWith("a/")).length).toBe(22);
    expect(rows.find((row) => row.key === "more:b")).toEqual({ type: "more", key: "more:b", path: "b", depth: 2, remaining: 1 });
  });

  it("preserves unusual valid path characters without parsing them as delimiters", () => {
    const tree = createRepositoryTree(["[a]: folder/space #?.ts", "[a]: folder/line\nname.ts", "emoji 😀/file.ts"]);
    tree.expandFolder("[a]: folder");

    expect(tree.rows().map((row) => row.path)).toEqual(["", "[a]: folder", "[a]: folder/line\nname.ts", "[a]: folder/space #?.ts", "emoji 😀"]);
  });

  it("returns capped fuzzy file rows with full paths and leaves tree rows unchanged for a blank query", () => {
    const files = Array.from({ length: 300 }, (_, index) => `packages/app/src/Component${String(index).padStart(3, "0")}.tsx`);
    const tree = createRepositoryTree(files);
    const before = tree.rows();

    const results = tree.searchFiles("component");
    if (results == null) throw new Error("non-empty query must return results");
    expect(results).toHaveLength(200);
    expect(results[0]).toMatchObject({ type: "file", key: "file:packages/app/src/Component000.tsx", path: "packages/app/src/Component000.tsx" });
    expect(results.at(-1)?.path).toBe("packages/app/src/Component199.tsx");
    expect(tree.searchFiles("   ")).toBeNull();
    expect(tree.rows()).toEqual(before);
  });

  it("uses stable, type-prefixed keys for every row kind", () => {
    const tree = createRepositoryTree(Array.from({ length: 21 }, (_, index) => `src/file-${index}.ts`));
    tree.expandFolder("src");

    expect(tree.rows().map((row) => row.key)).toEqual(expect.arrayContaining(["folder:", "folder:src", "file:src/file-0.ts", "more:src"]));
  });

  it("round-trips expanded and independently revealed folders structurally", () => {
    const paths = Array.from({ length: 21 }, (_, index) => `src/file-${index}.ts`).concat("lib/util.ts");
    const source = createRepositoryTree(paths);
    source.expandFolder("src");
    source.revealFolder("src");
    source.expandFolder("lib");

    const restored = createRepositoryTree(paths);
    const selected = restored.restore(source.snapshot(), "file:src/file-20.ts");

    expect(restored.snapshot()).toEqual(source.snapshot());
    expect(selected).toBe("file:src/file-20.ts");
    expect(restored.indexOfKey("file:src/file-20.ts")).toBe(restored.rows().findIndex((row) => row.key === "file:src/file-20.ts"));
    expect(restored.indexOfKey("file:missing.ts")).toBeUndefined();
    expect(restored.rows()).toBe(restored.rows());
  });

  it("expands a preferred deep file's containing folder from an otherwise collapsed snapshot", () => {
    const tree = createRepositoryTree(["src/app/main.ts", "README.md"]);

    expect(tree.restore({ expandedFolderKeys: [], revealedFolders: [] }, "file:src/app/main.ts")).toBe("file:src/app/main.ts");
    expect(tree.rows().map((row) => row.key)).toEqual([
      "folder:",
      "folder:src",
      "folder:src/app",
      "file:src/app/main.ts",
      "file:README.md",
    ]);
  });

  it("restores a preferred file in a huge capped folder without materializing its siblings", () => {
    const fileCount = 100_000;
    const preferredPath = `src/file-${String(fileCount - 1).padStart(6, "0")}.ts`;
    const tree = createRepositoryTree(Array.from({ length: fileCount }, (_, index) => `src/file-${String(index).padStart(6, "0")}.ts`));

    expect(tree.restore({ expandedFolderKeys: [], revealedFolders: [] }, `file:${preferredPath}`)).toBe(`file:${preferredPath}`);
    const rows = tree.rows();
    expect(rows.filter((row) => row.type === "file")).toHaveLength(21);
    expect(rows.some((row) => row.key === `file:${preferredPath}`)).toBe(true);
    expect(rows.at(-1)).toEqual({ type: "more", key: "more:src", path: "src", depth: 2, remaining: fileCount - 21 });
  });

  it("reveals a preferred capped file when its folder was omitted from the snapshot", () => {
    const tree = createRepositoryTree(Array.from({ length: 21 }, (_, index) => `src/file-${String(index).padStart(2, "0")}.ts`));

    expect(tree.restore({ expandedFolderKeys: [], revealedFolders: [] }, "file:src/file-20.ts")).toBe("file:src/file-20.ts");
    expect(tree.rows().at(-1)?.key).toBe("file:src/file-20.ts");
    expect(tree.snapshot()).toEqual({ expandedFolderKeys: ["folder:", "folder:src"], revealedFolders: [] });
  });

  it("clears only tracked active folders before restoring a replacement snapshot", () => {
    const tree = createRepositoryTree(["src/app/main.ts", "lib/util.ts"]);
    tree.expandFolder("src");
    tree.expandFolder("src/app");
    tree.revealFolder("src/app");
    tree.expandFolder("lib");

    tree.restore({ expandedFolderKeys: ["folder:lib"], revealedFolders: [] });

    expect(tree.snapshot()).toEqual({ expandedFolderKeys: ["folder:", "folder:lib"], revealedFolders: [] });
    expect(tree.rows().map((row) => row.key)).toEqual(["folder:", "folder:lib", "file:lib/util.ts", "folder:src"]);
  });

  it("ignores stale or wrong-kind state and falls back through a surviving ancestor to root", () => {
    const tree = createRepositoryTree(["src/app/main.ts", "README.md"]);

    const wrongExpandedKind = ["file:README.md"] as unknown as `folder:${string}`[];
    const wrongRevealedKind = ["file:README.md"] as unknown as Array<{ key: `folder:${string}`; visibleFileCount: number }>;
    expect(tree.restore({ expandedFolderKeys: wrongExpandedKind, revealedFolders: wrongRevealedKind }, "file:src/missing.ts")).toBe("folder:src");
    expect(tree.rows().map((row) => row.key)).toEqual(["folder:", "folder:src", "folder:src/app", "file:README.md"]);
    expect(tree.restore({ expandedFolderKeys: ["folder:gone"], revealedFolders: [{ key: "folder:gone", visibleFileCount: 40 }] }, "file:gone.ts")).toBe("folder:");
  });
});
