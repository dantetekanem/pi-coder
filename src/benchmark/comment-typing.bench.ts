import { bench, describe } from "vitest";
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

async function createApp(lineCount: number, diffViewMode: DiffViewMode, mixed = false): Promise<ReviewApp> {
  const sourceLines = Array.from({ length: lineCount }, (_, index) => mixed
    ? `const value${index} = "${index % 7 === 0 ? "日本語 café 👩‍💻" : "source"}"; // ${"context ".repeat(index % 13)}`
    : `line ${index + 1}`);
  const originalContent = mixed ? sourceLines.join("\n") + "\n" : "";
  const modifiedContent = sourceLines.map((line, index) => mixed && index % 9 === 0 ? line.replace("const", "let") : line).join("\n") + "\n";
  const tui = {
    terminal: { write() {}, rows: 40, columns: 120 },
    requestRender() {},
    getShowHardwareCursor: () => false,
    setShowHardwareCursor() {},
  };
  const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
  };
  const app = new ReviewApp(tui as never, theme as never, () => {}, {
    files: [makeFile()],
    repoRoot: "/repo",
    loadFileContents: async () => ({ originalContent, modifiedContent }),
    commentShortcuts: [],
    visibleScopes: ["git-diff"],
    notify() {},
  });

  (app as any).diffViewMode = diffViewMode;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await Promise.resolve();
    if ((app as any).getEntry((app as any).state.activeFileId, "git-diff")?.status === "ready") break;
  }
  const entry = (app as any).getEntry((app as any).state.activeFileId, "git-diff");
  if (entry?.status !== "ready") throw new Error("Benchmark diff did not finish loading");
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

let renderedCells = 0;
function consumeRender(app: ReviewApp, width: number): void {
  const lines = app.render(width);
  if (lines.length === 0) throw new Error("Empty benchmark render");
  for (const line of lines) renderedCells = (renderedCells + line.length) | 0;
}

for (const mode of ["unified", "side-by-side"] as const) {
  for (const count of [200, 20_000]) {
    const app = await createApp(count, mode, true);
    describe(`${mode} / ${count} lines / rendering`, () => {
      bench("scroll selection down and back", () => {
        for (let i = 0; i < 40; i++) {
          app.handleInput("\u001b[B");
          consumeRender(app, 120);
        }
        for (let i = 0; i < 40; i++) {
          app.handleInput("\u001b[A");
          consumeRender(app, 120);
        }
      });
      bench("resize between stacked and wide layouts", () => {
        consumeRender(app, 80);
        consumeRender(app, 160);
        consumeRender(app, 120);
      });
    });
  }
}

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
