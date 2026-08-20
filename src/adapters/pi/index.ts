import { copyToClipboard, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { createWorkbench } from "../../workbench/app.js";
import { type TargetOpenResult, type Workbench, type WorkbenchCompletionResult, type WorkbenchLaunch, type WorkbenchRepository } from "../../workbench/contracts.js";
import { cleanupWorkbench, formatTargetOpenIssue } from "../../workbench/host-boundary.js";
import { processExplorerStateStore, type ExplorerStateSession } from "../../workbench/explorer-state.js";
import { createNodeWorkspace } from "../../workbench/node/workspace.js";
import { normalizeWorkbenchLaunch } from "../../workbench/target.js";
import { fullScreenOverlayOptions } from "../../ui/full-screen-overlay.js";
import { createWorkbenchComponent, type WorkbenchTheme } from "../../workbench/ui/component.js";

function mapPiTheme(theme: Theme): WorkbenchTheme {
  return {
    fg: (color, text) => theme.fg(color, text),
    bg: (color, text) => theme.bg(color, text),
    searchMatch: (text, current) => {
      const yellow = theme.bold(theme.fg("warning", text));
      return current ? theme.inverse(yellow) : yellow;
    },
  };
}

export interface PiWorkbenchRunOptions {
  cwd: string;
  launch: WorkbenchLaunch;
  syntaxTheme?: string;
}

type StartupIssueLevel = "warning" | "error";

export interface PiWorkbenchRunnerDependencies {
  createRepository(cwd: string, syntaxTheme?: string): Promise<WorkbenchRepository>;
  createWorkbench(repository: WorkbenchRepository): Workbench;
  explorerStateForWorkspace(workspaceKey: string | undefined): ExplorerStateSession | undefined;
  createComponent: typeof createWorkbenchComponent;
  copyText?(text: string): Promise<void>;
  reportStartupIssue?(message: string, level: StartupIssueLevel): void;
}

const defaultDependencies: PiWorkbenchRunnerDependencies = {
  createRepository: createNodeWorkspace,
  createWorkbench,
  explorerStateForWorkspace: (workspaceKey) => processExplorerStateStore.forWorkspace(workspaceKey),
  createComponent: createWorkbenchComponent,
  copyText: copyToClipboard,
};

interface PiKeybindingsLike {
  matches(data: string, keybinding: string): boolean;
}

/**
 * Pi owns terminal decoding and keybinding state. The workbench uses its own
 * pi-tui dependency, so canonicalize host Enter events before crossing the
 * overlay boundary instead of relying on that dependency's module-global Kitty state.
 */
function normalizePiInput(data: string, keybindings: PiKeybindingsLike): string {
  if (keybindings.matches(data, "tui.input.submit")) return "\r";
  if (keybindings.matches(data, "tui.input.newLine")) return "\x1b[13;2u";
  // A direct TUI boundary test or host adapter can still deliver a CR/LF pair as one chunk.
  if (data === "\r\n" || data === "\n\r") return "\r";
  return data;
}

const bracketedPasteStart = "\x1b[200~";
const bracketedPasteEnd = "\x1b[201~";

type PiInputSink = (data: string) => void;

/**
 * Normalize host key events while keeping bracketed paste opaque to host keybindings.
 * Pi delivers complete paste framing at the overlay boundary; payload chunks are handed
 * directly to the editor's own bounded paste buffer until the complete end marker arrives.
 */
function createPiInputNormalizer(keybindings: PiKeybindingsLike): (data: string, sink: PiInputSink) => void {
  let inPaste = false;

  const emitNormal = (data: string, sink: PiInputSink): void => {
    let offset = 0;
    let segmentStart = 0;
    while (offset < data.length) {
      const pair = data.slice(offset, offset + 2);
      if (pair === "\r\n" || pair === "\n\r") {
        if (segmentStart < offset) sink(normalizePiInput(data.slice(segmentStart, offset), keybindings));
        sink(normalizePiInput(pair, keybindings));
        offset += 2;
        segmentStart = offset;
      } else if (data[offset] === "\r" || data[offset] === "\n") {
        if (segmentStart < offset) sink(normalizePiInput(data.slice(segmentStart, offset), keybindings));
        sink(normalizePiInput(data[offset]!, keybindings));
        offset += 1;
        segmentStart = offset;
      } else {
        offset += 1;
      }
    }
    if (segmentStart < data.length) sink(normalizePiInput(data.slice(segmentStart), keybindings));
  };

  const consumePaste = (data: string, sink: PiInputSink): void => {
    const markerIndex = data.indexOf(bracketedPasteEnd);
    if (markerIndex < 0) {
      sink(data);
      return;
    }
    if (markerIndex > 0) sink(data.slice(0, markerIndex));
    sink(bracketedPasteEnd);
    inPaste = false;
    const remaining = data.slice(markerIndex + bracketedPasteEnd.length);
    if (remaining.length > 0) consumeNormal(remaining, sink);
  };

  function consumeNormal(data: string, sink: PiInputSink): void {
    const markerIndex = data.indexOf(bracketedPasteStart);
    if (markerIndex < 0) {
      emitNormal(data, sink);
      return;
    }
    if (markerIndex > 0) emitNormal(data.slice(0, markerIndex), sink);
    sink(bracketedPasteStart);
    inPaste = true;
    const remaining = data.slice(markerIndex + bracketedPasteStart.length);
    if (remaining.length > 0) consumePaste(remaining, sink);
  }

  return (data, sink): void => {
    if (data.length === 0) return;
    if (inPaste) consumePaste(data, sink);
    else consumeNormal(data, sink);
  };
}

interface PiMountedComponent {
  focused: boolean;
  handleInput(data: string): void;
  render(width: number): string[];
  invalidate(): void;
}

function mountPiComponent(
  component: ReturnType<typeof createWorkbenchComponent>,
  keybindings: PiKeybindingsLike,
): PiMountedComponent {
  const normalizeInput = createPiInputNormalizer(keybindings);
  return {
    get focused() { return component.focused; },
    set focused(value: boolean) { component.focused = value; },
    handleInput(data: string): void {
      normalizeInput(data, (normalized) => component.handleInput(normalized));
    },
    render(width: number): string[] { return component.render(width); },
    invalidate(): void { component.invalidate(); },
  };
}

function reportTargetOpenIssue(result: TargetOpenResult, report: (message: string, level: StartupIssueLevel) => void): void {
  if (result.status === "opened" && result.message == null) return;
  report(formatTargetOpenIssue(result), result.status === "unreadable" ? "error" : "warning");
}

function failed(error: unknown, code?: string): WorkbenchCompletionResult {
  const errorCode = code ?? (typeof error === "object" && error != null && "code" in error && typeof error.code === "string" ? error.code : undefined);
  return {
    status: "failed",
    message: error instanceof Error ? error.message : String(error),
    ...(errorCode == null ? {} : { code: errorCode }),
  };
}

/** Pi overlay lifecycle owner. It never stages prompts or sends agent messages. */
export async function runPiWorkbench(
  ctx: ExtensionContext,
  options: PiWorkbenchRunOptions,
  dependencies: PiWorkbenchRunnerDependencies = defaultDependencies,
): Promise<WorkbenchCompletionResult> {
  if (!ctx.hasUI) return { status: "failed", code: "PI_TUI_REQUIRED", message: "The code workbench requires a TUI session." };

  let workbench: Workbench | undefined;
  let outcome: WorkbenchCompletionResult | undefined;
  let failure: WorkbenchCompletionResult | undefined;
  try {
    const launch = normalizeWorkbenchLaunch(options.launch);
    const repository = await dependencies.createRepository(options.cwd, options.syntaxTheme);
    const explorerState = dependencies.explorerStateForWorkspace(repository.workspaceKey);
    workbench = dependencies.createWorkbench(repository);
    await workbench.start();
    const reportStartupIssue = dependencies.reportStartupIssue ?? ((message: string, level: StartupIssueLevel) => ctx.ui.notify(message, level));
    if (launch.initialTarget != null) {
      const opened = await workbench.openTarget(launch.initialTarget);
      reportTargetOpenIssue(opened, reportStartupIssue);
    }
    outcome = await ctx.ui.custom<WorkbenchCompletionResult>(
      (tui, theme, keybindings, done) => {
        const component = dependencies.createComponent(tui, mapPiTheme(theme), workbench!, done, explorerState, launch, {
          writeText: dependencies.copyText ?? copyToClipboard,
        });
        return mountPiComponent(component, keybindings as unknown as PiKeybindingsLike);
      },
      fullScreenOverlayOptions,
    );
  } catch (error) {
    failure = failed(error);
  } finally {
    const cleanupErrors = cleanupWorkbench(workbench);
    if (outcome?.status === "failed") return outcome;
    if (failure == null && cleanupErrors.length > 0) {
      failure = failed(new AggregateError(cleanupErrors, "Pi code workbench cleanup failed."), "PI_WORKBENCH_CLEANUP_FAILED");
    }
  }

  return failure ?? outcome ?? { status: "failed", code: "PI_WORKBENCH_NO_OUTCOME", message: "Pi code workbench closed without an outcome." };
}
