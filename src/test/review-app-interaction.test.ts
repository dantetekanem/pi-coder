import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ReviewContextPanelSource, ReviewConversationMetadata, ReviewFile, ReviewFileContents, ReviewReplyItem, ReviewRepliesSnapshot } from "../types.js";
import { getHalfPageStep, ReviewApp } from "../ui/review-app.js";
import { hashTargetSlice } from "../workbench/target.js";
import * as piRender from "../pi-render.js";
import { getSelectedLineTarget } from "../state.js";

const STATUS_CELL_BOUND = 96;
const STATUS_BYTE_BOUND = 256;
const TERMINAL_CONTROL_PATTERN = /[\u0000-\u001F\u007F-\u009F]/;

function expectSafeStatus(app: ReviewApp, marker: string): void {
  const message = String((app as any).message);
  expect(message).toContain(marker);
  expect(message).not.toMatch(TERMINAL_CONTROL_PATTERN);
  expect(visibleWidth(message)).toBeLessThanOrEqual(STATUS_CELL_BOUND);
  expect(Buffer.byteLength(message, "utf8")).toBeLessThanOrEqual(STATUS_BYTE_BOUND);

  const statusRows = app.render(120).filter((row) => row.includes(marker));
  expect(statusRows.length).toBeGreaterThan(0);
  for (const row of statusRows) {
    expect(row).not.toMatch(TERMINAL_CONTROL_PATTERN);
    expect(row.split("\n")).toHaveLength(1);
    const statusRow = row.replace(/^[│ ]+/, "").replace(/[│ ]+$/, "");
    expect(visibleWidth(statusRow)).toBeLessThanOrEqual(STATUS_CELL_BOUND);
    expect(Buffer.byteLength(statusRow, "utf8")).toBeLessThanOrEqual(STATUS_BYTE_BOUND);
  }
}

const originalPreferencesPath = process.env.PI_CODE_DIFF_PREFERENCES_PATH;
let preferencesDir: string;

beforeEach(() => {
  preferencesDir = mkdtempSync(join(tmpdir(), "pi-code-diff-review-app-"));
  process.env.PI_CODE_DIFF_PREFERENCES_PATH = join(preferencesDir, "preferences.json");
});

afterEach(() => {
  if (originalPreferencesPath == null) delete process.env.PI_CODE_DIFF_PREFERENCES_PATH;
  else process.env.PI_CODE_DIFF_PREFERENCES_PATH = originalPreferencesPath;
  rmSync(preferencesDir, { recursive: true, force: true });
});

function makeFile(path = "src/app.ts"): ReviewFile {
  return {
    id: `${path}::working::::`,
    path,
    worktreeStatus: "modified",
    hasWorkingTreeFile: true,
    inGitDiff: true,
    inLastCommit: false,
    inAllFiles: false,
    gitDiff: {
      status: "modified",
      oldPath: path,
      newPath: path,
      displayPath: path,
      hasOriginal: true,
      hasModified: true,
    },
    lastCommit: null,
    allFiles: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createHarness(
  contents: ReviewFileContents = { originalContent: "\told()  \n", modifiedContent: "\tcurrent()  \n" },
  files = [makeFile()],
  overrides: Partial<ConstructorParameters<typeof ReviewApp>[3]> = {},
  terminal: { rows?: number; columns?: number } = {},
) {
  const loadFileContents = vi.fn(async () => contents);
  const terminalWrite = vi.fn<(data: string) => void>();
  const tui = {
    terminal: { write: terminalWrite, rows: terminal.rows ?? 30, columns: terminal.columns ?? 120 },
    requestRender: vi.fn(),
    getShowHardwareCursor: vi.fn(() => false),
    setShowHardwareCursor: vi.fn(),
  };
  const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
  };
  const done = vi.fn();
  const app = new ReviewApp(tui as never, theme as never, done, {
    files,
    repoRoot: "/repo",
    loadFileContents,
    commentShortcuts: [],
    visibleScopes: ["git-diff"],
    notify: vi.fn(),
    ...overrides,
  });
  return { app, done, loadFileContents, terminalWrite, theme };
}

describe("ReviewApp interaction", () => {
  it("reuses the action hint at the same width and rebuilds it after resize or invalidation", async () => {
    const { app, loadFileContents, theme } = createHarness();
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());
    const foreground = vi.spyOn(theme, "fg");
    const hintCalls = () => foreground.mock.calls.filter(([, text]) => text === "Enter/m").length;
    try {
      app.render(120);
      expect(hintCalls()).toBe(1);
      app.render(120);
      expect(hintCalls()).toBe(1);
      app.render(160);
      expect(hintCalls()).toBe(2);
      app.invalidate();
      app.render(160);
      expect(hintCalls()).toBe(3);
    } finally {
      foreground.mockRestore();
      app.dispose();
    }
  });

  it.each(["unified", "side-by-side"])("reuses %s navigation targets until the layout is invalidated", async (mode) => {
    const modifiedContent = Array.from({ length: 2000 }, (_, i) => `line ${i + 1}`).join("\n");
    const { app, loadFileContents } = createHarness({ originalContent: "", modifiedContent });
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());
    (app as any).diffViewMode = mode;
    app.render(120);
    app.handleInput("\r");
    app.handleInput("\x1b[B");
    const fileId = (app as any).state.activeFileId;
    const layout = (app as any).getDiffLayout(fileId, "git-diff");
    const rowsKey = mode === "unified" ? "unifiedRows" : "sideBySideRows";
    layout[rowsKey] = new Proxy(layout[rowsKey], {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property) && Number(property) > 500) {
          throw new Error("rescanned offscreen navigation rows");
        }
        return Reflect.get(target, property, receiver);
      },
    });
    try {
      app.handleInput("\x1b[B");
      expect(getSelectedLineTarget((app as any).state, fileId, "git-diff")).toEqual({ side: "added", line: 3 });
      app.invalidate();
      app.handleInput("\x1b[A");
      expect(getSelectedLineTarget((app as any).state, fileId, "git-diff")).toEqual({ side: "added", line: 2 });
    } finally {
      app.dispose();
    }
  });

  it.each(["unified", "side-by-side"])("styles only visible wrapped %s rows when measuring a large diff", async (mode) => {
    const modifiedContent = Array.from({ length: 2000 }, (_, i) => `const item${i} = "日本語";`).join("\n");
    const { app, loadFileContents, theme } = createHarness({ originalContent: "", modifiedContent });
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());
    (app as any).diffViewMode = mode;
    (app as any).state.wrapLines = true;
    const background = vi.spyOn(theme, "bg");
    try {
      const lines = app.render(120);
      expect(lines.join("\n")).toContain("item0");
      expect(lines.every((line) => visibleWidth(line) <= 120)).toBe(true);
      expect(background.mock.calls.length).toBeLessThan(120);
    } finally {
      background.mockRestore();
      app.dispose();
    }
  });

  it.each(["unified", "side-by-side"])("limits unwrapped %s highlighting to the viewport on first render and resize", async (mode) => {
    const modifiedContent = Array.from({ length: 2000 }, (_, i) => `const item${i} = "日本語";`).join("\n");
    const { app, loadFileContents } = createHarness({ originalContent: "", modifiedContent });
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());
    (app as any).diffViewMode = mode;
    (app as any).state.wrapLines = false;
    const highlight = vi.spyOn(piRender, "highlightCodeLineWithPi");
    try {
      for (const width of [120, 160]) {
        const lines = app.render(width);
        expect(lines.join("\n")).toContain("item0");
        expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
        expect(highlight.mock.calls.length).toBeLessThan(120);
      }
    } finally {
      highlight.mockRestore();
      app.dispose();
    }
  });

  it("uses lowercase o for a writable local current-side bridge target and preserves editor isolation", async () => {
    const { app, done, loadFileContents } = createHarness(undefined, undefined, {
      reviewIdentity: "/repo|working|worktree|local",
      reviewSessionId: "session-1",
    } as never);
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());
    app.handleInput("\r");
    app.handleInput("\x1b[B");
    app.handleInput("o");

    expect(done).toHaveBeenCalledWith(expect.objectContaining({
      type: "open-code",
      target: expect.objectContaining({ path: "src/app.ts", range: expect.any(Object), anchor: expect.any(Object) }),
      resume: expect.objectContaining({ repository: "/repo", sessionId: "session-1", scope: "git-diff", side: "added" }),
    }));

    const isolated = createHarness();
    await vi.waitFor(() => expect(isolated.loadFileContents).toHaveBeenCalled());
    isolated.app.handleInput("\r");
    isolated.app.handleInput("c");
    isolated.app.handleInput("o");
    expect(isolated.done).not.toHaveBeenCalled();
    expect((isolated.app as any).editor.getText()).toContain("o");
    app.dispose();
    isolated.app.dispose();
  });

  it("emits a typed external-editor transition with the contextual current file and line", async () => {
    const previousEditor = process.env.EDITOR;
    process.env.EDITOR = String.raw`'my editor' --wait "--title=review \"draft\""`;
    try {
      const { app, done, loadFileContents } = createHarness(undefined, undefined, {
        reviewIdentity: "/repo|working|worktree|local",
        reviewSessionId: "session-1",
      } as never);
      await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());
      app.handleInput("\r");
      app.handleInput("\x1b[B");
      app.handleInput("e");
      expect(done).toHaveBeenCalledWith(expect.objectContaining({
        type: "open-editor",
        command: "my editor",
        args: ["--wait", '--title=review "draft"', "+1", "--", "/repo/src/app.ts"],
        filePath: "/repo/src/app.ts",
        line: 1,
        resume: expect.objectContaining({ repository: "/repo", scope: "git-diff", path: "src/app.ts" }),
      }));
      app.dispose();
    } finally {
      if (previousEditor == null) delete process.env.EDITOR;
      else process.env.EDITOR = previousEditor;
    }
  });

  it("rejects unchanged current-side context ranges for the /code bridge", async () => {
    const { app, done, loadFileContents } = createHarness({ originalContent: "a\ncontext\nold\n", modifiedContent: "a\ncontext\nnew\n" });
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());
    (app as any).state = {
      ...(app as any).state,
      focus: "diff",
      selectedLineTargetByScopeFile: { [`git-diff::${makeFile().id}`]: { side: "added", line: 2 } },
    };
    app.handleInput("o");
    expect(done).not.toHaveBeenCalled();
    expect(String((app as any).message)).toMatch(/current-side changed/i);
    app.dispose();
  });

  it("rejects bridge opening on deleted-side and unsupported-scope selections without closing", async () => {
    const deleted = createHarness({ originalContent: "gone\n", modifiedContent: "" });
    await vi.waitFor(() => expect(deleted.loadFileContents).toHaveBeenCalled());
    deleted.app.handleInput("\r");
    deleted.app.handleInput("o");
    expect(deleted.done).not.toHaveBeenCalled();
    expect((deleted.app as any).message).toMatch(/current.*side|deleted/i);

    const unsupportedFile = makeFile();
    unsupportedFile.inLastCommit = true;
    unsupportedFile.lastCommit = { ...unsupportedFile.gitDiff!, originalRevision: "a", modifiedRevision: "b" };
    const unsupported = createHarness(undefined, [unsupportedFile], { visibleScopes: ["git-diff", "last-commit"] });
    await vi.waitFor(() => expect(unsupported.loadFileContents).toHaveBeenCalled());
    unsupported.app.handleInput("\r");
    unsupported.app.handleInput("\x1b2");
    unsupported.app.handleInput("o");
    expect(unsupported.done).not.toHaveBeenCalled();
    expect(String((unsupported.app as any).message)).toMatch(/working-tree review/i);
    deleted.app.dispose();
    unsupported.app.dispose();
  });

  it("does not open $EDITOR for deleted-side selections", async () => {
    const { app, done, loadFileContents } = createHarness({ originalContent: "gone\n", modifiedContent: "" });
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());
    app.handleInput("\r");
    app.handleInput("e");
    expect(done).not.toHaveBeenCalled();
    expect(String((app as any).message)).toMatch(/current.*side|deleted/i);
    app.dispose();
  });

  it("does not open $EDITOR for history-scope selections", async () => {
    const file = makeFile();
    file.inGitDiff = false;
    file.inLastCommit = true;
    file.gitDiff = null;
    file.lastCommit = { status: "modified", oldPath: file.path, newPath: file.path, displayPath: file.path, hasOriginal: true, hasModified: true, originalRevision: "a", modifiedRevision: "b" };
    const { app, done, loadFileContents } = createHarness(undefined, [file], { visibleScopes: ["last-commit"] });
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());
    app.handleInput("\r");
    app.handleInput("e");
    expect(done).not.toHaveBeenCalled();
    expect(String((app as any).message)).toMatch(/working-tree review/i);
    app.dispose();
  });
  it("reanchors stale COMMENT explicitly and cancels without mutation", async () => {
    const { app, loadFileContents } = createHarness();
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());
    const stale = { id: "stale", fileId: (app as any).state.activeFileId, scope: "git-diff" as const, side: "added" as const, intent: "comment" as const, startLine: 9, endLine: 9, body: "Keep me", anchorStatus: "stale" as const };
    (app as any).state = { ...(app as any).state, focus: "comments", draft: { ...(app as any).state.draft, comments: [stale] } };
    app.handleInput("a");
    expect((app as any).reanchorTarget).not.toBeNull();
    app.handleInput("\x1b");
    expect((app as any).state.draft.comments[0]).toEqual(stale);

    (app as any).state = { ...(app as any).state, focus: "comments" };
    app.handleInput("a");
    app.handleInput("\x1b[B");
    app.handleInput("\r");
    expect((app as any).state.draft.comments[0]).toMatchObject({ body: "Keep me", anchorStatus: "mapped", captureHash: { algorithm: "sha256" } });
    app.dispose();
  });

  it("reanchors a legacy line draft in its own visible non-git scope without enabling /code", async () => {
    const file = makeFile();
    file.inGitDiff = false;
    file.inAllFiles = true;
    file.gitDiff = null;
    file.allFiles = {
      status: "modified",
      oldPath: file.path,
      newPath: file.path,
      displayPath: file.path,
      hasOriginal: true,
      hasModified: true,
      originalRevision: "base",
      modifiedRevision: "head",
    };
    const { app, done, loadFileContents } = createHarness(
      { originalContent: "before\n", modifiedContent: "current\n" },
      [file],
      { visibleScopes: ["all-files"] },
    );
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalledWith("/repo", file, "all-files"));
    const legacy = {
      id: "legacy-custom",
      fileId: file.id,
      scope: "all-files" as const,
      side: "added" as const,
      intent: "comment" as const,
      startLine: 1,
      endLine: 1,
      body: "Keep the stable ID",
      anchorStatus: "stale" as const,
    };
    (app as any).state = { ...(app as any).state, focus: "comments", draft: { ...(app as any).state.draft, comments: [legacy] } };

    app.handleInput("a");
    expect((app as any).reanchorTarget).toMatchObject({ phase: "selecting", commentId: legacy.id, scope: "all-files", fileId: file.id });
    const nonGitModalSnapshot = (app as any).getSessionData();
    for (const key of ["s", "\t", "?", "o", "e", "a", "x", "z"]) {
      app.handleInput(key);
      expect((app as any).getSessionData()).toEqual(nonGitModalSnapshot);
    }
    app.handleInput("\r");

    expect((app as any).state.draft.comments[0]).toMatchObject({
      id: legacy.id,
      fileId: file.id,
      scope: "all-files",
      side: "added",
      body: legacy.body,
      anchorStatus: "mapped",
      captureHash: { algorithm: "sha256" },
    });
    app.handleInput("o");
    expect(done).not.toHaveBeenCalled();
    expect(String((app as any).message)).toMatch(/working-tree review/i);
    app.dispose();
  });

  it("never auto-maps a preexisting stale anchor during lazy file validation", async () => {
    const file = makeFile();
    const stale = {
      id: "stale-matching", fileId: file.id, scope: "git-diff" as const, side: "added" as const,
      intent: "comment" as const, startLine: 1, endLine: 1, body: "stay stale",
      captureHash: hashTargetSlice("\tcurrent()  \n", { startLine: 1, endLine: 1 }), anchorStatus: "stale" as const,
    };
    const initialSession = {
      state: {
        activeScope: "git-diff" as const, activeFileId: file.id, searchQuery: "", focus: "diff" as const,
        wrapLines: true, hideUnchanged: false, selectedCommentIndex: 0, selectedLineTargetByScopeFile: {},
        draft: { allComment: "", allIntent: "comment" as const, comments: [stale] },
      },
      diffViewMode: "unified" as const, navigatorTreeMode: false, contextLineNavigation: true,
      commentsGlobal: false, reviewedFileIds: [], navigatorScroll: 0, diffScroll: 0, commentsScroll: 0,
    };
    const { app, loadFileContents } = createHarness(undefined, [file], { initialSession });

    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());

    expect((app as any).state.draft.comments).toEqual([stale]);
    app.dispose();
  });

  it.each([
    ["Diff c", "diff", "c", false, "comment", "Replacement!"],
    ["Diff d", "diff", "d", false, "discuss", "Replacement!"],
    ["Diff m", "diff", "m", false, "modify", ""],
    ["Diff Enter", "diff", "\r", false, "modify", ""],
    ["Comments e", "comments", "e", false, "modify", ""],
    ["Comments Enter", "comments", "\r", false, "modify", ""],
    ["intent toggle", "diff", "c", true, "modify", "Replacement"],
  ] as const)("keeps exact stale anchor fields through the %s editor entry path", async (_label, focus, key, toggleIntent, intent, body) => {
    const file = makeFile();
    const stale = {
      id: "stable-stale-id",
      fileId: file.id,
      scope: "git-diff" as const,
      side: "added" as const,
      intent: "modify" as const,
      startLine: 1,
      endLine: 1,
      body: "Replacement",
      originalText: "Captured original bytes",
      captureHash: hashTargetSlice("captured bytes\n", { startLine: 1, endLine: 1 }),
      anchorStatus: "stale" as const,
    };
    const { app, loadFileContents } = createHarness(undefined, [file]);
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());
    (app as any).state = {
      ...(app as any).state,
      activeFileId: file.id,
      activeScope: "git-diff",
      focus,
      selectedCommentIndex: 0,
      selectedLineTargetByScopeFile: {
        ...(app as any).state.selectedLineTargetByScopeFile,
        [`git-diff::${file.id}`]: { side: "added", line: 1 },
      },
      draft: { ...(app as any).state.draft, comments: [stale] },
    };

    app.handleInput(key);
    if (toggleIntent) app.handleInput("\t");
    if (intent !== "modify") app.handleInput("!");
    for (const isolatedKey of ["o", "e", "a", "s", "?"]) app.handleInput(isolatedKey);
    app.handleInput("\r");

    expect((app as any).state.draft.comments).toEqual([{
      ...stale,
      intent,
      body: `${body}oeas?`,
    }]);
    app.dispose();
  });

  it("makes async reanchor loading modal and exits truthfully on load failure", async () => {
    const file = makeFile();
    const loading = deferred<{ originalContent: string; modifiedContent: string }>();
    const loadFileContents = vi.fn(() => loading.promise);
    const { app, done } = createHarness(undefined, [file], { loadFileContents });
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());
    const stale = {
      id: "loading-stale", fileId: file.id, scope: "git-diff" as const, side: "added" as const,
      intent: "comment" as const, startLine: 9, endLine: 9, body: "Keep exact", anchorStatus: "stale" as const,
    };
    (app as any).state = { ...(app as any).state, focus: "comments", draft: { ...(app as any).state.draft, comments: [stale] } };

    app.handleInput("a");
    expect((app as any).reanchorTarget).toMatchObject({ phase: "loading", commentId: stale.id });
    const modalSnapshot = (app as any).getSessionData();
    for (const key of ["s", "\t", "\x1b[D", "?", "/", "o", "e", "c", "d", "m", "a", "x", "y", "]", "n", "1", "z", "\x1b[6~", "\x06", "\r"]) {
      app.handleInput(key);
      expect((app as any).getSessionData()).toEqual(modalSnapshot);
      expect((app as any).reanchorTarget).toMatchObject({ phase: "loading", commentId: stale.id });
    }
    expect(done).not.toHaveBeenCalled();
    expect((app as any).editTarget).toBeNull();

    const maliciousLoadError = `comparison exploded\r\n\t\x1b\x00\x85${"a\u0301".repeat(500)}${"🧪".repeat(500)}`;
    loading.reject(new Error(maliciousLoadError));
    await vi.waitFor(() => expect((app as any).reanchorTarget).toBeNull());
    expect((app as any).state.draft.comments).toEqual([stale]);
    expectSafeStatus(app, "Could not load modified comparison bytes for reanchor:");
    expect(String((app as any).message)).toContain("comparison exploded");
    app.dispose();
  });

  it("cancels reanchor while bytes are loading without letting the eventual load reopen it", async () => {
    const file = makeFile();
    const loading = deferred<{ originalContent: string; modifiedContent: string }>();
    const loadFileContents = vi.fn(() => loading.promise);
    const { app } = createHarness(undefined, [file], { loadFileContents });
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());
    const stale = {
      id: "cancel-loading", fileId: file.id, scope: "git-diff" as const, side: "added" as const,
      intent: "comment" as const, startLine: 7, endLine: 7, body: "unchanged", anchorStatus: "stale" as const,
    };
    (app as any).state = { ...(app as any).state, focus: "comments", draft: { ...(app as any).state.draft, comments: [stale] } };

    app.handleInput("a");
    app.handleInput("\x03");
    expect((app as any).reanchorTarget).toBeNull();
    expect((app as any).state.draft.comments).toEqual([stale]);
    loading.resolve({ originalContent: "before\n", modifiedContent: "after\n" });
    await vi.waitFor(() => expect((app as any).getEntry(file.id, "git-diff")?.status).toBe("ready"));
    expect((app as any).reanchorTarget).toBeNull();
    expect((app as any).state.draft.comments).toEqual([stale]);
    app.dispose();
  });

  it("distinguishes a loaded valid empty modified file from unavailable bytes", async () => {
    const file = makeFile();
    const { app, loadFileContents } = createHarness({
      originalContent: "before",
      modifiedContent: "",
      originalAvailable: true,
      modifiedAvailable: true,
    }, [file]);
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());
    const stale = {
      id: "valid-empty", fileId: file.id, scope: "git-diff" as const, side: "added" as const,
      intent: "comment" as const, startLine: 1, endLine: 1, body: "empty is loaded", anchorStatus: "stale" as const,
    };
    (app as any).state = { ...(app as any).state, focus: "comments", draft: { ...(app as any).state.draft, comments: [stale] } };

    app.handleInput("a");

    expect((app as any).reanchorTarget).toBeNull();
    expect(String((app as any).message)).toMatch(/loaded modified bytes.*no modified\/current-side range/i);
    expect(String((app as any).message)).not.toMatch(/bytes are unavailable/i);
    expect((app as any).state.draft.comments).toEqual([stale]);
    app.dispose();
  });

  it("keeps selection reanchor modal, rejects wrong-scope/out-of-bounds targets, and maps COMMENT in one Enter", async () => {
    const contents = { originalContent: "before one\nbefore two\nbefore three\n", modifiedContent: "after one\nafter two\nafter three\n" };
    const { app, done, loadFileContents } = createHarness(contents);
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());
    const fileId = (app as any).state.activeFileId;
    const stale = {
      id: "comment-transaction", fileId, scope: "git-diff" as const, side: "deleted" as const,
      intent: "comment" as const, startLine: 40, endLine: 41, body: "Keep fields", originalText: "legacy",
      captureHash: hashTargetSlice("legacy", { startLine: 1, endLine: 1 }), anchorStatus: "stale" as const,
    };
    (app as any).state = { ...(app as any).state, focus: "comments", draft: { ...(app as any).state.draft, comments: [stale] } };
    app.handleInput("a");
    expect((app as any).reanchorTarget).toMatchObject({ phase: "selecting" });

    const selectingSnapshot = (app as any).getSessionData();
    for (const key of ["s", "\t", "?", "/", "o", "e", "c", "d", "m", "a", "x", "y", "z", "\x1b[6~"]) {
      app.handleInput(key);
      expect((app as any).getSessionData()).toEqual(selectingSnapshot);
      expect((app as any).reanchorTarget).toMatchObject({ phase: "selecting" });
    }
    expect(done).not.toHaveBeenCalled();

    app.handleInput("\x1b[B");
    expect((app as any).state.selectedLineTargetByScopeFile[`git-diff::${fileId}`]).toEqual({ side: "added", line: 2 });
    app.handleInput("\x1b[1;2B");
    expect((app as any).state.selectedLineTargetByScopeFile[`git-diff::${fileId}`]).toEqual({ side: "added", line: 3, endLine: 2 });

    (app as any).state = { ...(app as any).state, activeScope: "last-commit" };
    app.handleInput("\r");
    expect((app as any).reanchorTarget).toMatchObject({ phase: "selecting" });
    expect((app as any).state.draft.comments).toEqual([stale]);
    (app as any).state = {
      ...(app as any).state,
      activeScope: "git-diff",
      selectedLineTargetByScopeFile: {
        ...(app as any).state.selectedLineTargetByScopeFile,
        [`git-diff::${fileId}`]: { side: "added", line: 999 },
      },
    };
    app.handleInput("\r");
    expect((app as any).reanchorTarget).toMatchObject({ phase: "selecting" });
    expect((app as any).state.draft.comments).toEqual([stale]);
    expect(String((app as any).message)).toMatch(/range|current|available|bounds/i);

    (app as any).state.selectedLineTargetByScopeFile[`git-diff::${fileId}`] = { side: "added", line: 3, endLine: 2 };
    app.handleInput("\r");
    expect((app as any).reanchorTarget).toBeNull();
    expect((app as any).state.draft.comments).toEqual([{
      ...stale,
      fileId,
      scope: "git-diff",
      side: "added",
      startLine: 2,
      endLine: 3,
      captureHash: hashTargetSlice(contents.modifiedContent, { startLine: 2, endLine: 3 }),
      anchorStatus: "mapped",
    }]);
    app.dispose();
  });

  it("freezes loaded MODIFY bytes and proposal on first Enter, isolates keys, and applies only that candidate", async () => {
    const contents = { originalContent: "before\ncontext\n", modifiedContent: "after\ncontext\n" };
    const { app, done, loadFileContents } = createHarness(contents);
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());
    const fileId = (app as any).state.activeFileId;
    const proposal = `replacement()\r\n\t\x1b\x00\x85${"a\u0301".repeat(500)}${"🧪".repeat(500)} unchanged proposal`;
    const stale = {
      id: "modify-transaction", fileId, scope: "git-diff" as const, side: "added" as const,
      intent: "modify" as const, startLine: 77, endLine: 78, body: proposal, originalText: "old bytes",
      captureHash: hashTargetSlice("old bytes", { startLine: 1, endLine: 1 }), anchorStatus: "stale" as const,
    };
    (app as any).state = { ...(app as any).state, focus: "comments", draft: { ...(app as any).state.draft, comments: [stale] } };
    app.handleInput("a");
    app.handleInput("\r");

    const frozen = (app as any).reanchorTarget;
    expect(frozen).toEqual(expect.objectContaining({
      phase: "confirm-modify",
      commentId: stale.id,
      proposedReplacement: proposal,
      candidate: {
        fileId,
        scope: "git-diff",
        range: { startLine: 1, endLine: 1 },
        captureHash: hashTargetSlice(contents.modifiedContent, { startLine: 1, endLine: 1 }),
        originalText: "after",
      },
    }));
    expect((app as any).state.draft.comments).toEqual([stale]);
    expect((app as any).getSessionData().state.draft.comments).toEqual([stale]);
    expectSafeStatus(app, "MODIFY reanchor frozen.");
    expect(String((app as any).message)).not.toContain("\x1b");

    const frozenSnapshot = (app as any).getSessionData();
    for (const key of ["\x1b[A", "\x1b[B", "\x1b[1;2A", "\x1b[1;2B", "s", "\t", "?", "/", "o", "e", "c", "d", "m", "a", "x", "y", "z"]) {
      app.handleInput(key);
      expect((app as any).getSessionData()).toEqual(frozenSnapshot);
      expect((app as any).reanchorTarget).toEqual(frozen);
    }
    expect(done).not.toHaveBeenCalled();

    (app as any).state = {
      ...(app as any).state,
      activeFileId: "tampered-file",
      activeScope: "last-commit",
      selectedLineTargetByScopeFile: {
        ...(app as any).state.selectedLineTargetByScopeFile,
        [`git-diff::${fileId}`]: { side: "added", line: 999 },
      },
    };
    app.handleInput("\r");

    expect((app as any).reanchorTarget).toBeNull();
    expect((app as any).state.draft.comments).toEqual([{
      ...stale,
      fileId,
      scope: "git-diff",
      side: "added",
      startLine: 1,
      endLine: 1,
      body: proposal,
      originalText: "after",
      captureHash: hashTargetSlice(contents.modifiedContent, { startLine: 1, endLine: 1 }),
      anchorStatus: "mapped",
    }]);
    expect((app as any).state.draft.comments[0].body).toBe(proposal);
    app.dispose();
  });

  it("cancels frozen MODIFY reanchor without changing any draft field", async () => {
    const { app, loadFileContents } = createHarness();
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());
    const stale = {
      id: "cancel-frozen", fileId: (app as any).state.activeFileId, scope: "git-diff" as const, side: "added" as const,
      intent: "modify" as const, startLine: 9, endLine: 9, body: "proposal", originalText: "old",
      captureHash: hashTargetSlice("old", { startLine: 1, endLine: 1 }), anchorStatus: "stale" as const,
    };
    (app as any).state = { ...(app as any).state, focus: "comments", draft: { ...(app as any).state.draft, comments: [stale] } };
    app.handleInput("a");
    app.handleInput("\r");
    expect((app as any).reanchorTarget).toMatchObject({ phase: "confirm-modify" });
    app.handleInput("\x1b");
    expect((app as any).reanchorTarget).toBeNull();
    expect((app as any).state.draft.comments).toEqual([stale]);
    app.dispose();
  });

  it("keeps deleted or unavailable non-git scopes visibly non-reanchorable", async () => {
    const deleted = makeFile("src/deleted.ts");
    deleted.inGitDiff = false;
    deleted.inAllFiles = true;
    deleted.gitDiff = null;
    deleted.hasWorkingTreeFile = false;
    deleted.allFiles = {
      status: "deleted",
      oldPath: deleted.path,
      newPath: null,
      displayPath: deleted.path,
      hasOriginal: true,
      hasModified: false,
      originalRevision: "base",
      modifiedRevision: "head",
    };
    const { app, loadFileContents } = createHarness(
      { originalContent: "gone\n", modifiedContent: "" },
      [deleted],
      { visibleScopes: ["all-files"] },
    );
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());
    const stale = {
      id: "deleted-custom", fileId: deleted.id, scope: "all-files" as const, side: "deleted" as const,
      intent: "comment" as const, startLine: 1, endLine: 1, body: "gone", anchorStatus: "stale" as const,
    };
    (app as any).state = { ...(app as any).state, focus: "comments", draft: { ...(app as any).state.draft, comments: [stale] } };

    app.handleInput("a");

    expect((app as any).reanchorTarget).toBeNull();
    expect(String((app as any).message)).toMatch(/no modified|unavailable|reanchor/i);
    app.dispose();

    const unavailable = makeFile("src/unavailable.ts");
    unavailable.inGitDiff = false;
    unavailable.inAllFiles = true;
    unavailable.gitDiff = null;
    unavailable.allFiles = {
      status: "modified",
      oldPath: unavailable.path,
      newPath: unavailable.path,
      displayPath: unavailable.path,
      hasOriginal: true,
      hasModified: true,
      originalRevision: "missing-base",
      modifiedRevision: "missing-head",
    };
    const unavailableLoad = vi.fn(async () => ({
      originalContent: "before\n",
      modifiedContent: "",
      originalAvailable: true,
      modifiedAvailable: false,
    }));
    const unavailableHarness = createHarness(undefined, [unavailable], {
      visibleScopes: ["all-files"],
      loadFileContents: unavailableLoad,
    });
    await vi.waitFor(() => expect((unavailableHarness.app as any).getEntry(unavailable.id, "all-files")?.status).toBe("ready"));
    const unavailableDraft = {
      id: "unavailable-custom", fileId: unavailable.id, scope: "all-files" as const, side: "added" as const,
      intent: "comment" as const, startLine: 1, endLine: 1, body: "unavailable", anchorStatus: "stale" as const,
    };
    (unavailableHarness.app as any).state = {
      ...(unavailableHarness.app as any).state,
      focus: "comments",
      draft: { ...(unavailableHarness.app as any).state.draft, comments: [unavailableDraft] },
    };

    unavailableHarness.app.handleInput("a");

    expect((unavailableHarness.app as any).reanchorTarget).toBeNull();
    expect(String((unavailableHarness.app as any).message)).toMatch(/unavailable/i);
    unavailableHarness.app.dispose();
  });

  it("leaves mouse reporting to tmux for native selection", async () => {
    const { app, loadFileContents, terminalWrite } = createHarness();
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());

    expect(terminalWrite).not.toHaveBeenCalled();
    app.dispose();
    expect(terminalWrite).not.toHaveBeenCalled();
  });

  it("starts a new grouped review on the first visible navigator file", async () => {
    const files = [makeFile("zeta/important.ts"), makeFile("alpha/first.ts")];
    const { app, loadFileContents } = createHarness(undefined, files);
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());

    expect((app as any).getNavigatorFiles().map((file: ReviewFile) => file.path)).toEqual([
      "alpha/first.ts",
      "zeta/important.ts",
    ]);
    expect((app as any).activeFile().path).toBe("alpha/first.ts");
    app.dispose();
  });

  it("hides unrelated locale files until the locale visibility toggle is used", async () => {
    const files = [
      makeFile("src/app.ts"),
      makeFile("config/locales/en.yml"),
      makeFile("config/locales/pt-BR.yml"),
      makeFile("config/locales/fr.yml"),
    ];
    const { app, loadFileContents } = createHarness(undefined, files);
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());

    expect((app as any).getNavigatorFiles().map((file: ReviewFile) => file.path)).toEqual([
      "config/locales/en.yml",
      "config/locales/pt-BR.yml",
      "src/app.ts",
    ]);

    app.handleInput("L");
    expect((app as any).getNavigatorFiles().map((file: ReviewFile) => file.path)).toEqual([
      "config/locales/en.yml",
      "config/locales/fr.yml",
      "config/locales/pt-BR.yml",
      "src/app.ts",
    ]);
    app.dispose();
  });

  it("orders the navigator by review risk and toggles to alphabetical with O", async () => {
    const sized = (path: string, additions: number): ReviewFile => {
      const file = makeFile(path);
      return { ...file, gitDiff: { ...file.gitDiff!, additions, deletions: 0 } };
    };
    const files = [sized("src/aaa.ts", 1), sized("src/zzz.ts", 400), sized("src/mmm.ts", 30)];
    const { app, loadFileContents } = createHarness(undefined, files, {
      orderSignals: { priorityPaths: ["src/mmm.ts"], unresolvedThreadsByPath: {} },
    });
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());

    expect((app as any).getNavigatorFiles().map((file: ReviewFile) => file.path)).toEqual([
      "src/mmm.ts",
      "src/zzz.ts",
      "src/aaa.ts",
    ]);
    expect(app.render(220).join("\n")).toContain("risk order");

    app.handleInput("O");

    expect((app as any).getNavigatorFiles().map((file: ReviewFile) => file.path)).toEqual([
      "src/aaa.ts",
      "src/mmm.ts",
      "src/zzz.ts",
    ]);
    expect(app.render(220).join("\n")).toContain("a-z order");
    expect(JSON.parse(readFileSync(process.env.PI_CODE_DIFF_PREFERENCES_PATH!, "utf8")).navigatorFileOrder).toBe("alphabetical");
    app.dispose();
  });

  it("keeps the pull request header visible while reviewing", async () => {
    const { app, loadFileContents } = createHarness(undefined, [makeFile()], {
      reviewHeader: {
        identity: "example/widgets#1",
        title: "Add review mode",
        state: "OPEN",
        revision: "c".repeat(40),
        queue: { position: 2, total: 4 },
        openThreads: 1,
        awaitingReply: 1,
      },
    });
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());

    const rendered = app.render(160).join("\n");

    expect(rendered).toContain("example/widgets#1");
    expect(rendered).toContain("queue 2/4");
    expect(rendered).toContain("@ccccccc");
    expect(rendered).toContain("0/1 reviewed");
    expect(rendered).toContain("1 open thread, 1 awaiting reply");
    app.dispose();
  });

  it("toggles panes with number keys and restores visibility in the next review", async () => {
    const contextPanelSource = {
      title: "PR context",
      loadingText: "Loading PR context",
      load: vi.fn(async () => "Problem:\nKeep pane state"),
    };
    const first = createHarness(undefined, undefined, {
      visibleScopes: ["git-diff", "last-commit"],
      contextPanelSource,
    });
    await vi.waitFor(() => expect(first.loadFileContents).toHaveBeenCalled());

    for (const key of ["1", "2", "3", "4"]) first.app.handleInput(key);

    expect((first.app as any).state.activeScope).toBe("git-diff");
    expect((first.app as any).paneVisibility).toEqual({
      navigator: false,
      diff: false,
      comments: false,
      context: false,
      replies: true,
    });
    expect(first.app.render(200).join("\n")).toContain("All panes are hidden");
    first.app.dispose();

    const second = createHarness(undefined, undefined, { contextPanelSource });
    await vi.waitFor(() => expect(second.loadFileContents).toHaveBeenCalled());
    expect((second.app as any).paneVisibility).toEqual({
      navigator: false,
      diff: false,
      comments: false,
      context: false,
      replies: true,
    });

    second.app.handleInput("2");
    expect((second.app as any).state.focus).toBe("diff");
    const rendered = second.app.render(200).join("\n");
    expect(rendered).toContain("▶ Diff");
    expect((second.app as any).mousePaneLayout).toMatchObject({
      navigator: null,
      comments: null,
    });
    expect((second.app as any).mousePaneLayout.diff).not.toBeNull();
    second.app.dispose();
  });

  it("uses Alt+number for scope switching after number keys become pane toggles", async () => {
    const { app, loadFileContents } = createHarness(undefined, undefined, {
      visibleScopes: ["git-diff", "last-commit"],
    });
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());

    app.handleInput("1");
    expect((app as any).state.activeScope).toBe("git-diff");
    expect((app as any).paneVisibility.navigator).toBe(false);

    app.handleInput("\x1b2");
    expect((app as any).state.activeScope).toBe("last-commit");
    app.dispose();
  });

  it("expands ten hidden lines above or below the selected diff line", async () => {
    const originalLines = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`);
    const modifiedLines = [...originalLines];
    modifiedLines[19] = "changed line 20";
    const { app, loadFileContents } = createHarness({
      originalContent: `${originalLines.join("\n")}\n`,
      modifiedContent: `${modifiedLines.join("\n")}\n`,
    });
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());
    app.handleInput("\r");

    const fileId = (app as any).state.activeFileId;
    const before = (app as any).getDiffLayout(fileId, "git-diff").displayDiff;
    const beforeVisibleRows = before.visibleItems.filter((item: { type: string }) => item.type === "row").length;

    const selectedBeforeExpansion = structuredClone((app as any).state.selectedLineTargetByScopeFile);
    app.handleInput("j");
    expect((app as any).state.selectedLineTargetByScopeFile).toEqual(selectedBeforeExpansion);
    const entryKey = (app as any).cacheKey(fileId, "git-diff");
    expect((app as any).expandedContextRows.get(entryKey).size).toBe(10);
    const below = (app as any).getDiffLayout(fileId, "git-diff").displayDiff;
    expect(below.visibleItems.filter((item: { type: string }) => item.type === "row")).toHaveLength(beforeVisibleRows + 10);

    app.handleInput("k");
    expect((app as any).expandedContextRows.get(entryKey).size).toBe(20);
    app.dispose();
  });

  it("renders the final wrapped shortcut on short three-pane and four-pane terminals", async () => {
    const contextPanelSource = {
      title: "PR context",
      loadingText: "Loading PR context",
      load: vi.fn(async () => "Problem:\nKeep every shortcut visible"),
    };
    const scenarios = [
      { width: 80, terminal: { rows: 20, columns: 80 }, overrides: { contextPanelSource } },
      { width: 54, terminal: { rows: 20, columns: 54 }, overrides: {} },
      { width: 80, terminal: { rows: 20, columns: 80 }, overrides: { contextPanelSource, visibleScopes: ["git-diff", "last-commit"] as Array<"git-diff" | "last-commit"> } },
    ];

    for (const scenario of scenarios) {
      const { app, loadFileContents } = createHarness(undefined, undefined, scenario.overrides, scenario.terminal);
      await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());
      const rendered = app.render(scenario.width).join("\n");
      expect(rendered).toContain("Esc / Ctrl+C exit");
      app.dispose();
    }
  });

  it("selects the first changed row when a newly opened file starts with unchanged context", async () => {
    const first = makeFile("src/a.ts");
    const second = makeFile("src/b.ts");
    const loadFileContents = vi.fn(async (_repoRoot: string, file: ReviewFile) => file.id === second.id
      ? {
          originalContent: "one\ntwo\nthree\nold\nfive\n",
          modifiedContent: "one\ntwo\nthree\nnew\nfive\n",
        }
      : { originalContent: "old\n", modifiedContent: "new\n" });
    const { app } = createHarness(undefined, [first, second], { loadFileContents });
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalledTimes(1));

    app.handleInput("\x1b[B");
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalledTimes(2));

    expect((app as any).state.selectedLineTargetByScopeFile[`git-diff::${second.id}`]).toEqual({ side: "deleted", line: 4 });
    app.dispose();
  });

  it("keeps arrow navigation and Shift+arrow range extension in Diff focus", async () => {
    const { app, loadFileContents } = createHarness({
      originalContent: "",
      modifiedContent: "one\ntwo\nthree\nfour\n",
    });
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());
    app.handleInput("\r");

    const fileId = (app as any).state.activeFileId;
    const targetKey = `git-diff::${fileId}`;
    const initial = structuredClone((app as any).state.selectedLineTargetByScopeFile[targetKey]);
    app.handleInput("\x1b[B");
    const moved = structuredClone((app as any).state.selectedLineTargetByScopeFile[targetKey]);
    expect(moved.line).toBeGreaterThan(initial.line);

    app.handleInput("\x1b[b");
    const extended = (app as any).state.selectedLineTargetByScopeFile[targetKey];
    expect(extended.line).toBeGreaterThan(moved.line);
    expect(extended.endLine).toBe(moved.line);
    app.dispose();
  });

  it("does not shift the entire viewport on every downward arrow move after crossing its edge", async () => {
    const modifiedContent = Array.from({ length: 80 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
    const { app, loadFileContents } = createHarness({ originalContent: "", modifiedContent });
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());

    app.render(120);
    app.handleInput("\r");
    const movesPastViewport = (app as any).diffPageSize + 4;
    for (let index = 0; index < movesPastViewport; index += 1) {
      app.handleInput("\x1b[B");
      app.render(120);
    }
    const recenteredScroll = (app as any).diffScroll;

    app.handleInput("\x1b[B");
    app.render(120);

    expect(recenteredScroll).toBeGreaterThan(1);
    expect((app as any).diffScroll).toBe(recenteredScroll);
    app.dispose();
  });

  it("does not rescan offscreen row heights while typing a comment", async () => {
    const modifiedContent = Array.from({ length: 2_000 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
    const { app, loadFileContents } = createHarness({ originalContent: "", modifiedContent });
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());

    (app as any).diffViewMode = "unified";
    app.render(120);
    app.handleInput("\r");
    app.handleInput("c");
    expect((app as any).editTarget?.intent).toBe("comment");

    const layout = (app as any).getDiffLayout((app as any).state.activeFileId, "git-diff");
    const [heightKey, rowHeights] = [...layout.unifiedRowHeights.entries()][0] as [string, number[]];
    layout.unifiedRowHeights.set(heightKey, new Proxy(rowHeights, {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property) && Number(property) > 500) {
          throw new Error("read offscreen row height");
        }
        return Reflect.get(target, property, receiver);
      },
    }));

    app.handleInput("x");
    expect(() => app.render(120)).not.toThrow();
    app.dispose();
  });

  it("does not rescan all side-by-side line targets while typing a comment", async () => {
    const modifiedContent = Array.from({ length: 2_000 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
    const { app, loadFileContents } = createHarness({ originalContent: "", modifiedContent });
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());

    (app as any).diffViewMode = "side-by-side";
    app.render(120);
    app.handleInput("\r");
    app.handleInput("c");
    const layout = (app as any).getDiffLayout((app as any).state.activeFileId, "git-diff");
    layout.sideBySideRows = new Proxy(layout.sideBySideRows, {
      get(target, property, receiver) {
        if (property === Symbol.iterator) throw new Error("iterated all side-by-side rows");
        return Reflect.get(target, property, receiver);
      },
    });

    app.handleInput("x");
    expect(() => app.render(120)).not.toThrow();
    app.dispose();
  });

  it("does not persist unchanged session data while typing a comment", async () => {
    const { app, loadFileContents } = createHarness();
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());

    app.handleInput("\r");
    app.handleInput("c");
    const onSessionChange = vi.fn();
    (app as any).options.onSessionChange = onSessionChange;
    vi.useFakeTimers();

    try {
      app.handleInput("a");
      vi.advanceTimersByTime(150);
      app.handleInput("b");
      vi.advanceTimersByTime(150);
      expect(onSessionChange).not.toHaveBeenCalled();

      app.handleInput("\r");
      vi.advanceTimersByTime(100);
      expect(onSessionChange).toHaveBeenCalledTimes(1);
    } finally {
      app.dispose();
      vi.useRealTimers();
    }
  });

  it("removes only the selected comment with r from the comments panel", async () => {
    const { app, loadFileContents } = createHarness();
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());
    const fileId = "src/app.ts::working::::";
    (app as any).state = {
      ...(app as any).state,
      focus: "comments",
      selectedCommentIndex: 1,
      draft: {
        allComment: "Keep the review-wide note",
        allIntent: "discuss",
        comments: [
          {
            id: "line:git-diff:src/app.ts:added:1",
            fileId,
            scope: "git-diff",
            side: "added",
            intent: "comment",
            startLine: 1,
            endLine: 1,
            body: "Remove this selected comment",
          },
          {
            id: "line:git-diff:src/app.ts:added:2",
            fileId,
            scope: "git-diff",
            side: "added",
            intent: "discuss",
            startLine: 2,
            endLine: 2,
            body: "Keep this other comment",
          },
        ],
      },
    };

    app.handleInput("r");

    expect((app as any).state.draft.allComment).toBe("Keep the review-wide note");
    expect((app as any).state.draft.comments.map((comment: { body: string }) => comment.body)).toEqual([
      "Keep this other comment",
    ]);
    const rendered = app.render(120).join("\n");
    expect(rendered).toContain("Keep this other comment");
    expect(rendered).not.toContain("Remove this selected comment");
    app.dispose();
  });

  it("keeps a stale-only draft in the open overlay instead of approving it as empty", async () => {
    const stale = {
      id: "stable-stale-id",
      fileId: "src/app.ts::working::::",
      scope: "git-diff" as const,
      side: "added" as const,
      intent: "modify" as const,
      startLine: 7,
      endLine: 8,
      body: "\treplacement()  ",
      originalText: "\toriginal()  ",
      captureHash: { algorithm: "sha256" as const, value: "b".repeat(64) },
      anchorStatus: "stale" as const,
    };
    const { app, done, loadFileContents } = createHarness(undefined, undefined, { allowEmptySubmit: true });
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());
    (app as any).state = {
      ...(app as any).state,
      draft: { allComment: "", allIntent: "discuss", comments: [stale] },
    };

    app.handleInput("s");

    expect(done).not.toHaveBeenCalled();
    expect((app as any).state.draft.comments).toEqual([stale]);
    expect(String((app as any).message)).toMatch(/unresolved|stale/i);
    app.dispose();
  });

  it("flushes the full draft but submits only mapped stable IDs and the review-wide note", async () => {
    const mapped = {
      id: "mapped-file-note",
      fileId: "src/app.ts::working::::",
      scope: "git-diff" as const,
      side: "file" as const,
      intent: "comment" as const,
      startLine: null,
      endLine: null,
      body: "Mapped file note",
      fileTarget: "all-lines" as const,
      anchorStatus: "mapped" as const,
    };
    const stale = {
      id: "stable-stale-id",
      fileId: "src/app.ts::working::::",
      scope: "git-diff" as const,
      side: "added" as const,
      intent: "modify" as const,
      startLine: 7,
      endLine: 8,
      body: "\treplacement()  ",
      originalText: "\toriginal()  ",
      captureHash: { algorithm: "sha256" as const, value: "b".repeat(64) },
      anchorStatus: "stale" as const,
    };
    const onSessionChange = vi.fn();
    const { app, done, loadFileContents } = createHarness(undefined, undefined, { onSessionChange });
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());
    (app as any).state = {
      ...(app as any).state,
      draft: { allComment: "Review-wide note", allIntent: "comment", comments: [mapped, stale] },
    };

    app.handleInput("s");

    expect(onSessionChange).toHaveBeenLastCalledWith(expect.objectContaining({
      state: expect.objectContaining({
        draft: { allComment: "Review-wide note", allIntent: "comment", comments: [mapped, stale] },
      }),
    }));
    expect(done).toHaveBeenCalledWith({
      type: "submit",
      allComment: "Review-wide note",
      allIntent: "comment",
      comments: [mapped],
    });
    app.dispose();
  });

  it("keeps the overlay usable when the final full-draft save fails", async () => {
    const { app, done, loadFileContents } = createHarness();
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());
    const mapped = {
      id: "mapped",
      fileId: "src/app.ts::working::::",
      scope: "git-diff" as const,
      side: "file" as const,
      intent: "comment" as const,
      startLine: null,
      endLine: null,
      body: "Keep this exact draft",
      anchorStatus: "mapped" as const,
    };
    (app as any).state = { ...(app as any).state, draft: { allComment: "", allIntent: "comment", comments: [mapped] } };
    const onSessionChange = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    (app as any).options.onSessionChange = onSessionChange;

    app.handleInput("s");

    expect(done).not.toHaveBeenCalled();
    expect((app as any).state.draft.comments).toEqual([mapped]);
    expect(String((app as any).message)).toMatch(/could not save.*remains open/i);

    app.handleInput("s");
    expect(done).toHaveBeenCalledWith(expect.objectContaining({ type: "submit", comments: [mapped] }));
    app.dispose();
  });

  it("flushes the current review session before submitting", async () => {
    const { app, done, loadFileContents } = createHarness();
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());
    const onSessionChange = vi.fn();
    (app as any).options.onSessionChange = onSessionChange;
    (app as any).state = {
      ...(app as any).state,
      draft: {
        allComment: "",
        allIntent: "discuss",
        comments: [{
          id: "line:git-diff:src/app.ts:added:1",
          fileId: "src/app.ts::working::::",
          scope: "git-diff",
          side: "added",
          intent: "discuss",
          startLine: 1,
          endLine: 1,
          body: "Why is this needed?",
          captureHash: { algorithm: "sha256", value: "a".repeat(64) },
          anchorStatus: "mapped",
        }],
      },
    };

    app.handleInput("s");

    expect(onSessionChange).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledWith(expect.objectContaining({ type: "submit" }));
    expect(onSessionChange.mock.invocationCallOrder[0]).toBeLessThan(done.mock.invocationCallOrder[0]!);
    app.dispose();
  });

  it("opens highlighted MODIFY input with Enter, pastes exactly, saves, and cancels", async () => {
    const { app, loadFileContents } = createHarness();
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());

    app.handleInput("\r");
    app.handleInput("\r");
    expect((app as any).editTarget?.intent).toBe("modify");
    expect((app as any).exactEditor.isSelectionArmed()).toBe(true);

    app.handleInput("\u001b[200~\treplacement()  \r\n  child()  \u001b[201~");
    app.handleInput("\r");
    expect((app as any).state.draft.comments[0]?.body).toBe("\treplacement()  \r\n  child()  ");
    expect((app as any).editTarget).toBeNull();

    app.handleInput("\r");
    expect((app as any).editTarget?.intent).toBe("modify");
    app.handleInput("\u001b");
    expect((app as any).editTarget).toBeNull();
    expect((app as any).state.draft.comments).toHaveLength(1);

    app.handleInput("/");
    app.handleInput("\u001b[200~replacement child\u001b[201~");
    expect((app as any).searchBuffer).toBe("replacement child");
    app.dispose();
  });

  function createExitHarness() {
    const onSessionChange = vi.fn();
    return createHarness(undefined, [makeFile()], {
      onSessionChange,
      seedComments: [{ fileId: makeFile().id, scope: "git-diff", side: "file", intent: "comment", startLine: null, endLine: null, body: "Saved draft note." }],
    } as never);
  }

  it("parks a draft review on exit instead of dropping it", async () => {
    const { app, done, loadFileContents } = createExitHarness();
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());

    app.handleInput("\u001b");
    expect(done).not.toHaveBeenCalled();
    expect((app as any).renderCancelConfirmation().join("\n")).toContain("p park review and exit");

    app.handleInput("p");
    expect(done).toHaveBeenCalledWith({ type: "cancel", disposition: "park" });
    app.dispose();
  });

  it("discards a draft review only on the explicit discard key", async () => {
    const { app, done, loadFileContents } = createExitHarness();
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());

    app.handleInput("\u001b");
    app.handleInput("\r");
    expect(done).not.toHaveBeenCalled();

    app.handleInput("\u001b");
    app.handleInput("d");
    expect(done).toHaveBeenCalledWith({ type: "cancel", disposition: "discard" });
    app.dispose();
  });

  it("confirms before leaving when only reviewed-file state would be lost", async () => {
    const { app, done, loadFileContents } = createHarness();
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());

    app.handleInput("R");
    app.handleInput("\u001b");
    expect(done).not.toHaveBeenCalled();

    app.handleInput("p");
    expect(done).toHaveBeenCalledWith({ type: "cancel", disposition: "park" });
    app.dispose();
  });
});

describe("Replies pane", () => {
  function makeReply(index: number, overrides: Partial<ReviewReplyItem> = {}): ReviewReplyItem {
    return {
      id: `thread-${index}:comment-${index}`,
      threadId: `thread-${index}`,
      commentId: `comment-${index}`,
      author: `reviewer-${index}`,
      body: `Reply body ${index}`,
      url: `https://github.com/example/widgets/pull/12#discussion_r${index}`,
      path: `src/file-${index}.ts`,
      line: index + 1,
      resolved: index % 2 === 0,
      ...overrides,
    };
  }

  function makeRepliesSnapshot(count = 8, overrides: Partial<ReviewReplyItem> = {}): ReviewRepliesSnapshot {
    return {
      replies: Array.from({ length: count }, (_, index) => makeReply(index, index === 0 ? overrides : {})),
      selfLogin: "author",
      fetchedAt: "2026-01-01T00:00:00.000Z",
    };
  }

  function focusReplies(app: ReviewApp): void {
    app.handleInput("\t");
    app.handleInput("\t");
    app.handleInput("\t");
    expect((app as any).state.focus).toBe("replies");
  }

  async function createRepliesHarness(
    snapshot = makeRepliesSnapshot(),
    overrides: { analyze?: (reply: ReviewReplyItem) => Promise<string>; openUrl?: (url: string) => Promise<any> } = {},
  ) {
    const load = vi.fn(async () => snapshot);
    const analyze = vi.fn(overrides.analyze ?? (async (reply: ReviewReplyItem) => `Analysis for ${reply.id}`));
    const harness = createHarness(undefined, undefined, {
      repliesSource: { title: "Replies", loadingText: "Loading replies", load, analyze },
      openUrl: overrides.openUrl,
    }, { rows: 30, columns: 200 });
    harness.app.render(200);
    await vi.waitFor(() => expect((harness.app as any).repliesPanelState.status).toBe("ready"));
    harness.app.render(200);
    return { ...harness, load, analyze };
  }

  function conversation(generation = 1): ReviewConversationMetadata {
    return { identity: "current-pr", generation, attempt: 1, fetchedAt: `2026-01-0${generation}T00:00:00.000Z`, threadCounts: { open: 50, unknown: 1 },
      coverage: { details: "complete", comments: "complete", reviews: "complete", threads: "complete", checks: "complete", identity: "complete" } };
  }

  it.each(["r", "m"])("coordinates %s across shared panes without moving review selection", async (key) => {
    const shared = {};
    const token = {};
    let current = { ...makeRepliesSnapshot(100), conversation: { ...conversation(), continuation: token }, totalReplies: 101, previewLimit: 1200 };
    const next = { ...current, replies: [...current.replies].reverse(), conversation: { ...conversation(2), generation: key === "r" ? 2 : 1, attempt: 2, continuation: token } };
    let update: Parameters<ReviewContextPanelSource["load"]>[0];
    const text = "Known facts\n".repeat(40);
    const loadContext = vi.fn<ReviewContextPanelSource["load"]>(async (onUpdate, options) => {
      update = onUpdate;
      if (options != null) current = next;
      onUpdate?.(text, current.conversation);
      return text;
    });
    const load = vi.fn(async () => current);
    const { app, loadFileContents } = createHarness(undefined, undefined, {
      reviewHeader: { identity: "PR1", openThreads: 9999 },
      contextPanelSource: { title: "Context", loadingText: "Loading", conversation: shared, load: loadContext },
      repliesSource: { title: "Replies", loadingText: "Loading", conversation: shared, get current() { return current; }, load },
    }, { columns: 360, rows: 60 });
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());
    app.render(360);
    await vi.waitFor(() => expect((app as any).repliesPanelState.status).toBe("ready"));
    (app as any).state.focus = "diff";
    app.handleInput("j");
    (app as any).state.focus = key === "r" ? "context" : "replies";
    (app as any).selectedReplyIndex = 1;
    (app as any).contextScroll = 2;
    const code = structuredClone((app as any).state);
    const selected = current.replies[1]!.id;
    app.handleInput(key);
    expect(loadContext.mock.calls.at(-1)?.[1]?.[key === "r" ? "refresh" : "continuation"]).toBe(key === "r" ? true : token);
    expect(load).toHaveBeenLastCalledWith();
    await vi.waitFor(() => expect((app as any).repliesRefreshing).toBe(false));
    expect((app as any).repliesPanelState.snapshot.replies[(app as any).selectedReplyIndex].id).toBe(selected);
    expect((app as any).state).toEqual(code);
    expect((app as any).contextScroll).toBe(2);
    current = { ...next, totalReplies: 102, conversation: { ...conversation(3), continuation: token } };
    update?.(text, current.conversation);
    expect((app as any).conversation).toEqual(current.conversation);
    expect((app as any).repliesPanelState.snapshot.conversation).toEqual(current.conversation);
    expect(app.render(360).join("\n")).toContain("Showing 100 of 102 fetched replies");
    expect(app.render(360).join("\n")).toContain(current.conversation.fetchedAt);
    expect(app.render(360).join("\n")).toContain("50 known open, 1 resolution unknown");
    expect(app.render(360).join("\n")).not.toContain("9999 open threads");
    update?.("Outdated facts", next.conversation);
    expect((app as any).contextPanelState.text).toBe(text);
    update?.("Facts unavailable", { ...conversation(4), coverage: { details: "unavailable", comments: "unavailable", reviews: "unavailable", threads: "unavailable", checks: "unavailable", identity: "complete" } });
    expect((app as any).contextPanelState.text).toBe(text);
    app.handleInput("m");
    expect(loadContext).toHaveBeenCalledTimes(2);
    app.dispose();
  });

  it.each([false, true])("rejects late replies after supersession or disposal: %s", async (dispose) => {
    const { app, load } = await createRepliesHarness(makeRepliesSnapshot(2));
    const pending = deferred<ReviewRepliesSnapshot>();
    load.mockReturnValueOnce(pending.promise);
    focusReplies(app);
    const retained = (app as any).repliesPanelState.snapshot;
    app.handleInput("r");
    if (dispose) app.dispose();
    else {
      load.mockRejectedValueOnce(new Error("offline"));
      app.handleInput("r");
      await vi.waitFor(() => expect((app as any).message).toContain("offline"));
    }
    pending.resolve(makeRepliesSnapshot(1));
    await pending.promise;
    expect((app as any).repliesPanelState.snapshot).toBe(retained);
    app.dispose();
  });

  it("loads only while visible and renders sanitized reply details", async () => {
    const load = vi.fn(async () => makeRepliesSnapshot(1, {
      author: "reviewer\x1b[31m",
      body: "Please revisit\x07 this line.",
      path: "src/app\x1b[2J.ts",
      resolved: true,
    }));
    const { app, loadFileContents } = createHarness(undefined, undefined, {
      repliesSource: { title: "Replies", loadingText: "Loading replies", load },
    }, { rows: 30, columns: 200 });
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());

    app.handleInput("5");
    app.render(200);
    expect(load).not.toHaveBeenCalled();

    app.handleInput("5");
    expect(load).toHaveBeenCalledTimes(1);
    expect(app.render(200).join("\n")).toContain("Loading replies");
    await vi.waitFor(() => expect((app as any).repliesPanelState.status).toBe("ready"));

    const rendered = app.render(200).join("\n");
    expect(rendered).toContain("reviewer\\x1b[31m");
    expect(rendered).toContain("Please revisit\\x07 this line.");
    expect(rendered).toContain("src/app\\x1b[2J.ts:1");
    expect(rendered).toContain("resolved");
    expect(rendered).not.toContain("\x1b[31m");
    app.dispose();
  });

  it("distinguishes an unknown reply resolution from unresolved", async () => {
    const { app } = await createRepliesHarness(makeRepliesSnapshot(1, { resolved: null }));
    try {
      expect(app.render(200).join("\n")).toContain("resolution unknown");
    } finally {
      app.dispose();
    }
  });

  it("renders load errors and the empty state", async () => {
    const failing = createHarness(undefined, undefined, {
      repliesSource: {
        title: "Replies",
        loadingText: "Loading replies",
        load: vi.fn(async () => { throw new Error("provider\x1b failed"); }),
      },
    }, { rows: 30, columns: 200 });
    failing.app.render(200);
    await vi.waitFor(() => expect((failing.app as any).repliesPanelState.status).toBe("error"));
    expect(failing.app.render(200).join("\n")).toContain("Could not load replies.");
    expect(failing.app.render(200).join("\n")).toContain("provider\\x1b failed");
    failing.app.dispose();

    const empty = await createRepliesHarness(makeRepliesSnapshot(0));
    const rendered = empty.app.render(200).join("\n");
    expect(rendered).toContain("0 replies");
    expect(rendered).toContain("coverage unknown");
    empty.app.dispose();
  });

  it.each(["complete", "partial", "unavailable", "supplied"] as const)("qualifies empty replies using fetched coverage: %s", async (coverage) => {
    const metadata = conversation();
    metadata.coverage.threads = coverage === "supplied" ? "partial" : coverage;
    if (coverage === "supplied") metadata.fetchedAt = null;
    const snapshot = { ...makeRepliesSnapshot(0), conversation: metadata };
    const { app } = await createRepliesHarness(snapshot);
    try {
      const rendered = app.render(200).join("\n");
      expect(rendered).toContain(coverage === "complete" ? "No replies to review." : "No replies in fetched threads.");
      if (coverage === "supplied") expect(rendered).toContain("fetch time unknown");
    } finally {
      app.dispose();
    }
  });

  it("selects, pages, and clamps replies with every supported navigation key", async () => {
    const { app } = await createRepliesHarness(makeRepliesSnapshot(12));
    focusReplies(app);
    const pageSize = (app as any).repliesPageSize;
    expect(pageSize).toBeGreaterThan(1);

    app.handleInput("\x1b[B");
    app.handleInput("j");
    expect((app as any).selectedReplyIndex).toBe(2);
    app.handleInput("\x1b[A");
    app.handleInput("k");
    expect((app as any).selectedReplyIndex).toBe(0);

    app.handleInput("\x04");
    expect((app as any).selectedReplyIndex).toBe(getHalfPageStep(pageSize));
    app.handleInput("\x15");
    expect((app as any).selectedReplyIndex).toBe(0);

    app.handleInput("\x1b[6~");
    expect((app as any).selectedReplyIndex).toBe(pageSize);
    app.render(200);
    expect((app as any).repliesScroll).toBeGreaterThan(0);
    app.handleInput("\x1b[5~");
    expect((app as any).selectedReplyIndex).toBe(0);

    app.handleInput("\x06");
    expect((app as any).selectedReplyIndex).toBe(pageSize);
    app.handleInput("\x02");
    expect((app as any).selectedReplyIndex).toBe(0);

    app.handleInput("G");
    expect((app as any).selectedReplyIndex).toBe(11);
    app.handleInput("\x1b[B");
    expect((app as any).selectedReplyIndex).toBe(11);
    app.handleInput("g");
    app.handleInput("g");
    expect((app as any).selectedReplyIndex).toBe(0);
    app.handleInput("\x1b[A");
    expect((app as any).selectedReplyIndex).toBe(0);
    app.dispose();
  });

  it("opens, refreshes, and explicitly analyzes the selected reply", async () => {
    const openUrl = vi.fn(async (url: string) => ({ status: "opened" as const, url }));
    let rejectAnalysis: ((error: Error) => void) | undefined;
    const analyze = vi.fn((_reply: ReviewReplyItem) => new Promise<string>((_resolve, reject) => {
      rejectAnalysis = reject;
    }));
    const snapshot = makeRepliesSnapshot(3);
    snapshot.replies[1] = { ...snapshot.replies[1]!, body: "Long reply body ".repeat(100) };
    const harness = await createRepliesHarness(snapshot, { analyze, openUrl });
    focusReplies(harness.app);
    harness.app.handleInput("j");

    harness.app.handleInput("\r");
    const selectedUrl = makeReply(1).url!;
    await vi.waitFor(() => expect(openUrl).toHaveBeenCalledWith(selectedUrl));
    expect((harness.app as any).message).toBe(`Opened ${selectedUrl} in your browser.`);

    harness.app.handleInput("A");
    expect(analyze).toHaveBeenCalledWith(expect.objectContaining({ id: "thread-1:comment-1" }));
    expect(harness.app.render(200).join("\n")).toContain("Analyzing reply…");
    rejectAnalysis!(new Error("analysis\x1b failed"));
    await vi.waitFor(() => expect((harness.app as any).replyAnalysis.status).toBe("error"));
    expect(harness.app.render(200).join("\n")).toContain("Analysis failed: analysis\\x1b failed");

    analyze.mockResolvedValueOnce("Read-only result\x1b[2J");
    harness.app.handleInput("A");
    await vi.waitFor(() => expect((harness.app as any).replyAnalysis.status).toBe("ready"));
    expect(harness.app.render(200).join("\n")).toContain("Analysis: Read-only result\\x1b[2J");

    harness.app.handleInput("r");
    expect(harness.load).toHaveBeenCalledTimes(2);
    expect(harness.load).toHaveBeenLastCalledWith({ refresh: true });
    expect(harness.load.mock.calls[0]).toEqual([]);
    await vi.waitFor(() => expect((harness.app as any).repliesPanelState.status).toBe("ready"));
    expect((harness.app as any).replyAnalysis.status).toBe("idle");
    harness.app.dispose();
  });

  it("does not route Replies keys into search, comments, or diff actions", async () => {
    const { app, analyze } = await createRepliesHarness(makeRepliesSnapshot(3));
    focusReplies(app);
    const beforeState = structuredClone((app as any).state);
    const beforeView = (app as any).diffViewMode;

    for (const input of ["/", "n", "N", "p", "a", "w", "v"]) app.handleInput(input);

    expect((app as any).searchMode).toBe(false);
    expect((app as any).message).toBe("Search is not available in the Replies pane.");
    expect((app as any).state).toEqual(beforeState);
    expect((app as any).diffViewMode).toBe(beforeView);
    expect((app as any).editTarget).toBeNull();
    expect(analyze).not.toHaveBeenCalled();
    app.dispose();
  });

  it("focuses and selects Replies with the mouse wheel, and toggles Pane 5", async () => {
    const { app } = await createRepliesHarness(makeRepliesSnapshot(3));
    const bounds = (app as any).mousePaneLayout.replies;
    expect(bounds).not.toBeNull();

    app.handleInput(`\u001b[<65;${bounds.left + 2};${bounds.top + 2}M`);
    expect((app as any).state.focus).toBe("replies");
    expect((app as any).selectedReplyIndex).toBe(1);

    app.handleInput(`\u001b[<64;${bounds.left + 2};${bounds.top + 2}M`);
    expect((app as any).selectedReplyIndex).toBe(0);

    app.handleInput("5");
    expect((app as any).paneVisibility.replies).toBe(false);
    expect((app as any).state.focus).not.toBe("replies");
    app.handleInput("5");
    expect((app as any).paneVisibility.replies).toBe(true);
    app.dispose();
  });
});

describe("PR context pane", () => {
  const contextText = Array.from({ length: 80 }, (_, index) => `context line ${index + 1}`).join("\n");
  const prUrl = "https://github.com/example/widgets/pull/12";

  async function createContextHarness(overrides: Record<string, unknown> = {}, text = contextText) {
    const load = vi.fn(async () => text);
    const harness = createHarness(
      undefined,
      undefined,
      { contextPanelSource: { title: "PR context", loadingText: "Loading PR context", url: prUrl, load }, ...overrides } as never,
      { rows: 30, columns: 200 },
    );
    await vi.waitFor(() => expect(harness.loadFileContents).toHaveBeenCalled());
    await vi.waitFor(() => expect((harness.app as any).contextPanelState.status).toBe("ready"));
    harness.app.render(200);
    return harness;
  }

  function focusContext(app: any): void {
    app.handleInput("\t");
    app.handleInput("\t");
    app.handleInput("\t");
  }

  it("applies context enrichment without moving scroll or code selection", async () => {
    let update: ((text: string) => void) | undefined;
    const { app } = await createContextHarness({ contextPanelSource: {
      title: "PR context", loadingText: "Loading", load: async (onUpdate?: typeof update) => {
        update = onUpdate;
        return contextText;
      },
    } });
    try {
      focusContext(app);
      app.handleInput("j");
      const before = structuredClone((app as any).state);
      expect(update).toBeTypeOf("function");
      update!(`${contextText}\nGenerated explanation`);
      expect((app as any).contextPanelState.text).toContain("Generated explanation");
      expect((app as any).contextScroll).toBe(1);
      expect((app as any).state).toEqual(before);
      expect(app.render(200).join("\n")).toContain("context line 2");
      app.handleInput("G");
      expect(app.render(200).join("\n")).toContain("Generated explanation");
    } finally { app.dispose(); }
  });

  it.each(["disposal", "supersession"])("ignores late context callbacks after %s", async (reason) => {
    const updates: Array<((text: string) => void) | undefined> = [];
    const { app } = await createContextHarness({ contextPanelSource: {
      title: "PR context", loadingText: "Loading", load: async (update?: (text: string) => void) => {
        updates.push(update);
        return `facts ${updates.length}`;
      },
    } });
    const render = vi.spyOn((app as any).tui, "requestRender");
    try {
      expect(updates[0]).toBeTypeOf("function");
      if (reason === "disposal") app.dispose();
      else {
        (app as any).contextPanelState = { status: "idle" };
        app.handleInput("4");
        app.handleInput("4");
        await vi.waitFor(() => expect((app as any).contextPanelState.text).toBe("facts 2"));
        updates[1]!("current explanation");
      }
      const before = structuredClone((app as any).contextPanelState);
      render.mockClear();
      updates[0]!("late explanation");
      expect((app as any).contextPanelState).toEqual(before);
      expect(render).not.toHaveBeenCalled();
    } finally { app.dispose(); }
  });

  it("keeps an early context update when the initial load finishes later", async () => {
    const { app } = await createContextHarness({ contextPanelSource: {
      title: "PR context", loadingText: "Loading", load: async (update?: (text: string) => void) => {
        update?.("enriched facts");
        return "initial facts";
      },
    } });
    try { expect(app.render(200).join("\n")).toContain("enriched facts"); }
    finally { app.dispose(); }
  });

  it("joins the Tab cycle and shows the focused border", async () => {
    const { app } = await createContextHarness();

    focusContext(app);
    expect((app as any).state.focus).toBe("context");
    const rendered = app.render(200).join("\n");
    expect(rendered).toContain("▶ PR context");
    expect(rendered).toContain("Focus: PR context");

    app.handleInput("\u001b[Z");
    expect((app as any).state.focus).toBe("comments");

    app.handleInput("\t");
    app.handleInput("\t");
    expect((app as any).state.focus).toBe("navigator");
    app.dispose();
  });

  it("is skipped by focus traversal when the review has no PR context", async () => {
    const { app, loadFileContents } = createHarness(undefined, undefined, {}, { rows: 30, columns: 200 });
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());
    app.render(200);

    for (const expected of ["diff", "comments", "navigator"]) {
      app.handleInput("\t");
      expect((app as any).state.focus).toBe(expected);
    }

    app.handleInput("4");
    expect((app as any).message).toBe("PR context is not available in this review.");
    expect((app as any).state.focus).toBe("navigator");
    app.dispose();
  });

  it("scrolls clipped context with Up/Down and clamps at both ends", async () => {
    const { app } = await createContextHarness();
    focusContext(app);

    const maxScroll = (app as any).maxContextScroll();
    expect((app as any).contextLineCount).toBe(80);
    expect(maxScroll).toBe(80 - (app as any).contextPageSize);
    expect(maxScroll).toBeGreaterThan(0);

    app.handleInput("\u001b[B");
    app.handleInput("\u001b[B");
    expect((app as any).contextScroll).toBe(2);
    const scrolled = app.render(200).join("\n");
    expect(scrolled).toContain("context line 3");
    expect(scrolled).not.toContain("context line 1 ");

    app.handleInput("\u001b[A");
    expect((app as any).contextScroll).toBe(1);

    for (let index = 0; index < 5; index += 1) app.handleInput("\u001b[6~");
    expect((app as any).contextScroll).toBe(maxScroll);

    app.handleInput("\u001b[B");
    expect((app as any).contextScroll).toBe(maxScroll);

    app.handleInput("g");
    app.handleInput("g");
    expect((app as any).contextScroll).toBe(0);

    app.handleInput("\u001b[A");
    expect((app as any).contextScroll).toBe(0);

    app.handleInput("G");
    expect((app as any).contextScroll).toBe(maxScroll);
    app.dispose();
  });

  it("keeps the diff selection untouched while scrolling context", async () => {
    const { app } = await createContextHarness();
    focusContext(app);
    const before = structuredClone((app as any).state.selectedLineTargetByScopeFile);

    app.handleInput("\u001b[B");
    app.handleInput("j");

    expect((app as any).contextScroll).toBe(2);
    expect((app as any).state.selectedLineTargetByScopeFile).toEqual(before);
    app.dispose();
  });

  it("opens the canonical PR URL with Enter at any scroll position", async () => {
    const openUrl = vi.fn(async (url: string) => ({ status: "opened" as const, url }));
    const { app } = await createContextHarness({ openUrl });
    focusContext(app);

    app.handleInput("\r");
    await vi.waitFor(() => expect(openUrl).toHaveBeenCalledWith(prUrl));
    expect((app as any).message).toBe(`Opened ${prUrl} in your browser.`);

    app.handleInput("G");
    app.handleInput("\r");
    await vi.waitFor(() => expect(openUrl).toHaveBeenCalledTimes(2));
    expect((app as any).contextScroll).toBe((app as any).maxContextScroll());
    app.dispose();
  });

  it("reports missing and invalid PR URLs instead of opening anything", async () => {
    const openUrl = vi.fn(async () => ({ status: "invalid" as const }));
    const missing = await createContextHarness({
      openUrl,
      contextPanelSource: { title: "PR context", loadingText: "Loading PR context", load: vi.fn(async () => contextText) },
    });
    focusContext(missing.app);

    missing.app.handleInput("\r");
    expect(openUrl).not.toHaveBeenCalled();
    expect((missing.app as any).message).toBe("No PR URL is available for this review.");
    missing.app.dispose();

    const invalid = await createContextHarness({
      openUrl,
      contextPanelSource: { title: "PR context", loadingText: "Loading PR context", url: "javascript:alert(1)", load: vi.fn(async () => contextText) },
    });
    focusContext(invalid.app);

    invalid.app.handleInput("\r");
    await vi.waitFor(() => expect((invalid.app as any).message).toBe("PR URL is not a valid http(s) address."));
    invalid.app.dispose();
  });

  it("focuses and scrolls the context pane from the mouse wheel", async () => {
    const { app } = await createContextHarness();
    const bounds = (app as any).mousePaneLayout.context;
    expect(bounds).not.toBeNull();

    app.handleInput(`\u001b[<65;${bounds.left + 2};${bounds.top + 2}M`);
    expect((app as any).state.focus).toBe("context");
    expect((app as any).contextScroll).toBe(1);

    app.handleInput(`\u001b[<64;${bounds.left + 2};${bounds.top + 2}M`);
    expect((app as any).contextScroll).toBe(0);
    app.dispose();
  });

  it("keeps context scroll independent from navigator, diff, and comments scroll", async () => {
    const { app } = await createContextHarness();
    focusContext(app);

    app.handleInput("\u001b[B");
    app.handleInput("\u001b[B");
    app.handleInput("\u001b[B");

    expect((app as any).contextScroll).toBe(3);
    expect((app as any).navigatorScroll).toBe(0);
    expect((app as any).diffScroll).toBe(0);
    expect((app as any).commentsScroll).toBe(0);
    app.dispose();
  });

  it("moves a resumed context focus to a visible pane when the review has no PR context", async () => {
    const file = makeFile();
    const initialSession = {
      version: 2,
      id: "session-1",
      identity: "local",
      updatedAt: new Date().toISOString(),
      revision: "abc",
      fileSignatures: {},
      state: {
        activeScope: "git-diff",
        activeFileId: file.id,
        searchQuery: "",
        focus: "context",
        wrapLines: true,
        hideUnchanged: false,
        selectedCommentIndex: 0,
        selectedLineTargetByScopeFile: {},
        draft: { allComment: "", allIntent: "discuss", comments: [] },
      },
      diffViewMode: "unified",
      navigatorTreeMode: false,
      contextLineNavigation: false,
      commentsGlobal: false,
      reviewedFileIds: [],
      navigatorScroll: 0,
      diffScroll: 0,
      commentsScroll: 0,
    };
    const { app, loadFileContents } = createHarness(undefined, [file], { initialSession } as never, { rows: 30, columns: 200 });
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());

    expect((app as any).state.focus).toBe("navigator");
    app.dispose();
  });

  it("refuses pane search while PR context is focused", async () => {
    const { app } = await createContextHarness();
    focusContext(app);

    app.handleInput("/");

    expect((app as any).searchMode).toBe(false);
    expect((app as any).message).toBe("Search is not available in the PR context pane.");
    app.dispose();
  });
});
