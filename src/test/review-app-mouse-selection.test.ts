import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createStorySnapshot, validateDiffStory } from "../diff-story/plan.js";
import type { ReviewSourceLocation } from "../source-links.js";
import { setSelectedLineTarget } from "../state.js";
import type { ReviewFile, ReviewFileContents } from "../types.js";
import { ReviewApp } from "../ui/review-app.js";
import { stripTerminalSequences } from "../ui/mouse-selection.js";

const clipboard = vi.hoisted(() => ({ copy: vi.fn(async (_text: string) => undefined) }));
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
  copyToClipboard: clipboard.copy,
}));

const originalPreferencesPath = process.env.PI_CODER_PREFERENCES_PATH;
let preferencesDir: string;

beforeEach(() => {
  clipboard.copy.mockClear();
  preferencesDir = mkdtempSync(join(tmpdir(), "pi-coder-mouse-selection-"));
  process.env.PI_CODER_PREFERENCES_PATH = join(preferencesDir, "preferences.json");
});

afterEach(() => {
  if (originalPreferencesPath == null) delete process.env.PI_CODER_PREFERENCES_PATH;
  else process.env.PI_CODER_PREFERENCES_PATH = originalPreferencesPath;
  rmSync(preferencesDir, { recursive: true, force: true });
});

interface Point {
  row: number;
  col: number;
}

function makeFile(path = "src/app.ts"): ReviewFile {
  return {
    id: `${path}::working::::`,
    path,
    worktreeStatus: "modified",
    hasWorkingTreeFile: true,
    inGitDiff: true,
    inAllFiles: false,
    gitDiff: { status: "modified", oldPath: path, newPath: path, displayPath: path, hasOriginal: true, hasModified: true },
    allFiles: null,
  };
}

const COLOR_THEME = {
  fg: (color: string, text: string) => `\x1b[38;5;${color.length}m${text}\x1b[39m`,
  bg: (color: string, text: string) => `\x1b[48;5;${color.length}m${text}\x1b[49m`,
  getFgAnsi: (color: string) => `\x1b[38;2;${color.length};1;1m`,
  getBgAnsi: (color: string) => `\x1b[48;2;${color.length};2;2m`,
};

function harness(
  contents: ReviewFileContents,
  options: { files?: ReviewFile[]; mode?: "regular" | "fullscreen"; tui?: unknown; theme?: unknown; overrides?: Partial<ConstructorParameters<typeof ReviewApp>[3]> } = {},
) {
  const loadFileContents = vi.fn(async () => contents);
  const tui = {
    mode: options.mode ?? "regular",
    terminal: { write: vi.fn(), rows: 30, columns: 120 },
    requestRender: vi.fn(),
    getShowHardwareCursor: vi.fn(() => false),
    setShowHardwareCursor: vi.fn(),
  };
  const theme = options.theme ?? { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text };
  const app = new ReviewApp((options.tui ?? tui) as never, theme as never, vi.fn(), {
    files: options.files ?? [makeFile()],
    repoRoot: "/repo",
    loadFileContents,
    commentShortcuts: [],
    scope: "git-diff",
    notify: vi.fn(),
    ...options.overrides,
  });
  return { app, loadFileContents };
}

function locate(app: ReviewApp, text: string, width = 120): Point {
  app.render(width);
  const frame = (app as any).mouseSelection.frame as { top: number; left: number; lines: string[] };
  for (let index = 0; index < frame.lines.length; index += 1) {
    const plain = stripTerminalSequences(frame.lines[index]!);
    const at = plain.indexOf(text);
    if (at >= 0) return { row: frame.top + index, col: frame.left + visibleWidth(plain.slice(0, at)) };
  }
  throw new Error(`${text} is not rendered`);
}

const right = (point: Point, cells: number): Point => ({ row: point.row, col: point.col + cells });
const press = (point: Point) => `\x1b[<0;${point.col + 1};${point.row + 1}M`;
const drag = (point: Point) => `\x1b[<32;${point.col + 1};${point.row + 1}M`;
const release = (point: Point) => `\x1b[<0;${point.col + 1};${point.row + 1}m`;

function selectWithTerminalInput(app: ReviewApp, from: Point, to: Point): void {
  app.handleInput(press(from));
  app.handleInput(drag(to));
  app.handleInput(release(to));
}

const THREE_LINES = { originalContent: "", modifiedContent: "const first = 1;\nconst second = 2;\nconst third = 3;\n" };

describe("ReviewApp mouse selection in diffs", () => {
  it("copies only the code between two cells of a unified diff", async () => {
    const { app, loadFileContents } = harness(THREE_LINES);
    try {
      await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());
      const start = locate(app, "first");
      const end = right(locate(app, "third"), 4);
      app.handleInput(press(start));
      app.handleInput(drag(end));
      const highlighted = app.render(120).join("\n");
      expect(highlighted).toContain("\x1b[7m");
      expect(stripTerminalSequences(highlighted)).toContain("const second = 2;");
      app.handleInput(release(end));
      await vi.waitFor(() => expect(String((app as any).message)).toBe("Copied 3 lines."));
      expect(clipboard.copy).toHaveBeenCalledExactlyOnceWith("first = 1;\nconst second = 2;\nconst third");
    } finally {
      app.dispose();
    }
  });

  it("keeps a side-by-side selection on the side where it started", async () => {
    const { app, loadFileContents } = harness({ originalContent: "alpha_old()\nbeta_old()\n", modifiedContent: "alpha_new()\nbeta_new()\n" });
    try {
      await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());
      (app as any).diffViewMode = "side-by-side";
      selectWithTerminalInput(app, locate(app, "alpha_old"), locate(app, "beta_new"));
      await vi.waitFor(() => expect(clipboard.copy).toHaveBeenCalledExactlyOnceWith("alpha_old()\nbeta_old()"));

      selectWithTerminalInput(app, right(locate(app, "alpha_new"), 6), right(locate(app, "beta_new"), 3));
      await vi.waitFor(() => expect(clipboard.copy).toHaveBeenLastCalledWith("new()\nbeta"));
    } finally {
      app.dispose();
    }
  });

  it("copies the exact source across a wrapped line", async () => {
    const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliett", "kilo", "lima", "mike",
      "november", "oscar", "papa", "quebec", "romeo", "sierra", "tango", "uniform", "victor", "whiskey", "xray", "yankee", "zulu"];
    const source = `const words = "${words.join(" ")}";`;
    const { app, loadFileContents } = harness({ originalContent: "", modifiedContent: `${source}\n` });
    try {
      await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());
      const start = locate(app, "alpha");
      const end = right(locate(app, "zulu"), 3);
      expect(end.row).toBeGreaterThan(start.row);
      app.handleInput(press(start));
      app.handleInput(drag(end));
      const zuluRow = app.render(120).find((line) => stripTerminalSequences(line).includes("zulu"));
      expect(zuluRow).toContain("\x1b[7m");
      app.handleInput(release(end));
      await vi.waitFor(() => expect(clipboard.copy).toHaveBeenCalledExactlyOnceWith(source.slice(source.indexOf("alpha"), source.indexOf("zulu") + 4)));
    } finally {
      app.dispose();
    }
  });

  it("keeps selections aligned with colored gutters and syntax-highlighted wrapped code", async () => {
    const source = `{"words": "alpha bravo charlie delta echo foxtrot golf hotel india juliett kilo lima mike", "tail": [1, 2, 3], "last": "zulu"}`;
    const { app, loadFileContents } = harness({ originalContent: "", modifiedContent: `${source}\n` }, { files: [makeFile("config/words.json")], theme: COLOR_THEME });
    try {
      await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());
      expect(app.render(120).join("\n")).toContain("\x1b[38;5;");
      const start = locate(app, "bravo");
      const end = right(locate(app, "zulu"), 1);
      expect(end.row).toBeGreaterThan(start.row);
      selectWithTerminalInput(app, start, end);
      await vi.waitFor(() => expect(clipboard.copy).toHaveBeenCalledExactlyOnceWith(source.slice(source.indexOf("bravo"), source.indexOf("zulu") + 2)));
    } finally {
      app.dispose();
    }
  });

  it("selects whole lines from the gutter and the hidden tail of truncated lines", async () => {
    const long = `const message = "${"x".repeat(200)}";`;
    const { app, loadFileContents } = harness({ originalContent: "", modifiedContent: `const first = 1;\n${long}\nconst third = 3;\n` });
    try {
      await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());
      app.handleInput("w");
      const gutter = { row: locate(app, "first").row, col: locate(app, "first").col - 9 };
      const surface = (app as any).mouseSelection.surfaces[0];
      const tail = { row: locate(app, "message").row, col: surface.left + surface.paneWidth - 3 };
      selectWithTerminalInput(app, gutter, tail);
      await vi.waitFor(() => expect(clipboard.copy).toHaveBeenCalledExactlyOnceWith(`const first = 1;\n${long}`));
    } finally {
      app.dispose();
    }
  });

  it("selects a word on double click and the whole source line on triple click, tabs included", async () => {
    const { app, loadFileContents } = harness({ originalContent: "", modifiedContent: "\tcall(load_user);\n" });
    try {
      await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());
      const word = right(locate(app, "load_user"), 2);
      for (let click = 0; click < 3; click += 1) {
        app.handleInput(press(word));
        app.handleInput(release(word));
      }
      await vi.waitFor(() => expect(clipboard.copy).toHaveBeenCalledTimes(2));
      expect(clipboard.copy.mock.calls.map(([text]) => text)).toEqual(["load_user", "\tcall(load_user);"]);
    } finally {
      app.dispose();
    }
  });

  it("copies nothing for a plain click and clears the highlight on keyboard input", async () => {
    const { app, loadFileContents } = harness(THREE_LINES);
    try {
      await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());
      const point = locate(app, "second");
      app.handleInput(press(point));
      app.handleInput(release(point));
      expect(app.render(120).join("\n")).not.toContain("\x1b[7m");
      expect(clipboard.copy).not.toHaveBeenCalled();

      app.handleInput(press(right(point, 1)));
      app.handleInput(drag(right(point, 4)));
      expect(app.render(120).join("\n")).toContain("\x1b[7m");
      app.handleInput("\x1b[B");
      expect(app.render(120).join("\n")).not.toContain("\x1b[7m");
      app.handleInput(release(right(point, 4)));
      expect(clipboard.copy).not.toHaveBeenCalled();
    } finally {
      app.dispose();
    }
  });

  it("captures Pi's normalized press, drag, and release events in fullscreen mode", async () => {
    const { app, loadFileContents } = harness(THREE_LINES, { mode: "fullscreen" });
    try {
      await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());
      const event = (type: string, point: Point) => ({ type, button: "left", x: point.col, y: point.row, screenX: point.col, screenY: point.row });
      const start = locate(app, "second");
      const end = right(locate(app, "third"), 2);
      expect(app.handleMouse(event("press", start))).toEqual({ handled: true, capture: true });
      expect(app.handleMouse(event("drag", end))).toEqual({ handled: true });
      expect(app.handleMouse(event("release", end))).toEqual({ handled: true });
      await vi.waitFor(() => expect(clipboard.copy).toHaveBeenCalledExactlyOnceWith("second = 2;\nconst thi"));
      expect(app.handleMouse({ type: "move", x: 0, y: 0 })).toBeUndefined();
    } finally {
      app.dispose();
    }
  });

  it("selects code through the real regular-mode Pi renderer", async () => {
    const runtime = await import(process.env.PI_CODER_TEST_TUI_MODULE ?? "@earendil-works/pi-tui");
    const Renderer = runtime.TuiMainScreen ?? runtime.TUI;
    let input = (_data: string) => {};
    const terminal = {
      rows: 30, columns: 120, kittyProtocolActive: false,
      start: (onInput: typeof input) => { input = onInput; },
      stop: vi.fn(), write: vi.fn(), hideCursor: vi.fn(), showCursor: vi.fn(),
    };
    const tui = new Renderer(terminal);
    const { app, loadFileContents } = harness(THREE_LINES, { tui });
    try {
      tui.start();
      tui.showOverlay(app, { anchor: "center", width: "100%", maxHeight: "100%", margin: { top: 1, bottom: 1 } });
      await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());
      const start = locate(app, "first");
      const end = right(locate(app, "second"), 5);
      input(press(start));
      input(drag(end));
      input(release(end));
      await vi.waitFor(() => expect(clipboard.copy).toHaveBeenCalledExactlyOnceWith("first = 1;\nconst second"));
    } finally {
      tui.hideOverlay();
      app.dispose();
      tui.stop();
    }
  });

  it("selects code inside a /diff-story pane without crossing into the paired pane", async () => {
    const files = [makeFile("app.ts"), makeFile("app.test.ts")];
    const snapshot = createStorySnapshot(files.map((file) => ({
      fileId: file.id,
      path: file.path,
      scope: "git-diff" as const,
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
          explanation: "The caller reuses pending work.",
          implementation: [{ fileId: files[0]!.id, side: "added", startLine: 2, endLine: 2 }],
          tests: [{ fileId: files[1]!.id, side: "added", startLine: 2, endLine: 2 }],
        },
        {
          id: "remove",
          title: "Remove the old entry",
          explanation: "The old entry is no longer called.",
          implementation: [{ fileId: files[0]!.id, side: "deleted", startLine: 1, endLine: 1 }],
          tests: [],
        },
      ],
    }, snapshot);
    const { app } = harness({ originalContent: "", modifiedContent: "" }, {
      files,
      overrides: {
        allowEmptySubmit: true,
        story: { plan, snapshot },
        loadFileContents: async (_root, file) => snapshot.files.find((entry) => entry.fileId === file.id)!.contents,
      },
    });
    try {
      const tests = locate(app, "expectReuse");
      selectWithTerminalInput(app, tests, right(tests, "expectReuse()".length - 1));
      await vi.waitFor(() => expect(clipboard.copy).toHaveBeenLastCalledWith("expectReuse()"));
      expect(app.render(120).join("\n")).toContain("Copied 13 characters.");

      selectWithTerminalInput(app, locate(app, "reuse()"), right(tests, 4));
      await vi.waitFor(() => expect(clipboard.copy).toHaveBeenLastCalledWith("reuse()"));
    } finally {
      app.dispose();
    }
  });

  it("copies text from other panes and the footer without crossing pane borders", async () => {
    const load = vi.fn(async () => "Problem: keep pane state\nSecond context line");
    const { app } = harness(THREE_LINES, { overrides: { contextPanelSource: { title: "PR context", loadingText: "Loading", load } } });
    try {
      await vi.waitFor(() => expect(app.render(120).join("\n")).toContain("Problem: keep pane state"));
      const start = locate(app, "\u2191\u2193 scroll");
      const outside = { row: locate(app, "Problem").row + 5, col: 500 };
      selectWithTerminalInput(app, start, outside);
      await vi.waitFor(() => expect(clipboard.copy).toHaveBeenLastCalledWith("\u2191\u2193 scroll\nConversation coverage unknown\n  Problem: keep pane state"));

      const footer = right(locate(app, "Copied 3 lines."), 1);
      for (let click = 0; click < 2; click += 1) {
        app.handleInput(press(footer));
        app.handleInput(release(footer));
      }
      await vi.waitFor(() => expect(clipboard.copy).toHaveBeenLastCalledWith("Copied"));
    } finally {
      app.dispose();
    }
  });

  it("drops a pane text selection when that pane scrolls", async () => {
    const { app, loadFileContents } = harness(THREE_LINES);
    try {
      await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());
      const start = locate(app, "1 file");
      app.handleInput(press(start));
      app.handleInput(drag(right(start, 5)));
      expect(app.render(120).join("\n")).toContain("\x1b[7m");
      app.handleInput(`\x1b[<65;${start.col + 1};${start.row + 1}M`);
      expect(app.render(120).join("\n")).not.toContain("\x1b[7m");
      app.handleInput(release(right(start, 5)));
      expect(clipboard.copy).not.toHaveBeenCalled();
    } finally {
      app.dispose();
    }
  });

  it("scrolls the diff while a drag rests below its last visible line", async () => {
    const content = Array.from({ length: 80 }, (_, index) => `line_${index + 1}`).join("\n");
    const { app, loadFileContents } = harness({ originalContent: "", modifiedContent: content });
    try {
      await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());
      const start = locate(app, "line_1");
      const surface = (app as any).mouseSelection.surfaces[0];
      const visibleRows = surface.lines.length;
      const below = { row: surface.top + visibleRows + 1, col: start.col };
      vi.useFakeTimers();
      try {
        app.handleInput(press(start));
        app.handleInput(drag(below));
        for (let tick = 0; tick < 10; tick += 1) {
          vi.advanceTimersByTime(50);
          app.render(120);
        }
        expect((app as any).diffScroll).toBe(10);
        app.handleInput(release(below));
      } finally {
        vi.useRealTimers();
      }
      await vi.waitFor(() => expect(clipboard.copy).toHaveBeenCalledOnce());
      const copied = clipboard.copy.mock.calls[0]![0].split("\n");
      expect(copied[0]).toBe("line_1");
      expect(copied).toHaveLength(visibleRows + 10);
      expect(copied.at(-1)).toBe(`line_${visibleRows + 10}`);
      expect((app as any).mouseSelection.edgeTimer).toBeNull();
    } finally {
      app.dispose();
    }
  });
});

describe("ReviewApp code host links", () => {
  const head = "a".repeat(40);
  const base = "b".repeat(40);

  function linkHarness(overrides: Partial<ConstructorParameters<typeof ReviewApp>[3]> = {}) {
    const reviewed = makeFile();
    reviewed.gitDiff = { ...reviewed.gitDiff!, originalRevision: base, modifiedRevision: "origin/feature" };
    const openUrl = vi.fn(async (url: string) => ({ status: "opened" as const, url }));
    const file = vi.fn((location: ReviewSourceLocation) => `https://code.example/blob/${location.revision}/${location.path}#L${location.line}`);
    const search = vi.fn((query: string) => `https://search.example/results?q=sym:${query}`);
    const result = harness({ originalContent: "const value = old_name;\n", modifiedContent: "const value = load_user;\n" }, {
      files: [reviewed],
      overrides: { openUrl, reviewHeader: { identity: "team/app#7", title: "Rename", revision: head }, sourceLinks: { file, search }, ...overrides },
    });
    const select = (side: "added" | "deleted") => {
      (result.app as any).state = setSelectedLineTarget((result.app as any).state, reviewed.id, "git-diff", { side, line: 1 });
    };
    return { ...result, openUrl, file, search, select };
  }

  it("opens the selected line at the reviewed commit, and deleted lines at the base commit", async () => {
    const { app, loadFileContents, openUrl, file, select } = linkHarness();
    try {
      await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());
      select("added");
      app.handleInput("g");
      app.handleInput("f");
      expect(file).toHaveBeenLastCalledWith({ path: "src/app.ts", revision: head, line: 1 });
      await vi.waitFor(() => expect(openUrl).toHaveBeenLastCalledWith(`https://code.example/blob/${head}/src/app.ts#L1`));

      select("deleted");
      app.handleInput("g");
      app.handleInput("f");
      expect(file).toHaveBeenLastCalledWith({ path: "src/app.ts", revision: base, line: 1 });
      await vi.waitFor(() => expect(openUrl).toHaveBeenLastCalledWith(`https://code.example/blob/${base}/src/app.ts#L1`));
      expect(String((app as any).message)).toMatch(/^Opened https:\/\/code\.example\/blob\//);
    } finally {
      app.dispose();
    }
  });

  it.each(["added", "deleted"] as const)("declines gf for %s submodule lines and restores parent links", async (side) => {
    const parent = makeFile("vendor/child");
    parent.gitDiff = { ...parent.gitDiff!, originalRevision: base, modifiedRevision: head };
    parent.submodule = { "git-diff": {
      repoRoot: "/repo/vendor/child", path: parent.path,
      oldSha: "c".repeat(40), newSha: "d".repeat(40), available: true,
    } };
    const child = makeFile("src/child.ts");
    child.gitDiff = { ...child.gitDiff!, originalRevision: "c".repeat(40), modifiedRevision: "d".repeat(40) };
    const loadSubmoduleReviewData = vi.fn(async () => ({
      repoRoot: "/repo/vendor/child", files: [child], scope: "git-diff" as const,
    }));
    const parentSource = makeFile();
    parentSource.gitDiff = { ...parentSource.gitDiff!, originalRevision: base, modifiedRevision: head };
    const { app, openUrl, file } = linkHarness({ files: [parent, parentSource], loadSubmoduleReviewData });
    try {
      (app as any).state = { ...(app as any).state, activeFileId: parent.id };
      app.handleInput("\r");
      await vi.waitFor(() => {
        const active = (app as any).activeFile();
        expect(active.pathPrefix).toBe("vendor/child");
        expect((app as any).getEntry(active.id, "git-diff")?.status).toBe("ready");
      });
      expect(loadSubmoduleReviewData).toHaveBeenCalledWith(parent.submodule["git-diff"]);
      const nestedId = (app as any).state.activeFileId;
      (app as any).state = setSelectedLineTarget((app as any).state, nestedId, "git-diff", { side, line: 1 });
      app.handleInput("g");
      app.handleInput("f");
      expect(file).not.toHaveBeenCalled();
      expect(openUrl).not.toHaveBeenCalled();
      expect(String((app as any).message)).toBe("gf is unavailable inside submodules because their code host is not configured.");

      app.handleInput("b");
      expect((app as any).state.activeFileId).toBe(parent.id);
      (app as any).state = { ...(app as any).state, activeFileId: parentSource.id };
      await (app as any).ensureActiveEntry();
      (app as any).state = setSelectedLineTarget((app as any).state, parentSource.id, "git-diff", { side, line: 1 });
      app.handleInput("g");
      app.handleInput("f");
      expect(file).toHaveBeenLastCalledWith({ path: parentSource.path, revision: side === "deleted" ? base : head, line: 1 });
      expect(openUrl).toHaveBeenCalledOnce();
    } finally {
      app.dispose();
    }
  });

  it("searches the double-clicked symbol with gd and a Ctrl+clicked symbol directly", async () => {
    const { app, loadFileContents, openUrl, search } = linkHarness();
    try {
      await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());
      app.handleInput("g");
      app.handleInput("d");
      expect(String((app as any).message)).toBe("Double-click a symbol first, then press gd.");

      const word = right(locate(app, "load_user"), 2);
      for (let click = 0; click < 2; click += 1) {
        app.handleInput(press(word));
        app.handleInput(release(word));
      }
      await vi.waitFor(() => expect(clipboard.copy).toHaveBeenCalledWith("load_user"));
      app.handleInput("g");
      app.handleInput("d");
      expect(search).toHaveBeenLastCalledWith("load_user");
      await vi.waitFor(() => expect(openUrl).toHaveBeenLastCalledWith("https://search.example/results?q=sym:load_user"));

      const other = right(locate(app, "old_name"), 1);
      app.handleInput(`\x1b[<16;${other.col + 1};${other.row + 1}M`);
      app.handleInput(`\x1b[<16;${other.col + 1};${other.row + 1}m`);
      expect(search).toHaveBeenLastCalledWith("old_name");
      expect(clipboard.copy).toHaveBeenCalledOnce();
    } finally {
      app.dispose();
    }
  });

  it("explains what is missing instead of opening a link", async () => {
    const unconfigured = linkHarness({ sourceLinks: undefined });
    const local = linkHarness({ reviewHeader: undefined });
    try {
      await vi.waitFor(() => expect(unconfigured.loadFileContents).toHaveBeenCalled());
      await vi.waitFor(() => expect(local.loadFileContents).toHaveBeenCalled());
      unconfigured.app.handleInput("g");
      unconfigured.app.handleInput("f");
      expect(String((unconfigured.app as any).message)).toContain("urls.file");
      unconfigured.app.handleInput("g");
      unconfigured.app.handleInput("d");
      expect(String((unconfigured.app as any).message)).toContain("\"search\"");

      local.select("added");
      local.app.handleInput("g");
      local.app.handleInput("f");
      expect(String((local.app as any).message)).toBe("This line has no commit on the code host to open.");
      expect(unconfigured.openUrl).not.toHaveBeenCalled();
      expect(local.openUrl).not.toHaveBeenCalled();
    } finally {
      unconfigured.app.dispose();
      local.app.dispose();
    }
  });
});
