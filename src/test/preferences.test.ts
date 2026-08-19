import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_REVIEW_PANE_VISIBILITY, DEFAULT_REVIEW_PREFERENCES, loadReviewPreferences, saveReviewPreference } from "../preferences.js";

const originalEnvPath = process.env.PI_CODE_DIFF_PREFERENCES_PATH;
let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-code-diff-prefs-"));
  process.env.PI_CODE_DIFF_PREFERENCES_PATH = join(tempDir, "code-diff-preferences.json");
});

afterEach(async () => {
  if (originalEnvPath == null) delete process.env.PI_CODE_DIFF_PREFERENCES_PATH;
  else process.env.PI_CODE_DIFF_PREFERENCES_PATH = originalEnvPath;
  await rm(tempDir, { recursive: true, force: true });
});

describe("review preferences", () => {
  it("returns defaults when no preferences file exists", () => {
    expect(loadReviewPreferences()).toEqual(DEFAULT_REVIEW_PREFERENCES);
  });

  it("persists review display and navigation preferences across calls", () => {
    saveReviewPreference({
      diffViewMode: "side-by-side",
      navigatorTreeMode: false,
      contextLineNavigation: true,
      commentsGlobal: true,
      paneVisibility: {
        navigator: false,
        diff: true,
        comments: false,
        context: true,
        replies: true,
      },
    });

    expect(loadReviewPreferences()).toEqual({
      diffViewMode: "side-by-side",
      navigatorTreeMode: false,
      navigatorFileOrder: "risk",
      contextLineNavigation: true,
      commentsGlobal: true,
      lastReviewVerdict: null,
      paneVisibility: {
        navigator: false,
        diff: true,
        comments: false,
        context: true,
        replies: true,
      },
    });

    saveReviewPreference({ diffViewMode: "unified" });
    expect(loadReviewPreferences()).toMatchObject({
      diffViewMode: "unified",
      paneVisibility: {
        navigator: false,
        diff: true,
        comments: false,
        context: true,
      },
    });
  });

  it("remembers the navigator file order and the last submitted verdict", () => {
    saveReviewPreference({ navigatorFileOrder: "alphabetical" });
    saveReviewPreference({ lastReviewVerdict: "approve" });

    expect(loadReviewPreferences()).toMatchObject({ navigatorFileOrder: "alphabetical", lastReviewVerdict: "approve" });
  });

  it("falls back to defaults for unknown order and verdict values", async () => {
    await writeFile(process.env.PI_CODE_DIFF_PREFERENCES_PATH!, JSON.stringify({
      navigatorFileOrder: "random",
      lastReviewVerdict: "merge",
    }), "utf8");

    expect(loadReviewPreferences()).toMatchObject({ navigatorFileOrder: "risk", lastReviewVerdict: null });
  });

  it("fills missing pane visibility keys from defaults", async () => {
    await writeFile(process.env.PI_CODE_DIFF_PREFERENCES_PATH!, JSON.stringify({
      paneVisibility: { comments: false },
    }), "utf8");

    expect(loadReviewPreferences().paneVisibility).toEqual({
      ...DEFAULT_REVIEW_PANE_VISIBILITY,
      comments: false,
    });
  });

  it("ignores corrupted preference files and keeps defaults", async () => {
    await writeFile(process.env.PI_CODE_DIFF_PREFERENCES_PATH!, "{ not valid json", "utf8");

    expect(loadReviewPreferences()).toEqual(DEFAULT_REVIEW_PREFERENCES);
  });
});
