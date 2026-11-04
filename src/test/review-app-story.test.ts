import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { generateDiffStory } from "../diff-story/generate.js";
import { storyViewportKey, type StoryMember } from "../diff-story/navigation.js";
import { createStorySnapshot, uncoveredStoryChanges, validateDiffStory } from "../diff-story/plan.js";
import { configureRuntime, resetRuntime } from "../host/runtime.js";
import { getHalfPageStep, ReviewApp } from "../ui/review-app.js";
import type { ReviewFile } from "../types.js";
import type { ReviewSessionData } from "../review-session.js";

const previous = process.env.PI_CODER_PREFERENCES_PATH;
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "diff-story-ui-"));
  process.env.PI_CODER_PREFERENCES_PATH = join(directory, "prefs.json");
});
afterEach(() => {
  if (previous == null) delete process.env.PI_CODER_PREFERENCES_PATH;
  else process.env.PI_CODER_PREFERENCES_PATH = previous;
  rmSync(directory, { recursive: true, force: true });
});

const files: ReviewFile[] = ["app.ts", "app.test.ts"].map((path) => ({
  id: path, path, worktreeStatus: "modified", hasWorkingTreeFile: true,
  inGitDiff: true, inAllFiles: false,
  gitDiff: { status: "modified", oldPath: path, newPath: path, displayPath: path, hasOriginal: true, hasModified: true },
  allFiles: null,
}));
const snapshot = createStorySnapshot(files.map((file) => ({
  fileId: file.id,
  path: file.path,
  scope: "git-diff",
  contents: {
    originalContent: file.path === "app.ts" ? "old()\n" : "oldTest()\n",
    modifiedContent: file.path === "app.ts" ? "begin()\nreuse()\nfinish()\n" : "describe(() => {\nexpectReuse()\n})\n",
  },
})));
const plan = validateDiffStory({
  version: 1,
  snapshot: snapshot.fingerprint,
  summary: "Reuse an in-flight request.",
  steps: [
    {
      id: "reuse",
      title: "Reuse pending work",
      explanation: "The caller reuses pending work instead of starting it again.",
      implementation: [{ fileId: "app.ts", side: "added", startLine: 2, endLine: 2 }],
      tests: [{ fileId: "app.test.ts", side: "added", startLine: 2, endLine: 2 }],
    },
    {
      id: "remove",
      title: "Remove the old entry",
      explanation: "The old entry is no longer called.",
      implementation: [{ fileId: "app.ts", side: "deleted", startLine: 1, endLine: 1 }],
      tests: [],
    },
  ],
}, snapshot);

function harness(initialSession?: ReviewSessionData, rows = 40, pair = { plan, snapshot }, overrides: Partial<ConstructorParameters<typeof ReviewApp>[3]> = {}) {
  let saved: ReviewSessionData | undefined;
  const done = vi.fn();
  const tui = { terminal: { rows, columns: 140 }, requestRender: vi.fn() };
  const theme = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text };
  const app = new ReviewApp(tui, theme as never, done, {
    repoRoot: "/repo",
    files,
    scope: "git-diff",
    commentShortcuts: [],
    notify: vi.fn(),
    allowEmptySubmit: true,
    loadFileContents: async (_root, file) => pair.snapshot.files.find((entry) => entry.fileId === file.id)!.contents,
    story: pair,
    initialSession,
    ...overrides,
    onSessionChange: (data) => {
      saved = structuredClone(data);
      return true;
    },
  });
  return { app, done, saved: () => saved };
}

describe("paired diff story", () => {
  it.each([[80, 32], [140, 40]])("opens PR context without losing the story selection at %i×%i", async (width, height) => {
    const load = vi.fn(async () => "Why this change matters\nValidation: checks pending");
    const { app, done } = harness(undefined, height, { plan, snapshot }, {
      reviewHeader: {
        identity: "widgets#12",
        title: "Reuse pending requests",
        revision: "a".repeat(40),
        state: "OPEN",
      },
      contextPanelSource: {
        title: "PR context",
        loadingText: "Loading",
        load,
        brief: "Reuse work rather than starting the same request twice.",
        description: "Full author details\n" + "More background\n".repeat(50),
      },
    });
    try {
      await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
      const initial = app.render(width).join("\n");
      expect(initial).not.toContain("widgets#12");
      expect(initial).not.toContain("Reuse work rather than starting the same request twice.");
      expect(initial).not.toContain("Full author details");

      app.handleInput("i");
      const info = app.render(width).join("\n");
      expect(info).toContain("widgets#12");
      expect(info).toContain("@aaaaaaa");
      expect(info).toContain("Reuse pending requests");
      expect(info).toContain("Reuse work rather than starting the same request twice.");
      app.handleInput("\x1b");

      app.handleInput("\x1b[D");
      app.handleInput("\x1b[1;2B");
      const selected = structuredClone((app as any).state.selectedLineTargetByScopeFile);
      app.handleInput("4");
      expect(app.render(width).join("\n")).toContain("Why this change matters");
      app.handleInput("D");
      expect(app.render(width).join("\n")).toContain("Full author details");
      app.handleInput("\x1b[6~");
      expect((app as any).contextScroll).toBeGreaterThan(0);

      app.handleInput("\x1b");
      expect(done).not.toHaveBeenCalled();
      expect((app as any).story.member).toBe("tests");
      expect((app as any).state.selectedLineTargetByScopeFile).toEqual(selected);
      const rows = app.render(width);
      expect(rows).toHaveLength(height);
      expect(rows.every((row) => visibleWidth(row) === width)).toBe(true);
      expect(rows.join("\n")).toContain("expectReuse()");
      expect(load).toHaveBeenCalledOnce();
    } finally {
      app.dispose();
    }
  });

  it("keeps the cursor on the step's own lines, never moves it with Option, and reaches context with C", async () => {
    const before = Array.from({ length: 30 }, (_, i) => `line${i + 1}()`);
    const after = before.map((line, i) => i === 4 || i === 24 ? `changed${i + 1}()` : line);
    const captured = createStorySnapshot(files.map((file) => ({ fileId: file.id, path: file.path, scope: "git-diff", contents: { originalContent: before.join("\n"), modifiedContent: after.join("\n") } })));
    const ordered = validateDiffStory({ ...plan, snapshot: captured.fingerprint, steps: [{ ...plan.steps[0]!, implementation: [{ fileId: "app.ts", side: "added", startLine: 5, endLine: 5 }], tests: [] }] }, captured);
    const { app, saved } = harness(undefined, 40, { plan: ordered, snapshot: captured });
    const selected = () => (app as any).state.selectedLineTargetByScopeFile["git-diff::app.ts"];
    try {
      await Promise.resolve();
      const page = app.render(140).join("\n");
      expect(page).toContain("changed5()");
      expect(page).not.toContain("changed25()");
      expect(page).toContain("lines outside this step");
      app.handleInput("\x1b[B");
      expect(selected().line).toBe(5);
      for (const option of ["\x1b[1;3A", "\x1b[1;3B", "\x1b[1;4A", "\x1b[1;4B", "\x1b[5;3~", "\x1b[6;3~", "\x1b[1;3H", "\x1b[1;3F", "\x1bd", "\x1bu"]) app.handleInput(option);
      expect(selected().line).toBe(5);
      app.handleInput("C");
      for (let i = 0; i < 6; i += 1) app.handleInput("\x1b[A");
      app.render(140);
      expect(selected().line).toBe(2);
      app.handleInput("\x1b[1;2B");
      app.handleInput("d");
      app.handleInput("Why this context?");
      app.handleInput("\r");
      expect(saved()?.state.draft.comments[0]).toMatchObject({ intent: "discuss", startLine: 2, endLine: 3, body: "Why this context?" });
    } finally { app.dispose(); }
  });

  it("never shows a neighbouring step's changed lines again on the next page", async () => {
    const captured = createStorySnapshot(files.map((file) => ({
      fileId: file.id,
      path: file.path,
      scope: "git-diff",
      contents: file.path === "app.ts"
        ? {
          originalContent: "function first() {\n  return 1;\n}\nfunction second() {\n  return 3;\n}\n",
          modifiedContent: "function first() {\n  return 2;\n}\nfunction second() {\n  return 4;\n}\n",
        }
        : { originalContent: "", modifiedContent: "" },
    })));
    const story = await generateDiffStory(captured, async () => '{"order":[],"pairs":[]}', new AbortController().signal, () => {});
    const { app } = harness(undefined, 40, { plan: story, snapshot: captured });
    try {
      await Promise.resolve();
      const first = app.render(140).join("\n");
      expect(first).toContain("return 2;");
      expect(first).not.toContain("return 4;");
      app.handleInput("\x1b[1;2C");
      const second = app.render(140).join("\n");
      expect(second).toContain("return 4;");
      expect(second).not.toContain("return 2;");
    } finally {
      app.dispose();
    }
  });

  it("shows each side of a replaced line only on the step that owns it", async () => {
    const captured = createStorySnapshot(files.map((file) => ({
      fileId: file.id,
      path: file.path,
      scope: "git-diff",
      contents: file.path === "app.ts"
        ? { originalContent: "keep()\noldCall()\nkeep()\n", modifiedContent: "keep()\nnewCall()\nkeep()\n" }
        : { originalContent: "", modifiedContent: "" },
    })));
    const split = validateDiffStory({
      ...plan,
      snapshot: captured.fingerprint,
      steps: [
        { id: "old", title: "Remove the old call", explanation: "", implementation: [{ fileId: "app.ts", side: "deleted", startLine: 2, endLine: 2 }], tests: [] },
        { id: "new", title: "Add the new call", explanation: "", implementation: [{ fileId: "app.ts", side: "added", startLine: 2, endLine: 2 }], tests: [] },
      ],
    }, captured);
    const { app } = harness(undefined, 40, { plan: split, snapshot: captured });
    try {
      await Promise.resolve();
      const first = app.render(140).join("\n");
      expect(first).toContain("oldCall()");
      expect(first).not.toContain("newCall()");
      app.handleInput("\x1b[1;2C");
      const second = app.render(140).join("\n");
      expect(second).toContain("newCall()");
      expect(second).not.toContain("oldCall()");
    } finally {
      app.dispose();
    }
  });

  it("starts at the anchor line and uses only the reader's range when commenting", async () => {
    const ranged = validateDiffStory({
      ...plan,
      steps: [{
        ...plan.steps[0]!,
        implementation: [{ fileId: "app.ts", side: "added", startLine: 2, endLine: 3 }],
        tests: [{ fileId: "app.test.ts", side: "added", startLine: 1, endLine: 3 }],
      }],
    }, snapshot);
    const { app, saved } = harness(undefined, 40, { plan: ranged, snapshot });
    try {
      await Promise.resolve();
      app.render(140);
      app.handleInput("c");
      app.handleInput("This line");
      app.handleInput("\r");
      expect(saved()?.state.draft.comments[0]).toMatchObject({ startLine: 2, endLine: 2 });

      app.handleInput("\x1b[D");
      app.handleInput("\x1b[1;2B");
      app.handleInput("\x1b[C");
      app.render(140);
      app.handleInput("\x1b[D");
      app.handleInput("c");
      app.handleInput("My range");
      app.handleInput("\r");
      expect(saved()?.state.draft.comments.at(-1)).toMatchObject({
        fileId: "app.test.ts", startLine: 1, endLine: 2, body: "My range",
      });
    } finally {
      app.dispose();
    }
  });

  it("keeps saved notes accessible and preserves range comments when returning to the paired diffs", async () => {
    const summary = Array.from({ length: 20 }, (_, i) => `Summary-${i}. ${"Detail ".repeat(20)}`).join(" ");
    const explanation = Array.from({ length: 20 }, (_, i) => `Explanation-${i}. ${"Reason ".repeat(20)}`).join(" ");
    const longPlan = validateDiffStory({
      ...plan,
      summary,
      steps: [{ ...plan.steps[0]!, explanation, implementation: [{ fileId: "app.ts", side: "added", startLine: 2, endLine: 3 }] }, plan.steps[1]!],
    }, snapshot);
    const { app, saved } = harness(undefined, 40, { plan: longPlan, snapshot });
    try {
      await Promise.resolve();
      app.handleInput("i");
      let visible = app.render(140).join("\n");
      expect(visible).toContain("Step 1/4");
      expect(visible).toContain("Explanation-0");
      for (let line = 0; line < 100; line += 1) {
        app.handleInput("\x1b[B");
        visible += app.render(140).join("\n");
      }
      for (let i = 0; i < 20; i += 1) {
        expect(visible).toContain(`Summary-${i}`);
        expect(visible).toContain(`Explanation-${i}`);
      }
      app.handleInput("\x1b");
      const paired = app.render(140).join("\n");
      expect(paired).toContain("reuse()");
      expect(paired).toContain("expectReuse()");
      expect((app as any).story.step).toBe(0);
      app.handleInput("\x1b[1;2B");
      app.handleInput("c");
      app.handleInput("Explain this range");
      app.handleInput("\r");
      expect(saved()?.state.draft.comments[0]).toMatchObject({
        fileId: "app.ts", side: "added", startLine: 2, endLine: 3, body: "Explain this range",
      });
    } finally {
      app.dispose();
    }
  });

  it("pairs exact independent ranges, uses bare arrows for pane focus, and never changes steps while composing", async () => {
    const { app, saved } = harness();
    try {
      await Promise.resolve();
      expect((app as any).state.activeFileId).toBe("app.ts");
      const rendered = app.render(140).join("\n");
      expect(rendered).toContain("reuse()");
      expect(rendered).toContain("expectReuse()");

      app.handleInput("\x1b[D");
      expect((app as any).state.activeFileId).toBe("app.test.ts");
      app.handleInput("c");
      app.handleInput("Explain the assertion");
      app.handleInput("\x1b[1;2C");
      app.handleInput("\r");
      expect(saved()?.story?.step).toBe(0);
      expect(saved()?.state.draft.comments[0]).toMatchObject({
        fileId: "app.test.ts", side: "added", startLine: 2, endLine: 2,
        intent: "comment", anchorStatus: "mapped",
      });

      app.handleInput("\x1b[1;2C");
      app.handleInput("c");
      app.handleInput("Old entry question");
      app.handleInput("\r");
      expect(saved()?.story?.step).toBe(1);
      expect(saved()?.state.draft.comments.at(-1)).toMatchObject({ fileId: "app.ts", side: "deleted", startLine: 1 });
    } finally {
      app.dispose();
    }
  });

  it("shows every range of a file on one page and updates the hunk count while moving between them", async () => {
    const context = Array.from({ length: 20 }, (_, index) => `keep${index}()`).join("\n");
    const multiple = createStorySnapshot(snapshot.files.map((file) => file.fileId !== "app.ts" ? file : {
      ...file,
      contents: {
        originalContent: `start()\nold()\n${context}\nend()\n`,
        modifiedContent: `start()\nnew()\n${context}\nextra()\nanother()\nend()\n`,
      },
    }));
    const paired = validateDiffStory({
      ...plan,
      snapshot: multiple.fingerprint,
      steps: [{
        ...plan.steps[0]!,
        implementation: [
          { fileId: "app.ts", side: "deleted", startLine: 2, endLine: 2 },
          { fileId: "app.ts", side: "added", startLine: 23, endLine: 24 },
        ],
      }],
    }, multiple);
    const { app } = harness(undefined, 40, { plan: paired, snapshot: multiple });
    try {
      await Promise.resolve();
      let rendered = app.render(140).join("\n");
      expect(rendered).toContain("Hunk 1/2 · +1 −1");
      expect(rendered).toContain("Hunk 1/1 · +3 −1");
      expect(rendered).toContain("extra()");
      expect(rendered).not.toContain("Implementation 1/2");
      app.handleInput("\x1b[B");
      app.handleInput("\x1b[B");
      rendered = app.render(140).join("\n");
      expect(rendered).toContain("Hunk 2/2 · +2 −0");
      app.handleInput("\x1b[A");
      app.handleInput("\x1b[A");
      expect(app.render(140).join("\n")).toContain("Hunk 1/2 · +1 −1");
    } finally {
      app.dispose();
    }
  });

  it("marks the linked step rather than unseen files, resumes on the code pane with both viewports, and keeps final comments intact", async () => {
    const first = harness();
    let saved: ReviewSessionData | undefined;
    try {
      await Promise.resolve();
      first.app.render(140);
      first.app.handleInput("R");
      first.app.handleInput("\x1b[D");
      first.app.handleInput("c");
      first.app.handleInput("Review note");
      first.app.handleInput("\r");
      saved = first.saved();
      expect(saved?.story?.viewedStepIds).toEqual(["reuse"]);
      expect(saved?.reviewedFileIds).toEqual([]);
    } finally {
      first.app.dispose();
    }

    const resumed = harness(saved);
    try {
      await Promise.resolve();
      expect((resumed.app as any).story.member).toBe("implementation");
      expect((resumed.app as any).state.activeFileId).toBe("app.ts");
      resumed.app.handleInput("\x1b[D");
      expect((resumed.app as any).state.activeFileId).toBe("app.test.ts");
      expect(saved?.story?.member).toBe("tests");
      resumed.app.handleInput("s");
      expect(resumed.done).toHaveBeenCalledWith(expect.objectContaining({
        type: "submit",
        comments: [expect.objectContaining({ body: "Review note", fileId: "app.test.ts" })],
      }));
    } finally {
      resumed.app.dispose();
    }
  });

  it("loads a story session saved by 0.9.8: its step, marks, comments and viewports return and the code pane is focused", async () => {
    const first = harness();
    let session: ReviewSessionData;
    try {
      await Promise.resolve();
      first.app.handleInput("c");
      first.app.handleInput("Kept note");
      first.app.handleInput("\r");
      session = first.saved()!;
    } finally {
      first.app.dispose();
    }
    const saved = structuredClone(session);
    const steps = saved.story!.plan.steps;
    saved.story = {
      plan: saved.story!.plan,
      step: 1,
      member: "tests",
      related: { implementation: 0, tests: 0 },
      viewedStepIds: [steps[0]!.id],
      viewports: { [JSON.stringify([steps[1]!.id, "implementation", 0])]: { scroll: 0, initialized: true, selection: { side: "deleted", line: 1 } } },
    };

    const resumed = harness(JSON.parse(JSON.stringify(saved)));
    try {
      await Promise.resolve();
      const story = (resumed.app as any).story;
      const rows = resumed.app.render(140);
      expect(story.step).toBe(1);
      expect(story.member).toBe("implementation");
      expect(story.viewedStepIds).toEqual([steps[0]!.id]);
      expect((resumed.app as any).state.activeFileId).toBe("app.ts");
      expect((resumed.app as any).state.selectedLineTargetByScopeFile["git-diff::app.ts"]).toEqual({ side: "deleted", line: 1 });
      expect(rows[1]!.slice(1, -1).trimEnd().startsWith("\u25c6 Remove the old entry")).toBe(true);
      expect(rows.join("\n")).toContain("\u25b6 Implementation");
      expect((resumed.app as any).state.draft.comments).toEqual([expect.objectContaining({ body: "Kept note" })]);
    } finally {
      resumed.app.dispose();
    }
  });

  it("reaches omitted changes through normal step navigation and preserves progress on resume", async () => {
    const { app, saved } = harness();
    let session: ReviewSessionData | undefined;
    try {
      await Promise.resolve();
      const story = (app as any).story;
      expect(uncoveredStoryChanges(story.plan, snapshot)).toEqual([]);
      for (let step = 1; step < story.plan.steps.length; step += 1) app.handleInput("\x1b[1;2C");
      expect(story.step).toBeGreaterThanOrEqual(plan.steps.length);
      app.render(140);
      app.handleInput("c");
      app.handleInput("Question on this change");
      app.handleInput("\r");
      session = saved();
      expect(session?.state.draft.comments[0]?.body).toBe("Question on this change");
    } finally {
      app.dispose();
    }
    const resumed = harness(session);
    try {
      await Promise.resolve();
      expect((resumed.app as any).story.step).toBe(session?.story?.step);
      expect((resumed.app as any).story.plan.steps).toHaveLength(session!.story!.plan.steps.length);
    } finally {
      resumed.app.dispose();
    }
  });

  it("offers to park story progress even when no feedback has been written", async () => {
    const { app, done, saved } = harness();
    try {
      await Promise.resolve();
      app.handleInput("R");
      app.handleInput("\x1b[1;2C");
      app.handleInput("\x1b");

      expect(done).not.toHaveBeenCalled();
      app.handleInput("p");
      expect(done).toHaveBeenCalledWith({ type: "cancel", disposition: "park" });
      expect(saved()?.story).toMatchObject({ step: 1, viewedStepIds: ["reuse"] });
    } finally {
      app.dispose();
    }
  });

  it("keeps a saved comment editor on its original file when opened from another story member", async () => {
    const { app, saved } = harness();
    try {
      await Promise.resolve();
      app.handleInput("\x1b[D");
      app.handleInput("c");
      app.handleInput("Assertion question");
      app.handleInput("\r");
      app.handleInput("\x1b[C");
      app.handleInput("h");
      app.handleInput("e");
      const rows = app.render(140);

      expect(rows.some((line) => line.includes(CURSOR_MARKER))).toBe(true);
      expect((app as any).state.activeFileId).toBe("app.test.ts");
      app.handleInput(" amended");
      app.handleInput("\r");
      expect(saved()?.state.draft.comments).toEqual([
        expect.objectContaining({ fileId: "app.test.ts", startLine: 2, body: "Assertion question amended" }),
      ]);
    } finally {
      app.dispose();
    }
  });

  it("places related anchors at the same visual row when their line numbers differ", async () => {
    const distant = createStorySnapshot(snapshot.files.map((file) => ({
      ...file,
      contents: {
        ...file.contents,
        modifiedContent: Array.from({ length: 100 }, (_, i) => `${file.fileId}:${i + 1}`).join("\n"),
      },
    })));
    const paired = validateDiffStory({
      ...plan,
      snapshot: distant.fingerprint,
      steps: [{
        ...plan.steps[0]!,
        implementation: [{ fileId: "app.ts", side: "added", startLine: 80, endLine: 80 }],
        tests: [{ fileId: "app.test.ts", side: "added", startLine: 10, endLine: 10 }],
      }],
    }, distant);
    const { app } = harness(undefined, 40, { plan: paired, snapshot: distant });
    try {
      await Promise.resolve();
      const lines = app.render(140);
      expect(lines.findIndex((line) => line.includes("app.ts:80"))).toBe(lines.findIndex((line) => line.includes("app.test.ts:10")));
    } finally {
      app.dispose();
    }
  });

  it("returns from full-diff browsing to paired unified views without changing the review or jumping an editor target", async () => {
    const { app } = harness();
    try {
      await Promise.resolve();
      app.handleInput("F");
      app.handleInput("v");
      app.handleInput("F");

      expect((app as any).diffViewMode).toBe("unified");
      expect((app as any).state.activeFileId).toBe("app.ts");
      expect(app.render(140).join("\n")).toContain("Related changed tests");
    } finally {
      app.dispose();
    }
  });

  it.each([140, 80, 40])("retains both members and the file inventory within a %i-column terminal", async (width) => {
    const { app } = harness(undefined, 40);
    try {
      await Promise.resolve();
      const rows = app.render(width);
      expect(rows.every((row) => visibleWidth(row) === width)).toBe(true);
      expect(rows).toHaveLength(40);
      expect(rows.join("\n")).toContain("Implementation");
      expect(rows.join("\n")).toContain("Related changed tests");

      app.handleInput("i");
      expect(app.render(width).join("\n")).toContain("app.ts");
      app.handleInput("\x1b");
      app.handleInput("\x1b[1;2C");
      expect(app.render(width).join("\n")).toContain("No related changed tests");

      app.handleInput("F");
      const fullDiff = app.render(width);
      expect(fullDiff).toHaveLength(40);
      expect(fullDiff.every((row) => visibleWidth(row) === width)).toBe(true);
    } finally {
      app.dispose();
    }
  });

  it.each([140, 80, 40])("ends the story with the one-line shortcuts footer at %i columns", async (width) => {
    const { app } = harness(undefined, 40);
    try {
      await Promise.resolve();
      const rows = app.render(width);
      const footer = rows.slice(-4, -1).map((row) => row.replace(/^[│ ]+|[│ ]+$/g, "")).join(" ").trim();
      expect(footer.endsWith("Shortcuts: c (Comment) - d (Discuss with Agent) - Ctrl+? (All Shortcuts) - i (Info)")).toBe(true);
      expect(rows.join("\n")).not.toContain("Shift+←/→ step");
    } finally {
      app.dispose();
    }
  });

  it.each(["?", "\x1b[47;5u", "\x1b[47;6u", "\x1b[63;5u", "\x1b[63;6u", "\x1b[27;5;63~", "\x1b[27;6;63~", "\x1b[27;5;47~", "\x1b[27;6;47~", "\x1f"])("opens the story shortcuts over the paired panes with %j and closes them with Esc", async (key) => {
    const { app, done } = harness(undefined, 60);
    try {
      await Promise.resolve();
      app.handleInput(key);
      const text = app.render(140).join("\n");
      expect(text).toContain("Shortcuts · ↑↓ scroll · Esc close");
      for (const line of ["Shift+←/→ previous/next step", "Option+↑↓ scroll the other pane one row; focus stays", "Home/End • gg/G first/last line"]) {
        expect(text).toContain(line);
      }
      expect(text).not.toContain("Template shortcuts");
      expect(text).toContain("Related changed tests");

      app.handleInput("\x1b");
      expect(done).not.toHaveBeenCalled();
      expect((app as any).confirmCancel).toBe(false);
      expect(app.render(140).join("\n")).not.toContain("Shortcuts · ↑↓ scroll");
    } finally {
      app.dispose();
    }
  });

  it("lists the review keys, not the story keys, when the full diff is open inside a story", async () => {
    const { app } = harness(undefined, 60);
    try {
      await Promise.resolve();
      app.handleInput("F");
      app.handleInput("?");
      expect(app.render(140).join("\n")).toContain("Navigation");
      app.handleInput("\x1b[F");
      const text = app.render(140).join("\n");
      expect(text).toContain("Template shortcuts");
      expect(text).not.toContain("Other pane");
      app.handleInput("\x1b");
      expect((app as any).helpMode).toBe(false);
      expect(app.render(140).at(-2)).toContain("Shortcuts: c (Comment) - d (Discuss with Agent) - Ctrl+? (All Shortcuts)");
      expect(app.render(140).at(-2)).not.toContain("(Info)");
    } finally {
      app.dispose();
    }
  });

  it("shows a status message on its own row above the shortcuts", async () => {
    const { app } = harness(undefined, 40);
    try {
      await Promise.resolve();
      app.handleInput("v");
      const rows = app.render(140);
      expect(rows.at(-3)).toContain("Story uses paired read-only diffs.");
      expect(rows.at(-2)).toContain("Shortcuts: c (Comment)");
    } finally {
      app.dispose();
    }
  });

  it("still opens the shortcuts when the terminal is too small for the panes", async () => {
    const { app } = harness(undefined, 24);
    try {
      await Promise.resolve();
      expect(app.render(140).join("\n")).toContain("Resize to 40 columns");
      app.handleInput("?");
      const rows = app.render(140);
      expect(rows).toHaveLength(24);
      expect(rows.every((row) => visibleWidth(row) === 140)).toBe(true);
      expect(rows.join("\n")).toContain("Shortcuts \u00b7 \u2191\u2193 scroll");
      app.handleInput("\x1b");
      expect(app.render(140).join("\n")).not.toContain("Shortcuts \u00b7 \u2191\u2193 scroll");
    } finally {
      app.dispose();
    }
  });

  it("swallows story keys while the shortcuts are open, and replaces the story info", async () => {
    const { app } = harness(undefined, 60);
    try {
      await Promise.resolve();
      app.handleInput("i");
      expect((app as any).storyInventory).toBe(true);
      app.handleInput("?");
      expect((app as any).storyInventory).toBe(false);
      expect((app as any).helpMode).toBe(true);

      for (const key of ["\x1b[1;2C", "R", "c", "\x1b[D", "F", "i"]) app.handleInput(key);
      expect((app as any).story.step).toBe(0);
      expect((app as any).story.viewedStepIds).toEqual([]);
      expect((app as any).storyBrowsingDiff).toBe(false);
      expect((app as any).storyInventory).toBe(false);
      expect((app as any).editTarget).toBeNull();
      expect((app as any).helpMode).toBe(true);
    } finally {
      app.dispose();
    }
  });

  it("draws the shortcuts over the PR context popup and closes only the shortcuts with Esc", async () => {
    const { app } = harness(undefined, 60, { plan, snapshot }, {
      contextPanelSource: { title: "PR context", loadingText: "Loading", load: async () => "Why this change matters" },
    });
    try {
      await Promise.resolve();
      app.handleInput("4");
      await vi.waitFor(() => expect(app.render(140).join("\n")).toContain("Why this change matters"));
      app.handleInput("?");
      expect(app.render(140).join("\n")).toContain("Shortcuts · ↑↓ scroll");
      app.handleInput("\x1b");
      const text = app.render(140).join("\n");
      expect(text).not.toContain("Shortcuts · ↑↓ scroll");
      expect(text).toContain("Why this change matters");
      expect((app as any).storyContextReturnFocus).toBeDefined();
    } finally {
      app.dispose();
    }
  });

  it("shows the tests on the left and the code on the right, and stacks the tests above the code", async () => {
    const { app } = harness(undefined, 40);
    try {
      await Promise.resolve();
      const wide = app.render(140);
      const titles = wide.find((row) => row.includes("Related changed tests"))!;
      expect(titles.indexOf("Related changed tests")).toBeLessThan(titles.indexOf("Implementation"));
      const aligned = wide.find((row) => row.includes("expectReuse()"))!;
      expect(aligned.indexOf("expectReuse()")).toBeLessThan(aligned.indexOf("reuse()"));

      const stacked = app.render(80);
      const tests = stacked.findIndex((row) => row.includes("Related changed tests"));
      const code = stacked.findIndex((row) => row.includes("Implementation"));
      expect(tests).toBeGreaterThan(0);
      expect(code).toBeGreaterThan(tests);
      expect(stacked.findIndex((row) => row.includes("expectReuse()"))).toBeLessThan(stacked.findIndex((row) => row.includes(" reuse()")));
    } finally {
      app.dispose();
    }
  });

  it("focuses the code pane on open and on every step change", async () => {
    const stepped = validateDiffStory({
      ...plan,
      steps: [
        plan.steps[0]!,
        { id: "finish", title: "Finish the request", explanation: "", implementation: [{ fileId: "app.ts", side: "added", startLine: 3, endLine: 3 }], tests: [{ fileId: "app.test.ts", side: "added", startLine: 3, endLine: 3 }] },
      ],
    }, snapshot);
    const { app } = harness(undefined, 40, { plan: stepped, snapshot });
    try {
      await Promise.resolve();
      const story = (app as any).story;
      expect(story.member).toBe("implementation");
      expect((app as any).state.activeFileId).toBe("app.ts");
      expect(app.render(140).join("\n")).toContain("▶ Implementation");
      expect(app.render(140).join("\n")).not.toContain("▶ Related changed tests");

      app.handleInput("\x1b[D");
      expect(story.member).toBe("tests");
      expect(app.render(140).join("\n")).toContain("▶ Related changed tests");
      app.handleInput("\x1b[1;2C");
      expect(story.step).toBe(1);
      expect(story.member).toBe("implementation");
      expect((app as any).state.activeFileId).toBe("app.ts");

      app.handleInput("\x1b[D");
      app.handleInput("\x1b[1;2D");
      expect(story.step).toBe(0);
      expect(story.member).toBe("implementation");
    } finally {
      app.dispose();
    }
  });

  it("opens a step without implementation on its tests", async () => {
    const testsOnly = validateDiffStory({
      ...plan,
      steps: [{ id: "tests", title: "Only the tests", explanation: "", implementation: [], tests: [{ fileId: "app.test.ts", side: "added", startLine: 2, endLine: 2 }] }],
    }, snapshot);
    const { app } = harness(undefined, 40, { plan: testsOnly, snapshot });
    try {
      await Promise.resolve();
      expect((app as any).story.plan.steps[0].implementation).toEqual([]);
      expect((app as any).story.member).toBe("tests");
      expect((app as any).state.activeFileId).toBe("app.test.ts");
    } finally {
      app.dispose();
    }
  });

  describe("header and info", () => {
    const reviewHeader = { identity: "widgets#12", title: "Reuse pending requests", revision: "a".repeat(40), state: "OPEN" };
    const contextPanelSource = { title: "PR context", loadingText: "Loading", load: async () => "facts", brief: "Reuse work rather than starting the same request twice." };
    const withHeader = (rows = 40) => harness(undefined, rows, { plan, snapshot }, { reviewHeader, contextPanelSource });

    it.each([140, 80, 40])("shows only the step title and its position in the header at %i columns", async (width) => {
      const { app } = withHeader();
      try {
        await Promise.resolve();
        const rows = app.render(width);
        const header = rows[1]!.slice(1, -1).trimEnd();
        expect(header.startsWith("◆ Reuse pending work")).toBe(true);
        expect(header.endsWith("1/4")).toBe(true);
        expect(rows[2]!.slice(1, -1).trim()).toBe("");
        expect(rows[3]!.startsWith("│┌")).toBe(true);
        const frame = rows.join("\n");
        for (const gone of ["widgets#12", "Reuse work rather", "2 files", "steps seen", "Previous", "Next:"]) expect(frame).not.toContain(gone);

        app.handleInput("R");
        expect(app.render(width)[1]!.slice(1, -1).trimEnd().endsWith("1/4 · seen")).toBe(true);
      } finally {
        app.dispose();
      }
    });

    it("truncates a long step title before the position", async () => {
      const long = validateDiffStory({ ...plan, steps: [{ ...plan.steps[0]!, title: "A very long step title that cannot fit into a forty column terminal" }] }, snapshot);
      const { app } = harness(undefined, 40, { plan: long, snapshot });
      try {
        await Promise.resolve();
        const row = app.render(40)[1]!;
        expect(visibleWidth(row)).toBe(40);
        expect(row.replace(/\x1b\[[0-9;]*m/g, "").slice(1, -1).trimEnd()).toMatch(/^◆ A very long.*… +1\/\d$/);
      } finally {
        app.dispose();
      }
    });

    it("opens a centered info popup with the step, review, totals, files and story", async () => {
      const { app, done } = withHeader();
      try {
        await Promise.resolve();
        app.handleInput("R");
        app.handleInput("i");
        const rows = app.render(140);
        const text = rows.join("\n");
        for (const line of [
          "Story info · ↑↓ scroll · Esc close", "Step 1/4 · seen", "The caller reuses pending work instead of starting it again.",
          "Tests:", "app.test.ts:2", "Implementation:", "app.ts:2",
          "widgets#12 • @aaaaaaa", "Reuse pending requests", "Reuse work rather than starting the same request twice.",
          "2 files · +6 −2 · 1/4 steps seen · 0 comments", "Captured files", "Reuse an in-flight request.",
          "› 1. Reuse pending work · seen", "  2. Remove the old entry", "4 PR context · F full diff",
        ]) expect(text).toContain(line);
        expect(rows).toHaveLength(40);
        expect(rows[1]).toContain("◆ Reuse pending work");
        const top = rows.find((row) => row.includes("Story info"))!;
        expect(top.indexOf("┌", 1)).toBeGreaterThan(5);

        app.handleInput("\x1b");
        expect(done).not.toHaveBeenCalled();
        expect(app.render(140).join("\n")).not.toContain("Story info");
      } finally {
        app.dispose();
      }
    });

    it("lists a deleted range and each step's own tests", async () => {
      const { app } = withHeader();
      try {
        await Promise.resolve();
        app.handleInput("\x1b[1;2C");
        app.handleInput("i");
        const text = app.render(140).join("\n");
        expect(text).toContain("Step 2/4");
        expect(text).toContain("Tests: none");
        expect(text).toContain("app.ts:1 (deleted)");
        expect(text).toContain("› 2. Remove the old entry");
      } finally {
        app.dispose();
      }
    });

    it("scrolls by row, page and to either end, closes with Esc, Ctrl+C or i, and holds the step still", async () => {
      const long = validateDiffStory({ ...plan, summary: Array.from({ length: 30 }, (_, i) => `Summary-${i}.`).join(" ").repeat(4) }, snapshot);
      const { app, done } = harness(undefined, 30, { plan: long, snapshot });
      try {
        await Promise.resolve();
        app.handleInput("i");
        const first = app.render(140).join("\n");
        const page = (app as any).storyInfoPageSize;
        expect(first).toContain("Step 1/4");
        expect(first).not.toContain("F full diff");

        app.handleInput("\x1b[B");
        app.handleInput("j");
        expect((app as any).storyInventoryScroll).toBe(2);
        app.handleInput("k");
        app.handleInput("\x1b[A");
        app.handleInput("\x1b[6~");
        expect((app as any).storyInventoryScroll).toBe(page);
        app.handleInput("\x1b[5~");
        expect((app as any).storyInventoryScroll).toBe(0);
        app.handleInput("\x1b[F");
        expect(app.render(140).join("\n")).toContain("F full diff");
        app.handleInput("\x1b[H");
        expect(app.render(140).join("\n")).toContain("Step 1/4");
        app.handleInput("G");
        expect(app.render(140).join("\n")).toContain("F full diff");
        app.handleInput("g");
        expect((app as any).storyInventoryScroll).toBe(0);

        for (const key of ["\x1b[1;2C", "\x1b[D", "R", "c"]) app.handleInput(key);
        expect((app as any).story.step).toBe(0);
        expect((app as any).story.member).toBe("implementation");
        expect((app as any).story.viewedStepIds).toEqual([]);
        expect((app as any).storyInventory).toBe(true);

        for (const close of ["\x1b", "\x03", "i"]) {
          app.handleInput(close);
          expect((app as any).storyInventory).toBe(false);
          app.handleInput("i");
        }
        expect(done).not.toHaveBeenCalled();
      } finally {
        app.dispose();
      }
    });

    it("leaves the info popup for the PR context or the full diff", async () => {
      const { app } = withHeader();
      try {
        await Promise.resolve();
        app.handleInput("i");
        app.handleInput("4");
        expect((app as any).storyInventory).toBe(false);
        expect((app as any).storyContextReturnFocus).toBeDefined();
        app.handleInput("\x1b");

        app.handleInput("i");
        app.handleInput("F");
        expect((app as any).storyInventory).toBe(false);
        app.handleInput("F");
        expect(app.render(140).join("\n")).not.toContain("Story info");
      } finally {
        app.dispose();
      }
    });
  });

  it("cycles Tab through tests, code and comments, Shift+Tab backwards, and h between comments and code", async () => {
    const { app } = harness(undefined, 40);
    try {
      await Promise.resolve();
      const where = () => (app as any).state.focus === "comments" ? "comments" : (app as any).story.member;
      const press = (key: string) => {
        app.handleInput(key);
        return where();
      };
      expect(where()).toBe("implementation");
      expect([press("\t"), press("\t"), press("\t")]).toEqual(["comments", "tests", "implementation"]);
      expect([press("\x1b[Z"), press("\x1b[Z"), press("\x1b[Z")]).toEqual(["tests", "comments", "implementation"]);
      expect([press("h"), press("h")]).toEqual(["comments", "implementation"]);
      app.handleInput("\x1b[D");
      expect([press("h"), press("h")]).toEqual(["comments", "implementation"]);
    } finally {
      app.dispose();
    }
  });

  it("edits the one comment on code repeated across split steps, and tracks seen and viewports per step", async () => {
    const repeated = validateDiffStory({
      version: 1,
      snapshot: snapshot.fingerprint,
      summary: "Repeated code.",
      steps: [
        { id: "u1", title: "reuse, tests 1/2", explanation: "", implementation: [{ fileId: "app.ts", side: "added", startLine: 2, endLine: 2 }], tests: [{ fileId: "app.test.ts", side: "added", startLine: 1, endLine: 1 }] },
        { id: "u1~2", title: "reuse, tests 2/2", explanation: "", implementation: [{ fileId: "app.ts", side: "added", startLine: 2, endLine: 2 }], tests: [{ fileId: "app.test.ts", side: "added", startLine: 3, endLine: 3 }] },
      ],
    }, snapshot);
    const { app, saved } = harness(undefined, 40, { plan: repeated, snapshot });
    try {
      await Promise.resolve();
      app.render(140);
      app.handleInput("R");
      app.handleInput("c");
      app.handleInput("Why reuse?");
      app.handleInput("\r");
      expect(saved()?.state.draft.comments).toHaveLength(1);

      app.handleInput("\x1b[1;2C");
      const rows = app.render(140);
      expect((app as any).story.step).toBe(1);
      expect(rows.join("\n")).toContain("reuse()");
      expect(rows[1]!.slice(1, -1).trimEnd().endsWith("2/" + (app as any).story.plan.steps.length)).toBe(true);
      expect((app as any).story.viewedStepIds).toEqual(["u1"]);

      app.handleInput("c");
      expect((app as any).editor.getExpandedText()).toBe("Why reuse?");
      app.handleInput(" And here?");
      app.handleInput("\r");
      expect(saved()?.state.draft.comments).toEqual([expect.objectContaining({ fileId: "app.ts", side: "added", startLine: 2, endLine: 2, body: "Why reuse? And here?" })]);
      expect(Object.keys(saved()!.story!.viewports).filter((key) => key.includes("implementation")).map((key) => JSON.parse(key)[0])).toEqual(["u1", "u1~2"]);
    } finally {
      app.dispose();
    }
  });

  it("blocks the template shortcuts in a story, and leaves them to the full diff", async () => {
    const commentShortcuts = [{ id: "explain-added", key: "e", label: "explain", intent: "discuss" as const, side: "added" as const, text: "Explain what this code is doing." }];
    const { app } = harness(undefined, 40, { plan, snapshot }, { commentShortcuts });
    try {
      await Promise.resolve();
      app.handleInput("t");
      expect((app as any).shortcutMode).toBe(false);
      expect((app as any).message).toBe("Story uses paired read-only diffs. F opens the full diff; Shift+←/→ moves steps.");

      app.handleInput("F");
      app.handleInput("\r");
      app.handleInput("t");
      expect((app as any).shortcutMode).toBe(true);
    } finally {
      app.dispose();
    }
  });

  describe("scrolling", () => {
    const tall = createStorySnapshot(files.map((file) => ({
      fileId: file.id,
      path: file.path,
      scope: "git-diff",
      contents: { originalContent: "", modifiedContent: Array.from({ length: 120 }, (_, i) => `${file.path === "app.ts" ? "step" : "check"}${i + 1}()`).join("\n") + "\n" },
    })));
    const tallPlan = validateDiffStory({
      version: 1,
      snapshot: tall.fingerprint,
      summary: "Two tall panes.",
      steps: [
        { id: "tall", title: "Two tall panes", explanation: "", implementation: [{ fileId: "app.ts", side: "added", startLine: 1, endLine: 120 }], tests: [{ fileId: "app.test.ts", side: "added", startLine: 1, endLine: 120 }] },
        { id: "alone", title: "No tests", explanation: "", implementation: [{ fileId: "app.ts", side: "added", startLine: 1, endLine: 2 }], tests: [] },
      ],
    }, tall);
    const OPTION = { up: "\x1b[1;3A", down: "\x1b[1;3B", pageUp: "\x1b[5;3~", pageDown: "\x1b[6;3~", home: "\x1b[1;3H", end: "\x1b[1;3F", shiftUp: "\x1b[1;4A", shiftDown: "\x1b[1;4B" };
    const open = () => harness(undefined, 32, { plan: tallPlan, snapshot: tall });
    const viewport = (app: ReviewApp, member: StoryMember) => (app as any).story.viewports[storyViewportKey((app as any).story, member)];
    const metrics = (app: ReviewApp, member: StoryMember) => (app as any).storyPaneMetrics[member] as { max: number; page: number };
    const selected = (app: ReviewApp, path: string) => (app as any).state.selectedLineTargetByScopeFile[`git-diff::${path}`];

    it("scrolls the other pane a row at a time without moving focus, the cursor or the selection", async () => {
      const { app } = open();
      try {
        await Promise.resolve();
        app.render(140);
        const story = (app as any).story;
        const cursor = structuredClone(selected(app, "app.ts"));
        const testsSelection = structuredClone(viewport(app, "tests").selection);
        expect(story.member).toBe("implementation");
        expect(viewport(app, "tests").scroll).toBe(0);
        expect(metrics(app, "tests").max).toBeGreaterThan(50);

        app.handleInput(OPTION.down);
        expect(viewport(app, "tests").scroll).toBe(1);
        app.handleInput(OPTION.down);
        app.handleInput(OPTION.up);
        const frame = app.render(140).join("\n");
        expect(viewport(app, "tests").scroll).toBe(1);
        expect(story.member).toBe("implementation");
        expect(frame).toContain("▶ Implementation");
        expect(frame).not.toContain("▶ Related changed tests");
        expect(selected(app, "app.ts")).toEqual(cursor);
        expect(viewport(app, "tests").selection).toEqual(testsSelection);
        expect(viewport(app, "implementation").scroll).toBe(0);

        app.handleInput(OPTION.up);
        app.handleInput(OPTION.up);
        expect(viewport(app, "tests").scroll).toBe(0);

        app.handleInput("\x1b[B");
        app.handleInput(OPTION.down);
        app.handleInput("\x1b[B");
        app.render(140);
        expect(viewport(app, "tests").scroll).toBe(1);
        expect(selected(app, "app.ts").line).toBe(3);
      } finally {
        app.dispose();
      }
    });

    it("does not move the other pane up on Option+Down when its aligned scroll is past the computed end", async () => {
      const { app } = open();
      try {
        await Promise.resolve();
        app.render(140);
        const { max } = metrics(app, "tests");
        const story = (app as any).story;
        const key = storyViewportKey(story, "tests");
        story.viewports[key] = { ...story.viewports[key], scroll: max + 2 };

        app.handleInput(OPTION.down);
        expect(viewport(app, "tests").scroll).toBe(max + 2);
        app.handleInput(OPTION.up);
        expect(viewport(app, "tests").scroll).toBe(max + 1);
      } finally {
        app.dispose();
      }
    });

    it("pages the other pane, and jumps it to either end with Option+Shift+arrows or Option+Home and End", async () => {
      const { app } = open();
      try {
        await Promise.resolve();
        app.render(140);
        const { max, page } = metrics(app, "tests");

        app.handleInput(OPTION.pageDown);
        expect(viewport(app, "tests").scroll).toBe(page - 1);
        app.handleInput(OPTION.pageUp);
        expect(viewport(app, "tests").scroll).toBe(0);

        for (const [down, up] of [[OPTION.shiftDown, OPTION.shiftUp], [OPTION.end, OPTION.home]]) {
          app.handleInput(down);
          let frame = app.render(140).join("\n");
          expect(viewport(app, "tests").scroll).toBe(max);
          expect(frame).toContain("check120()");
          expect(frame).not.toContain("check1()");
          expect(frame).toContain("▶ Implementation");
          app.handleInput(OPTION.pageDown);
          expect(viewport(app, "tests").scroll).toBe(max);

          app.handleInput(up);
          frame = app.render(140).join("\n");
          expect(viewport(app, "tests").scroll).toBe(0);
          expect(frame).toContain("check1()");
          expect(frame).not.toContain("check120()");
        }
      } finally {
        app.dispose();
      }
    });

    it("moves, comments and copies with the keys the story shortcuts list", async () => {
      const copied: string[] = [];
      configureRuntime({ copyText: async (text) => { copied.push(text); } });
      const { app } = open();
      try {
        await Promise.resolve();
        app.render(140);
        const line = () => selected(app, "app.ts").line;
        const bodies = () => (app as any).state.draft.comments.map((comment: { body: string }) => comment.body);
        const page = (app as any).diffPageSize as number;
        for (const [key, expected] of [["\x1b[6~", 1 + page], ["\x1b[5~", 1], ["\x04", 1 + getHalfPageStep(page)], ["\x15", 1], ["\x06", 1 + page], ["\x02", 1]] as const) {
          app.handleInput(key);
          expect(line()).toBe(expected);
        }

        app.handleInput("y");
        app.handleInput("Y");
        await vi.waitFor(() => expect(copied).toEqual(["step1()", "app.ts:1"]));

        for (const [key, expected] of [["m", { kind: "line", intent: "modify" }], ["l", { kind: "file", fileTarget: "file" }], ["a", { kind: "file", fileTarget: "all-lines" }]] as const) {
          app.handleInput(key);
          expect((app as any).editTarget).toMatchObject(expected);
          app.handleInput("\x1b");
          expect((app as any).editTarget).toBeNull();
        }

        for (const [move, body] of [["", "First"], ["\x1b[B", "Second"]] as const) {
          if (move) app.handleInput(move);
          app.handleInput("c");
          app.handleInput(body);
          app.handleInput("\r");
        }
        expect(bodies()).toEqual(["First", "Second"]);
        app.handleInput("x");
        expect(bodies()).toEqual(["First"]);

        app.handleInput("h");
        expect((app as any).state.focus).toBe("comments");
        app.handleInput("y");
        await vi.waitFor(() => expect(copied.at(-1)).toBe("First"));
        app.handleInput("d");
        expect(bodies()).toEqual([]);
      } finally {
        resetRuntime();
        app.dispose();
      }
    });

    it("scrolls the code pane when the tests are focused, and snaps a pane back to its cursor once focused", async () => {
      const { app } = open();
      try {
        await Promise.resolve();
        app.render(140);
        app.handleInput(OPTION.shiftDown);
        expect(viewport(app, "tests").scroll).toBe(metrics(app, "tests").max);

        app.handleInput("\x1b[D");
        app.render(140);
        expect((app as any).story.member).toBe("tests");
        expect(viewport(app, "tests").scroll).toBe(0);
        expect(viewport(app, "tests").selection).toMatchObject({ line: 1 });

        app.handleInput(OPTION.down);
        app.handleInput(OPTION.down);
        app.render(140);
        expect(viewport(app, "implementation").scroll).toBe(2);
        expect(viewport(app, "tests").scroll).toBe(0);
        expect((app as any).story.member).toBe("tests");
      } finally {
        app.dispose();
      }
    });

    it("swallows the other Option chords and does nothing when the other pane is empty or the step changes", async () => {
      const { app } = open();
      try {
        await Promise.resolve();
        app.render(140);
        const cursor = structuredClone(selected(app, "app.ts"));
        for (const chord of ["\x1bd", "\x1bu", "\x1bf", "\x1bb", "\x1b[6;4~", "\x1b[1;4H"]) app.handleInput(chord);
        expect(viewport(app, "tests").scroll).toBe(0);
        expect(selected(app, "app.ts")).toEqual(cursor);

        app.handleInput(OPTION.shiftDown);
        expect((app as any).storyFreeScroll.has("tests")).toBe(true);
        app.handleInput("\x1b[1;2C");
        app.render(140);
        expect((app as any).story.step).toBe(1);
        expect((app as any).storyFreeScroll.size).toBe(0);
        expect(app.render(140).join("\n")).toContain("No related changed tests");
        for (const chord of Object.values(OPTION)) app.handleInput(chord);
        expect((app as any).story.member).toBe("implementation");
        expect((app as any).storyFreeScroll.size).toBe(0);
      } finally {
        app.dispose();
      }
    });

    it("ignores Option while the comments are focused, and leaves the full diff to its own Option keys", async () => {
      const { app } = open();
      try {
        await Promise.resolve();
        app.render(140);
        app.handleInput("h");
        app.handleInput(OPTION.shiftDown);
        expect(viewport(app, "tests").scroll).toBe(0);
        app.handleInput("h");

        app.handleInput("F");
        app.handleInput("\r");
        expect((app as any).state.focus).toBe("diff");
        const before = structuredClone(selected(app, "app.ts"));
        app.handleInput(OPTION.down);
        expect(selected(app, "app.ts")).toMatchObject({ line: before.line + 1 });
        expect(viewport(app, "tests").scroll).toBe(0);
      } finally {
        app.dispose();
      }
    });

    it.each([["\x1b[H", "\x1b[F"], ["gg", "G"]])("jumps the focused pane to its first and last line with %j and %j", async (start, end) => {
      const { app } = open();
      try {
        await Promise.resolve();
        app.render(140);
        const press = (keys: string) => [...keys.startsWith("\x1b") ? [keys] : keys].forEach((key) => app.handleInput(key));

        press(end);
        let frame = app.render(140).join("\n");
        expect(selected(app, "app.ts")).toMatchObject({ side: "added", line: 120 });
        expect(viewport(app, "implementation").scroll).toBe(metrics(app, "implementation").max);
        expect(frame).toContain("step120()");
        expect(frame).not.toContain("step1()");
        expect(viewport(app, "tests").scroll).toBe(0);
        expect((app as any).story.member).toBe("implementation");

        press(start);
        frame = app.render(140).join("\n");
        expect(selected(app, "app.ts")).toMatchObject({ side: "added", line: 1 });
        expect(viewport(app, "implementation").scroll).toBe(0);
        expect(frame).toContain("step1()");
        expect(frame).not.toContain("step120()");

        app.handleInput("\x1b[D");
        press(end);
        frame = app.render(140).join("\n");
        expect(viewport(app, "tests").selection).toMatchObject({ line: 120 });
        expect(viewport(app, "tests").scroll).toBe(metrics(app, "tests").max);
        expect(frame).toContain("check120()");
      } finally {
        app.dispose();
      }
    });

    it("reaches both ends of the PR context with Home and End", async () => {
      const load = vi.fn(async () => "Why this change matters");
      const { app } = harness(undefined, 32, { plan: tallPlan, snapshot: tall }, {
        contextPanelSource: { title: "PR context", loadingText: "Loading", load, description: "Full author details\n" + "More background\n".repeat(80) },
      });
      try {
        await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
        app.handleInput("4");
        app.handleInput("D");
        app.render(140);
        app.handleInput("\x1b[F");
        expect((app as any).contextScroll).toBe((app as any).maxContextScroll());
        expect((app as any).contextScroll).toBeGreaterThan(0);
        app.handleInput("\x1b[H");
        expect((app as any).contextScroll).toBe(0);
        expect((app as any).storyContextReturnFocus).toBeDefined();
      } finally {
        app.dispose();
      }
    });
  });
});
