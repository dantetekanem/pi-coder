import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { generateDiffStory } from "../diff-story/generate.js";
import { createStorySnapshot, uncoveredStoryChanges, validateDiffStory } from "../diff-story/plan.js";
import { ReviewApp } from "../ui/review-app.js";
import type { ReviewFile } from "../types.js";
import type { ReviewSessionData } from "../review-session.js";

const previous = process.env.PI_CODE_DIFF_PREFERENCES_PATH;
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "diff-story-ui-"));
  process.env.PI_CODE_DIFF_PREFERENCES_PATH = join(directory, "prefs.json");
});
afterEach(() => {
  if (previous == null) delete process.env.PI_CODE_DIFF_PREFERENCES_PATH;
  else process.env.PI_CODE_DIFF_PREFERENCES_PATH = previous;
  rmSync(directory, { recursive: true, force: true });
});

const files: ReviewFile[] = ["app.ts", "app.test.ts"].map((path) => ({
  id: path, path, worktreeStatus: "modified", hasWorkingTreeFile: true,
  inGitDiff: true, inAllFiles: false, inLastCommit: false,
  gitDiff: { status: "modified", oldPath: path, newPath: path, displayPath: path, hasOriginal: true, hasModified: true },
  allFiles: null, lastCommit: null,
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

function harness(initialSession?: ReviewSessionData, rows = 40, pair = { plan, snapshot }) {
  let saved: ReviewSessionData | undefined;
  const done = vi.fn();
  const tui = { terminal: { rows, columns: 140 }, requestRender: vi.fn() };
  const theme = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text };
  const app = new ReviewApp(tui, theme as never, done, {
    repoRoot: "/repo",
    files,
    visibleScopes: ["git-diff"],
    commentShortcuts: [],
    notify: vi.fn(),
    allowEmptySubmit: true,
    loadFileContents: async (_root, file) => pair.snapshot.files.find((entry) => entry.fileId === file.id)!.contents,
    story: pair,
    initialSession,
    onSessionChange: (data) => {
      saved = structuredClone(data);
      return true;
    },
  });
  return { app, done, saved: () => saved };
}

describe("paired diff story", () => {
  it("keeps the cursor on the step's own lines and uses Option only for their context", async () => {
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
      app.handleInput("\x1b[1;3A");
      expect(selected().line).toBe(4);
      for (let i = 0; i < 5; i += 1) app.handleInput("\x1b[1;3A");
      app.render(140);
      expect(selected().line).toBe(2);
      app.handleInput("\x1b[1;4B");
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

      app.handleInput("\x1b[C");
      app.handleInput("\x1b[1;2B");
      app.handleInput("\x1b[D");
      app.render(140);
      app.handleInput("\x1b[C");
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
      expect(visible).toContain("Summary-0");
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

      app.handleInput("\x1b[C");
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

  it("marks the linked step rather than unseen files, resumes both members, and keeps final comments intact", async () => {
    const first = harness();
    let saved: ReviewSessionData | undefined;
    try {
      await Promise.resolve();
      first.app.render(140);
      first.app.handleInput("R");
      first.app.handleInput("\x1b[C");
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
      expect((resumed.app as any).state.activeFileId).toBe("app.test.ts");
      resumed.app.handleInput("s");
      expect(resumed.done).toHaveBeenCalledWith(expect.objectContaining({
        type: "submit",
        comments: [expect.objectContaining({ body: "Review note", fileId: "app.test.ts" })],
      }));
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
      app.handleInput("\x1b[C");
      app.handleInput("c");
      app.handleInput("Assertion question");
      app.handleInput("\r");
      app.handleInput("\x1b[D");
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
});
