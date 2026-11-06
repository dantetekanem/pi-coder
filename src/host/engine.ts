import type { SubmitReviewResult } from "../review-submit.js";
import type { WorkbenchCompletionResult } from "../workbench/contracts.js";
import type { HostContext } from "./types.js";

export interface ReviewRunStatus {
  started: boolean;
  message?: string;
  prompt?: string;
  context?: string;
  /** True only after a provider accepted the review submission. */
  submitted?: boolean;
  /** Shared provider evidence, including partial/unknown outcomes and receipt status. */
  submission?: SubmitReviewResult;
  /** Next pull request the caller queued, offered after a successful submission. */
  nextCandidate?: { url: string; title?: string };
}

export type PiCoderToolName = "open_code" | "open_code_diff" | "open_code_diff_story" | "submit_pr_review";

/** The same text and details a Pi tool call returns. */
export interface PiCoderToolResult {
  text: string;
  details: Record<string, unknown>;
}

/** Outcome of a /diff, /diff-story, or /code command run to completion. */
export interface PiCoderCommandResult {
  /** True when a UI opened or a setting changed. */
  started: boolean;
  /** Text for the agent: review feedback, a DISCUSS handoff, or a code discussion. Pi puts it in its editor. */
  prompt?: string;
  message?: string;
  review?: ReviewRunStatus;
  workbench?: WorkbenchCompletionResult;
}

export type ExternalEditorOutcome =
  | { kind: "exit"; code: number }
  | { kind: "signal"; signal: NodeJS.Signals | string };

export type ExternalEditorLauncher = (command: string, args: string[], cwd: string) => Promise<ExternalEditorOutcome>;

export interface PiCoderCommandNames {
  diff: string;
  diffStory: string;
  code: string;
}

export interface PiCoderEngineOptions {
  /** Runs $EDITOR and the configured code command. A terminal host suspends its screen around it. */
  runExternalEditor?: ExternalEditorLauncher;
  /** Called after each review or workbench run settles, for host status such as Pi's footer. */
  onRunSettled?(ctx: HostContext): void;
  /** How hints and errors name the commands. Defaults to the Pi slash commands: /diff, /diff-story, and /code. */
  commands?: PiCoderCommandNames;
}

export interface PiCoderEngine {
  /** /diff and /review: a review target, or "fullscreen on|off". Resolves when the review closes. */
  diff(args: string, ctx: HostContext): Promise<PiCoderCommandResult>;
  /** /diff-story: a review target, or "agent" to pick the story model. */
  diffStory(args: string, ctx: HostContext): Promise<PiCoderCommandResult>;
  /** /code: a path, structured options, or "syntax" to pick the Shiki theme. */
  code(args: string, ctx: HostContext): Promise<PiCoderCommandResult>;
  /** open_code, open_code_diff, open_code_diff_story, and submit_pr_review, with the Pi tool inputs and results. */
  runTool(name: PiCoderToolName, params: unknown, ctx: HostContext, signal?: AbortSignal): Promise<PiCoderToolResult>;
  /** Stops timers and progress widgets. */
  shutdown(): void;
}
