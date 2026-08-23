import { access, realpath, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PiWorkbenchOrigin } from "../adapters/pi/coordinator.js";
import { loadPiCodeDiffSettings, type PiCodeDiffSettings } from "../provider-settings.js";
import type { WorkbenchCompletionResult, WorkbenchLaunch } from "../workbench/contracts.js";
import { normalizeWorkbenchLaunch } from "../workbench/target.js";
import { CodeHostError, launchCodeHost, type CodeHostCompletion } from "./hosts.js";
import {
  renderExternalEditorCommand,
  resolveExternalCodeTarget,
  type ResolvedExternalCodeTarget,
} from "./settings.js";

export type ExternalCodeOpenOutcome =
  | { status: "closed"; changes: "unknown" }
  | { status: "failed"; message: string; lifecycle: "not-started" | "closed" | "unconfirmed"; code?: string };

export type CodeOpenResult =
  | { backend: "workbench"; outcome: WorkbenchCompletionResult }
  | { backend: "external"; outcome: ExternalCodeOpenOutcome };

export type CodeOpener = (
  origin: PiWorkbenchOrigin,
  ctx: ExtensionContext,
  cwd: string,
  launch: WorkbenchLaunch,
) => Promise<CodeOpenResult>;

export interface CodeOpenerDependencies {
  loadSettings?: () => PiCodeDiffSettings;
  runWorkbench(ctx: ExtensionContext, cwd: string, launch: WorkbenchLaunch): Promise<WorkbenchCompletionResult>;
  launchHost?: typeof launchCodeHost;
  resolveTarget?: typeof resolveExternalCodeTarget;
  resolveWorkspace?: (cwd: string) => Promise<string>;
  resolveExecutable?: (executable: string) => Promise<string>;
}

function failedExternal(error: unknown, lifecycle: "not-started" | "closed" | "unconfirmed" = "not-started"): CodeOpenResult {
  const hostError = error instanceof CodeHostError ? error : null;
  const message = error instanceof Error ? error.message : String(error);
  return {
    backend: "external",
    outcome: {
      status: "failed",
      message,
      lifecycle: hostError?.lifecycle ?? lifecycle,
      ...(typeof error === "object" && error != null && "code" in error && typeof error.code === "string" ? { code: error.code } : {}),
    },
  };
}

async function defaultResolveWorkspace(cwd: string): Promise<string> {
  const canonical = await realpath(cwd);
  if (!(await stat(canonical)).isDirectory()) throw new Error("External code workspace must be a directory.");
  return canonical;
}

export async function resolveExternalExecutable(
  executable: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (isAbsolute(executable)) {
    const canonical = await realpath(executable);
    await access(canonical, fsConstants.X_OK);
    if (!(await stat(canonical)).isFile()) throw new Error(`External code executable is not a regular file: ${executable}`);
    return canonical;
  }

  const candidates = (env.PATH ?? "")
    .split(delimiter)
    .filter((entry) => entry.length > 0 && isAbsolute(entry));
  for (const directory of candidates) {
    const candidate = join(directory, executable);
    try {
      await access(candidate, fsConstants.X_OK);
      if ((await stat(candidate)).isFile()) return await realpath(candidate);
    } catch {
      // Continue through trusted absolute PATH entries only.
    }
  }
  throw new Error(`External code executable was not found in absolute PATH entries: ${executable}`);
}

function externalStoriesFailure(): CodeOpenResult {
  return {
    backend: "external",
    outcome: {
      status: "failed",
      lifecycle: "not-started",
      message: "Code stories are Workbench-only and cannot be opened by an external editor.",
    },
  };
}

function hasTerminalUi(ctx: ExtensionContext): boolean {
  // Pi <= 0.78 exposes only hasUI; newer Pi also sets hasUI in RPC and exposes mode.
  const mode = (ctx as ExtensionContext & { mode?: unknown }).mode;
  return mode === undefined ? ctx.hasUI : mode === "tui";
}

function completedExternal(completion: CodeHostCompletion): CodeOpenResult {
  if (completion.status === "aborted") {
    return {
      backend: "external",
      outcome: { status: "failed", lifecycle: "closed", message: "External code editor was cancelled after its host closed." },
    };
  }
  return { backend: "external", outcome: { status: "closed", changes: "unknown" } };
}

export function createCodeOpener(dependencies: CodeOpenerDependencies): CodeOpener {
  const loadSettings = dependencies.loadSettings ?? loadPiCodeDiffSettings;
  const launchHost = dependencies.launchHost ?? launchCodeHost;
  const resolveTarget = dependencies.resolveTarget ?? resolveExternalCodeTarget;
  const resolveWorkspace = dependencies.resolveWorkspace ?? defaultResolveWorkspace;
  const resolveExecutable = dependencies.resolveExecutable ?? resolveExternalExecutable;

  return async (_origin, ctx, cwd, inputLaunch) => {
    let settings: PiCodeDiffSettings;
    let launch: WorkbenchLaunch;
    try {
      settings = loadSettings();
      launch = normalizeWorkbenchLaunch(inputLaunch);
    } catch (error) {
      return failedExternal(error);
    }

    if (settings.code.opener.kind === "workbench") {
      try {
        return { backend: "workbench", outcome: await dependencies.runWorkbench(ctx, cwd, launch) };
      } catch (error) {
        return { backend: "workbench", outcome: { status: "failed", message: error instanceof Error ? error.message : String(error) } };
      }
    }
    if (!hasTerminalUi(ctx)) {
      return failedExternal(new Error("External code editors require a TUI session."));
    }
    if ((launch.stories?.length ?? 0) > 0) return externalStoriesFailure();

    try {
      const canonicalCwd = await resolveWorkspace(cwd);
      let resolvedTarget: ResolvedExternalCodeTarget | undefined;
      if (launch.initialTarget != null) resolvedTarget = await resolveTarget({ cwd: canonicalCwd, target: launch.initialTarget });
      const rendered = renderExternalEditorCommand(settings.code.opener, { cwd: canonicalCwd, resolvedTarget });
      const executable = await resolveExecutable(rendered.executable);
      const completion = await launchHost(rendered.host, {
        cwd: canonicalCwd,
        editor: { executable, args: rendered.args },
        ...(ctx.signal == null ? {} : { signal: ctx.signal }),
      });
      return completedExternal(completion);
    } catch (error) {
      return failedExternal(error);
    }
  };
}
