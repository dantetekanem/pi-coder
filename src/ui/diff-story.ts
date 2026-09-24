import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { createStorySnapshot, validateSavedDiffStory, type DiffStory, type StoryFile, type StorySnapshot } from "../diff-story/plan.js";
import { createStoryAgentGenerator } from "../diff-story/agent.js";
import type { StoryAgentActivity } from "../diff-story/activity.js";
import { generateDiffStory, type DiffStoryGenerate } from "../diff-story/generate.js";
import type { StorySessionData } from "../diff-story/navigation.js";
import { filterReviewFilesByLocale } from "../locale-files.js";
import { loadReviewPreferences, saveReviewPreference } from "../preferences.js";
import { validateReviewAgent } from "../review-agent.js";
import { sanitizeTerminalText } from "../sanitize.js";
import { getReviewFileDisplayPath, type ReviewFile, type ReviewFileContents, type ReviewScope } from "../types.js";
import { edgeToEdgeOverlayOptions } from "./full-screen-overlay.js";
import { StoryOutputCarousel } from "./story-output.js";

const RUNNING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface PreparedDiffStory {
  plan: DiffStory;
  snapshot: StorySnapshot;
}

export async function selectStoryAgent(ctx: ExtensionContext): Promise<void> {
  const models = ctx.modelRegistry.getAvailable();
  const labels = models.map((model) => `${model.provider}/${model.id}`);
  const selected = await ctx.ui.select("Story agent (independent of this conversation)", labels);
  const model = selected == null ? undefined : models[labels.indexOf(selected)];
  if (model == null) return;

  const levels = Object.entries(model.thinkingLevelMap ?? {})
    .filter(([, value]) => value != null)
    .map(([level]) => level);
  if (levels.length === 0) {
    ctx.ui.notify("This model does not advertise exact thinking levels.", "warning");
    return;
  }
  const thinking = await ctx.ui.select("Story thinking level (no automatic downgrade)", levels);
  if (thinking == null) return;

  const selection = { provider: model.provider, model: model.id, thinking };
  validateReviewAgent(ctx, selection);
  saveReviewPreference({ storyAgent: selection });
  const saved = loadReviewPreferences().storyAgent;
  if (saved.provider !== selection.provider || saved.model !== selection.model || saved.thinking !== selection.thinking) {
    ctx.ui.notify("Could not save the story agent. The previous model selection is still in use.", "error");
    return;
  }
  ctx.ui.notify(`Story agent: ${selected} · ${thinking}`, "info");
}

export function prepareDiffStory(
  ctx: ExtensionContext,
  files: ReviewFile[],
  scope: ReviewScope,
  load: (file: ReviewFile, scope: ReviewScope) => Promise<ReviewFileContents>,
  saved?: StorySessionData,
  generate?: DiffStoryGenerate,
): Promise<PreparedDiffStory | "diff" | undefined> {
  const selection = loadReviewPreferences().storyAgent;
  const storyFiles = filterReviewFilesByLocale(files, false);
  const hiddenLocales = files.length - storyFiles.length;
  const localeNote = hiddenLocales === 0 ? "" : ` · ${hiddenLocales} locale${hiddenLocales === 1 ? "" : "s"} hidden`;
  return ctx.ui.custom((tui, theme, _keys, done) => {
    const abort = new AbortController();
    let settled = false;
    let phase = "Preparing captured diff";
    let counts = `${storyFiles.length} selected files${localeNote}`;
    let error: string | undefined;
    let stale = false;
    let snapshot: StorySnapshot | undefined;
    let startedAt = Date.now();
    const carousel = new StoryOutputCarousel();
    let frame = 0;
    const animate = () => setInterval(() => {
      frame = (frame + 1) % RUNNING_FRAMES.length;
      tui.requestRender();
    }, 80);
    let timer = animate();
    const finish = (value: PreparedDiffStory | "diff" | undefined) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      carousel.clear();
      abort.abort();
      done(value);
    };
    const update = (value: string) => {
      if (settled) return;
      phase = value;
      tui.requestRender();
    };
    const construct = async () => {
      error = undefined;
      stale = false;
      phase = "Preparing story agent";
      carousel.clear();
      startedAt = Date.now();
      clearInterval(timer);
      timer = animate();
      let acceptingOutput = true;
      try {
        const generator = generate ?? createStoryAgentGenerator(ctx, selection, (activity: StoryAgentActivity) => {
          if (settled || !acceptingOutput) return;
          carousel.addActivity(activity);
          tui.requestRender();
        });
        const plan = await generateDiffStory(snapshot!, generator, abort.signal, (progress) => {
          update(progress === "Generating story" ? "Constructing storyline and connecting changed tests" : progress);
        });
        if (!settled) finish({ plan, snapshot: snapshot! });
      } catch (failure) {
        if (settled) return;
        error = sanitizeTerminalText(failure instanceof Error ? failure.message : String(failure));
        clearInterval(timer);
        carousel.clear();
        update("Story could not be prepared");
      } finally {
        acceptingOutput = false;
      }
    };

    queueMicrotask(async () => {
      if (storyFiles.length === 0 && hiddenLocales > 0) {
        error = "This change only touches non-English/non-pt-BR locale files, which stories skip.";
        clearInterval(timer);
        update("No story to build");
        return;
      }
      try {
        const captured: StoryFile[] = [];
        for (const file of storyFiles) {
          if (settled) return;
          update(`Reading ${captured.length + 1} of ${storyFiles.length} files · ${sanitizeTerminalText(file.path)}`);
          const comparison = scope === "git-diff" ? file.gitDiff : scope === "last-commit" ? file.lastCommit : file.allFiles;
          captured.push({
            fileId: file.id,
            path: getReviewFileDisplayPath(file, scope),
            scope,
            contents: await load(file, scope),
            hasOriginal: comparison?.hasOriginal,
            hasModified: comparison?.hasModified,
          });
        }
        if (settled) return;
        snapshot = createStorySnapshot(captured);
        counts = `${snapshot.files.length} files · +${snapshot.additions} −${snapshot.deletions} lines changed${localeNote}`;
        if (saved != null) {
          try {
            finish({ snapshot, plan: validateSavedDiffStory(saved.plan, snapshot) });
            return;
          } catch {
            stale = true;
            clearInterval(timer);
            carousel.clear();
            error = "Saved story no longer matches these exact bytes. Comments and discussion history are retained.";
            update("Story needs rebuilding");
            return;
          }
        }
        await construct();
      } catch (failure) {
        if (settled) return;
        error = sanitizeTerminalText(failure instanceof Error ? failure.message : String(failure));
        clearInterval(timer);
        carousel.clear();
        update("Diff could not be captured");
      }
    });

    return {
      handleInput(data: string) {
        if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) finish(undefined);
        else if (error && data === "f") finish("diff");
        else if (error && snapshot != null && data === "r") void construct();
        else if (!error && data === " ") {
          carousel.togglePaused();
          tui.requestRender();
        }
      },
      render(width: number) {
        const height = Math.max(1, tui.terminal.rows);
        const center = (text: string) => {
          const clipped = truncateToWidth(text, Math.max(1, width - 4), "…");
          const remaining = Math.max(0, width - visibleWidth(clipped));
          const left = Math.floor(remaining / 2);
          return `${" ".repeat(left)}${clipped}${" ".repeat(remaining - left)}`;
        };
        const indicator = error ? "" : `${RUNNING_FRAMES[frame]} `;
        const seconds = Math.floor((Date.now() - startedAt) / 1000);
        const elapsed = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
        const activity = carousel.paused ? "Preview paused · agent still running"
          : carousel.hasActivity ? "Receiving agent activity" : "Waiting for agent activity";
        const retry = stale ? "r rebuild · " : snapshot != null ? "r retry · " : "";
        const controls = error
          ? `${retry}f ordinary diff · Esc cancel`
          : "Read-only · Space pause/resume motion · Esc cancel";
        const lines = [
          theme.fg("accent", `${indicator}${phase}`),
          "",
          counts,
          `${selection.provider}/${selection.model} · ${selection.thinking}`,
          ...(error ? ["", theme.fg("warning", error)] : [theme.fg("dim", `${activity} · ${elapsed}`)]),
          "",
          controls,
        ];
        const showCarousel = !error && !settled && height >= 18;
        const maxTop = showCarousel ? height - lines.length - 7 : height;
        const top = Math.max(0, Math.min(Math.floor((height - lines.length) / 2), maxTop));
        const rows = Array.from({ length: height }, (_, row) => center(lines[row - top] ?? ""));
        if (showCarousel) {
          const feed = carousel.render(width, theme);
          rows.splice(height - feed.length - 1, feed.length, ...feed);
        }
        return rows;
      },
      invalidate() {},
      dispose() {
        settled = true;
        clearInterval(timer);
        carousel.clear();
        abort.abort();
      },
    };
  }, edgeToEdgeOverlayOptions);
}
