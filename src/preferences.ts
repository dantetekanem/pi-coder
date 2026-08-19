import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getShortcutConfigPath } from "./shortcuts.js";

export type PersistedDiffViewMode = "unified" | "side-by-side";

export type PersistedNavigatorFileOrder = "risk" | "alphabetical";

export type PersistedReviewVerdict = "approve" | "request_changes" | "comment";

export interface ReviewPaneVisibility {
  navigator: boolean;
  diff: boolean;
  comments: boolean;
  context: boolean;
  replies: boolean;
}

export interface ReviewPreferences {
  diffViewMode: PersistedDiffViewMode;
  navigatorTreeMode: boolean;
  navigatorFileOrder: PersistedNavigatorFileOrder;
  contextLineNavigation: boolean;
  commentsGlobal: boolean;
  paneVisibility: ReviewPaneVisibility;
  lastReviewVerdict: PersistedReviewVerdict | null;
}

export const DEFAULT_REVIEW_PANE_VISIBILITY: ReviewPaneVisibility = {
  navigator: true,
  diff: true,
  comments: true,
  context: true,
  replies: true,
};

export const DEFAULT_REVIEW_PREFERENCES: ReviewPreferences = {
  diffViewMode: "unified",
  navigatorTreeMode: true,
  navigatorFileOrder: "risk",
  contextLineNavigation: false,
  commentsGlobal: false,
  paneVisibility: DEFAULT_REVIEW_PANE_VISIBILITY,
  lastReviewVerdict: null,
};

function getPreferencesPath(): string {
  return process.env.PI_CODE_DIFF_PREFERENCES_PATH ?? join(dirname(getShortcutConfigPath()), "code-diff-preferences.json");
}

function isPersistedDiffViewMode(value: unknown): value is PersistedDiffViewMode {
  return value === "unified" || value === "side-by-side";
}

function isPersistedNavigatorFileOrder(value: unknown): value is PersistedNavigatorFileOrder {
  return value === "risk" || value === "alphabetical";
}

function isPersistedReviewVerdict(value: unknown): value is PersistedReviewVerdict {
  return value === "approve" || value === "request_changes" || value === "comment";
}

function defaultReviewPreferences(): ReviewPreferences {
  return {
    ...DEFAULT_REVIEW_PREFERENCES,
    paneVisibility: { ...DEFAULT_REVIEW_PANE_VISIBILITY },
  };
}

function loadPaneVisibility(value: unknown): ReviewPaneVisibility {
  const record = value != null && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    navigator: typeof record.navigator === "boolean" ? record.navigator : DEFAULT_REVIEW_PANE_VISIBILITY.navigator,
    diff: typeof record.diff === "boolean" ? record.diff : DEFAULT_REVIEW_PANE_VISIBILITY.diff,
    comments: typeof record.comments === "boolean" ? record.comments : DEFAULT_REVIEW_PANE_VISIBILITY.comments,
    context: typeof record.context === "boolean" ? record.context : DEFAULT_REVIEW_PANE_VISIBILITY.context,
    replies: typeof record.replies === "boolean" ? record.replies : DEFAULT_REVIEW_PANE_VISIBILITY.replies,
  };
}

export function loadReviewPreferences(): ReviewPreferences {
  const path = getPreferencesPath();
  if (!existsSync(path)) return defaultReviewPreferences();

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (parsed == null || typeof parsed !== "object") return defaultReviewPreferences();
    const record = parsed as Record<string, unknown>;
    return {
      diffViewMode: isPersistedDiffViewMode(record.diffViewMode) ? record.diffViewMode : DEFAULT_REVIEW_PREFERENCES.diffViewMode,
      navigatorTreeMode: typeof record.navigatorTreeMode === "boolean" ? record.navigatorTreeMode : DEFAULT_REVIEW_PREFERENCES.navigatorTreeMode,
      navigatorFileOrder: isPersistedNavigatorFileOrder(record.navigatorFileOrder) ? record.navigatorFileOrder : DEFAULT_REVIEW_PREFERENCES.navigatorFileOrder,
      lastReviewVerdict: isPersistedReviewVerdict(record.lastReviewVerdict) ? record.lastReviewVerdict : DEFAULT_REVIEW_PREFERENCES.lastReviewVerdict,
      contextLineNavigation: typeof record.contextLineNavigation === "boolean" ? record.contextLineNavigation : DEFAULT_REVIEW_PREFERENCES.contextLineNavigation,
      commentsGlobal: typeof record.commentsGlobal === "boolean" ? record.commentsGlobal : DEFAULT_REVIEW_PREFERENCES.commentsGlobal,
      paneVisibility: loadPaneVisibility(record.paneVisibility),
    };
  } catch {
    return defaultReviewPreferences();
  }
}

export function saveReviewPreference(patch: Partial<ReviewPreferences>): void {
  const path = getPreferencesPath();
  const current = loadReviewPreferences();
  const next: ReviewPreferences = {
    ...current,
    ...patch,
    paneVisibility: patch.paneVisibility == null
      ? current.paneVisibility
      : { ...current.paneVisibility, ...patch.paneVisibility },
  };

  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  } catch {
    // Preference persistence is best-effort; never block review UI on disk writes.
  }
}

export function getReviewPreferencesPathForDiagnostics(): string {
  return getPreferencesPath();
}

// Re-export getAgentDir so callers do not need a second import solely for diagnostics.
export { getAgentDir };

export function preferencesConfigPath(): string {
  return getShortcutConfigPath();
}
