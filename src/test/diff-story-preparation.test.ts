import { afterEach, describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";

const storyAgent = vi.hoisted(() => ({ createStoryAgentGenerator: vi.fn() }));
vi.mock("../diff-story/agent.js", () => storyAgent);
const formalFailure = vi.hoisted(() => ({ error: undefined as Error | undefined }));
vi.mock("../diff-story/formal.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../diff-story/formal.js")>();
  return {
    ...actual,
    generateFormalStory: (...args: Parameters<typeof actual.generateFormalStory>) =>
      formalFailure.error == null ? actual.generateFormalStory(...args) : Promise.reject(formalFailure.error),
  };
});

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
const localeFile = (path: string): ReviewFile => ({
  ...file, id: path, path,
  gitDiff: { ...file.gitDiff!, displayPath: path, oldPath: path, newPath: path },
});
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
const formalOutput = JSON.stringify({
  steps: [{ units: ["u1"], title: "Call after() instead of before()", priority: "needed", property: "The app calls after().", checks: ["Run it."] }],
});
const formalStory = {
  snapshot,
  storylineFirst: true,
  plan: { snapshot: snapshot.fingerprint, steps: [expect.objectContaining({ title: "Needed · Call after() instead of before()" })] },
};
const disposals: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
  vi.restoreAllMocks();
  storyAgent.createStoryAgentGenerator.mockReset();
  formalFailure.error = undefined;
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
  it("keeps remote orientation visible while generation is pending and still cancels immediately", async () => {
    const preparation = harness();
    const generate = vi.fn(() => new Promise<string>(() => {}));
    const ready = prepareDiffStory(preparation.ctx as never, [file], "git-diff", async () => contents, undefined, generate, {
      header: {
        identity: "dantetekanem/pi-coder#25",
        title: "Reuse pending requests",
        revision: "a".repeat(40),
        state: "OPEN",
      },
      brief: "Reuse work rather than starting the same request twice.",
    });
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
    for (const [width, height] of [[80, 30], [40, 20]] as const) {
      preparation.terminal.rows = height;
      const rows = preparation.view().render(width);
      expect(rows).toHaveLength(height);
      expect(rows.every((row) => visibleWidth(row) === width)).toBe(true);
      expect(rows.join("\n")).toContain("dantetekanem/pi-coder#25");
      expect(rows.join("\n")).toContain("@aaaaaaa");
      expect(rows.join("\n")).toContain("Reuse pending requests");
    }
    preparation.view().handleInput("\x1b");
    await expect(ready).resolves.toBeUndefined();
  });

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

    if (ending === "ready") finish(formalOutput);
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
      .mockResolvedValueOnce(formalOutput);
    const ready = prepareDiffStory(preparation.ctx as never, [file], "git-diff", load, undefined, generate);
    await vi.waitFor(() => expect(preparation.view().render(100).join("\n")).toContain("r retry"));
    expect(preparation.view().render(100).join("\n")).toContain("The guideline model failed: Provider unavailable.");
    expect(vi.getTimerCount()).toBe(0);
    preparation.view().handleInput("r");
    await expect(ready).resolves.toMatchObject(formalStory);
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
    const phase = state === "error" ? "Storyline built from host rules only" : "Constructing storyline";
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
    finish(formalOutput);
    await expect(ready).resolves.toMatchObject(formalStory);
  });

  it("opens the host-rule story on Enter when the guideline model fails", async () => {
    const preparation = harness();
    const generate = vi.fn(async () => {
      throw new Error("Provider \u001b[31mdown.");
    });
    const ready = prepareDiffStory(preparation.ctx as never, [file], "git-diff", async () => contents, undefined, generate);
    await vi.waitFor(() => expect(preparation.view().render(100).join("\n")).toContain("Enter continue with host steps"));

    preparation.view().handleInput("\r");
    await expect(ready).resolves.toMatchObject({
      snapshot,
      storylineFirst: true,
      guide: { refinement: { status: "failed", message: "Provider [31mdown." } },
      plan: { summary: expect.stringContaining("The guideline model failed (Provider [31mdown.), so steps follow host rules.") },
    });
    expect(generate).toHaveBeenCalledOnce();
  });

  it("sends the PR description with the guideline request and saves the guide for the same bytes", async () => {
    const preparation = harness();
    const saves: unknown[] = [];
    const store = { load: vi.fn(async () => undefined), save: vi.fn(async (guide: unknown) => (saves.push(guide), { status: "saved" as const, path: "/guides/x.json" })) };
    const generate = vi.fn(async (_system: string, prompt: string) => {
      expect(prompt).toContain("Swap before() for after().");
      return formalOutput;
    });
    const target = { kind: "remote" as const, label: "owner/repo#7", repoRoot: "/repo", scope: "git-diff" as const };
    const ready = prepareDiffStory(preparation.ctx as never, [file], "git-diff", async () => contents, undefined, generate, undefined, {
      target,
      description: "## Solution\n\nSwap before() for after().",
      store,
    });

    await expect(ready).resolves.toMatchObject(formalStory);
    expect(store.load).toHaveBeenCalledWith(snapshot.fingerprint);
    expect(saves).toEqual([expect.objectContaining({ snapshot: snapshot.fingerprint, target, refinement: expect.objectContaining({ status: "applied" }) })]);
  });

  it("keeps the formal story when the guide store throws", async () => {
    const preparation = harness();
    const generate = vi.fn(async () => formalOutput);
    const store = { load: () => { throw new Error("Broken store."); }, save: () => { throw new Error("Broken store."); } };
    const ready = prepareDiffStory(preparation.ctx as never, [file], "git-diff", async () => contents, undefined, generate, undefined, {
      target: { kind: "working", label: "uncommitted changes", repoRoot: "/repo", scope: "git-diff" },
      store: store as never,
    });

    await expect(ready).resolves.toMatchObject(formalStory);
    expect(generate).toHaveBeenCalledOnce();
  });

  it("falls back to the plain story order, opening on its storyline, when the validation guide cannot be built", async () => {
    formalFailure.error = new Error("Broken \u001b[31mguide.");
    const preparation = harness();
    const generate = vi.fn(async () => orderOutput);
    const ready = prepareDiffStory(preparation.ctx as never, [file], "git-diff", async () => contents, undefined, generate);

    await expect(ready).resolves.toEqual({
      snapshot,
      storylineFirst: true,
      plan: { ...plan, summary: "Formal validation failed (Broken [31mguide.); steps follow the plain story order." },
    });
    expect(generate).toHaveBeenCalledOnce();
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
    const generate = vi.fn(async () => formalOutput);
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
    await expect(ready).resolves.toMatchObject(formalStory);
    expect(generate).toHaveBeenCalledOnce();
  });

  it("skips non-English/non-pt-BR locale files before capture, like /diff", async () => {
    const preparation = harness();
    const french = localeFile("config/locales/fr.yml");
    const load = vi.fn(async () => contents);
    let finish!: (value: string) => void;
    const generate = vi.fn((_system: string, _prompt: string) => new Promise<string>((resolve) => { finish = resolve; }));
    const files = [file, localeFile("config/locales/en.yml"), localeFile("config/locales/pt-BR.yml"), french];
    const ready = prepareDiffStory(preparation.ctx as never, files, "git-diff", load, undefined, generate);
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());

    expect(preparation.view().render(100).join("\n")).toContain("3 files · +3 −3 lines changed · 1 locale hidden");
    expect(load).not.toHaveBeenCalledWith(french, "git-diff");
    expect(generate.mock.calls[0]![1]).not.toContain("fr.yml");
    finish(formalOutput);
    await expect(ready).resolves.toMatchObject({
      snapshot: { files: [{ path: "app.ts" }, { path: "config/locales/en.yml" }, { path: "config/locales/pt-BR.yml" }] },
    });
  });

  it("explains a change with only skipped locale files and never calls the model", async () => {
    const preparation = harness();
    const load = vi.fn(async () => contents);
    const generate = vi.fn(async () => orderOutput);
    const ready = prepareDiffStory(preparation.ctx as never, [localeFile("config/locales/fr.yml")], "git-diff", load, undefined, generate);
    await vi.waitFor(() => expect(preparation.view().render(100).join("\n")).toContain("No story to build"));

    const screen = preparation.view().render(100).join("\n");
    expect(screen).toContain("This change only touches non-English/non-pt-BR locale files, which stories skip.");
    expect(screen).toContain("0 selected files · 1 locale hidden");
    expect(screen).toContain("f ordinary diff · Esc cancel");
    expect(screen).not.toContain("r retry");
    preparation.view().handleInput("f");
    await expect(ready).resolves.toBe("diff");
    expect(load).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });
});
