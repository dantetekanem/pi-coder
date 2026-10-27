import { describe, expect, it, vi } from "vitest";
import type { ChangeStatus, ReviewFile } from "../types.js";
import { stripTerminalSequences } from "../ui/mouse-selection.js";
import { ReviewApp, shortenNavigatorPath } from "../ui/review-app.js";

describe("navigator path shortening", () => {
  it("keeps short paths intact", () => {
    expect(shortenNavigatorPath("src/index.ts", 20)).toBe("src/index.ts");
  });

  it("preserves the basename when truncating", () => {
    expect(shortenNavigatorPath("src/ui/components/review-app.ts", 18)).toBe("…/review-app.ts");
  });

  it("keeps as much trailing path context as fits", () => {
    expect(shortenNavigatorPath("src/ui/components/review-app.ts", 28)).toBe("…/components/review-app.ts");
  });

  it("keeps both ends of a long file name so a test stays distinct from its implementation", () => {
    expect(shortenNavigatorPath("messaging/app/mailers/messages_mailer.rb", 18)).toBe("messages_mailer.rb");
    expect(shortenNavigatorPath("messaging/test/mailers/messages_mailer_test.rb", 18)).toBe("messages_…_test.rb");
    expect(shortenNavigatorPath("order_confirmation_mailer_test.rb", 17)).toBe("order_co…_test.rb");
  });
});

describe("navigator rendering", () => {
  const RGB: Record<string, number[]> = { text: [200, 200, 200], success: [0, 200, 0], warning: [200, 100, 0], error: [200, 0, 0], mdLink: [0, 100, 200] };

  function makeFile(path: string, status: ChangeStatus, additions: number, deletions: number): ReviewFile {
    return {
      id: `${path}::working::::`,
      path,
      worktreeStatus: status,
      hasWorkingTreeFile: status !== "deleted",
      inGitDiff: true,
      inLastCommit: false,
      inAllFiles: false,
      gitDiff: { status, oldPath: path, newPath: path, displayPath: path, hasOriginal: status !== "added", hasModified: status !== "deleted", additions, deletions },
      lastCommit: null,
      allFiles: null,
    };
  }

  async function renderNavigator(getFgAnsi: (color: string) => string): Promise<string[]> {
    const files = [
      makeFile("README.md", "modified", 1, 0),
      makeFile("app/models/legacy.rb", "deleted", 0, 20),
      makeFile("test/models/user_test.rb", "modified", 30, 0),
      makeFile("app/models/user.rb", "modified", 12, 3),
      makeFile("app/models/order.rb", "added", 140, 0),
    ];
    const loadFileContents = vi.fn(async () => ({ originalContent: "old\n", modifiedContent: "new\n" }));
    const theme = {
      fg: (color: string, text: string) => `\x1b[38;5;${color.length}m${text}\x1b[39m`,
      bg: (_color: string, text: string) => text,
      getFgAnsi,
    };
    const tui = { mode: "regular", terminal: { write: vi.fn(), rows: 30, columns: 120 }, requestRender: vi.fn(), getShowHardwareCursor: vi.fn(() => false), setShowHardwareCursor: vi.fn() };
    const app = new ReviewApp(tui as never, theme as never, vi.fn(), { files, repoRoot: "/repo", loadFileContents, commentShortcuts: [], visibleScopes: ["git-diff"], notify: vi.fn() });
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());
    const lines = (app as any).renderNavigator(40, 14) as string[];
    app.dispose();
    return lines.slice(1, -1).map((line) => line.slice(line.indexOf("│") + 1, line.lastIndexOf("│")));
  }

  it("pads rows, spaces folders apart and aligns change counts", async () => {
    const rows = await renderNavigator(() => "");

    expect(stripTerminalSequences(rows[0]!).trimEnd()).toBe(" 5 files - +183/-23");
    expect(rows.slice(2, 10).map((row) => stripTerminalSequences(row).trimEnd())).toEqual([
      "   app/",
      " › A models/order.rb      +140  -0  ·",
      "   M models/user.rb        +12  -3  ·",
      "   M …/user_test.rb        +30  -0  ·",
      "   D models/legacy.rb       +0 -20  ·",
      "",
      "   root/",
      "   M README.md              +1  -0  ·",
    ]);
  });

  it("colors each status with a soft mix of the theme color and body text", async () => {
    const rows = await renderNavigator((color) => `\x1b[38;2;${(RGB[color] ?? [9, 9, 9]).join(";")}m`);
    const added = "\x1b[38;2;80;200;80m";
    const modified = "\x1b[38;2;200;140;80m";
    const deleted = "\x1b[38;2;200;80;80m";

    expect(rows[0]).toContain(`${added}+183\x1b[39m`);
    expect(rows[0]).toContain(`${deleted}-23\x1b[39m`);
    expect(rows[3]).toContain(`${added}A\x1b[39m`);
    expect(rows[3]).toContain(`${added}+140\x1b[39m`);
    expect(rows[3]).toContain("\x1b[38;5;6mmodels/order.rb\x1b[39m");
    expect(rows[4]).toContain(`${modified}M\x1b[39m`);
    expect(rows[4]).toContain("\x1b[38;5;4mmodels/user.rb\x1b[39m");
    expect(rows[4]).toContain(`${deleted} -3\x1b[39m`);
    expect(rows[6]).toContain(`${deleted}D\x1b[39m`);
  });

  it("keeps the theme's own status colors without truecolor", async () => {
    const rows = await renderNavigator(() => "\x1b[38;5;2m");

    expect(rows[3]).toContain("\x1b[38;5;7mA\x1b[39m");
    expect(rows[4]).toContain("\x1b[38;5;7mM\x1b[39m");
  });
});
