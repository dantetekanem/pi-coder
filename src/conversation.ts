import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PullRequestDetails } from "./pr-summary.js";
import type { RemoteReviewTarget } from "./remote.js";
import type { ReviewConversationMetadata, ReviewConversationLoadOptions, ReviewReplyItem } from "./types.js";

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

interface ConversationData {
  details: PullRequestDetails;
  selfLogin: string | null;
  replies?: ReviewReplyItem[];
}
interface ConversationSnapshot extends ConversationData {
  metadata: ReviewConversationMetadata;
  supplied: boolean;
}
interface ConversationLoad {
  facts: Promise<PullRequestDetails>;
  snapshot: Promise<ConversationSnapshot>;
}
interface PendingRead extends ConversationLoad {
  settled: boolean;
  close: () => void;
  resolveFacts: (details: PullRequestDetails) => void;
}

export function createConversationReader(
  pi: ExtensionAPI, target: RemoteReviewTarget,
  acquire: (read: ReturnType<typeof createConversationRead>, onProgress: (data: Partial<ConversationData>) => void) => Promise<ConversationData>,
  supplied?: PullRequestDetails,
) {
  const identity = JSON.stringify([target.provider ?? target.handoff?.provider, target.repo ?? target.pullRequest?.repo, target.pullRequest?.number, target.pullRequest?.headRefOid]);
  let generation = 0;
  let live = supplied == null;
  let current: PendingRead | undefined;
  return {
    isCurrent: (metadata: ReviewConversationMetadata) => metadata.identity === identity && metadata.generation === generation,
    load: (options?: ReviewConversationLoadOptions): ConversationLoad => {
      if (!options?.refresh && current != null && (!current.settled || !live)) return current;
      if (options?.refresh) live = true;
      const previous = current;
      const id = ++generation;
      const fromHandoff = !live;
      const read = live ? createConversationRead(pi) : undefined;
      let known: PullRequestDetails = { checksUnavailable: true, pending: ["PR details", "checks", "PR comments", "reviews", "review threads"] };
      let resolveFacts!: (details: PullRequestDetails) => void;
      const facts = new Promise<PullRequestDetails>((resolve) => { resolveFacts = resolve; });
      let selfLogin: string | null = null;
      const failed = (): ConversationData => ({ selfLogin, details: { ...known, pending: undefined,
        unavailable: [...(known.unavailable ?? []), ...(known.pending ?? [])] } });
      const finish = ({ details, selfLogin, replies }: ConversationData): ConversationSnapshot => {
        const coverage = (label: string, success: "complete" | "partial") => details.unavailable?.includes(label) ? "unavailable" : success;
        return {
          details, selfLogin, replies, supplied: fromHandoff,
          metadata: {
            identity, generation: id, fetchedAt: fromHandoff ? null : new Date().toISOString(),
            coverage: {
              details: coverage("PR details", fromHandoff ? "partial" : "complete"),
              comments: coverage("PR comments", "partial"), reviews: coverage("reviews", "partial"),
              checks: details.checksUnavailable ? "unavailable" : fromHandoff ? "partial" : "complete",
              threads: details.threadRead?.coverage ?? (fromHandoff ? "partial" : "unavailable"),
              identity: selfLogin == null ? "unavailable" : "complete",
            },
          },
        };
      };
      const snapshot: Promise<ConversationSnapshot> = Promise.resolve().then(() => read == null
        ? { details: supplied!, selfLogin: null } : acquire(read, (progress) => {
          if (current !== entry) return;
          if (progress.selfLogin !== undefined) selfLogin = progress.selfLogin;
          if (progress.details != null) {
            known = progress.details;
            resolveFacts(known);
          }
        }))
        .catch(failed).then((data) => {
          if (current !== entry) return current!.snapshot;
          try {
            return read?.retain(finish(data)) ?? finish(data);
          } catch {
            return finish(failed());
          }
        }).then((value) => { resolveFacts(value.details); return value; })
        .finally(() => { read?.close(); entry.settled = true; });
      const entry: PendingRead = { facts, snapshot, resolveFacts, settled: false, close: () => read?.close() };
      current = entry;
      if (previous != null) {
        void facts.then(previous.resolveFacts);
        previous.close();
      }
      return entry;
    },
  };
}
