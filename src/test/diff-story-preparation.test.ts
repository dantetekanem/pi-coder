import { afterEach, describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";

const storyAgent = vi.hoisted(() => ({ createStoryAgentGenerator: vi.fn() }));
vi.mock("../diff-story/agent.js", () => storyAgent);

import { prepareDiffStory, selectStoryAgent } from "../ui/diff-story.js";
import * as preferences from "../preferences.js";
import type { StoryAgentActivity } from "../diff-story/activity.js";
import { createStorySnapshot, validateDiffStory } from "../diff-story/plan.js";
import { restoreStoryNavigation } from "../diff-story/navigation.js";
import type { ReviewFile } from "../types.js";

const file: ReviewFile = {
  id: "app", path: "app.ts", worktreeStatus: "modified", hasWorkingTreeFile: true,
  inGitDiff: true, inLastCommit: false, inAllFiles: false, lastCommit: null, allFiles: null,
  gitDiff: { status: "modified", displayPath: "app.ts", oldPath: "app.ts", newPath: "app.ts", hasOriginal: true, hasModified: true },
};
const contents = { originalContent: "before()\n", modifiedContent: "after()\n" };
const snapshot = createStorySnapshot([{ fileId: file.id, path: file.path, scope: "git-diff", contents }]);
const plan = validateDiffStory({
  version: 1,
  snapshot: snapshot.fingerprint,
  summary: "",
  steps: [{
    id: "u1",
    title: "app.ts · lines 1–1",
    explanation: "",
    implementation: [
      { unitId: "u1", fileId: file.id, side: "added", startLine: 1, endLine: 1 },
      { unitId: "u1", fileId: file.id, side: "deleted", startLine: 1, endLine: 1 },
    ],
    tests: [],
  }],
}, snapshot);
const orderOutput = '{"order":[],"pairs":[]}';
const disposals: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
  vi.restoreAllMocks();
  storyAgent.createStoryAgentGenerator.mockReset();
  vi.useRealTimers();
});

function harness() {
  let component: { render: (width: number) => string[]; handleInput: (key: string) => void; dispose: () => void };
  const completed = vi.fn();
  const terminal = { rows: 30 };
  const requestRender = vi.fn();
  const ctx = {
    ui: {
      custom: vi.fn((factory: (...args: any[]) => typeof component, _options?: unknown) => new Promise((resolve) => {
        const tui = { terminal, requestRender };
        const theme = { fg: (_: string, text: string) => text };
        component = factory(tui, theme, {}, (value: unknown) => {
          completed(value);
          component.dispose();
          resolve(value);
        });
        disposals.push(() => component.dispose());
      })),
    },
  };
  return { ctx, completed, terminal, requestRender, view: () => component };
}

describe("story agent selection", () => {
  it("reports a failed preference save instead of claiming a different model was selected", async () => {
    const model = { provider: "openrouter", id: "anthropic/claude-opus:extended", thinkingLevelMap: { high: "high" } };
    vi.spyOn(preferences, "saveReviewPreference").mockImplementation(() => {});
    vi.spyOn(preferences, "loadReviewPreferences").mockReturnValue(preferences.DEFAULT_REVIEW_PREFERENCES);
    const ctx = {
      modelRegistry: { getAvailable: () => [model], find: () => model },
      ui: { select: vi.fn().mockResolvedValueOnce(`${model.provider}/${model.id}`).mockResolvedValueOnce("high"), notify: vi.fn() },
    };

    await selectStoryAgent(ctx as never);

    expect(ctx.ui.notify).toHaveBeenCalledOnce();
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/could not save/i), "error");
  });
});

describe("centered story preparation", () => {
  it.each(["ready", "cancel"])("streams public output below status, supports pausing, and clears feedback on %s", async (ending) => {
    vi.useFakeTimers();
    const preparation = harness();
    let emit!: (activity: StoryAgentActivity) => void;
    let finish!: (value: string) => void;
    storyAgent.createStoryAgentGenerator.mockImplementation((_ctx, _selection, onActivity) => {
      emit = onActivity;
      return () => new Promise<string>((resolve) => { finish = resolve; });
    });
    const ready = prepareDiffStory(preparation.ctx as never, [file], "git-diff", async () => contents);
    await vi.waitFor(() => expect(storyAgent.createStoryAgentGenerator).toHaveBeenCalledOnce());

    emit({ kind: "status", text: "Arranging prepared code and tests" });
    emit({ kind: "text", id: "final", text: '{"order":["u1"]}' });
    const rows = preparation.view().render(80);
    const previewRow = rows.findIndex((row) => row.includes('"order":["u1"]'));
    expect(previewRow).toBeGreaterThan(rows.findIndex((row) => row.includes("Constructing storyline")));
    expect(previewRow).toBeGreaterThan(20);
    expect(rows.every((row) => visibleWidth(row) === 80)).toBe(true);
    preparation.view().handleInput(" ");
    emit({ kind: "text", id: "final", text: orderOutput });
    expect(preparation.view().render(80).join("\n")).toContain('"order":["u1"]');
    preparation.view().handleInput(" ");
    expect(preparation.view().render(80).join("\n")).toContain(orderOutput);

    if (ending === "ready") finish(orderOutput);
    else preparation.view().handleInput("\x1b");
    await ready;
    const renders = preparation.requestRender.mock.calls.length;
    emit({ kind: "text", id: "final", text: "Late output" });
    finish(orderOutput);
    await vi.advanceTimersByTimeAsync(1000);
    expect(preparation.view().render(80).join("\n")).not.toContain(orderOutput);
    expect(preparation.view().render(80).join("\n")).not.toContain("Late output");
    expect(preparation.requestRender).toHaveBeenCalledTimes(renders);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops failed feedback and retries only on request without rereading the captured files", async () => {
    vi.useFakeTimers();
    const preparation = harness();
    const load = vi.fn(async () => contents);
    const generate = vi.fn()
      .mockImplementationOnce(async () => {
        throw new Error("Provider unavailable.");
      })
      .mockResolvedValueOnce(orderOutput);
    const ready = prepareDiffStory(preparation.ctx as never, [file], "git-diff", load, undefined, generate);
    await vi.waitFor(() => expect(preparation.view().render(100).join("\n")).toContain("r retry"));
    expect(vi.getTimerCount()).toBe(0);
    preparation.view().handleInput("r");
    await expect(ready).resolves.toEqual({ plan, snapshot });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(load).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["loading", "error"])("fills the resized terminal in the %s state without exposing the conversation", async (state) => {
    const preparation = harness();
    const generate = vi.fn(() => state === "error"
      ? Promise.reject(new Error("Generation unavailable"))
      : new Promise<string>(() => {}));
    const ready = prepareDiffStory(preparation.ctx as never, [file], "git-diff", async () => contents, undefined, generate);
    const phase = state === "error" ? "Story could not be prepared" : "Constructing storyline";
    await vi.waitFor(() => expect(preparation.view().render(100).join("\n")).toContain(phase));

    expect(preparation.ctx.ui.custom).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({
      overlay: true,
      overlayOptions: expect.objectContaining({ anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 }),
    }));
    for (const [width, height] of [[80, 30], [120, 45], [40, 20]] as const) {
      preparation.terminal.rows = height;
      const rows = preparation.view().render(width);
      expect(rows).toHaveLength(height);
      expect(rows.every((row) => visibleWidth(row) === width)).toBe(true);
    }
    preparation.view().handleInput("\x1b");
    await expect(ready).resolves.toBeUndefined();
  });

  it("animates the running phase even while activity is paused, then returns the captured bytes and validated plan", async () => {
    vi.useFakeTimers();
    const preparation = harness();
    let finish!: (value: string) => void;
    const generate = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
    const ready = prepareDiffStory(preparation.ctx as never, [file], "git-diff", async () => contents, undefined, generate);
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());

    const rows = preparation.view().render(80);
    expect(rows.join("\n")).toContain("1 files · +1 −1 lines changed");
    expect(rows.join("\n")).toContain("Constructing storyline");
    expect(rows.every((row) => visibleWidth(row) <= 80)).toBe(true);
    const runningLine = () => preparation.view().render(80).find((row) => row.includes("Constructing storyline"))!;
    const initial = runningLine();
    preparation.view().handleInput(" ");
    const renders = preparation.requestRender.mock.calls.length;
    await vi.advanceTimersByTimeAsync(80);
    expect(runningLine()).not.toBe(initial);
    expect(preparation.requestRender.mock.calls.length).toBeGreaterThan(renders);
    finish(orderOutput);
    await expect(ready).resolves.toEqual({ plan, snapshot });
  });

  it("cancels promptly and never mounts a late answer", async () => {
    const preparation = harness();
    let finish!: (value: string) => void;
    let signal!: AbortSignal;
    const generate = vi.fn((_system, _prompt, value: AbortSignal) => {
      signal = value;
      return new Promise<string>((resolve) => { finish = resolve; });
    });
    const ready = prepareDiffStory(preparation.ctx as never, [file], "git-diff", async () => contents, undefined, generate);
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
    preparation.view().handleInput("\x1b");

    await expect(ready).resolves.toBeUndefined();
    expect(signal.aborted).toBe(true);
    finish(orderOutput);
    await Promise.resolve();
    expect(preparation.completed).toHaveBeenCalledTimes(1);
  });

  it("resumes matching hashes without a model call and requires an explicit rebuild for drift", async () => {
    const saved = restoreStoryNavigation(plan);
    const generate = vi.fn(async () => orderOutput);
    const matching = harness();
    await expect(prepareDiffStory(matching.ctx as never, [file], "git-diff", async () => contents, saved, generate))
      .resolves.toEqual({ plan, snapshot });
    expect(generate).not.toHaveBeenCalled();

    const drifted = harness();
    const old = { ...saved, plan: { ...plan, snapshot: "old snapshot" } };
    const ready = prepareDiffStory(drifted.ctx as never, [file], "git-diff", async () => contents, old, generate);
    await vi.waitFor(() => expect(drifted.view().render(100).join("\n")).toContain("needs rebuilding"));
    expect(generate).not.toHaveBeenCalled();
    drifted.view().handleInput("r");
    await expect(ready).resolves.toEqual({ plan, snapshot });
    expect(generate).toHaveBeenCalledOnce();
  });
});
