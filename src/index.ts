import { copyToClipboard, getAgentDir, getLanguageFromPath, highlightCode, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createPiCoderEngine, notifyShortcutWarnings } from "./engine.js";
import { RepositoryChangeStatusController } from "./git-change-status.js";
import type { ExternalEditorLauncher, PiCoderCommandResult } from "./host/engine.js";
import { configureRuntime } from "./host/runtime.js";
import type { HostContext } from "./host/types.js";
import { toHostContext } from "./pi/context.js";
import { loadCommentShortcuts } from "./shortcuts.js";
import { PI_CODER_TOOLS } from "./tool-definitions.js";

export {
  buildReviewEndActions,
  composeRemoteDiscussionPrompt,
  composeRemoteReviewPrompt,
  composeReviewSubmissionPrompt,
  mergeReviewBodies,
  runExternalEditor,
  submitUiConfirmedReview,
  type ExternalEditorLauncher,
  type ExternalEditorOutcome,
  type ReviewEndAction,
} from "./engine.js";

const REPOSITORY_MUTATION_TOOL_NAMES = new Set(["bash", "edit", "write"]);
const REPOSITORY_MUTATION_REFRESH_DELAY_MS = 250;

function getReviewArgumentCompletions(prefix: string) {
  const normalized = prefix.trimStart().toLowerCase();
  if (!normalized.includes(" ")) {
    return "fullscreen".startsWith(normalized)
      ? [{ value: "fullscreen", label: "fullscreen" }]
      : null;
  }

  const match = normalized.match(/^fullscreen\s+(\S*)$/);
  if (match == null) return null;
  const valuePrefix = match[1]!;
  const items = ["on", "off"]
    .filter((value) => value.startsWith(valuePrefix))
    .map((value) => ({ value: `fullscreen ${value}`, label: value }));
  return items.length > 0 ? items : null;
}

export default function codeDiffExtension(pi: ExtensionAPI, options: { runExternalEditor?: ExternalEditorLauncher } = {}) {
  configureRuntime({
    agentDir: getAgentDir,
    copyText: copyToClipboard,
    highlightLine: (text, language) => highlightCode(text, language)[0] ?? text,
    languageForPath: getLanguageFromPath,
  });
  const initialShortcutConfig = loadCommentShortcuts();
  const repositoryChangeStatus = new RepositoryChangeStatusController();
  let toolStatusRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let toolStatusRefreshContext: ExtensionContext | null = null;
  let toolStatusRefreshInFlight: Promise<void> | null = null;
  let toolStatusRefreshImmediate = false;
  let toolStatusRefreshStopped = false;
  let sawRepositoryMutationTool = false;

  function armToolStatusRefresh(delayMs: number): void {
    if (toolStatusRefreshTimer != null) clearTimeout(toolStatusRefreshTimer);
    toolStatusRefreshTimer = setTimeout(runToolStatusRefresh, delayMs);
  }

  function runToolStatusRefresh(): void {
    toolStatusRefreshTimer = null;
    if (toolStatusRefreshStopped || toolStatusRefreshInFlight != null || toolStatusRefreshContext == null) return;
    const ctx = toolStatusRefreshContext;
    toolStatusRefreshContext = null;
    toolStatusRefreshImmediate = false;
    const refresh = repositoryChangeStatus.refresh(ctx);
    toolStatusRefreshInFlight = refresh;
    const settled = () => {
      if (toolStatusRefreshInFlight !== refresh) return;
      toolStatusRefreshInFlight = null;
      if (toolStatusRefreshStopped || toolStatusRefreshContext == null) return;
      armToolStatusRefresh(toolStatusRefreshImmediate ? 0 : REPOSITORY_MUTATION_REFRESH_DELAY_MS);
    };
    void refresh.then(settled, settled);
  }

  function scheduleToolStatusRefresh(ctx: ExtensionContext): void {
    if (toolStatusRefreshStopped || !ctx.hasUI) return;
    toolStatusRefreshContext = ctx;
    if (toolStatusRefreshInFlight == null) armToolStatusRefresh(REPOSITORY_MUTATION_REFRESH_DELAY_MS);
  }

  function flushToolStatusRefresh(ctx: ExtensionContext): void {
    if (toolStatusRefreshStopped || !ctx.hasUI || toolStatusRefreshContext == null) return;
    toolStatusRefreshContext = ctx;
    toolStatusRefreshImmediate = true;
    if (toolStatusRefreshInFlight == null) armToolStatusRefresh(0);
  }

  function stopToolStatusRefresh(): void {
    toolStatusRefreshStopped = true;
    if (toolStatusRefreshTimer != null) clearTimeout(toolStatusRefreshTimer);
    toolStatusRefreshTimer = null;
    toolStatusRefreshContext = null;
    toolStatusRefreshImmediate = false;
  }

  const engine = createPiCoderEngine(pi, {
    runExternalEditor: options.runExternalEditor,
    onRunSettled: (ctx) => {
      void repositoryChangeStatus.refresh(ctx);
    },
  });

  function stageReviewPrompt(ctx: HostContext, result: PiCoderCommandResult): void {
    if (result.prompt == null) return;
    ctx.ui.setEditorText(result.prompt);
    ctx.ui.notify("Inserted review feedback into the editor.", "info");
  }

  function runDetached(ctx: HostContext, run: Promise<PiCoderCommandResult>): void {
    void run.then((result) => stageReviewPrompt(ctx, result)).catch((error) => {
      ctx.ui.notify(`Could not start review: ${error instanceof Error ? error.message : String(error)}`, "error");
    });
  }

  const reviewCommand = {
    description: "Review and annotate code changes. /diff or /review (local), remote <url | branch>, base..head, or fullscreen on|off",
    getArgumentCompletions: getReviewArgumentCompletions,
    handler: async (args: string, ctx: ExtensionContext) => {
      const host = toHostContext(pi, ctx);
      if (args.trim().split(/\s+/)[0]?.toLowerCase() === "fullscreen") {
        await engine.diff(args, host);
        return;
      }
      runDetached(host, engine.diff(args, host));
    },
  };

  const codeCommand = {
    description: "Browse repository files, or open /code <path> directly in INSERT mode. Use /code syntax to choose a Shiki theme. Structured options: --path, --line, --end-line, --anchor-sha256, --story-json.",
    getArgumentCompletions: (prefix: string) => "syntax".startsWith(prefix)
      ? [{ value: "syntax", label: "syntax" }]
      : null,
    handler: async (args: string, ctx: ExtensionContext) => {
      const host = toHostContext(pi, ctx);
      const result = await engine.code(args, host);
      if (result.workbench?.status === "discuss" && result.prompt != null) {
        host.ui.setEditorText(result.prompt);
        host.ui.notify("Inserted code discussion into the editor.", "info");
      }
    },
  };

  pi.registerCommand("code", codeCommand);
  pi.registerCommand("diff", reviewCommand);
  pi.registerCommand("review", reviewCommand);
  pi.registerCommand("diff-story", {
    description: "Follow a change as a linked code/test story. Same targets as /diff; agent selects the independent model/thinking.",
    handler: async (args, ctx) => {
      const host = toHostContext(pi, ctx);
      if (args.trim() === "agent") {
        await engine.diffStory(args, host);
        return;
      }
      runDetached(host, engine.diffStory(args, host));
    },
  });

  for (const tool of PI_CODER_TOOLS) {
    pi.registerTool({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      promptSnippet: tool.promptSnippet,
      promptGuidelines: tool.promptGuidelines,
      parameters: tool.parameters,
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const result = await engine.runTool(tool.name, params, toHostContext(pi, ctx), signal);
        return { content: [{ type: "text" as const, text: result.text }], details: result.details };
      },
    });
  }

  pi.registerShortcut(initialShortcutConfig.globalShortcut, {
    description: "Open review UI",
    handler: async (ctx) => {
      const host = toHostContext(pi, ctx);
      stageReviewPrompt(host, await engine.diff("", host));
    },
  });

  pi.on("session_start", async (event, ctx) => {
    if (event.reason === "startup" || event.reason === "reload") {
      notifyShortcutWarnings(ctx, initialShortcutConfig.warnings);
    }
    void repositoryChangeStatus.refresh(ctx, { clear: true });
  });

  pi.on("tool_execution_end", (event, ctx) => {
    if (!REPOSITORY_MUTATION_TOOL_NAMES.has(event.toolName)) return;
    sawRepositoryMutationTool = true;
    scheduleToolStatusRefresh(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (sawRepositoryMutationTool) {
      sawRepositoryMutationTool = false;
      flushToolStatusRefresh(ctx);
    } else {
      void repositoryChangeStatus.refresh(ctx);
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    engine.shutdown();
    stopToolStatusRefresh();
    await repositoryChangeStatus.shutdown(ctx);
  });
}
