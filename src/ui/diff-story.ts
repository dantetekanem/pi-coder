import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { createStorySnapshot, storyFile, validateSavedDiffStory, type DiffStory, type StoryFile, type StorySnapshot } from "../diff-story/plan.js";
import { createStoryAgentGenerator } from "../diff-story/agent.js";
import type { StoryAgentActivity } from "../diff-story/activity.js";
import { generateFormalStory, type FormalStory, type FormalStoryOptions, type FormalStoryPhase } from "../diff-story/formal.js";
import { generateDiffStory, type DiffStoryGenerate } from "../diff-story/generate.js";
import type { StorySessionData } from "../diff-story/navigation.js";
import type { FormalValidationGuide } from "../formal-validation/guide.js";
import { singleLine } from "../formal-validation/source.js";
import { filterReviewFilesByLocale } from "../locale-files.js";
import { loadReviewPreferences, saveReviewPreference } from "../preferences.js";
import { validateReviewAgent } from "../review-agent.js";
import { sanitizeTerminalText } from "../sanitize.js";
import { formatScopeLabel, type ReviewFile, type ReviewFileContents, type ReviewScope } from "../types.js";
import { edgeToEdgeOverlayOptions } from "./full-screen-overlay.js";
import { StoryOutputCarousel } from "./story-output.js";
import { buildReviewOrientationLines, type ReviewHeaderInfo } from "./review-app.js";

const RUNNING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const FORMAL_PHASES: Record<FormalStoryPhase, string> = {
  "Preparing code and test units": "Preparing code and test units",
  "Writing the validation guide": "Constructing storyline from a validation guide",
  "Reusing the saved validation guide": "Constructing storyline from the saved validation guide",
  "Validating story": "Validating story",
};

export interface PreparedDiffStory {
  plan: DiffStory;
  snapshot: StorySnapshot;
  /** A freshly built story opens on its storyline before the first code step. */
  storylineFirst?: boolean;
  guide?: FormalValidationGuide;
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
  orientation?: { header: ReviewHeaderInfo; brief?: string },
  formal?: Omit<FormalStoryOptions, "model">,
): Promise<PreparedDiffStory | "diff" | undefined> {
  const selection = loadReviewPreferences().storyAgent;
  const model = `${selection.provider}/${selection.model} · ${selection.thinking}`;
  const formalOptions: FormalStoryOptions = {
    ...(formal ?? { target: { kind: "working", label: formatScopeLabel(scope), repoRoot: "", scope } }),
    model,
  };
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
    // A story built from host rules after the guideline model failed; Enter opens it.
    let pending: FormalStory | undefined;
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
    const opened = (story: FormalStory): PreparedDiffStory => ({ plan: story.plan, snapshot: snapshot!, storylineFirst: true, guide: story.guide });
    const construct = async () => {
      error = undefined;
      stale = false;
      pending = undefined;
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
        let story: FormalStory;
        try {
          story = await generateFormalStory(snapshot!, generator, abort.signal, (value) => update(FORMAL_PHASES[value]), formalOptions);
        } catch (failure) {
          if (settled || abort.signal.aborted) throw failure;
          const message = singleLine(failure instanceof Error ? failure.message : String(failure), 300);
          carousel.addActivity({ kind: "error", text: `Formal validation failed: ${message}. Using the plain story order.` });
          const plan = await generateDiffStory(snapshot!, generator, abort.signal, (progress) => {
            update(progress === "Generating story" ? "Constructing storyline and connecting changed tests" : progress);
          });
          if (!settled) finish({ plan: { ...plan, summary: `Formal validation failed (${message}); steps follow the plain story order.` }, snapshot: snapshot!, storylineFirst: true });
          return;
        }
        if (settled) return;
        if (story.guide.refinement.status === "failed") {
          pending = story;
          error = sanitizeTerminalText(`The guideline model failed: ${story.guide.refinement.message ?? "no message"}`);
          clearInterval(timer);
          carousel.clear();
          update("Storyline built from host rules only");
          return;
        }
        finish(opened(story));
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
          captured.push(storyFile(file, scope, await load(file, scope)));
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
        else if (error && pending != null && matchesKey(data, Key.enter)) finish(opened(pending));
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
        const proceed = pending == null ? "" : "Enter continue with host steps · ";
        const controls = error
          ? `${retry}${proceed}f ordinary diff · Esc cancel`
          : "Read-only · Space pause/resume motion · Esc cancel";
        const lines = [
          ...(orientation == null ? [] : buildReviewOrientationLines(theme, Math.max(1, width - 4), orientation.header, {
            files: storyFiles.length,
            reviewed: 0,
            comments: 0,
          }, orientation.brief)),
          theme.fg("accent", `${indicator}${phase}`),
          "",
          counts,
          model,
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
