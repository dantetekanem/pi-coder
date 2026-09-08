import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RemoteReviewTarget } from "./remote.js";
import { getProviderCapability, readConfiguredField, renderProviderOperation, type ProviderSettings } from "./provider-settings.js";

export type ConversationCoverage = "complete" | "partial" | "unavailable";
export interface ConversationComment {
  id: string;
  author: string;
  body: string;
  createdAt?: string;
  submittedAt?: string;
  state?: string;
  url?: string;
  path?: string;
  line?: number | null;
}
export interface ConversationThread {
  id: string;
  /** null means the provider did not report resolution. */
  resolved: boolean | null;
  outdated?: boolean;
  side?: "added" | "deleted";
  headRevision?: string;
  baseRevision?: string;
  path?: string;
  line?: number | null;
  comments: ConversationComment[];
}
type Section = "threads" | "comments" | "reviews";
type Work = { section: Section; kind: "graphql" | "nested" | "rest"; cursor?: string; threadId?: string; page?: number; operation?: string };
interface State {
  threads: ConversationThread[];
  comments: ConversationComment[];
  reviews: ConversationComment[];
  pending: Work[];
  reasons: string[];
  sections: Record<Section, ConversationCoverage>;
  seen: string[];
  retainedBytes: number;
}
/** Opaque, reader-owned token. Not serializable or valid after refresh. */
export interface ConversationContinuation { readonly generation: number }
export interface ConversationSnapshot {
  identity: string;
  generation: number;
  fetchedAt: string;
  coverage: ConversationCoverage;
  sections: Record<Section, ConversationCoverage>;
  reasons: string[];
  threads: ConversationThread[];
  comments: ConversationComment[];
  reviews: ConversationComment[];
  continuation?: ConversationContinuation;
  retainedBytes: number;
}
export interface ConversationLoadOptions { refresh?: boolean; continuation?: ConversationContinuation; budgets?: Partial<ConversationBudgets> }
export interface ConversationReader {
  readonly current: ConversationSnapshot | undefined;
  load(options?: ConversationLoadOptions): Promise<ConversationSnapshot>;
}
export interface ConversationBudgets {
  maxRequests: number;
  maxTimeMs: number;
  maxBytes: number;
  maxRetainedBytes: number;
}
const DEFAULT_BUDGETS: ConversationBudgets = { maxRequests: 12, maxTimeMs: 30_000, maxBytes: 2_000_000, maxRetainedBytes: 8_000_000 };
const record = (value: unknown): Record<string, unknown> | undefined => value != null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const string = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const identifier = (value: unknown): string | undefined => typeof value === "number" && Number.isFinite(value) ? String(value) : string(value);
const boolean = (value: unknown): boolean | undefined => typeof value === "boolean" ? value : undefined;
const line = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const side = (value: unknown) => value === "RIGHT" || value === "added" ? "added" : value === "LEFT" || value === "deleted" ? "deleted" : undefined;
const PAGE_INFO = "pageInfo { hasNextPage endCursor }";
const COMMENT_FIELDS = "id databaseId author { login } body createdAt url path line";
function query(work: Work): string {
  const after = work.cursor == null ? "null" : JSON.stringify(work.cursor);
  if (work.kind === "nested") return `query { node(id: ${JSON.stringify(work.threadId)}) { ... on PullRequestReviewThread { comments(first: 50, after: ${after}) { nodes { ${COMMENT_FIELDS} } ${PAGE_INFO} } } } }`;
  return `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { headRefOid baseRefOid reviewThreads(first: 50, after: ${after}) { nodes { id isResolved isOutdated diffSide path line comments(first: 50) { nodes { ${COMMENT_FIELDS} } ${PAGE_INFO} } } ${PAGE_INFO} } } } }`;
}

export function parseGraphqlConversationThreads(payload: unknown): ConversationThread[] {
  const pullRequest = record(record(record(record(payload)?.data)?.repository)?.pullRequest);
  const nodes = record(pullRequest?.reviewThreads)?.nodes;
  if (!Array.isArray(nodes)) return [];
  return nodes.flatMap((raw) => {
    const node = record(raw);
    const id = identifier(node?.id);
    if (!node || !id) return [];
    const comments = record(node.comments)?.nodes;
    return [{ id, resolved: boolean(node.isResolved) ?? null, outdated: boolean(node.isOutdated), side: side(node.diffSide), headRevision: string(pullRequest?.headRefOid), baseRevision: string(pullRequest?.baseRefOid), path: string(node.path), line: line(node.line), comments: Array.isArray(comments) ? comments.flatMap(graphqlComment) : [] }];
  });
}
function graphqlComment(raw: unknown): ConversationComment[] {
  const node = record(raw);
  const id = identifier(node?.databaseId) ?? identifier(node?.id);
  if (!node || !id || typeof node.body !== "string") return [];
  return [{ id, author: string(record(node.author)?.login) ?? "unknown", body: node.body, createdAt: string(node.createdAt), url: string(node.url), path: string(node.path), line: line(node.line) }];
}
function providerComment(row: unknown, provider: ProviderSettings): ConversationComment | undefined {
  const field = (key: string) => readConfiguredField(provider, key, row);
  const id = identifier(field("commentId"));
  const body = string(field("commentBody"));
  if (!id || body == null) return undefined;
  return { id, author: string(field("commentAuthor")) ?? "unknown", body, createdAt: string(field("commentCreatedAt")), submittedAt: string(field("commentSubmittedAt")), state: string(field("commentState")), url: string(field("commentUrl")), path: string(field("commentPath")), line: line(field("commentLine")) };
}
export function groupConversationComments(rows: unknown[], provider: ProviderSettings): ConversationThread[] {
  const threads = new Map<string, ConversationThread>();
  for (const row of rows) {
    const comment = providerComment(row, provider);
    if (!comment) continue;
    const field = (key: string) => readConfiguredField(provider, key, row);
    const id = identifier(field("commentThreadId")) ?? identifier(field("commentReplyToId")) ?? comment.id;
    const resolved = boolean(field("commentResolved")) ?? null;
    const existing = threads.get(id) ?? { id, resolved, path: comment.path, line: comment.line, side: side(field("commentSide")), headRevision: string(field("commentCommitId")), comments: [] };
    if (!existing.comments.some((entry) => entry.id === comment.id)) existing.comments.push(comment);
    if (resolved === true) existing.resolved = true;
    threads.set(id, existing);
  }
  return [...threads.values()];
}

/** Per-open-target ownership: weak keys cannot retain closed reviews; only in-flight work is reused. */
const readers = new WeakMap<RemoteReviewTarget, { pi: ExtensionAPI; reader: ConversationReader }>();
export function getConversationReader(pi: ExtensionAPI, target: RemoteReviewTarget, provider: ProviderSettings): ConversationReader {
  const existing = readers.get(target);
  if (existing?.pi === pi) return existing.reader;
  const reader = createConversationReader(pi, target, provider);
  readers.set(target, { pi, reader });
  return reader;
}

export function createConversationReader(pi: ExtensionAPI, target: RemoteReviewTarget, provider: ProviderSettings, overrides: Partial<ConversationBudgets> = {}): ConversationReader {
  const budgets = { ...DEFAULT_BUDGETS, ...overrides };
  for (const value of Object.values(budgets)) if (!Number.isFinite(value) || value <= 0) throw new Error("Conversation budgets must be positive finite numbers.");
  const repo = target.repo ?? target.pullRequest?.repo ?? "";
  const number = target.pullRequest?.number ?? "";
  const identity = JSON.stringify([target.gitRoot, provider.id, repo, number]);
  let generation = 0;
  let requestEpoch = 0;
  let activeContinuation: ConversationContinuation | undefined;
  let current: ConversationSnapshot | undefined;
  let inFlight: Promise<ConversationSnapshot> | undefined;
  let continuation: { token: ConversationContinuation; state: State } | undefined;

  function initial(): State {
    const state: State = { threads: [], comments: [], reviews: [], pending: [], reasons: [], sections: { threads: "complete", comments: "complete", reviews: "complete" }, seen: [], retainedBytes: 0 };
    if (getProviderCapability(provider, "graphqlReviewThreads") && repo.split("/").length === 2) state.pending.push({ kind: "graphql", section: "threads" });
    else addRest(state, "threads");
    addRest(state, "comments");
    addRest(state, "reviews");
    return state;
  }
  function addRest(state: State, section: Section): void {
    const operation = section === "threads" ? "reviewComments" : section === "comments" ? "pullRequestComments" : "pullRequestReviews";
    if (provider.operations[`${operation}Page`]) state.pending.push({ kind: "rest", section, operation: `${operation}Page`, page: 1 });
    else if (provider.operations[operation]) state.pending.push({ kind: "rest", section, operation });
    else { state.sections[section] = "unavailable"; state.reasons.push(`${section}: operation unavailable`); }
  }
  function mark(state: State, section: Section, reason: string): void {
    state.sections[section] = "partial";
    const label = `${section}: ${reason}`;
    if (!state.reasons.includes(label)) state.reasons.push(label);
  }
  function next(state: State, connection: unknown, work: Work): void {
    const info = record(record(connection)?.pageInfo);
    if (typeof info?.hasNextPage !== "boolean") { mark(state, work.section, "pageInfo unavailable; pagination unsupported or incomplete"); return; }
    if (!info.hasNextPage) return;
    const cursor = string(info.endCursor);
    const key = JSON.stringify([work.kind, work.threadId, cursor]);
    if (!cursor || cursor === work.cursor || state.seen.includes(key)) { mark(state, work.section, "non-advancing or duplicate cursor"); return; }
    state.seen.push(key);
    state.pending.unshift({ ...work, cursor });
  }
  function mergeThreads(state: State, incoming: ConversationThread[]): void {
    for (const thread of incoming) {
      const existing = state.threads.find((entry) => entry.id === thread.id);
      if (!existing) state.threads.push(thread);
      else {
        if (thread.resolved != null) existing.resolved = thread.resolved;
        for (const comment of thread.comments) if (!existing.comments.some((entry) => entry.id === comment.id)) existing.comments.push(comment);
      }
    }
  }
  function parseGraphql(state: State, payload: unknown, work: Work): void {
    const root = record(payload);
    const errors = root?.errors;
    const errorReason = Array.isArray(errors) && errors.length ? errors.some((error) => /rate/i.test(JSON.stringify(error))) ? "GraphQL rate limit" : "GraphQL errors with partial data" : undefined;
    const data = record(root?.data);
    const connection = work.kind === "nested" ? record(data?.node)?.comments : record(record(data?.repository)?.pullRequest)?.reviewThreads;
    const nodes = record(connection)?.nodes;
    if (!Array.isArray(nodes)) throw new Error(errorReason ?? "missing GraphQL connection data");
    if (errorReason) mark(state, "threads", errorReason);
    if (work.kind === "nested") {
      const thread = state.threads.find((entry) => entry.id === work.threadId);
      if (!thread) throw new Error("missing parent thread");
      const comments = nodes.flatMap(graphqlComment);
      if (comments.length !== nodes.length) mark(state, "threads", "missing comment ID or body");
      for (const comment of comments) if (!thread.comments.some((entry) => entry.id === comment.id)) thread.comments.push(comment);
    } else {
      const threads = parseGraphqlConversationThreads(payload);
      if (threads.length !== nodes.length) mark(state, "threads", "missing thread ID or data");
      mergeThreads(state, threads);
      for (const raw of nodes) {
        const node = record(raw);
        const id = identifier(node?.id);
        if (!id) continue;
        const comments = record(node?.comments)?.nodes;
        if (!Array.isArray(comments)) mark(state, "threads", "missing nested comment data");
        else if (comments.flatMap(graphqlComment).length !== comments.length) mark(state, "threads", "missing comment ID or body");
        next(state, node?.comments, { kind: "nested", section: "threads", threadId: id });
      }
    }
    next(state, connection, work);
  }
  function parseRest(state: State, text: string, work: Work): void {
    let body = text;
    let headers: string | undefined;
    if (work.page != null) {
      const separator = text.match(/\r?\n\r?\n/);
      if (!/^HTTP\//.test(text) || separator?.index == null) throw new Error("paginated REST operation requires included HTTP headers");
      headers = text.slice(0, separator.index); body = text.slice(separator.index + separator[0].length);
      const status = Number(headers.match(/^HTTP\/\S+\s+(\d{3})(?:\s|$)/)?.[1]);
      if (!Number.isInteger(status) || status < 200 || status >= 300) throw new Error(`HTTP ${Number.isInteger(status) ? status : "status unavailable"}; conversation page unavailable`);
    }
    const payload: unknown = JSON.parse(body);
    const field = work.section === "threads" ? "pullRequestReviewComments" : work.section === "comments" ? "pullRequestComments" : "pullRequestReviews";
    const rows = readConfiguredField(provider, field, payload) ?? payload;
    if (!Array.isArray(rows)) throw new Error("missing REST conversation rows");
    if (work.section === "threads") {
      mergeThreads(state, groupConversationComments(rows, provider));
      if (rows.some((row) => !providerComment(row, provider))) mark(state, work.section, "missing comment ID or body");
    } else {
      for (const row of rows) {
        const comment = providerComment(row, provider);
        if (!comment) { mark(state, work.section, "missing comment ID or body"); continue; }
        if (!state[work.section].some((entry) => entry.id === comment.id)) state[work.section].push(comment);
      }
    }
    if (headers == null) { mark(state, work.section, "pagination unsupported by configured operation"); return; }
    const link = headers.split(/\r?\n/).find((entry) => /^link:/i.test(entry));
    if (!link || !/rel="next"/.test(link)) return;
    const nextLink = link.match(/<([^>]+)>;\s*rel="next"/);
    let nextPage = NaN;
    try { if (nextLink) nextPage = Number(new URL(nextLink[1]!).searchParams.get("page")); } catch { /* Invalid links are incomplete, never trusted commands. */ }
    if (!Number.isSafeInteger(nextPage) || nextPage <= (work.page ?? 0)) { mark(state, work.section, "non-advancing REST page"); return; }
    // Only the numeric page is reused, never the remote-provided URL/host.
    state.pending.push({ ...work, page: nextPage });
  }
  async function fetch(state: State, run: number, epoch: number, budgets: ConversationBudgets): Promise<ConversationSnapshot> {
    const started = Date.now();
    let requests = 0;
    let bytes = 0;
    let stopReason: string | undefined;
    const retry: Work[] = [];
    const failures: string[] = [];
    while (state.pending.length > 0 && epoch === requestEpoch) {
      if (requests >= budgets.maxRequests) { stopReason = "request budget exhausted"; break; }
      if (Date.now() - started >= budgets.maxTimeMs) { stopReason = "time budget exhausted"; break; }
      const work = state.pending.shift()!;
      const before = structuredClone(state);
      try {
        const [owner = "", name = ""] = repo.split("/");
        const document = query(work).replaceAll("{", "__CODE_DIFF_QUERY_OPEN__").replaceAll("}", "__CODE_DIFF_QUERY_CLOSE__");
        const operation = renderProviderOperation(provider, work.operation ?? "reviewThreads", { repo, number, owner, name, page: work.page ?? 1, query: document });
        const args = operation.args.map((arg) => arg.replaceAll("__CODE_DIFF_QUERY_OPEN__", "{").replaceAll("__CODE_DIFF_QUERY_CLOSE__", "}"));
        requests++;
        const result = await pi.exec(provider.executable, args, { cwd: target.gitRoot, timeout: Math.max(1, budgets.maxTimeMs - (Date.now() - started)) });
        if (epoch !== requestEpoch) break;
        const size = Buffer.byteLength(result.stdout ?? "", "utf8");
        if (bytes + size > budgets.maxBytes) { state = before; state.pending.unshift(work); stopReason = "byte budget exhausted before accepting page"; break; }
        bytes += size;
        if (Date.now() - started >= budgets.maxTimeMs) { state = before; state.pending.unshift(work); stopReason = "time budget exhausted"; break; }
        if (result.code !== 0) throw new Error(/rate/i.test(result.stderr) ? "rate limit" : "provider request failed");
        if (!result.stdout?.trim()) throw new Error("empty provider response");
        if (work.kind === "rest") parseRest(state, result.stdout, work);
        else parseGraphql(state, JSON.parse(result.stdout), work);
        state.retainedBytes = Buffer.byteLength(JSON.stringify(state), "utf8");
        if (state.retainedBytes > budgets.maxRetainedBytes) { state = before; state.pending.unshift(work); stopReason = "retained byte limit reached; resume with a larger explicit limit"; break; }
      } catch (error) {
        const reason = error instanceof Error ? error.message : "provider request failed";
        failures.push(`${work.section}: ${reason}`);
        if (work.kind === "graphql" && state.threads.length === 0 && (provider.operations.reviewCommentsPage || provider.operations.reviewComments)) {
          mark(state, "threads", "GraphQL unavailable; REST resolution may be unknown");
          addRest(state, "threads");
        } else {
          retry.push(work);
        }
      }
    }
    state.pending.push(...retry);
    const sections = { ...state.sections };
    for (const work of state.pending) sections[work.section] = retry.includes(work) && state[work.section].length === 0 ? "unavailable" : "partial";
    const all = Object.values(sections);
    const coverage = all.every((value) => value === "complete") ? "complete" : all.every((value) => value === "unavailable") ? "unavailable" : "partial";
    const reasons = [...state.reasons, ...failures, ...(retry.length ? ["request unavailable; retry continuation"] : []), ...(stopReason ? [stopReason] : [])];
    const token = state.pending.length ? { generation: run } : undefined;
    const snapshot: ConversationSnapshot = { identity, generation: run, fetchedAt: new Date().toISOString(), coverage, sections, reasons, threads: state.threads, comments: state.comments, reviews: state.reviews, retainedBytes: state.retainedBytes, ...(token ? { continuation: token } : {}) };
    if (epoch === requestEpoch) { current = snapshot; continuation = token ? { token, state: structuredClone(state) } : undefined; }
    return snapshot;
  }
  return {
    get current() { return current; },
    load(options = {}) {
      if (!options.refresh && inFlight) {
        if (options.continuation !== activeContinuation && options.continuation != null) return Promise.reject(new Error("Different conversation continuation already in flight."));
        return inFlight;
      }
      let state: State;
      if (options.continuation) {
        if (options.refresh || options.continuation !== continuation?.token) return Promise.reject(new Error("Stale or foreign conversation continuation; refresh instead."));
        state = structuredClone(continuation.state);
      } else state = initial();
      const limits = { ...budgets, ...options.budgets };
      if (Object.values(limits).some((value) => !Number.isFinite(value) || value <= 0)) return Promise.reject(new Error("Conversation budgets must be positive finite numbers."));
      const run = options.continuation ? generation : ++generation;
      const epoch = ++requestEpoch;
      activeContinuation = options.continuation;
      continuation = undefined;
      const promise = fetch(state, run, epoch, limits).then(async (snapshot) => epoch === requestEpoch ? snapshot : inFlight ?? current ?? snapshot).finally(() => { if (epoch === requestEpoch) { inFlight = undefined; activeContinuation = undefined; } });
      inFlight = promise;
      return promise;
    },
  };
}
