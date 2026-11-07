import type { Component, OverlayHandle, OverlayOptions, TUI } from "@earendil-works/pi-tui";

export interface HostExecOptions {
  cwd?: string;
  timeout?: number;
  signal?: AbortSignal;
}

export interface HostExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

export interface CommandRunner {
  exec(command: string, args: string[], options?: HostExecOptions): Promise<HostExecResult>;
}

export type FollowUpDelivery = "steer" | "followUp";

export interface HostApi extends CommandRunner {
  /** Hands text to the agent that owns this host. A terminal host records it in its result instead. */
  sendUserMessage(message: string, options?: { deliverAs?: FollowUpDelivery }): void;
}

export type HostThemeColor =
  | "accent"
  | "border"
  | "borderAccent"
  | "borderMuted"
  | "success"
  | "error"
  | "warning"
  | "muted"
  | "dim"
  | "text"
  | "thinkingText"
  | "userMessageText"
  | "customMessageText"
  | "customMessageLabel"
  | "toolTitle"
  | "toolOutput"
  | "mdHeading"
  | "mdLink"
  | "mdLinkUrl"
  | "mdCode"
  | "mdCodeBlock"
  | "mdCodeBlockBorder"
  | "mdQuote"
  | "mdQuoteBorder"
  | "mdHr"
  | "mdListBullet"
  | "toolDiffAdded"
  | "toolDiffRemoved"
  | "toolDiffContext"
  | "syntaxComment"
  | "syntaxKeyword"
  | "syntaxFunction"
  | "syntaxVariable"
  | "syntaxString"
  | "syntaxNumber"
  | "syntaxType"
  | "syntaxOperator"
  | "syntaxPunctuation"
  | "thinkingOff"
  | "thinkingMinimal"
  | "thinkingLow"
  | "thinkingMedium"
  | "thinkingHigh"
  | "thinkingXhigh"
  | "bashMode";

export type HostThemeBg =
  | "selectedBg"
  | "userMessageBg"
  | "customMessageBg"
  | "toolPendingBg"
  | "toolSuccessBg"
  | "toolErrorBg";

/** The theme surface pi-coder draws with. Pi's Theme satisfies it; terminal hosts build their own. */
export interface HostTheme {
  fg(color: HostThemeColor, text: string): string;
  bg(color: HostThemeBg, text: string): string;
  bold(text: string): string;
  italic(text: string): string;
  underline(text: string): string;
  inverse(text: string): string;
  strikethrough(text: string): string;
  getFgAnsi?(color: HostThemeColor): string;
  getBgAnsi?(color: HostThemeBg): string;
}

export interface HostKeybindings {
  matches(data: string, keybinding: string): boolean;
}

export type HostNotifyLevel = "info" | "warning" | "error";

export type HostComponent = Component & { dispose?(): void };

export type HostComponentFactory<T> = (
  tui: TUI,
  theme: HostTheme,
  keybindings: HostKeybindings,
  done: (result: T) => void,
) => HostComponent | Promise<HostComponent>;

export type HostWidgetFactory = (tui: TUI, theme: HostTheme) => HostComponent;

export interface HostCustomOptions {
  overlay?: boolean;
  overlayOptions?: OverlayOptions | (() => OverlayOptions);
  onHandle?(handle: OverlayHandle): void;
}

export interface HostSelectOptions {
  signal?: AbortSignal;
  timeout?: number;
}

export interface HostUI {
  notify(message: string, type?: HostNotifyLevel): void;
  select(title: string, options: string[], opts?: HostSelectOptions): Promise<string | undefined>;
  editor(title: string, prefill?: string): Promise<string | undefined>;
  setStatus(key: string, text: string | undefined): void;
  setWidget(key: string, content: HostWidgetFactory | undefined): void;
  custom<T>(factory: HostComponentFactory<T>, options?: HostCustomOptions): Promise<T>;
  setEditorText(text: string): void;
  readonly theme: HostTheme;
}

export type ModelPurpose = "grammar" | "story" | "analysis";

export interface StoryAgentSelection {
  provider: string;
  model: string;
  thinking: string;
}

export interface StoryAgentChoice {
  provider: string;
  model: string;
  label: string;
  thinkingLevels: string[];
}

export interface ModelTextRequest {
  system?: string;
  prompt: string;
  signal?: AbortSignal;
  cwd?: string;
  timeoutMs?: number;
  /** Receives the whole answer so far each time more text arrives. */
  onText?(text: string): void;
}

/** How pi-coder reaches a model. Pi uses its model registry; a terminal host runs configured commands. */
export interface ModelGateway {
  /** Short model name for status lines, or undefined when the host cannot tell. */
  label(purpose: ModelPurpose): string | undefined;
  /** One grammar or reply-analysis prompt, resolved with the full answer text. */
  complete(purpose: "grammar" | "analysis", request: ModelTextRequest): Promise<string>;
  /** One story-ordering request with the saved story agent selection. */
  streamStory(selection: StoryAgentSelection, request: ModelTextRequest & { system: string; signal: AbortSignal }): Promise<string>;
  /** Models the story agent picker can offer. Empty when the host has no model list. */
  storyAgents(): StoryAgentChoice[];
  /** Throws a readable error when the selection cannot run on this host. */
  validateStoryAgent(selection: StoryAgentSelection): void;
}

export interface HostContext {
  readonly cwd: string;
  readonly hasUI: boolean;
  /** "tui" for an interactive terminal UI. Hosts without one leave it unset or use another value. */
  readonly mode?: string;
  readonly ui: HostUI;
  readonly models: ModelGateway;
  isIdle(): boolean;
}
