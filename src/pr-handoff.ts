import type { PiCodeDiffSettings, ProviderUrlPattern } from "./provider-settings.js";
import {
  getProviderCapability,
  loadPiCodeDiffSettings,
  renderProviderTemplate,
  requireProviderSettings,
} from "./provider-settings.js";
import type { PullRequestMetadata } from "./remote.js";

export interface PullRequestHandoffReview {
  author: string;
  state: string;
}

export interface PullRequestHandoffStackParent {
  number: string;
  title: string;
  headRefName: string;
  state: string;
  url?: string;
}

export interface PullRequestHandoffThreadComment {
  author: string;
  body: string;
  createdAt?: string;
  state?: string;
}

export interface PullRequestHandoffThread {
  path?: string;
  line?: number;
  resolved?: boolean;
  outdated?: boolean;
  comments: PullRequestHandoffThreadComment[];
}

export interface PullRequestHandoffCheck {
  name: string;
  status?: string;
  conclusion?: string;
}

export interface PullRequestHandoffFilePriority {
  path: string;
  reason?: string;
}

export interface PullRequestHandoffQueue {
  position: number;
  total?: number;
}

export interface PullRequestHandoffNextCandidate {
  url: string;
  title?: string;
}

export interface PullRequestHandoff {
  provider: string;
  repo: string;
  number: string;
  url: string;
  title: string;
  authorLogin: string;
  state: string;
  body: string;
  baseRefName: string;
  baseRefOid?: string;
  headRefName: string;
  headRefOid: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  reviews: PullRequestHandoffReview[];
  reviewDecision?: string;
  stackParent?: PullRequestHandoffStackParent;
  threads?: PullRequestHandoffThread[];
  checks?: PullRequestHandoffCheck[];
  summary?: string;
  filePriority?: PullRequestHandoffFilePriority[];
  queue?: PullRequestHandoffQueue;
  nextCandidate?: PullRequestHandoffNextCandidate;
}

export interface ConfiguredPullRequestUrl {
  provider: string;
  repo: string;
  number: string;
  canonical: string;
}

const REPO_SEGMENT_PATTERN = /^[A-Za-z0-9_.-]+$/;
const NUMBER_PATTERN = /^[1-9]\d*$/;
const SHA_PATTERN = /^[0-9a-fA-F]{40}$|^[0-9a-fA-F]{64}$/;

const TOP_LEVEL_KEYS = new Set([
  "provider", "repo", "number", "url", "title", "authorLogin", "state", "body",
  "baseRefName", "baseRefOid", "headRefName", "headRefOid",
  "additions", "deletions", "changedFiles",
  "reviews", "reviewDecision", "stackParent", "threads", "checks", "summary",
  "filePriority", "queue", "nextCandidate",
]);

function fail(detail: string): never {
  throw new Error(`Invalid pull request handoff: ${detail}`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) fail(`${label} must be a non-empty string.`);
  return value.trim();
}

function bodyText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return fail("body must be a string.");
}

function optionalText(value: unknown, label: string): string | undefined {
  return value == null ? undefined : text(value, label);
}

function optionalFlag(value: unknown, label: string): boolean | undefined {
  if (value == null) return undefined;
  if (typeof value !== "boolean") fail(`${label} must be a boolean.`);
  return value;
}

function count(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail(`${label} must be a non-negative integer.`);
  return value;
}

function numberText(value: unknown, label: string): string {
  const raw = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!NUMBER_PATTERN.test(raw)) fail(`${label} must be a positive pull request number.`);
  return raw;
}

export function isSafeRepositoryName(value: string): boolean {
  const parts = value.split("/");
  return parts.length === 2
    && parts.every((part) => REPO_SEGMENT_PATTERN.test(part) && part !== "." && part !== "..");
}

function repoName(value: unknown, label: string): string {
  const raw = text(value, label);
  if (!isSafeRepositoryName(raw)) fail(`${label} must look like owner/repo.`);
  return raw;
}

function sha(value: unknown, label: string): string {
  const raw = text(value, label);
  if (!SHA_PATTERN.test(raw)) fail(`${label} must be a full commit SHA.`);
  return raw.toLowerCase();
}

function refName(value: unknown, label: string): string {
  const raw = text(value, label);
  const unsafe = /[\s~^:?*[\\]/.test(raw) || /[\x00-\x1f\x7f]/.test(raw) || raw.includes("..") || raw.includes("@{") || raw.startsWith("-") || raw.startsWith("/") || raw.endsWith("/") || raw.endsWith(".lock");
  if (unsafe) fail(`${label} must be a safe git ref name.`);
  return raw;
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) fail(`${label} has unsupported field(s): ${unknown.sort().join(", ")}.`);
}

function array<T>(value: unknown, label: string, map: (item: unknown, index: number) => T): T[] {
  if (!Array.isArray(value)) fail(`${label} must be an array.`);
  return value.map(map);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchPathPattern(pathname: string, pattern: ProviderUrlPattern): { repo: string; number: string } | undefined {
  const placeholders: string[] = [];
  let source = "^";
  let cursor = 0;
  for (const match of pattern.path.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)) {
    source += escapeRegex(pattern.path.slice(cursor, match.index));
    const key = match[1]!;
    placeholders.push(key);
    source += key === "repo" ? "([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)" : key === "number" ? "([1-9]\\d*)" : "([^/?#]+)";
    cursor = match.index! + match[0].length;
  }
  source += `${escapeRegex(pattern.path.slice(cursor))}$`;
  const matched = pathname.match(new RegExp(source));
  if (matched == null) return undefined;
  const values = Object.fromEntries(placeholders.map((key, index) => [key, matched[index + 1]]));
  const repo = values.repo;
  const number = values.number;
  return repo != null && isSafeRepositoryName(repo) && number != null && NUMBER_PATTERN.test(number) ? { repo, number } : undefined;
}

export function parseConfiguredPullRequestUrl(input: string, settings = loadPiCodeDiffSettings()): ConfiguredPullRequestUrl | undefined {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.port !== "" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return undefined;

  for (const configured of Object.values(settings.providers)) {
    for (const pattern of configured.urls.patterns) {
      if (url.hostname.toLowerCase() !== pattern.host) continue;
      const matched = matchPathPattern(url.pathname, pattern);
      if (matched == null) continue;
      return {
        provider: configured.id,
        repo: matched.repo,
        number: matched.number,
        canonical: renderProviderTemplate(configured.urls.canonical, matched),
      };
    }
  }
  return undefined;
}

export function canonicalPullRequestUrl(provider: string, repo: string, number: string, settings = loadPiCodeDiffSettings()): string {
  return renderProviderTemplate(requireProviderSettings(provider, settings).urls.canonical, { repo, number });
}

function pullRequestUrl(value: unknown, provider: string, repo: string, number: string, label: string, settings: PiCodeDiffSettings): string {
  const raw = text(value, label);
  const canonical = canonicalPullRequestUrl(provider, repo, number, settings);
  if (raw !== canonical) fail(`${label} must be exactly ${canonical}.`);
  return canonical;
}

function candidateUrl(value: unknown, label: string, settings: PiCodeDiffSettings): string {
  const raw = text(value, label);
  const matched = parseConfiguredPullRequestUrl(raw, settings);
  if (matched == null) fail(`${label} must match a configured pull request URL.`);
  return matched.canonical;
}

function providerId(value: unknown, settings: PiCodeDiffSettings): string {
  const id = text(value, "provider");
  if (settings.providers[id] == null) fail(`provider ${id} is not configured.`);
  return id;
}

function review(item: unknown, index: number): PullRequestHandoffReview {
  const row = record(item, `reviews[${index}]`);
  rejectUnknownKeys(row, new Set(["author", "state"]), `reviews[${index}]`);
  return { author: text(row.author, `reviews[${index}].author`), state: text(row.state, `reviews[${index}].state`).toUpperCase() };
}

function threadComment(item: unknown, threadIndex: number, index: number): PullRequestHandoffThreadComment {
  const label = `threads[${threadIndex}].comments[${index}]`;
  const row = record(item, label);
  rejectUnknownKeys(row, new Set(["author", "body", "createdAt", "state"]), label);
  return {
    author: text(row.author, `${label}.author`),
    body: text(row.body, `${label}.body`),
    createdAt: optionalText(row.createdAt, `${label}.createdAt`),
    state: optionalText(row.state, `${label}.state`),
  };
}

function thread(item: unknown, index: number): PullRequestHandoffThread {
  const label = `threads[${index}]`;
  const row = record(item, label);
  rejectUnknownKeys(row, new Set(["path", "line", "resolved", "outdated", "comments"]), label);
  const comments = array(row.comments, `${label}.comments`, (comment, commentIndex) => threadComment(comment, index, commentIndex));
  if (comments.length === 0) fail(`${label}.comments must not be empty.`);
  return {
    path: optionalText(row.path, `${label}.path`),
    line: row.line == null ? undefined : count(row.line, `${label}.line`),
    resolved: optionalFlag(row.resolved, `${label}.resolved`),
    outdated: optionalFlag(row.outdated, `${label}.outdated`),
    comments,
  };
}

function check(item: unknown, index: number): PullRequestHandoffCheck {
  const label = `checks[${index}]`;
  const row = record(item, label);
  rejectUnknownKeys(row, new Set(["name", "status", "conclusion"]), label);
  return {
    name: text(row.name, `${label}.name`),
    status: optionalText(row.status, `${label}.status`)?.toUpperCase(),
    conclusion: optionalText(row.conclusion, `${label}.conclusion`)?.toUpperCase(),
  };
}

function filePriority(item: unknown, index: number): PullRequestHandoffFilePriority {
  const label = `filePriority[${index}]`;
  const row = record(item, label);
  rejectUnknownKeys(row, new Set(["path", "reason"]), label);
  return { path: text(row.path, `${label}.path`), reason: optionalText(row.reason, `${label}.reason`) };
}

function stackParent(value: unknown, settings: PiCodeDiffSettings): PullRequestHandoffStackParent {
  const row = record(value, "stackParent");
  rejectUnknownKeys(row, new Set(["number", "title", "headRefName", "state", "url"]), "stackParent");
  return {
    number: numberText(row.number, "stackParent.number"),
    title: text(row.title, "stackParent.title"),
    headRefName: refName(row.headRefName, "stackParent.headRefName"),
    state: text(row.state, "stackParent.state").toUpperCase(),
    url: row.url == null ? undefined : candidateUrl(row.url, "stackParent.url", settings),
  };
}

function queue(value: unknown): PullRequestHandoffQueue {
  const row = record(value, "queue");
  rejectUnknownKeys(row, new Set(["position", "total"]), "queue");
  const position = count(row.position, "queue.position");
  if (position < 1) fail("queue.position must be at least 1.");
  const total = row.total == null ? undefined : count(row.total, "queue.total");
  if (total != null && total < position) fail("queue.total must be at least queue.position.");
  return { position, total };
}

function nextCandidate(value: unknown, settings: PiCodeDiffSettings): PullRequestHandoffNextCandidate {
  const row = record(value, "nextCandidate");
  rejectUnknownKeys(row, new Set(["url", "title"]), "nextCandidate");
  return { url: candidateUrl(row.url, "nextCandidate.url", settings), title: optionalText(row.title, "nextCandidate.title") };
}

export function parsePullRequestHandoff(input: unknown, settings = loadPiCodeDiffSettings()): PullRequestHandoff {
  const row = record(input, "pullRequest");
  rejectUnknownKeys(row, TOP_LEVEL_KEYS, "pullRequest");

  const handoffProvider = providerId(row.provider, settings);
  const configuredProvider = requireProviderSettings(handoffProvider, settings);
  const repo = repoName(row.repo, "repo");
  const number = numberText(row.number, "number");
  const baseRefOid = row.baseRefOid == null ? undefined : sha(row.baseRefOid, "baseRefOid");
  if (getProviderCapability(configuredProvider, "baseRevisionRequired") && baseRefOid == null) {
    fail(`baseRefOid is required for provider ${handoffProvider}.`);
  }

  return {
    provider: handoffProvider,
    repo,
    number,
    url: pullRequestUrl(row.url, handoffProvider, repo, number, "url", settings),
    title: text(row.title, "title"),
    authorLogin: text(row.authorLogin, "authorLogin"),
    state: text(row.state, "state").toUpperCase(),
    body: bodyText(row.body),
    baseRefName: refName(row.baseRefName, "baseRefName"),
    baseRefOid,
    headRefName: refName(row.headRefName, "headRefName"),
    headRefOid: sha(row.headRefOid, "headRefOid"),
    additions: count(row.additions, "additions"),
    deletions: count(row.deletions, "deletions"),
    changedFiles: count(row.changedFiles, "changedFiles"),
    reviews: row.reviews == null ? [] : array(row.reviews, "reviews", review),
    reviewDecision: optionalText(row.reviewDecision, "reviewDecision")?.toUpperCase(),
    stackParent: row.stackParent == null ? undefined : stackParent(row.stackParent, settings),
    threads: row.threads == null ? undefined : array(row.threads, "threads", thread),
    checks: row.checks == null ? undefined : array(row.checks, "checks", check),
    summary: optionalText(row.summary, "summary"),
    filePriority: row.filePriority == null ? undefined : array(row.filePriority, "filePriority", filePriority),
    queue: row.queue == null ? undefined : queue(row.queue),
    nextCandidate: row.nextCandidate == null ? undefined : nextCandidate(row.nextCandidate, settings),
  };
}

export function pullRequestMetadataFromHandoff(handoff: PullRequestHandoff): PullRequestMetadata {
  return {
    number: handoff.number,
    repo: handoff.repo,
    title: handoff.title,
    body: handoff.body,
    additions: handoff.additions,
    deletions: handoff.deletions,
    changedFiles: handoff.changedFiles,
    authorLogin: handoff.authorLogin,
    state: handoff.state,
    reviews: handoff.reviews.map((entry) => ({ author: { login: entry.author }, state: entry.state })),
    headRefName: handoff.headRefName,
    headRefOid: handoff.headRefOid,
    baseRefName: handoff.baseRefName,
    baseRefOid: handoff.baseRefOid,
    stackParent: handoff.stackParent,
  };
}

export function hasHandoffContext(handoff: PullRequestHandoff | undefined): boolean {
  return handoff != null && (handoff.summary != null || handoff.threads != null || handoff.checks != null);
}
