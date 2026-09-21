import { describe, expect, it } from "vitest";
import { generateDiffStory } from "../diff-story/generate.js";
import {
  createStorySnapshot,
  completeDiffStory,
  uncoveredStoryChanges,
  validateDiffStory,
  validateSavedDiffStory,
  type StoryFile,
} from "../diff-story/plan.js";
import { hashTargetSlice } from "../workbench/target.js";

function storyFile(
  fileId: string,
  path: string,
  originalContent: string,
  modifiedContent: string,
  options: Partial<StoryFile> = {},
): StoryFile {
  return {
    fileId,
    path,
    scope: "git-diff",
    contents: { originalContent, modifiedContent },
    ...options,
  };
}

function proposal(snapshot: ReturnType<typeof createStorySnapshot>) {
  return {
    version: 1,
    snapshot: snapshot.fingerprint,
    summary: "The change adds a parser and proves its behavior.",
    steps: [
      {
        id: "parse-input",
        title: "Parse the input",
        explanation: "The caller needs structured data, so the parser turns source text into values and the test checks that result.",
        implementation: [{ fileId: "app", side: "added", startLine: 2, endLine: 2 }],
        tests: [{ fileId: "spec", side: "added", startLine: 2, endLine: 2 }],
      },
    ],
  };
}

describe("diff story plans", () => {
  const files = [
    storyFile("app", "src/parser.ts", "export function parse() {}\n", "export function parse() {\n  return 1;\n}\n"),
    storyFile("spec", "src/parser.test.ts", "", "it('parses', () => {\n  expect(parse()).toBe(1);\n});\n", { hasOriginal: false }),
  ];

  it("captures exact revision bytes, factual counts, and stable fingerprints", () => {
    const first = createStorySnapshot(files);
    const second = createStorySnapshot(files);

    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first).toMatchObject({ additions: 6, deletions: 1 });
    expect(first.files[0]?.contents.modifiedContent).toContain("return 1");
    expect(first.changes).toEqual([
      { fileId: "app", path: "src/parser.ts", side: "deleted", startLine: 1, endLine: 1 },
      { fileId: "app", path: "src/parser.ts", side: "added", startLine: 1, endLine: 3 },
      { fileId: "spec", path: "src/parser.test.ts", side: "added", startLine: 1, endLine: 3 },
    ]);
  });

  it("records deletion-only changes on the original side", () => {
    const snapshot = createStorySnapshot([storyFile("removed", "src/legacy.ts", "export const legacy = true;\n", "", { hasModified: false })]);

    expect(snapshot).toMatchObject({ additions: 0, deletions: 1 });
    expect(snapshot.changes).toEqual([
      { fileId: "removed", path: "src/legacy.ts", side: "deleted", startLine: 1, endLine: 1 },
    ]);
    const story = validateDiffStory({
      version: 1,
      snapshot: snapshot.fingerprint,
      summary: "The unused legacy export is removed.",
      steps: [{
        id: "remove-legacy",
        title: "Remove the legacy export",
        explanation: "The revision drops the old export, leaving no replacement endpoint for this file.",
        implementation: [{ fileId: "removed", side: "deleted", startLine: 1, endLine: 1 }],
        tests: [],
      }],
    }, snapshot);

    expect(uncoveredStoryChanges(story, snapshot)).toEqual([]);
  });

  it("derives trusted hashes and preserves independent many-to-many source and test links", () => {
    const snapshot = createStorySnapshot(files);
    const raw = proposal(snapshot);
    raw.steps.push({
      id: "verify-parser",
      title: "Verify the parser",
      explanation: "The same implementation is exercised again for the observable return value.",
      implementation: [{ fileId: "app", side: "added", startLine: 2, endLine: 2 }],
      tests: [{ fileId: "spec", side: "added", startLine: 2, endLine: 2 }],
    });

    const story = validateDiffStory(raw, snapshot);
    expect(story.steps).toHaveLength(2);
    expect(story.steps[0]?.implementation[0]).toEqual({
      fileId: "app",
      side: "added",
      startLine: 2,
      endLine: 2,
      hash: hashTargetSlice(files[0]!.contents.modifiedContent, { startLine: 2, endLine: 2 }).value,
    });
    expect(uncoveredStoryChanges(story, snapshot)).toEqual([
      { fileId: "app", path: "src/parser.ts", side: "deleted", startLine: 1, endLine: 1 },
      { fileId: "app", path: "src/parser.ts", side: "added", startLine: 1, endLine: 1 },
      { fileId: "app", path: "src/parser.ts", side: "added", startLine: 3, endLine: 3 },
      { fileId: "spec", path: "src/parser.test.ts", side: "added", startLine: 1, endLine: 1 },
      { fileId: "spec", path: "src/parser.test.ts", side: "added", startLine: 3, endLine: 3 },
    ]);
  });

  it("permits a story without test associations and does not turn that absence into a coverage claim", () => {
    const snapshot = createStorySnapshot([storyFile("docs", "README.md", "old\n", "new\n")]);
    const story = validateDiffStory({
      version: 1,
      snapshot: snapshot.fingerprint,
      summary: "The documentation now names the new command.",
      steps: [{
        id: "document-command",
        title: "Name the command",
        explanation: "Readers need the command name before they can use it.",
        implementation: [{ fileId: "docs", side: "added", startLine: 1, endLine: 1 }],
        tests: [],
      }],
    }, snapshot);

    expect(story.steps[0]?.tests).toEqual([]);
    expect(uncoveredStoryChanges(story, snapshot)).toEqual([
      { fileId: "docs", path: "README.md", side: "deleted", startLine: 1, endLine: 1 },
    ]);
  });

  it.each([
    ["stale snapshot", (snapshot: ReturnType<typeof createStorySnapshot>) => ({ ...proposal(snapshot), snapshot: "0".repeat(64) })],
    ["unknown file", (snapshot: ReturnType<typeof createStorySnapshot>) => ({ ...proposal(snapshot), steps: [{ ...proposal(snapshot).steps[0]!, implementation: [{ fileId: "missing", side: "added", startLine: 1, endLine: 1 }] }] })],
    ["out-of-range line", (snapshot: ReturnType<typeof createStorySnapshot>) => ({ ...proposal(snapshot), steps: [{ ...proposal(snapshot).steps[0]!, implementation: [{ fileId: "app", side: "added", startLine: 99, endLine: 99 }] }] })],
    ["unavailable endpoint", (snapshot: ReturnType<typeof createStorySnapshot>) => ({ ...proposal(snapshot), steps: [{ ...proposal(snapshot).steps[0]!, implementation: [{ fileId: "app", side: "deleted", startLine: 1, endLine: 1 }] }] })],
  ])("rejects %s anchors", (_label, mutate) => {
    const unavailable = storyFile("app", "src/parser.ts", "", "new\n", { hasOriginal: false });
    const snapshot = createStorySnapshot([unavailable, files[1]!]);
    expect(() => validateDiffStory(mutate(snapshot), snapshot)).toThrow();
  });

  it("fails before generation when captured bytes are unreadable or binary", () => {
    expect(() => createStorySnapshot([
      storyFile("unreadable", "src/app.ts", "old\n", "new\n", { hasOriginal: true, contents: { originalContent: "old\n", modifiedContent: "new\n", originalAvailable: false } }),
    ])).toThrow(/unreadable/i);
    expect(() => createStorySnapshot([storyFile("binary", "asset.bin", "\u0000", "")])).toThrow(/control/i);
  });

  it("captures more than 100 files and complete endpoints larger than 8 MiB", () => {
    const content = "x".repeat(8 * 1024 * 1024 + 1);
    const snapshot = createStorySnapshot(Array.from({ length: 101 }, (_, index) =>
      storyFile(`file-${index}`, `file-${index}.ts`, "", index === 0 ? content : "value\n")));
    expect(snapshot.files).toHaveLength(101);
    expect(snapshot.files[0]!.contents.modifiedContent).toBe(content);
    expect(snapshot.additions).toBe(101);
  });

  it("preserves long identifiers, paths and prose with many steps and anchors", () => {
    const fileId = "f".repeat(4097);
    const path = `${"directory/".repeat(120)}file.ts`;
    const snapshot = createStorySnapshot([storyFile(fileId, path, "old\n", "new\n")]);
    const anchor = { fileId, side: "added", startLine: 1, endLine: 1 };
    const raw = {
      version: 1, snapshot: snapshot.fingerprint, summary: "s".repeat(2049),
      steps: Array.from({ length: 51 }, (_, index) => ({
        id: `${"i".repeat(129)}-${index}`, title: "t".repeat(257), explanation: "e".repeat(4097),
        implementation: Array.from({ length: 101 }, () => ({ ...anchor })),
        tests: Array.from({ length: 101 }, () => ({ ...anchor })),
      })),
    };
    const story = validateDiffStory(raw, snapshot);
    expect(story.summary).toBe(raw.summary);
    expect(story.steps).toHaveLength(51);
    expect(story.steps[50]).toMatchObject(raw.steps[50]!);
    expect(validateSavedDiffStory(story, snapshot)).toEqual(story);
    expect(snapshot.files[0]!.path).toBe(path);
  });

  it("completes omitted changes and expands a paired test without repeating its hunk", () => {
    const context = Array.from({ length: 10 }, (_, index) => `keep${index}()`).join("\n");
    const snapshot = createStorySnapshot([
      ...files,
      storyFile("extra", "extra.ts", `old()\n${context}\nremoved()\n`, `new()\n${context}\n`),
      storyFile("only-test", "other.test.ts", "", "assertOther()\n", { hasOriginal: false }),
    ]);
    const original = validateDiffStory(proposal(snapshot), snapshot);
    const completed = completeDiffStory(original, snapshot);

    expect(completed.steps[0]).toMatchObject({
      ...original.steps[0],
      tests: [expect.objectContaining({ fileId: "spec", startLine: 1, endLine: 3 })],
    });
    expect(original.steps).toHaveLength(1);
    expect(uncoveredStoryChanges(completed, snapshot)).toEqual([]);
    const extra = completed.steps.filter((step) => step.implementation.some((anchor) => anchor.fileId === "extra"));
    expect(extra).toHaveLength(2);
    expect(extra[0]?.implementation.map((anchor) => anchor.side)).toEqual(["added", "deleted"]);
    expect(extra[1]?.implementation).toEqual([expect.objectContaining({ side: "deleted", startLine: 12, endLine: 12 })]);
    expect(extra.every((step) => step.tests.length === 0)).toBe(true);
    expect(completed.steps.some((step) => step.implementation.some((anchor) => anchor.fileId === "only-test"))).toBe(true);
    expect(new Set(completed.steps.map((step) => step.id)).size).toBe(completed.steps.length);
    expect(completeDiffStory(completed, snapshot)).toEqual(completed);
    expect(validateSavedDiffStory(completed, snapshot)).toEqual(completed);
  });

  it("compares saved hashes exactly instead of remapping anchors", () => {
    const snapshot = createStorySnapshot(files);
    const saved = validateDiffStory(proposal(snapshot), snapshot);
    const stale = structuredClone(saved);
    stale.steps[0]!.implementation[0]!.hash = "0".repeat(64);

    expect(() => validateDiffStory(stale, snapshot)).toThrow(/hash/i);
    expect(() => validateSavedDiffStory(proposal(snapshot), snapshot)).toThrow(/hash/i);
    expect(validateSavedDiffStory(saved, snapshot)).toEqual(saved);
  });

  it("rejects an empty story and phantom EOF anchors", () => {
    const id = "app";
    const snapshot = createStorySnapshot([storyFile(id, "app.ts", "old\n", "new\n")]);
    const raw = {
      version: 1,
      snapshot: snapshot.fingerprint,
      summary: "A changed call",
      steps: [{
        id: "call",
        title: "Change the call",
        explanation: "The call changes.",
        implementation: [{ fileId: id, side: "added", startLine: 1, endLine: 1 }],
        tests: [],
      }],
    };
    expect(validateDiffStory(raw, snapshot).steps[0]!.implementation[0]!.fileId).toBe(id);
    expect(() => validateDiffStory({ ...raw, steps: [] }, snapshot)).toThrow(/step/i);
    raw.steps[0]!.implementation[0]!.endLine = 2;
    expect(() => validateDiffStory(raw, snapshot)).toThrow(/outside/i);
  });

  it("rejects unsafe strings and duplicate step IDs", () => {
    const snapshot = createStorySnapshot(files);
    const raw = proposal(snapshot);
    raw.steps.push({ ...raw.steps[0]!, title: "duplicate" });
    expect(() => validateDiffStory(raw, snapshot)).toThrow(/unique/i);
    expect(() => validateDiffStory({ ...proposal(snapshot), summary: "bad\u0000text" }, snapshot)).toThrow(/control/i);
  });
});

describe("diff story generation", () => {
  it("honors an already-aborted signal without calling the generator", async () => {
    const controller = new AbortController();
    controller.abort();
    const snapshot = createStorySnapshot([storyFile("app", "app.ts", "old\n", "new\n")]);
    const generate = async () => JSON.stringify({});

    await expect(generateDiffStory(snapshot, generate, controller.signal, () => undefined)).rejects.toMatchObject({ name: "AbortError" });
  });
});
