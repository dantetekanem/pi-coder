import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_LIMITS = { maxRequests: 12, maxMs: 30_000, maxBytes: 2_000_000, maxRetainedBytes: 8_000_000 };

/** Limits accepted decoded output and serialized retained data, not exec's transport buffers. */
export function createConversationRead(pi: ExtensionAPI, limits: Partial<typeof DEFAULT_LIMITS> = {}) {
  const policy = { ...DEFAULT_LIMITS, ...limits };
  if (Object.values(policy).some((value) => !Number.isSafeInteger(value) || value < 0)) throw new Error("Invalid conversation read limits.");
  const deadline = Date.now() + policy.maxMs;
  const controller = new AbortController();
  let requests = 0;
  let bytes = 0;
  let retainedBytes = 0;
  let failure: Error | undefined;
  let reject!: (error: Error) => void;
  const stopped = new Promise<never>((_resolve, fail) => { reject = fail; });
  void stopped.catch(() => undefined);
  const stop = (reason: string) => {
    if (failure == null) {
      failure = new Error(`Conversation read ${reason}.`);
      reject(failure);
      controller.abort();
    }
    return failure;
  };
  const check = () => {
    if (failure != null) throw failure;
    if (Date.now() >= deadline) throw stop("time limit reached");
  };
  const timer = setTimeout(() => stop("time limit reached"), policy.maxMs);
  const exec: ExtensionAPI["exec"] = async (command, args, options) => {
    check();
    if (++requests > policy.maxRequests) throw stop("request limit reached");
    const signal = options?.signal == null ? controller.signal : AbortSignal.any([controller.signal, options.signal]);
    if (signal.aborted) throw new Error("Conversation command cancelled.");
    const result = await Promise.race([pi.exec(command, args, {
      ...options, signal, timeout: Math.min(options?.timeout ?? policy.maxMs, deadline - Date.now()),
    }), stopped]);
    check();
    if (result.killed || signal.aborted) throw new Error("Conversation command cancelled.");
    const size = Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);
    if (bytes + size > policy.maxBytes) throw stop("byte limit reached");
    bytes += size;
    return result;
  };
  return {
    pi: { ...pi, exec },
    retain: <T>(value: T): T => {
      const size = Buffer.byteLength(JSON.stringify(value) ?? "");
      check();
      if (retainedBytes + size > policy.maxRetainedBytes) throw stop("retained data limit reached");
      retainedBytes += size;
      return value;
    },
    close: () => {
      clearTimeout(timer);
      stop("closed");
    },
  };
}
