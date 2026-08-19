import { sanitizeTerminalText, type TargetOpenResult, type Workbench } from "./contracts.js";

function boundedText(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  if (maxBytes < 3) return text.slice(0, maxBytes);
  let end = text.length;
  while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > maxBytes - 3) end -= 1;
  return `${text.slice(0, end)}…`;
}

function sanitizeIssueText(text: string): string {
  return sanitizeTerminalText(text).replace(/[\r\n\t]/g, " ");
}

function formatTargetLocation(path: string, range?: { startLine: number; endLine: number }): string {
  const line = range == null || range.startLine === range.endLine ? range?.startLine : `${range.startLine}-${range.endLine}`;
  return sanitizeIssueText(`${path}${line == null ? "" : `:${line}`}`);
}

/** Formats target-open feedback for a terminal-safe, bounded host notice. */
export function formatTargetOpenIssue(result: TargetOpenResult): string {
  const location = boundedText(formatTargetLocation(result.path, result.status === "opened" ? result.range : undefined), 240);
  const reason = boundedText(sanitizeIssueText(result.message ?? "").replace(/\s+/g, " ").trim(), 240);
  return boundedText(`${location}: ${reason}`, 512);
}

/** Cancels and disposes host-owned workbench work without skipping later cleanup. */
export function cleanupWorkbench(workbench: Workbench | undefined): unknown[] {
  const errors: unknown[] = [];
  if (workbench == null) return errors;
  for (const operation of [
    () => workbench.dispose(),
  ]) {
    try { operation(); } catch (error) { errors.push(error); }
  }
  return errors;
}
