import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { copyToClipboard } from "./clipboard.js";

export interface PiCoderRuntime {
  agentDir(): string;
  copyText(text: string): Promise<void>;
  highlightLine(text: string, language: string | undefined): string;
  languageForPath(path: string): string | undefined;
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function defaultAgentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  return configured ? resolve(expandHome(configured)) : join(homedir(), ".pi", "agent");
}

const defaults: PiCoderRuntime = {
  agentDir: defaultAgentDir,
  copyText: copyToClipboard,
  highlightLine: (text) => text,
  languageForPath: () => undefined,
};

let current: PiCoderRuntime = { ...defaults };

export function configureRuntime(overrides: Partial<PiCoderRuntime>): void {
  current = { ...current, ...overrides };
}

export function resetRuntime(): void {
  current = { ...defaults };
}

export function getAgentDir(): string {
  return current.agentDir();
}

export function copyText(text: string): Promise<void> {
  return current.copyText(text);
}

export function highlightLine(text: string, language: string | undefined): string {
  return current.highlightLine(text, language);
}

export function languageForPath(path: string): string | undefined {
  return current.languageForPath(path);
}
