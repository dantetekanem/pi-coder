import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplyThread } from "../review-replies.js";
import { setSelectedLineTarget } from "../state.js";
import type { ReviewConversationMetadata, ReviewFile, ReviewRepliesPanelSource } from "../types.js";
import { ReviewApp } from "../ui/review-app.js";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const originalContent = ["function total(items) {", "  let sum = 1;", "  return sum;", "}", ""].join("\n");
const modifiedContent = ["function total(items) {", "  let sum = 0;", "  for (const item of items) sum += item.price;", "  return sum;", "}", ""].join("\n");

const originalPreferencesPath = process.env.PI_CODER_PREFERENCES_PATH;
let preferencesDir: string;

beforeEach(() => {
  preferencesDir = mkdtempSync(join(tmpdir(), "pi-coder-review-threads-"));
  process.env.PI_CODER_PREFERENCES_PATH = join(preferencesDir, "preferences.json");
  writeFileSync(process.env.PI_CODER_PREFERENCES_PATH, JSON.stringify({
    diffViewMode: "unified",
    paneVisibility: { navigator: true, diff: true, comments: true, context: false, replies: false },
  }));
});

afterEach(() => {
  if (originalPreferencesPath == null) delete process.env.PI_CODER_PREFERENCES_PATH;
  else process.env.PI_CODER_PREFERENCES_PATH = originalPreferencesPath;
  rmSync(preferencesDir, { recursive: true, force: true });
});

function setPreferences(patch: Record<string, unknown>): void {
  const path = process.env.PI_CODER_PREFERENCES_PATH!;
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), ...patch }));
}

function makeFile(): ReviewFile {
  return {
    id: "src/cart.ts::working::::",
    path: "src/cart.ts",
    worktreeStatus: "modified",
    hasWorkingTreeFile: true,
    inGitDiff: true,
    inAllFiles: false,
    gitDiff: { status: "modified", oldPath: "src/cart.ts", newPath: "src/cart.ts", displayPath: "src/cart.ts", hasOriginal: true, hasModified: true,
      originalRevision: BASE, modifiedRevision: HEAD },
    allFiles: null,
  };
}

function conversation(): ReviewConversationMetadata {
  return { identity: "current-pr", generation: 1, attempt: 1, fetchedAt: "2026-11-01T12:00:00.000Z", threadCounts: { open: 2, unknown: 0 },
    coverage: { details: "complete", comments: "complete", reviews: "complete", threads: "complete", checks: "complete", identity: "complete" } };
}

function makeThreads(): ReplyThread[] {
  return [
    { id: "open", resolved: false, side: "added", path: "src/cart.ts", line: 3, headRevision: HEAD, comments: [
      { id: "1", author: "alice", body: "Use reduce here?\nIt reads better.", createdAt: "2026-11-01T10:00:00Z" },
      { id: "2", author: "bob", body: "Agreed." },
    ] },
    { id: "resolved", resolved: true, side: "added", path: "src/cart.ts", line: 2, headRevision: HEAD, comments: [{ id: "3", author: "carol", body: "Fixed already" }] },
    { id: "older", resolved: false, side: "added", path: "src/cart.ts", line: 1, headRevision: "c".repeat(40), comments: [{ id: "4", author: "dave", body: "Written on an older push" }] },
  ];
}

function createHarness(threads = makeThreads(), withReplies = true) {
  const data = { conversation: conversation(), threads };
  let read = false;
  const load = vi.fn(async () => {
    read = true;
    return { replies: [], selfLogin: "me", fetchedAt: "2026-11-01T12:00:00.000Z", conversation: data.conversation };
  });
  const repliesSource: ReviewRepliesPanelSource = {
    title: "Replies",
    loadingText: "Loading replies",
    get threadData() { return read ? data : undefined; },
    load,
  };
  const tui = {
    mode: "regular",
    terminal: { write: vi.fn(), rows: 30, columns: 180 },
    requestRender: vi.fn(),
    getShowHardwareCursor: vi.fn(() => false),
    setShowHardwareCursor: vi.fn(),
  };
  const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text };
  const file = makeFile();
  const app = new ReviewApp(tui as never, theme as never, vi.fn(), {
    files: [file],
    repoRoot: "/repo",
    loadFileContents: vi.fn(async () => ({ originalContent, modifiedContent })),
    commentShortcuts: [],
    scope: "git-diff",
    notify: vi.fn(),
    reviewHeader: { identity: "example/widgets#12", revision: HEAD },
    ...(withReplies ? { repliesSource } : {}),
  });
  return { app, load, file };
}

async function open(harness: ReturnType<typeof createHarness>) {
  await (harness.app as any).ensureActiveEntry();
  await vi.waitFor(() => expect(harness.load).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect((harness.app as any).threadData).toBeDefined());
  (harness.app as any).state = { ...(harness.app as any).state, focus: "diff" };
}

/** The diff gutter marker sits two cells before the code text. */
function markerBefore(rendered: string[], code: string): string {
  const line = rendered.find((candidate) => candidate.includes(code)) ?? "";
  return line[line.indexOf(code) - 2] ?? "";
}

describe("PR threads on diff lines", () => {
  it("reads PR threads in the background and marks only verified open threads", async () => {
    const harness = createHarness();
    await open(harness);
    const rendered = harness.app.render(180);
    expect(markerBefore(rendered, "  for (const item of items)")).toBe("\u25cb");
    expect(markerBefore(rendered, "  let sum = 0;")).toBe(" ");
    expect(markerBefore(rendered, "function total(items) {")).toBe(" ");
    expect(rendered.join("\n")).toContain("\u25cb 1 PR thread, 1 more in Replies (I show)");
    expect(rendered.some((line) => line.includes("M cart.ts 2\u25cb"))).toBe(true);
    expect(rendered.join("\n")).not.toContain("Use reduce here?");
    harness.app.dispose();
  });

  it("toggles the thread text under its line without touching the review draft", async () => {
    const harness = createHarness();
    await open(harness);
    const draft = structuredClone((harness.app as any).state.draft);

    harness.app.handleInput("I");
    let rendered = harness.app.render(180);
    const code = rendered.findIndex((line) => line.includes("for (const item of items)"));
    const header = rendered.findIndex((line) => line.includes("\u25cb PR thread \u00b7 unresolved"));
    const next = rendered.findIndex((line) => line.includes("return sum;"));
    expect(code).toBeGreaterThan(-1);
    expect(header).toBe(code + 1);
    expect(next).toBeGreaterThan(header);
    for (const text of ["alice \u00b7 2026-11-01", "Use reduce here?", "It reads better.", "bob", "Agreed."]) {
      const index = rendered.findIndex((line) => line.includes(text));
      expect(index).toBeGreaterThan(code);
      expect(index).toBeLessThan(next);
    }
    expect(rendered.join("\n")).not.toContain("Fixed already");
    expect(rendered.join("\n")).not.toContain("Written on an older push");
    expect(rendered.join("\n")).toContain("(I hide)");
    expect(JSON.parse(readFileSync(process.env.PI_CODER_PREFERENCES_PATH!, "utf8")).showPullRequestThreads).toBe(true);
    expect((harness.app as any).state.draft).toEqual(draft);

    harness.app.handleInput("I");
    rendered = harness.app.render(180);
    expect(rendered.join("\n")).not.toContain("Use reduce here?");
    expect(markerBefore(rendered, "  for (const item of items)")).toBe("\u25cb");
    expect((harness.app as any).state.draft).toEqual(draft);
    expect((harness.app as any).getSessionData().state.draft.comments).toEqual([]);
    harness.app.dispose();
  });

  it("keeps the reviewer's own feedback marker on a line with a PR thread", async () => {
    const harness = createHarness();
    await open(harness);
    const view = harness.app as any;
    view.state = setSelectedLineTarget(view.state, harness.file.id, "git-diff", { side: "added", line: 3 });
    harness.app.handleInput("c");
    harness.app.handleInput("Mine");
    harness.app.handleInput("\r");
    expect(markerBefore(harness.app.render(180), "  for (const item of items)")).toBe("\u25a0");
    expect(view.state.draft.comments).toEqual([expect.objectContaining({ body: "Mine", side: "added", startLine: 3 })]);
    harness.app.dispose();
  });

  it("marks and shows threads in the side-by-side view", async () => {
    setPreferences({ diffViewMode: "side-by-side", showPullRequestThreads: true });
    const harness = createHarness();
    await open(harness);
    const rendered = harness.app.render(180);
    const code = rendered.findIndex((line) => line.includes("for (const item of items)"));
    const header = rendered.findIndex((line) => line.includes("\u25cb PR thread \u00b7 unresolved"));
    expect(markerBefore(rendered, "  for (const item of items)")).toBe("\u25cb");
    expect(header).toBeGreaterThan(code);
    expect(header).toBeLessThan(rendered.findIndex((line) => line.includes("return sum;")));
    expect(rendered.join("\n")).toContain("Use reduce here?");
    harness.app.dispose();
  });

  it("marks a thread on an unchanged old line in the unified view", async () => {
    const harness = createHarness([{ id: "base", resolved: null, side: "deleted", path: "src/cart.ts", line: 1, baseRevision: BASE,
      comments: [{ id: "9", author: "erin", body: "Rename this function?" }] }]);
    await open(harness);
    harness.app.handleInput("I");
    const rendered = harness.app.render(180);
    const code = rendered.findIndex((line) => line.includes("function total(items)"));
    expect(markerBefore(rendered, "function total(items) {")).toBe("\u25cb");
    expect(rendered[code + 1]).toContain("\u25cb PR thread \u00b7 resolution unknown");
    expect(rendered.join("\n")).toContain("Rename this function?");
    harness.app.dispose();
  });

  it("explains the toggle in a review without a pull request", async () => {
    const harness = createHarness(makeThreads(), false);
    await (harness.app as any).ensureActiveEntry();
    harness.app.handleInput("I");
    expect((harness.app as any).message).toBe("PR threads show only in pull request reviews.");
    expect(harness.load).not.toHaveBeenCalled();
    harness.app.dispose();
  });
});
