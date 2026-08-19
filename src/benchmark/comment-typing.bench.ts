import { bench, describe, vi } from "vitest";
import type { ReviewFile } from "../types.js";
import { ReviewApp, type DiffViewMode } from "../ui/review-app.js";

const typingTrace = "This comment explains the regression.";

function makeFile(): ReviewFile {
  return {
    id: "src/large.ts::working::::",
    path: "src/large.ts",
    worktreeStatus: "modified",
    hasWorkingTreeFile: true,
    inGitDiff: true,
    inLastCommit: false,
    inAllFiles: false,
    gitDiff: {
      status: "modified",
      oldPath: "src/large.ts",
      newPath: "src/large.ts",
      displayPath: "src/large.ts",
      hasOriginal: true,
      hasModified: true,
    },
    lastCommit: null,
    allFiles: null,
  };
}

async function createApp(lineCount: number, diffViewMode: DiffViewMode): Promise<ReviewApp> {
  const modifiedContent = Array.from({ length: lineCount }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
  const tui = {
    terminal: { write: vi.fn(), rows: 40, columns: 120 },
    requestRender: vi.fn(),
    getShowHardwareCursor: vi.fn(() => false),
    setShowHardwareCursor: vi.fn(),
  };
  const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
  };
  const app = new ReviewApp(tui as never, theme as never, vi.fn(), {
    files: [makeFile()],
    repoRoot: "/repo",
    loadFileContents: async () => ({ originalContent: "", modifiedContent }),
    commentShortcuts: [],
    visibleScopes: ["git-diff"],
    notify: vi.fn(),
  });

  (app as any).diffViewMode = diffViewMode;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await Promise.resolve();
    if ((app as any).getEntry((app as any).state.activeFileId, "git-diff")?.status === "ready") break;
  }
  app.render(120);
  app.handleInput("\r");
  return app;
}

function typeComment(app: ReviewApp): void {
  app.handleInput("c");
  for (const character of typingTrace) {
    app.handleInput(character);
    app.render(120);
  }
  app.handleInput("\u001b");
}

const [smallUnifiedApp, largeUnifiedApp, smallSideBySideApp, largeSideBySideApp] = await Promise.all([
  createApp(200, "unified"),
  createApp(20_000, "unified"),
  createApp(200, "side-by-side"),
  createApp(20_000, "side-by-side"),
]);

describe("comment typing performance", () => {
  bench("unified / 200-line diff / 37 comment keystrokes", () => {
    typeComment(smallUnifiedApp);
  });

  bench("unified / 20k-line diff / 37 comment keystrokes", () => {
    typeComment(largeUnifiedApp);
  });

  bench("side-by-side / 200-line diff / 37 comment keystrokes", () => {
    typeComment(smallSideBySideApp);
  });

  bench("side-by-side / 20k-line diff / 37 comment keystrokes", () => {
    typeComment(largeSideBySideApp);
  });
});
