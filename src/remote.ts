import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, posix, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getDefaultBranchRef } from "./git.js";
import {
  isSafeRepositoryName,
  parseConfiguredPullRequestUrl,
  pullRequestMetadataFromHandoff,
  type PullRequestHandoff,
} from "./pr-handoff.js";
import type {
  PiCodeDiffSettings,
  ProviderSettings,
  RepositoryProfileSettings,
} from "./provider-settings.js";
import {
  getProviderCapability,
  loadPiCodeDiffSettings,
  readConfiguredField,
  renderProviderOperation,
  renderProviderTemplate,
  requireProviderSettings,
} from "./provider-settings.js";

export type PullRequestProvider = string;

export interface RemoteParseResult {
  branch: string;
  repo?: string;
  prNumber?: string;
  provider?: PullRequestProvider;
}

export interface StackParentMetadata {
  number: string;
  title: string;
  headRefName: string;
  state: string;
  url?: string;
}

export interface PullRequestMetadata {
  number: string;
  repo?: string;
  title: string;
  body: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  authorLogin: string;
  state: string;
  reviews: Array<{ author: { login: string }; state: string }>;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  baseRefOid?: string;
  stackParent?: StackParentMetadata;
}

export interface RemoteReviewTarget {
  gitRoot: string;
  baseRef: string;
  headRef: string;
  remote: string;
  branch: string;
  repo?: string;
  pullRequest?: PullRequestMetadata;
  workspacePath?: string;
  pathspecs?: string[];
  importAliases?: Record<string, string>;
  provider?: PullRequestProvider;
  handoff?: PullRequestHandoff;
}

export type RemoteProgress = (message: string) => void;

export interface RemoteDiscussContinuation {
  kind: "remote-discuss";
  priorSessionId: string;
  priorBaseRevision: string;
  priorHeadRevision: string;
}

export interface RemoteReviewTargetResolutionOptions {
  cacheMode?: "default" | "bypass";
}

function isRemoteReviewTargetResolutionOptions(
  value: PullRequestHandoff | RemoteReviewTargetResolutionOptions | undefined,
): value is RemoteReviewTargetResolutionOptions {
  return value != null && "cacheMode" in value;
}

interface ConfiguredRepositoryProfile {
  gitRoot: string;
  workspacePath?: string;
  pathspecs?: string[];
  importAliases?: Record<string, string>;
}

interface ResolvedRepoRoot extends ConfiguredRepositoryProfile {
  fetchRemote?: string;
}

function originRef(branch: string): string {
  return `refs/remotes/origin/${branch}`;
}

function originShortRef(branch: string): string {
  return `origin/${branch}`;
}

function sourceBranchRef(branch: string): string {
  return `refs/heads/${branch}`;
}

function stripOriginPrefix(ref: string): string {
  return ref.replace(/^origin\//, "");
}

export function extractBranchFromRemote(input: string, settings = loadPiCodeDiffSettings()): RemoteParseResult | null {
  const trimmed = input.trim();
  const pullRequest = parseConfiguredPullRequestUrl(trimmed, settings);
  if (pullRequest != null) {
    return {
      branch: `__pr__${pullRequest.number}`,
      repo: pullRequest.repo,
      prNumber: pullRequest.number,
      provider: pullRequest.provider,
    };
  }
  if (/^[\w./-]+$/.test(trimmed)) return { branch: trimmed };
  return null;
}

function normalizeRepoName(repo: string): string {
  return repo.trim().toLowerCase();
}

function normalizeConfiguredPathspec(value: string): string | undefined {
  if (value.trim().length === 0 || isAbsolute(value)) return undefined;
  const normalized = posix.normalize(value.trim().replace(/\\/g, "/")).replace(/^\.\//, "");
  return normalized === "." || normalized === ".." || normalized.startsWith("../") ? undefined : normalized;
}

function normalizeRepositoryProfile(repo: string, entry: RepositoryProfileSettings): ConfiguredRepositoryProfile | undefined {
  if (!existsSync(entry.cwd)) return undefined;
  const workspacePath = entry.subdir == null ? undefined : normalizeConfiguredPathspec(entry.subdir);
  if (entry.subdir != null && workspacePath == null) throw new Error(`Invalid subdir configured for ${repo}.`);
  const configuredPathspecs = entry.pathspecs?.map(normalizeConfiguredPathspec) ?? [];
  if (configuredPathspecs.some((path) => path == null)) throw new Error(`Invalid pathspec configured for ${repo}.`);
  const pathspecs = configuredPathspecs.length > 0
    ? [...new Set(configuredPathspecs as string[])]
    : workspacePath == null ? undefined : [workspacePath];
  const importAliases = entry.importAliases == null
    ? undefined
    : Object.fromEntries(Object.entries(entry.importAliases).map(([prefix, target]) => {
        const normalized = normalizeConfiguredPathspec(target);
        if (prefix.trim().length === 0 || normalized == null) throw new Error(`Invalid import alias configured for ${repo}.`);
        return [prefix.trim(), normalized];
      }));
  return {
    gitRoot: entry.cwd,
    workspacePath,
    pathspecs,
    importAliases,
  };
}

function getConfiguredRepositoryProfile(repo: string, settings: PiCodeDiffSettings): ConfiguredRepositoryProfile | undefined {
  const entry = settings.repositories[normalizeRepoName(repo)];
  return entry == null ? undefined : normalizeRepositoryProfile(repo, entry);
}

function repoMatchesRemoteUrl(repo: string, remoteUrl: string): boolean {
  const normalizedRepo = normalizeRepoName(repo).replace(/\.git$/, "");
  const normalizedRemote = remoteUrl.trim().toLowerCase().replace(/\.git$/, "");
  return normalizedRemote.endsWith(`/${normalizedRepo}`) || normalizedRemote.endsWith(`:${normalizedRepo}`);
}

async function getMatchingLocalRepoRoot(pi: ExtensionAPI, cwd: string, repo: string): Promise<string | undefined> {
  const rootResult = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 10000 });
  if (rootResult.code !== 0) return undefined;
  const gitRoot = rootResult.stdout.trim();
  if (gitRoot.length === 0) return undefined;
  const remoteResult = await pi.exec("git", ["remote", "get-url", "origin"], { cwd: gitRoot, timeout: 10000 });
  if (remoteResult.code !== 0 || !repoMatchesRemoteUrl(repo, remoteResult.stdout)) return undefined;
  return gitRoot;
}

export function getRemoteCacheRoot(repo: string): string {
  if (!isSafeRepositoryName(repo)) throw new Error(`Invalid repository name: ${repo}.`);
  const safeParts = repo.split("/").map((part) => part.replace(/[^\w.-]/g, "_")).filter(Boolean);
  if (safeParts.some((part) => part === "." || part === "..")) throw new Error(`Invalid repository name: ${repo}.`);
  const root = resolve(process.env.PI_CODE_DIFF_REMOTE_CACHE_ROOT ?? join(homedir(), ".pi", "agent", "cache", "pi-code-diff", "remotes"));
  const candidate = resolve(root, ...safeParts);
  if (!candidate.startsWith(`${root}${sep}`)) throw new Error(`Invalid repository cache path for ${repo}.`);
  return candidate;
}

async function ensureRemoteCacheRepo(pi: ExtensionAPI, repo: string, onProgress?: RemoteProgress): Promise<string> {
  const gitRoot = getRemoteCacheRoot(repo);
  onProgress?.(`Preparing remote review cache for ${repo}…`);
  await mkdir(gitRoot, { recursive: true });
  if (!existsSync(join(gitRoot, ".git"))) {
    const result = await pi.exec("git", ["init"], { cwd: gitRoot, timeout: 10000 });
    if (result.code !== 0) throw new Error(result.stderr || result.stdout || `Could not initialize remote review cache for ${repo}.`);
  }
  const ok = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd: gitRoot, timeout: 10000 });
  if (ok.code !== 0) throw new Error(`Remote review cache is not a usable git repository at ${gitRoot}.`);
  return ok.stdout.trim() || gitRoot;
}

async function validateConfiguredRepoRoot(pi: ExtensionAPI, repo: string, gitRoot: string): Promise<void> {
  const remoteResult = await pi.exec("git", ["remote", "get-url", "--all", "origin"], { cwd: gitRoot, timeout: 10000 });
  const matches = remoteResult.code === 0 && remoteResult.stdout.split(/\r?\n/).some((url) => repoMatchesRemoteUrl(repo, url));
  if (!matches) throw new Error(`Configured checkout ${gitRoot} does not match ${repo}.`);
}

async function resolveRepoRoot(
  pi: ExtensionAPI,
  fallbackCwd: string,
  repo: string | undefined,
  explicitCwd: string | undefined,
  settings: PiCodeDiffSettings,
  provider: ProviderSettings | undefined,
  onProgress?: RemoteProgress,
): Promise<ResolvedRepoRoot> {
  if (explicitCwd != null) {
    onProgress?.(`Using local checkout ${explicitCwd}…`);
    return { gitRoot: explicitCwd };
  }
  if (repo == null) {
    onProgress?.("Using current repository for remote branch review…");
    return { gitRoot: fallbackCwd };
  }

  const configuredProfile = getConfiguredRepositoryProfile(repo, settings);
  if (configuredProfile != null) {
    await validateConfiguredRepoRoot(pi, repo, configuredProfile.gitRoot);
    onProgress?.(`Using configured checkout for ${repo}${configuredProfile.workspacePath == null ? "" : ` at ${configuredProfile.workspacePath}`}…`);
    return configuredProfile;
  }

  const localRoot = await getMatchingLocalRepoRoot(pi, fallbackCwd, repo);
  if (localRoot != null) {
    onProgress?.(`Using current checkout for ${repo}…`);
    return { gitRoot: localRoot };
  }

  if (provider?.urls.clone == null) throw new Error(`Provider ${provider?.id ?? "unknown"} does not configure a clone URL.`);
  return {
    gitRoot: await ensureRemoteCacheRepo(pi, repo, onProgress),
    fetchRemote: renderProviderTemplate(provider.urls.clone, { repo }),
  };
}

function isDefaultBaseBranch(branch: string): boolean {
  return branch === "main" || branch === "master";
}

function parseJson(value: string, provider: ProviderSettings, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`Malformed ${provider.label} response for ${label}.`);
  }
}

function configuredString(provider: ProviderSettings, field: string, value: unknown, label: string, optional = false): string | undefined {
  const configured = readConfiguredField(provider, field, value);
  if (configured == null && optional) return undefined;
  if (typeof configured !== "string" || configured.length === 0) throw new Error(`Malformed ${provider.label} response: ${label} is missing.`);
  return configured;
}

function configuredNumber(provider: ProviderSettings, field: string, value: unknown, label: string): number {
  const configured = readConfiguredField(provider, field, value);
  if (typeof configured !== "number" || !Number.isFinite(configured) || configured < 0) {
    throw new Error(`Malformed ${provider.label} response: ${label} is invalid.`);
  }
  return configured;
}

function configuredPrNumber(provider: ProviderSettings, value: unknown, label: string): string {
  const configured = readConfiguredField(provider, "number", value);
  const number = typeof configured === "number" && Number.isSafeInteger(configured) ? String(configured) : typeof configured === "string" ? configured : "";
  if (!/^[1-9]\d*$/.test(number)) throw new Error(`Malformed ${provider.label} response: ${label} is invalid.`);
  return number;
}

async function executeProviderOperation(
  pi: ExtensionAPI,
  gitRoot: string,
  provider: ProviderSettings,
  operation: string,
  values: Record<string, string | number>,
  timeout: number,
): Promise<string> {
  const rendered = renderProviderOperation(provider, operation, values);
  const result = await pi.exec(provider.executable, rendered.args, { cwd: gitRoot, timeout });
  if (result.code !== 0 || result.stdout.trim().length === 0) {
    throw new Error(`Could not run ${provider.label} ${operation}: ${result.stderr || result.stdout || "empty response"}`);
  }
  return result.stdout.trim();
}

function parseReview(provider: ProviderSettings, value: unknown, index: number): PullRequestMetadata["reviews"][number] {
  const login = configuredString(provider, "author", value, `reviews[${index}].author`)!;
  const state = configuredString(provider, "reviewState", value, `reviews[${index}].state`)!;
  return { author: { login }, state };
}

async function getProviderReviews(
  pi: ExtensionAPI,
  gitRoot: string,
  provider: ProviderSettings,
  repo: string,
  prNumber: string,
): Promise<PullRequestMetadata["reviews"]> {
  if (provider.operations.reviews == null) return [];
  const output = await executeProviderOperation(pi, gitRoot, provider, "reviews", { repo, number: prNumber }, 30000);
  const parsed = parseJson(output, provider, `PR #${prNumber} reviews`);
  if (!Array.isArray(parsed)) throw new Error(`Malformed ${provider.label} response for PR #${prNumber} reviews.`);
  return parsed.map((review, index) => parseReview(provider, review, index));
}

async function getConfiguredPullRequestMetadata(
  pi: ExtensionAPI,
  gitRoot: string,
  prNumber: string,
  repo: string,
  provider: ProviderSettings,
  onProgress?: RemoteProgress,
  includeStackParent = true,
): Promise<PullRequestMetadata> {
  onProgress?.(`Fetching PR #${prNumber} metadata from ${repo} with ${provider.label}…`);
  const output = await executeProviderOperation(pi, gitRoot, provider, "pullRequest", { repo, number: prNumber }, 30000);
  const parsed = parseJson(output, provider, `PR #${prNumber}`);
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Malformed ${provider.label} response for PR #${prNumber}.`);
  if (configuredPrNumber(provider, parsed, "number") !== prNumber) {
    throw new Error(`Malformed ${provider.label} response: PR number does not match #${prNumber}.`);
  }

  const baseRefOid = configuredString(provider, "baseRefOid", parsed, "baseRefOid", true);
  if (getProviderCapability(provider, "baseRevisionRequired") && baseRefOid == null) {
    throw new Error(`Malformed ${provider.label} response: baseRefOid is missing.`);
  }
  const metadata: PullRequestMetadata = {
    number: prNumber,
    repo,
    title: configuredString(provider, "title", parsed, "title")!,
    body: configuredString(provider, "body", parsed, "body", true) ?? "",
    additions: configuredNumber(provider, "additions", parsed, "additions"),
    deletions: configuredNumber(provider, "deletions", parsed, "deletions"),
    changedFiles: configuredNumber(provider, "changedFiles", parsed, "changedFiles"),
    authorLogin: configuredString(provider, "author", parsed, "author")!,
    state: configuredString(provider, "state", parsed, "state")!.toUpperCase(),
    reviews: await getProviderReviews(pi, gitRoot, provider, repo, prNumber),
    headRefName: configuredString(provider, "headRefName", parsed, "headRefName")!,
    headRefOid: configuredString(provider, "headRefOid", parsed, "headRefOid")!,
    baseRefName: configuredString(provider, "baseRefName", parsed, "baseRefName")!,
    baseRefOid,
  };
  if (includeStackParent) metadata.stackParent = await getStackParentMetadataForHead(pi, gitRoot, metadata.baseRefName, repo, provider, onProgress);
  return metadata;
}

async function getStackParentMetadataForHead(
  pi: ExtensionAPI,
  gitRoot: string,
  headRefName: string,
  repo: string,
  provider: ProviderSettings,
  onProgress?: RemoteProgress,
): Promise<StackParentMetadata | undefined> {
  if (isDefaultBaseBranch(headRefName) || provider.operations.branchLookup == null) return undefined;
  onProgress?.(`Checking stack parent PR for ${headRefName}…`);
  let output: string;
  try {
    output = await executeProviderOperation(pi, gitRoot, provider, "branchLookup", { repo, branch: headRefName }, 15000);
  } catch {
    return undefined;
  }
  const parsed = parseJson(output, provider, `branch ${headRefName}`);
  const candidate = Array.isArray(parsed) ? parsed[0] : parsed;
  if (candidate == null) return undefined;
  let number: string;
  try {
    number = configuredPrNumber(provider, candidate, "number");
  } catch {
    return undefined;
  }
  try {
    const metadata = await getConfiguredPullRequestMetadata(pi, gitRoot, number, repo, provider, undefined, false);
    return {
      number,
      title: metadata.title,
      headRefName: metadata.headRefName,
      state: metadata.state,
      url: renderProviderTemplate(provider.urls.canonical, { repo, number }),
    };
  } catch {
    return undefined;
  }
}

export async function getPullRequestMetadata(
  pi: ExtensionAPI,
  gitRoot: string,
  prNumber: string,
  repo?: string,
  onProgress?: RemoteProgress,
  providerId?: PullRequestProvider,
  settings = loadPiCodeDiffSettings(),
): Promise<PullRequestMetadata> {
  if (repo == null) throw new Error(`Could not resolve PR #${prNumber}: repository is unknown.`);
  const configuredIds = Object.keys(settings.providers);
  const resolvedProviderId = providerId ?? (configuredIds.length === 1 ? configuredIds[0] : undefined);
  if (resolvedProviderId == null) throw new Error(`Could not resolve PR #${prNumber}: provider is unknown.`);
  return getConfiguredPullRequestMetadata(pi, gitRoot, prNumber, repo, requireProviderSettings(resolvedProviderId, settings), onProgress);
}

async function fetchRemoteRefs(
  pi: ExtensionAPI,
  gitRoot: string,
  refspecs: string[],
  remote = "origin",
  onProgress?: RemoteProgress,
): Promise<void> {
  onProgress?.(`Fetching remote refs from ${remote === "origin" ? "origin" : "configured remote"}…`);
  const result = await pi.exec("git", ["--no-pager", "fetch", "--no-tags", remote, ...refspecs], { cwd: gitRoot, timeout: 60000 });
  if (result.killed) throw new Error(`Timed out fetching remote refs after 60s. stderr: ${result.stderr || "(none)"}`);
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || "Failed to fetch remote refs.");
}

async function getMergeBase(pi: ExtensionAPI, gitRoot: string, baseRef: string, headRef: string): Promise<string> {
  const result = await pi.exec("git", ["merge-base", baseRef, headRef], { cwd: gitRoot, timeout: 10000 });
  const mergeBase = result.code === 0 ? result.stdout.trim().split("\n").pop()?.trim() : undefined;
  return mergeBase != null && mergeBase.length > 0 ? mergeBase : baseRef;
}

function configuredTrackingBranch(provider: ProviderSettings, key: string, values: Record<string, string | number>): string {
  const template = provider.refs[key];
  if (template == null) throw new Error(`Provider ${provider.id} does not configure ref ${key}.`);
  const rendered = renderProviderTemplate(template, values)
    .replace(/^refs\/remotes\/origin\//, "")
    .replace(/^refs\/heads\//, "");
  const unsafe = rendered.length === 0 || /[\s~^:?*[\\]/.test(rendered) || rendered.includes("..") || rendered.startsWith("-") || rendered.startsWith("/") || rendered.endsWith("/") || rendered.endsWith(".lock");
  if (unsafe) throw new Error(`Provider ${provider.id} rendered an invalid ${key} ref.`);
  return rendered;
}

async function fetchBranchBasedPullRequestRefs(
  pi: ExtensionAPI,
  gitRoot: string,
  metadata: PullRequestMetadata,
  provider: ProviderSettings,
  remote = "origin",
  onProgress?: RemoteProgress,
): Promise<{ baseRef: string; headRef: string }> {
  const baseBranch = metadata.baseRefName;
  try {
    await fetchRemoteRefs(pi, gitRoot, [
      `+${sourceBranchRef(baseBranch)}:${originRef(baseBranch)}`,
      `+${sourceBranchRef(metadata.headRefName)}:${originRef(metadata.headRefName)}`,
    ], remote, onProgress);
    const baseRef = originShortRef(baseBranch);
    const headRef = originShortRef(metadata.headRefName);
    return { baseRef: await getMergeBase(pi, gitRoot, baseRef, headRef), headRef };
  } catch {
    const headSource = provider.refs.head;
    if (headSource == null) throw new Error(`Provider ${provider.id} does not configure a fallback head ref.`);
    const values = { repo: metadata.repo ?? "", number: metadata.number };
    const sourceRef = renderProviderTemplate(headSource, values);
    const headBranch = `review/${provider.id}/${metadata.number}/head`;
    const pullRemote = remote !== "origin"
      ? remote
      : provider.urls.clone == null || metadata.repo == null
        ? remote
        : renderProviderTemplate(provider.urls.clone, { repo: metadata.repo });
    await fetchRemoteRefs(pi, gitRoot, [
      `+${sourceBranchRef(baseBranch)}:${originRef(baseBranch)}`,
      `+${sourceRef}:${originRef(headBranch)}`,
    ], pullRemote, onProgress);
    const baseRef = originShortRef(baseBranch);
    const headRef = originShortRef(headBranch);
    return { baseRef: await getMergeBase(pi, gitRoot, baseRef, headRef), headRef };
  }
}

async function fetchRevisionPinnedPullRequestRefs(
  pi: ExtensionAPI,
  gitRoot: string,
  metadata: PullRequestMetadata,
  provider: ProviderSettings,
  remote = "origin",
  onProgress?: RemoteProgress,
): Promise<{ baseRef: string; headRef: string }> {
  if (metadata.baseRefOid == null) throw new Error(`${provider.label} PR #${metadata.number} metadata is missing base revision.`);
  const values = { repo: metadata.repo ?? "", number: metadata.number };
  const baseBranch = configuredTrackingBranch(provider, "base", values);
  const headBranch = configuredTrackingBranch(provider, "head", values);
  await fetchRemoteRefs(pi, gitRoot, [
    `+${sourceBranchRef(metadata.baseRefName)}:${originRef(baseBranch)}`,
    `+${sourceBranchRef(metadata.headRefName)}:${originRef(headBranch)}`,
  ], remote, onProgress);

  const headResult = await pi.exec("git", ["rev-parse", originRef(headBranch)], { cwd: gitRoot, timeout: 10000 });
  const fetchedHead = headResult.code === 0 ? headResult.stdout.trim().toLowerCase() : "";
  if (fetchedHead !== metadata.headRefOid.toLowerCase()) {
    throw new Error(`${provider.label} PR #${metadata.number} head changed while preparing the review. Reopen it to review the latest head.`);
  }
  const baseRef = originShortRef(baseBranch);
  const headRef = originShortRef(headBranch);
  return { baseRef: await getMergeBase(pi, gitRoot, baseRef, headRef), headRef };
}

async function fetchPullRequestRefs(
  pi: ExtensionAPI,
  gitRoot: string,
  metadata: PullRequestMetadata,
  provider: ProviderSettings,
  remote = "origin",
  onProgress?: RemoteProgress,
): Promise<{ baseRef: string; headRef: string }> {
  return getProviderCapability(provider, "baseRevisionRequired")
    ? fetchRevisionPinnedPullRequestRefs(pi, gitRoot, metadata, provider, remote, onProgress)
    : fetchBranchBasedPullRequestRefs(pi, gitRoot, metadata, provider, remote, onProgress);
}

async function fetchPlainRemoteBranch(pi: ExtensionAPI, gitRoot: string, branch: string, onProgress?: RemoteProgress): Promise<{ baseRef: string; headRef: string }> {
  const defaultBranchRef = await getDefaultBranchRef(pi, gitRoot);
  const baseBranch = stripOriginPrefix(defaultBranchRef ?? "origin/main");
  await fetchRemoteRefs(pi, gitRoot, [
    `+${sourceBranchRef(baseBranch)}:${originRef(baseBranch)}`,
    `+${sourceBranchRef(branch)}:${originRef(branch)}`,
  ], "origin", onProgress);
  return { baseRef: originShortRef(baseBranch), headRef: originShortRef(branch) };
}

const REMOTE_TARGET_CACHE_TTL_MS = 10 * 60 * 1000;
const remoteTargetCache = new Map<string, { target: RemoteReviewTarget; expiresAt: number }>();

export function clearRemoteReviewTargetCache(): void {
  remoteTargetCache.clear();
}

function assertHandoffMatchesTarget(handoff: PullRequestHandoff, parsed: RemoteParseResult, remote: string): void {
  if (parsed.prNumber == null || parsed.repo == null || parsed.provider == null) throw new Error(`Supplied pull request metadata requires a pull request target, not: ${remote}`);
  if (parsed.prNumber !== handoff.number) throw new Error(`Supplied pull request metadata is for PR #${handoff.number}, but the review target is PR #${parsed.prNumber}.`);
  if (normalizeRepoName(parsed.repo) !== normalizeRepoName(handoff.repo)) throw new Error(`Supplied pull request metadata is for ${handoff.repo}, but the review target is ${parsed.repo}.`);
  if (parsed.provider !== handoff.provider) throw new Error(`Supplied pull request metadata is for ${handoff.provider}, but the review target is ${parsed.provider}.`);
}

async function verifySuppliedHeadRevision(pi: ExtensionAPI, gitRoot: string, headRef: string, metadata: PullRequestMetadata): Promise<void> {
  const result = await pi.exec("git", ["rev-parse", headRef], { cwd: gitRoot, timeout: 10000 });
  const fetched = result.code === 0 ? result.stdout.trim().toLowerCase() : "";
  if (fetched !== metadata.headRefOid.toLowerCase()) {
    throw new Error(`PR #${metadata.number} changed since the supplied metadata was prepared (expected head ${metadata.headRefOid}, fetched ${fetched.length === 0 ? "nothing" : fetched}). Reopen it to review the latest head.`);
  }
}

export async function resolveRemoteReviewTarget(
  pi: ExtensionAPI,
  fallbackCwd: string,
  remote: string,
  explicitCwd?: string,
  onProgress?: RemoteProgress,
  handoffOrOptions?: PullRequestHandoff | RemoteReviewTargetResolutionOptions,
  explicitOptions?: RemoteReviewTargetResolutionOptions,
): Promise<RemoteReviewTarget> {
  const handoff = isRemoteReviewTargetResolutionOptions(handoffOrOptions) ? undefined : handoffOrOptions;
  const options = isRemoteReviewTargetResolutionOptions(handoffOrOptions) ? handoffOrOptions : explicitOptions;
  const settings = loadPiCodeDiffSettings();
  const parsed = extractBranchFromRemote(remote, settings);
  if (parsed == null) throw new Error(`Could not extract branch name from: ${remote}`);
  if (handoff != null) assertHandoffMatchesTarget(handoff, parsed, remote);

  const provider = parsed.provider == null ? undefined : requireProviderSettings(parsed.provider, settings);
  const normalizedRemote = parsed.repo != null && parsed.prNumber != null && provider != null
    ? renderProviderTemplate(provider.urls.canonical, { repo: parsed.repo, number: parsed.prNumber })
    : remote.trim();
  const cacheKey = JSON.stringify([normalizedRemote, explicitCwd ?? "", parsed.repo == null ? fallbackCwd : ""]);
  const useCache = handoff == null && options?.cacheMode !== "bypass";
  const cached = useCache ? remoteTargetCache.get(cacheKey) : undefined;
  if (cached != null && cached.expiresAt > Date.now()) {
    onProgress?.(`Using cached remote review for ${remote}…`);
    return cached.target;
  }
  if (cached != null) remoteTargetCache.delete(cacheKey);

  onProgress?.(`Preparing remote review for ${remote}…`);
  const { gitRoot, fetchRemote, workspacePath, pathspecs, importAliases } = await resolveRepoRoot(
    pi,
    fallbackCwd,
    parsed.repo,
    explicitCwd,
    settings,
    provider,
    onProgress,
  );

  if (parsed.prNumber != null && parsed.repo != null && provider != null) {
    const pullRequest = handoff == null
      ? await getConfiguredPullRequestMetadata(pi, gitRoot, parsed.prNumber, parsed.repo, provider, onProgress)
      : pullRequestMetadataFromHandoff(handoff);
    if (handoff != null) onProgress?.(`Using supplied PR #${handoff.number} metadata…`);
    const refs = await fetchPullRequestRefs(pi, gitRoot, pullRequest, provider, fetchRemote, onProgress);
    if (handoff != null && !getProviderCapability(provider, "baseRevisionRequired")) {
      onProgress?.(`Verifying PR #${pullRequest.number} head commit…`);
      await verifySuppliedHeadRevision(pi, gitRoot, refs.headRef, pullRequest);
    }
    const target: RemoteReviewTarget = {
      gitRoot,
      baseRef: refs.baseRef,
      headRef: refs.headRef,
      remote: normalizedRemote,
      branch: pullRequest.headRefName,
      repo: parsed.repo,
      pullRequest,
      workspacePath,
      pathspecs,
      importAliases,
      provider: provider.id,
      handoff,
    };
    if (handoff == null) remoteTargetCache.set(cacheKey, { target, expiresAt: Date.now() + REMOTE_TARGET_CACHE_TTL_MS });
    return target;
  }

  const refs = await fetchPlainRemoteBranch(pi, gitRoot, parsed.branch, onProgress);
  const target: RemoteReviewTarget = {
    gitRoot,
    baseRef: refs.baseRef,
    headRef: refs.headRef,
    remote,
    branch: parsed.branch,
    repo: parsed.repo,
    workspacePath,
    pathspecs,
    importAliases,
  };
  remoteTargetCache.set(cacheKey, { target, expiresAt: Date.now() + REMOTE_TARGET_CACHE_TTL_MS });
  return target;
}

export function formatPullRequestContext(metadata: PullRequestMetadata): string {
  const reviewerMap = new Map<string, string>();
  for (const review of metadata.reviews) reviewerMap.set(review.author.login, review.state);
  const reviews = [...reviewerMap.entries()]
    .map(([login, state]) => `${login} (${state.toLowerCase().replace(/_/g, " ")})`)
    .join(", ") || "none yet";
  const repoLabel = metadata.repo == null ? "" : ` (${metadata.repo})`;
  const baseContext = metadata.stackParent != null
    ? `Stack parent: PR #${metadata.stackParent.number} ${metadata.stackParent.title} (${metadata.stackParent.headRefName}, ${metadata.stackParent.state.toLowerCase()})`
    : isDefaultBaseBranch(metadata.baseRefName) ? undefined : `Base branch: ${metadata.baseRefName}`;
  return [
    `PR #${metadata.number}${repoLabel}: ${metadata.title}`,
    `Author: ${metadata.authorLogin} | State: ${metadata.state.toLowerCase()}`,
    `${metadata.changedFiles} file(s) changed, +${metadata.additions} -${metadata.deletions}`,
    ...(baseContext == null ? [] : [baseContext]),
    `Reviews: ${reviews}`,
  ].join("\n");
}
