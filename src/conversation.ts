import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PullRequestDetails } from "./pr-summary.js";
import type { RemoteReviewTarget } from "./remote.js";
import type { ReviewConversationMetadata, ReviewConversationLoadOptions, ReviewReplyItem } from "./types.js";

const DEFAULT_LIMITS = { maxRequests: 12, maxMs: 30_000, maxBytes: 2_000_000, maxRetainedBytes: 8_000_000 };
export type ConversationReadLimits = Partial<typeof DEFAULT_LIMITS>;

/** Limits accepted decoded output and serialized retained data, not exec's transport buffers. */
export function createConversationRead(pi: ExtensionAPI, limits: ConversationReadLimits = {}, ledger = { bytes: 0 }) {
  const policy = { ...DEFAULT_LIMITS, ...limits };
  if (Object.values(policy).some((value) => !Number.isSafeInteger(value) || value < 0)) throw new Error("Invalid conversation read limits.");
  const deadline = Date.now() + policy.maxMs;
  const controller = new AbortController();
  let requests = 0;
  let bytes = 0;
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
      if (ledger.bytes + size > policy.maxRetainedBytes) throw stop("retained data limit reached");
      ledger.bytes += size;
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
  totalReplies?: number;
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
  acquire: (read: ReturnType<typeof createConversationRead>, onProgress: (data: Partial<ConversationData>) => void, previous?: ConversationData) => Promise<ConversationData>,
  supplied?: PullRequestDetails,
) {
  const identity = JSON.stringify([target.provider ?? target.handoff?.provider, target.repo ?? target.pullRequest?.repo, target.pullRequest?.number, target.pullRequest?.headRefOid]);
  let generation = 0;
  let attempt = 0;
  let ledger = { bytes: 0 };
  let limits: ConversationReadLimits = {};
  let checkpoint: ConversationSnapshot | undefined;
  let issued: object | undefined;
  let live = supplied == null;
  let current: PendingRead | undefined;
  return {
    get current() { return checkpoint; },
    isCurrent: (metadata: ReviewConversationMetadata) => metadata.identity === identity && metadata.generation === generation && metadata.attempt === attempt,
    load: (options?: ReviewConversationLoadOptions): ConversationLoad => {
      const continuing = options?.continuation != null;
      if (continuing && (options?.refresh || options.continuation !== issued)) throw new Error("Stale or foreign conversation continuation.");
      const fromHandoff = !live && !options?.refresh;
      if (fromHandoff && options?.budgets != null) throw new Error("Budget options require a live conversation read.");
      if (!continuing && !options?.refresh && current != null && (!current.settled || !live)) return current;
      const previous = current;
      const id = continuing ? generation : generation + 1;
      const revision = continuing ? attempt + 1 : 1;
      const nextLedger = continuing ? { ...ledger } : { bytes: 0 };
      const policy = { ...(continuing ? limits : {}), ...options?.budgets };
      const read = fromHandoff ? undefined : createConversationRead(pi, policy, nextLedger);
      const seed = continuing ? checkpoint : undefined;
      const retry = Object.freeze({});
      let known: ConversationData = seed ?? { selfLogin: null, details: fromHandoff ? supplied! : {
        checksUnavailable: true, pending: ["PR details", "checks", "PR comments", "reviews", "review threads"] } };
      let resolveFacts!: (details: PullRequestDetails) => void;
      const facts = new Promise<PullRequestDetails>((resolve) => { resolveFacts = resolve; });
      const finish = ({ details, selfLogin, replies, totalReplies }: ConversationData): ConversationSnapshot => {
        details = { ...details, pending: undefined, unavailable: [...(details.unavailable ?? []), ...(details.pending ?? [])] };
        const threads = details.threadRead?.threads;
        const coverage = (label: string, success: "complete" | "partial") => details.unavailable?.includes(label) ? "unavailable" : success;
        return {
          details, selfLogin, replies, totalReplies, supplied: fromHandoff,
          metadata: {
            identity, generation: id, attempt: revision, fetchedAt: fromHandoff ? null : new Date().toISOString(),
            threadCounts: threads == null ? undefined : { open: threads.filter((t) => t.resolved === false).length, unknown: threads.filter((t) => t.resolved == null).length },
            continuation: !fromHandoff && (selfLogin == null || details.unavailable!.length > 0 || details.threadRead?.pagination?.done === false
              || Object.values(details.pages ?? {}).some((page) => page?.nextPage != null)) ? retry : undefined,
            coverage: {
              details: coverage("PR details", fromHandoff ? "partial" : "complete"),
              comments: coverage("PR comments", details.pages?.comments?.coverage ?? "partial"),
              reviews: coverage("reviews", details.pages?.reviews?.coverage ?? "partial"),
              checks: details.checksUnavailable ? "unavailable" : coverage("checks", fromHandoff ? "partial" : "complete"),
              threads: details.unavailable?.includes("review threads") ? "unavailable" : details.threadRead?.coverage ?? (fromHandoff ? "partial" : "unavailable"),
              identity: selfLogin == null ? "unavailable" : "complete",
            },
          },
        };
      };
      let accepted = finish(known);
      if (seed != null) accepted.metadata.fetchedAt = seed.metadata.fetchedAt;
      try { read?.retain(accepted); } catch (error) { read?.close(); throw error; }
      const publish = (progress: Partial<ConversationData>) => {
        if (current !== entry) return;
        const candidate = { ...known, ...progress };
        const value = finish(candidate);
        accepted = read?.retain(value) ?? value;
        known = candidate;
        if (progress.details != null) resolveFacts(progress.details);
      };
      const snapshot: Promise<ConversationSnapshot> = Promise.resolve().then(() => read == null ? known : acquire(read, publish, seed))
        .then((data) => { publish(data); return accepted; }).catch(() => accepted).then((value) => {
          if (current !== entry) return current!.snapshot;
          checkpoint = value;
          issued = value.metadata.continuation;
          return value;
        }).then((value) => { resolveFacts(value.details); return value; })
        .finally(() => { read?.close(); entry.settled = true; });
      const entry: PendingRead = { facts, snapshot, resolveFacts, settled: false, close: () => read?.close() };
      current = entry;
      generation = id;
      attempt = revision;
      ledger = nextLedger;
      limits = policy;
      issued = undefined;
      live = !fromHandoff;
      if (previous != null) {
        void facts.then(previous.resolveFacts);
        previous.close();
      }
      return entry;
    },
  };
}
