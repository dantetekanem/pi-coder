import type { ChildProcess } from "node:child_process";
import { CHILD_CLOSURE_UNCONFIRMED } from "../contracts.js";

export { CHILD_CLOSURE_UNCONFIRMED } from "../contracts.js";

export const DEFAULT_TERMINATION_GRACE_MS = 100;

export class ChildClosureError extends Error {
  readonly code = CHILD_CLOSURE_UNCONFIRMED;

  constructor(label: string) {
    super(`${label} did not close after SIGKILL.`);
    this.name = "ChildClosureError";
  }
}

export function isChildClosureError(error: unknown): error is ChildClosureError {
  return error instanceof ChildClosureError && error.code === CHILD_CLOSURE_UNCONFIRMED;
}

export interface ChildTerminationState {
  request(): void;
  markClosed(): void;
  dispose(): void;
}

/**
 * Terminates one direct child with a bounded SIGTERM grace and SIGKILL
 * confirmation window. This assumes Node's POSIX signal semantics; it is not a
 * process-tree killer. Workbench rg/Git invocations disable subprocess-producing
 * preprocessors, pagers, and hooks, so the direct child is the owned boundary.
 */
export function createChildTermination(
  child: ChildProcess,
  label: string,
  onFinalFailure: (error: Error) => void,
  graceMs = DEFAULT_TERMINATION_GRACE_MS,
): ChildTerminationState {
  let requested = false;
  let closed = false;
  let graceTimer: NodeJS.Timeout | undefined;
  let confirmationTimer: NodeJS.Timeout | undefined;

  const clearTimers = () => {
    if (graceTimer != null) clearTimeout(graceTimer);
    if (confirmationTimer != null) clearTimeout(confirmationTimer);
    graceTimer = undefined;
    confirmationTimer = undefined;
  };

  const send = (signal: NodeJS.Signals) => {
    try { child.kill(signal); } catch { /* The confirmation window still bounds settlement. */ }
  };

  return {
    request() {
      if (requested || closed) return;
      requested = true;
      send("SIGTERM");
      if (closed) return;
      graceTimer = setTimeout(() => {
        if (closed) return;
        send("SIGKILL");
        if (closed) return;
        confirmationTimer = setTimeout(() => {
          if (!closed) onFinalFailure(new ChildClosureError(label));
        }, graceMs);
      }, graceMs);
    },
    markClosed() {
      closed = true;
      clearTimers();
    },
    dispose() {
      clearTimers();
    },
  };
}

/** Returns the longest whole-character UTF-8 prefix within maxBytes. */
export function utf8Prefix(text: string, maxBytes: number): { text: string; bytes: number } {
  let bytes = 0;
  let end = 0;
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    bytes += characterBytes;
    end += character.length;
  }
  return { text: text.slice(0, end), bytes };
}
