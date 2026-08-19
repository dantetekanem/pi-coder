import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, posix, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isReviewableFilePath, type ReviewPathPolicy } from "./path-policy.js";
import type { ChangeStatus, ReviewFile, ReviewFileComparison, ReviewFileContents, ReviewScope, ReviewSubmoduleByScope, ReviewSubmoduleInfo } from "./types.js";

export { isReviewableFilePath } from "./path-policy.js";
export type { ReviewPathPolicy } from "./path-policy.js";

export interface ChangedPath {
  status: ChangeStatus;
  oldPath: string | null;
  newPath: string | null;
}

export interface ChangeStats {
  additions: number;
  deletions: number;
}

export interface RawDiffChange extends ChangedPath {
  oldMode: string;
  newMode: string;
  oldSha: string;
  newSha: string;
}

export interface ReviewWindowData {
  repoRoot: string;
  files: ReviewFile[];
  branchBaseRevision: string | null;
  modifiedRevision?: string;
  visibleScopes: ReviewScope[];
  workspacePath?: string;
}

export interface ReviewWindowOptions extends ReviewPathPolicy {
  wholeRepo?: boolean;
  pathspecs?: string[];
  workspacePath?: string;
  importAliases?: Record<string, string>;
}

export interface RevisionRangeOptions extends ReviewPathPolicy {
  mergeBase?: boolean;
  wholeRepo?: boolean;
  pathspecs?: string[];
  workspacePath?: string;
  importAliases?: Record<string, string>;
}

export const MAX_REVIEW_FILE_BYTES = 1_000_000;
export const MAX_REVIEW_FILE_COUNT = 500;
const IMPORT_SOURCE_EXTENSIONS = new Set([".cjs", ".js", ".jsx", ".mjs", ".ts", ".tsx"]);
const MONOREPO_WORKSPACE_ROOTS = new Set(["apps", "areas", "modules", "packages", "services"]);
const LOCAL_GIT_TIMEOUT_MS = 30_000;

interface ReviewFileSeed {
  path: string;
  worktreeStatus: ChangeStatus | null;
  hasWorkingTreeFile: boolean;
  inGitDiff: boolean;
  inLastCommit: boolean;
  inAllFiles: boolean;
  gitDiff: ReviewFileComparison | null;
  lastCommit: ReviewFileComparison | null;
  allFiles: ReviewFileComparison | null;
  allFilesReferenceCount: number;
  allFilesOutgoingReferences: string[];
  allFilesIncomingReferences: string[];
  submodule?: ReviewSubmoduleByScope;
}

async function runGit(pi: ExtensionAPI, repoRoot: string, args: string[]): Promise<string> {
  const result = await pi.exec("git", args, { cwd: repoRoot, timeout: LOCAL_GIT_TIMEOUT_MS });
  if (result.code !== 0) {
    const message = result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`;
    throw new Error(message);
  }
  return result.stdout;
}

async function runGitAllowFailure(pi: ExtensionAPI, repoRoot: string, args: string[]): Promise<string> {
  const result = await pi.exec("git", args, { cwd: repoRoot, timeout: LOCAL_GIT_TIMEOUT_MS });
  if (result.code !== 0) return "";
  return result.stdout;
}

export async function getRepoRoot(pi: ExtensionAPI, cwd: string): Promise<string> {
  const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: LOCAL_GIT_TIMEOUT_MS });
  if (result.code !== 0) {
    throw new Error("Not inside a git repository.");
  }
  return result.stdout.trim();
}

async function hasHead(pi: ExtensionAPI, repoRoot: string): Promise<boolean> {
  const result = await pi.exec("git", ["rev-parse", "--verify", "HEAD"], { cwd: repoRoot, timeout: LOCAL_GIT_TIMEOUT_MS });
  return result.code === 0;
}

export function parseNameStatus(output: string): ChangedPath[] {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const changes: ChangedPath[] = [];

  for (const line of lines) {
    const parts = line.split("\t");
    const rawStatus = parts[0] ?? "";
    const code = rawStatus[0];

    if (code === "R") {
      const oldPath = parts[1] ?? null;
      const newPath = parts[2] ?? null;
      if (oldPath != null && newPath != null) {
        changes.push({ status: "renamed", oldPath, newPath });
      }
      continue;
    }

    if (code === "M") {
      const path = parts[1] ?? null;
      if (path != null) changes.push({ status: "modified", oldPath: path, newPath: path });
      continue;
    }

    if (code === "A") {
      const path = parts[1] ?? null;
      if (path != null) changes.push({ status: "added", oldPath: null, newPath: path });
      continue;
    }

    if (code === "D") {
      const path = parts[1] ?? null;
      if (path != null) changes.push({ status: "deleted", oldPath: path, newPath: null });
    }
  }

  return changes;
}

function parseRawStatus(rawStatus: string): ChangeStatus | null {
  const code = rawStatus[0];
  if (code === "M" || code === "T") return "modified";
  if (code === "A") return "added";
  if (code === "D") return "deleted";
  if (code === "R") return "renamed";
  return null;
}

export function parseRawDiff(output: string): RawDiffChange[] {
  const fields = output.split("\0").filter((field) => field.length > 0);
  const changes: RawDiffChange[] = [];

  for (let index = 0; index < fields.length;) {
    const header = fields[index++];
    if (header == null || !header.startsWith(":")) continue;
    const parts = header.slice(1).split(" ");
    const status = parseRawStatus(parts[4] ?? "");
    if (status == null) continue;
    const oldPath = fields[index++] ?? null;
    const newPath = status === "renamed" ? fields[index++] ?? null : oldPath;
    if (oldPath == null) continue;
    changes.push({
      status,
      oldPath: status === "added" ? null : oldPath,
      newPath: status === "deleted" ? null : newPath,
      oldMode: parts[0] ?? "",
      newMode: parts[1] ?? "",
      oldSha: parts[2] ?? "",
      newSha: parts[3] ?? "",
    });
  }

  return changes;
}

export function parseUntrackedPaths(output: string): ChangedPath[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((path) => ({ status: "added" as const, oldPath: null, newPath: path }));
}

export function parseStatusPorcelain(output: string): ChangedPath[] {
  const entries = output.split("\0");
  const changes: ChangedPath[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry == null || entry.length < 4) continue;

    const indexStatus = entry[0] ?? " ";
    const worktreeStatus = entry[1] ?? " ";
    const path = entry.slice(3);
    if (path.length === 0 || (indexStatus === "!" && worktreeStatus === "!")) continue;

    if (indexStatus === "?" && worktreeStatus === "?") {
      changes.push({ status: "added", oldPath: null, newPath: path });
      continue;
    }

    if (indexStatus === "R" || worktreeStatus === "R") {
      const oldPath = entries[index + 1] ?? null;
      if (oldPath != null && oldPath.length > 0) {
        changes.push({ status: "renamed", oldPath, newPath: path });
        index += 1;
      } else {
        changes.push({ status: "modified", oldPath: path, newPath: path });
      }
      continue;
    }

    if (indexStatus === "C" || worktreeStatus === "C" || indexStatus === "A" || worktreeStatus === "A") {
      changes.push({ status: "added", oldPath: null, newPath: path });
      continue;
    }

    if (indexStatus === "D" || worktreeStatus === "D") {
      changes.push({ status: "deleted", oldPath: path, newPath: null });
      continue;
    }

    if (indexStatus !== " " || worktreeStatus !== " ") {
      changes.push({ status: "modified", oldPath: path, newPath: path });
    }
  }

  return changes;
}

function parseTrackedPaths(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function mergeChangedPaths(tracked: ChangedPath[], untracked: ChangedPath[]): ChangedPath[] {
  const seen = new Set(tracked.map((change) => `${change.status}:${change.oldPath ?? ""}:${change.newPath ?? ""}`));
  const merged = [...tracked];

  for (const change of untracked) {
    const key = `${change.status}:${change.oldPath ?? ""}:${change.newPath ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(change);
  }

  return merged;
}

function getChangedPathCoverage(changes: ChangedPath[]): Set<string> {
  const paths = new Set<string>();
  for (const change of changes) {
    if (change.oldPath != null) paths.add(normalizeGitPath(change.oldPath));
    if (change.newPath != null) paths.add(normalizeGitPath(change.newPath));
  }
  return paths;
}

function mergeMissingChangedPaths(primary: ChangedPath[], supplemental: ChangedPath[]): ChangedPath[] {
  const coveredPaths = getChangedPathCoverage(primary);
  const merged = [...primary];

  for (const change of supplemental) {
    const paths = [change.oldPath, change.newPath]
      .filter((path): path is string => path != null)
      .map(normalizeGitPath);
    if (paths.length === 0 || paths.every((path) => coveredPaths.has(path))) continue;
    for (const path of paths) coveredPaths.add(path);
    merged.push(change);
  }

  return merged;
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

function parseStatCount(value: string | undefined): number {
  if (value == null || value === "-") return 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeNumStatPath(path: string): string {
  if (!path.includes(" => ")) return path;
  const expanded = path.replace(/\{[^{}]* => ([^{}]*)\}/g, "$1");
  if (!expanded.includes(" => ")) return expanded;
  return expanded.split(" => ").pop() ?? expanded;
}

export function parseNumStat(output: string): Map<string, ChangeStats> {
  const stats = new Map<string, ChangeStats>();

  for (const line of output.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const parts = line.split("\t");
    const rawPath = parts.slice(2).join("\t");
    if (rawPath.length === 0) continue;
    stats.set(normalizeGitPath(normalizeNumStatPath(rawPath)), {
      additions: parseStatCount(parts[0]),
      deletions: parseStatCount(parts[1]),
    });
  }

  return stats;
}

function countContentLines(content: string): number {
  if (content.length === 0) return 0;
  const lines = content.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}

function toDisplayPath(change: ChangedPath): string {
  if (change.status === "renamed") {
    return `${change.oldPath ?? ""} -> ${change.newPath ?? ""}`;
  }
  return change.newPath ?? change.oldPath ?? "(unknown)";
}

function toComparison(
  change: ChangedPath,
  stats?: ChangeStats,
  revisions?: { originalRevision?: string | null; modifiedRevision?: string | null },
  raw?: RawDiffChange,
): ReviewFileComparison {
  const originalBlobSha = raw == null ? undefined : readComparisonBlobSha(change.oldPath, raw.oldSha);
  const modifiedBlobSha = raw == null ? undefined : readComparisonBlobSha(change.newPath, raw.newSha);
  return {
    status: change.status,
    oldPath: change.oldPath,
    newPath: change.newPath,
    displayPath: toDisplayPath(change),
    hasOriginal: change.oldPath != null,
    hasModified: change.newPath != null,
    additions: stats?.additions,
    deletions: stats?.deletions,
    originalRevision: revisions?.originalRevision,
    modifiedRevision: revisions?.modifiedRevision,
    ...(originalBlobSha === undefined ? {} : { originalBlobSha }),
    ...(modifiedBlobSha === undefined ? {} : { modifiedBlobSha }),
  };
}

function buildReviewFileId(
  path: string,
  hasWorkingTreeFile: boolean,
  gitDiff: ReviewFileComparison | null,
  lastCommit: ReviewFileComparison | null,
  allFiles: ReviewFileComparison | null,
): string {
  return [path, hasWorkingTreeFile ? "working" : "gone", gitDiff?.displayPath ?? "", lastCommit?.displayPath ?? "", allFiles?.displayPath ?? ""].join("::");
}

function createReviewFile(seed: ReviewFileSeed): ReviewFile {
  return {
    id: buildReviewFileId(seed.path, seed.hasWorkingTreeFile, seed.gitDiff, seed.lastCommit, seed.allFiles),
    path: seed.path,
    worktreeStatus: seed.worktreeStatus,
    hasWorkingTreeFile: seed.hasWorkingTreeFile,
    inGitDiff: seed.inGitDiff,
    inLastCommit: seed.inLastCommit,
    inAllFiles: seed.inAllFiles,
    gitDiff: seed.gitDiff,
    lastCommit: seed.lastCommit,
    allFiles: seed.allFiles,
    allFilesReferenceCount: seed.allFilesReferenceCount,
    allFilesOutgoingReferences: seed.allFilesOutgoingReferences,
    allFilesIncomingReferences: seed.allFilesIncomingReferences,
    submodule: seed.submodule,
  };
}

export function isPathInside(parentPath: string, childPath: string): boolean {
  const relativePath = relative(parentPath, childPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

export function isReviewFileSizeAllowed(size: number): boolean {
  return size <= MAX_REVIEW_FILE_BYTES;
}

export function limitReviewItems<T>(items: T[]): T[] {
  return items.length <= MAX_REVIEW_FILE_COUNT ? items : items.slice(0, MAX_REVIEW_FILE_COUNT);
}

export async function mapWithConcurrency<T, R>(items: T[], limit: number, mapper: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(Math.floor(limit), items.length));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index]!, index);
    }
  }));
  return results;
}

interface LoadedReviewContent {
  content: string;
  available: boolean;
}

async function getRevisionContentResult(pi: ExtensionAPI, repoRoot: string, revision: string, path: string): Promise<LoadedReviewContent> {
  const objectSpec = `${revision}:${path}`;
  const sizeResult = await pi.exec("git", ["cat-file", "-s", objectSpec], { cwd: repoRoot });
  if (sizeResult.code === 0) {
    const size = Number.parseInt(sizeResult.stdout.trim(), 10);
    if (Number.isFinite(size) && !isReviewFileSizeAllowed(size)) return { content: "", available: false };
  }

  const result = await pi.exec("git", ["show", objectSpec], { cwd: repoRoot });
  if (result.code !== 0) return { content: "", available: false };
  return { content: result.stdout, available: true };
}

async function getRevisionContent(pi: ExtensionAPI, repoRoot: string, revision: string, path: string): Promise<string> {
  return (await getRevisionContentResult(pi, repoRoot, revision, path)).content;
}

async function getWorkingTreeContentResult(repoRoot: string, path: string): Promise<LoadedReviewContent> {
  try {
    const realRepoRoot = await realpath(repoRoot);
    const candidatePath = resolve(realRepoRoot, path);
    if (!isPathInside(realRepoRoot, candidatePath)) return { content: "", available: false };

    const linkStats = await lstat(candidatePath);
    const targetPath = linkStats.isSymbolicLink() ? await realpath(candidatePath) : candidatePath;
    if (!isPathInside(realRepoRoot, targetPath)) return { content: "", available: false };

    const targetStats = linkStats.isSymbolicLink() ? await stat(targetPath) : linkStats;
    if (!targetStats.isFile() || !isReviewFileSizeAllowed(targetStats.size)) return { content: "", available: false };

    return { content: await readFile(targetPath, "utf8"), available: true };
  } catch {
    return { content: "", available: false };
  }
}

export async function getWorkingTreeContent(repoRoot: string, path: string): Promise<string> {
  return (await getWorkingTreeContentResult(repoRoot, path)).content;
}

function normalizeGitPath(path: string): string {
  return posix.normalize(path).replace(/^\.\//, "");
}

function inferWorkspacePath(repoRoot: string, cwd: string): string | undefined {
  const relativePath = normalizeGitPath(relative(repoRoot, resolve(cwd)));
  if (relativePath === "." || relativePath.startsWith("../")) return undefined;
  const parts = relativePath.split("/").filter(Boolean);
  return parts.length > 1 && MONOREPO_WORKSPACE_ROOTS.has(parts[0]!) ? `${parts[0]}/${parts[1]}` : undefined;
}

function normalizeDiffSha(sha: string): string | null {
  return sha.length === 0 || /^0+$/.test(sha) ? null : sha;
}

function readComparisonBlobSha(path: string | null, sha: string): string | null | undefined {
  if (path == null) return null;
  return normalizeDiffSha(sha) ?? undefined;
}

function isSubmoduleRawChange(change: RawDiffChange): boolean {
  return change.oldMode === "160000" || change.newMode === "160000";
}

function rawDiffMap(changes: RawDiffChange[]): Map<string, RawDiffChange> {
  return new Map(changes.map((change) => [normalizeGitPath(getChangeKey(change)), change]));
}

async function getNestedRepoRoot(pi: ExtensionAPI, parentRepoRoot: string, submodulePath: string): Promise<{ repoRoot: string } | { unavailableReason: string }> {
  const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd: join(parentRepoRoot, submodulePath) });
  if (result.code !== 0) return { unavailableReason: "submodule is not initialized locally" };
  const repoRoot = result.stdout.trim();
  if (repoRoot.length === 0 || repoRoot === parentRepoRoot) return { unavailableReason: "submodule path does not resolve to a nested repository" };
  return { repoRoot };
}

function buildSubmoduleInfo(repoRoot: string | null, raw: RawDiffChange, unavailableReason?: string): ReviewSubmoduleInfo {
  return {
    repoRoot: repoRoot ?? "",
    path: raw.newPath ?? raw.oldPath ?? "(unknown)",
    oldSha: normalizeDiffSha(raw.oldSha),
    newSha: normalizeDiffSha(raw.newSha),
    available: repoRoot != null,
    ...(repoRoot == null ? { unavailableReason: unavailableReason ?? "submodule is not initialized locally" } : {}),
  };
}

async function resolveSubmoduleInfo(pi: ExtensionAPI, repoRoot: string, raw: RawDiffChange): Promise<ReviewSubmoduleInfo> {
  const submodulePath = raw.newPath ?? raw.oldPath;
  if (submodulePath == null || raw.newPath == null) return buildSubmoduleInfo(null, raw, "submodule is not available in the working tree");
  const nested = await getNestedRepoRoot(pi, repoRoot, submodulePath);
  return "repoRoot" in nested
    ? buildSubmoduleInfo(nested.repoRoot, raw)
    : buildSubmoduleInfo(null, raw, nested.unavailableReason);
}

function getChangeKey(change: ChangedPath): string {
  return change.newPath ?? change.oldPath ?? toDisplayPath(change);
}

function getImportAliases(path: string): string[] {
  const normalized = normalizeGitPath(path);
  const aliases = [normalized];
  const extension = posix.extname(normalized);

  if (extension.length > 0) {
    aliases.push(normalized.slice(0, -extension.length));
  }

  const directory = posix.dirname(normalized);
  const basename = posix.basename(normalized, extension);
  if (basename === "index" && directory !== ".") {
    aliases.push(directory);
  }

  return aliases;
}

function canContainImportSpecifiers(path: string): boolean {
  return IMPORT_SOURCE_EXTENSIONS.has(posix.extname(path).toLowerCase());
}

function extractImportSpecifiers(content: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g,
    /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];

  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier != null) specifiers.push(specifier);
    }
  }

  return specifiers;
}

function resolveImport(sourcePath: string, specifier: string, aliases: Map<string, string>, importAliases: Record<string, string>): string | null {
  if (specifier.startsWith(".")) {
    const resolved = normalizeGitPath(posix.join(posix.dirname(sourcePath), specifier));
    return aliases.get(resolved) ?? null;
  }

  const configuredAlias = Object.entries(importAliases)
    .filter(([prefix]) => specifier === prefix || specifier.startsWith(`${prefix}/`))
    .sort(([left], [right]) => right.length - left.length)[0];
  if (configuredAlias == null) return null;
  const [prefix, target] = configuredAlias;
  const suffix = specifier === prefix ? "" : specifier.slice(prefix.length + 1);
  const resolved = normalizeGitPath(posix.join(target, suffix));
  return aliases.get(resolved) ?? null;
}

export interface ChangedFileReferenceGraph {
  counts: Map<string, number>;
  outgoing: Map<string, string[]>;
  incoming: Map<string, string[]>;
}

export function getChangedFileReferenceGraph(changes: ChangedPath[], contentsByPath: Map<string, string>, options: { importAliases?: Record<string, string> } = {}): ChangedFileReferenceGraph {
  const paths = changes.map(getChangeKey).map(normalizeGitPath);
  const pathSet = new Set(paths);
  const aliases = new Map<string, string>();
  const counts = new Map<string, number>(paths.map((path) => [path, 0]));
  const outgoingSets = new Map<string, Set<string>>(paths.map((path) => [path, new Set<string>()]));
  const incomingSets = new Map<string, Set<string>>(paths.map((path) => [path, new Set<string>()]));

  for (const path of paths) {
    for (const alias of getImportAliases(path)) {
      if (!aliases.has(alias)) aliases.set(alias, path);
    }
  }

  for (const change of changes) {
    if (change.newPath == null) continue;
    const sourcePath = normalizeGitPath(change.newPath);
    const content = contentsByPath.get(sourcePath) ?? contentsByPath.get(change.newPath) ?? "";
    const referencedPaths = new Set<string>();

    for (const specifier of extractImportSpecifiers(content)) {
      const referencedPath = resolveImport(sourcePath, specifier, aliases, options.importAliases ?? {});
      if (referencedPath == null || referencedPath === sourcePath || !pathSet.has(referencedPath)) continue;
      referencedPaths.add(referencedPath);
    }

    for (const referencedPath of referencedPaths) {
      counts.set(referencedPath, (counts.get(referencedPath) ?? 0) + 1);
      outgoingSets.get(sourcePath)?.add(referencedPath);
      incomingSets.get(referencedPath)?.add(sourcePath);
    }
  }

  const toSortedArrays = (map: Map<string, Set<string>>): Map<string, string[]> => new Map(
    [...map.entries()].map(([path, relatedPaths]) => [path, [...relatedPaths].sort((a, b) => a.localeCompare(b))]),
  );

  return {
    counts,
    outgoing: toSortedArrays(outgoingSets),
    incoming: toSortedArrays(incomingSets),
  };
}

export function getChangedFileReferenceCounts(changes: ChangedPath[], contentsByPath: Map<string, string>): Map<string, number> {
  return getChangedFileReferenceGraph(changes, contentsByPath).counts;
}

function compareReviewFiles(a: ReviewFile, b: ReviewFile): number {
  return a.path.localeCompare(b.path);
}

function getLocalReviewLimitRank(file: ReviewFile): number {
  if (file.inGitDiff) return 0;
  if (file.inLastCommit) return 1;
  if (file.inAllFiles) return 2;
  return 3;
}

function compareLocalReviewFilesForLimit(a: ReviewFile, b: ReviewFile): number {
  const scopeDelta = getLocalReviewLimitRank(a) - getLocalReviewLimitRank(b);
  if (scopeDelta !== 0) return scopeDelta;
  return compareReviewFiles(a, b);
}

function upsertSeed(seeds: Map<string, ReviewFileSeed>, key: string, create: () => ReviewFileSeed): ReviewFileSeed {
  const existing = seeds.get(key);
  if (existing != null) return existing;
  const seed = create();
  seeds.set(key, seed);
  return seed;
}

function createSeed(path: string, hasWorkingTreeFile: boolean): ReviewFileSeed {
  return {
    path,
    worktreeStatus: null,
    hasWorkingTreeFile,
    inGitDiff: false,
    inLastCommit: false,
    inAllFiles: false,
    gitDiff: null,
    lastCommit: null,
    allFiles: null,
    allFilesReferenceCount: 0,
    allFilesOutgoingReferences: [],
    allFilesIncomingReferences: [],
  };
}

async function getFirstExistingRef(pi: ExtensionAPI, repoRoot: string, refs: string[]): Promise<string | null> {
  for (const ref of refs) {
    const result = await pi.exec("git", ["rev-parse", "--verify", "--quiet", ref], { cwd: repoRoot });
    if (result.code === 0) return ref;
  }
  return null;
}

export async function getDefaultBranchRef(pi: ExtensionAPI, repoRoot: string): Promise<string | null> {
  const originHead = (await runGitAllowFailure(pi, repoRoot, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])).trim();
  if (originHead.length > 0 && originHead !== "origin/HEAD") return originHead;

  return getFirstExistingRef(pi, repoRoot, ["origin/main", "origin/master", "main", "master"]);
}

export interface LocalBranchRef {
  name: string;
  commit: string;
}

export interface AncestorBranchCandidate {
  name: string;
  distanceFromHead: number;
}

export function parseLocalBranchRefs(output: string): LocalBranchRef[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      const separatorIndex = line.indexOf("\t");
      if (separatorIndex <= 0) return [];
      const name = line.slice(0, separatorIndex).trim();
      const commit = line.slice(separatorIndex + 1).trim();
      if (name.length === 0 || commit.length === 0) return [];
      return [{ name, commit }];
    });
}

export function selectClosestAncestorBranch(candidates: AncestorBranchCandidate[]): string | null {
  const sorted = candidates
    .filter((candidate) => candidate.distanceFromHead > 0)
    .sort((a, b) => a.distanceFromHead - b.distanceFromHead || a.name.localeCompare(b.name));
  return sorted[0]?.name ?? null;
}

async function getCurrentBranchName(pi: ExtensionAPI, repoRoot: string): Promise<string | null> {
  const result = await pi.exec("git", ["branch", "--show-current"], { cwd: repoRoot });
  if (result.code !== 0) return null;
  return result.stdout.trim() || null;
}

async function getClosestAncestorBranchRef(pi: ExtensionAPI, repoRoot: string, currentBranch: string | null): Promise<string | null> {
  if (currentBranch == null) return null;

  const branchRefsOutput = await runGitAllowFailure(pi, repoRoot, ["for-each-ref", "--format=%(refname:short)%09%(objectname)", "refs/heads"]);
  const localBranches = parseLocalBranchRefs(branchRefsOutput).filter((branch) => branch.name !== currentBranch);
  const candidates: AncestorBranchCandidate[] = [];

  for (const branch of localBranches) {
    const ancestorResult = await pi.exec("git", ["merge-base", "--is-ancestor", branch.name, "HEAD"], { cwd: repoRoot });
    if (ancestorResult.code !== 0) continue;

    const distanceResult = await pi.exec("git", ["rev-list", "--count", `${branch.name}..HEAD`], { cwd: repoRoot });
    if (distanceResult.code !== 0) continue;

    const distanceFromHead = Number.parseInt(distanceResult.stdout.trim(), 10);
    if (!Number.isFinite(distanceFromHead)) continue;
    candidates.push({ name: branch.name, distanceFromHead });
  }

  return selectClosestAncestorBranch(candidates);
}

export async function getBranchBaseRef(pi: ExtensionAPI, repoRoot: string): Promise<string | null> {
  const currentBranch = await getCurrentBranchName(pi, repoRoot);
  const closestAncestorBranch = await getClosestAncestorBranchRef(pi, repoRoot, currentBranch);
  if (closestAncestorBranch != null) return closestAncestorBranch;
  return getDefaultBranchRef(pi, repoRoot);
}

async function getBranchBaseRevision(pi: ExtensionAPI, repoRoot: string): Promise<string | null> {
  const branchBaseRef = await getBranchBaseRef(pi, repoRoot);
  if (branchBaseRef == null) return null;
  const result = await pi.exec("git", ["merge-base", branchBaseRef, "HEAD"], { cwd: repoRoot });
  if (result.code !== 0) return null;
  return result.stdout.trim() || null;
}

export async function getReviewWindowData(pi: ExtensionAPI, cwd: string, options: ReviewWindowOptions = {}): Promise<ReviewWindowData> {
  const repoRoot = await getRepoRoot(pi, cwd);
  const requestedWorkspace = options.workspacePath == null ? inferWorkspacePath(repoRoot, cwd) : normalizeGitPath(options.workspacePath);
  const workspacePath = options.wholeRepo || requestedWorkspace?.startsWith("../") ? undefined : requestedWorkspace;
  const configuredPathspecs = options.wholeRepo ? [] : options.pathspecs ?? (workspacePath == null ? [] : [workspacePath]);
  const pathspecs = [...new Set(configuredPathspecs.map(normalizeGitPath).filter((path) => path !== "." && !path.startsWith("../")))];
  const diffPathArgs = ["--", ...pathspecs];
  const optionalPathArgs = pathspecs.length > 0 ? ["--", ...pathspecs] : [];
  const repositoryHasHead = await hasHead(pi, repoRoot);

  const [
    trackedDiffOutput,
    worktreeNumStatOutput,
    worktreeRawOutput,
    untrackedOutput,
    statusOutput,
    trackedFilesOutput,
    deletedFilesOutput,
    lastCommitOutput,
    lastCommitNumStatOutput,
    lastCommitRawOutput,
    branchBaseRevision,
  ] = await Promise.all([
    repositoryHasHead ? runGit(pi, repoRoot, ["diff", "--find-renames", "-M", "--name-status", "HEAD", ...diffPathArgs]) : Promise.resolve(""),
    repositoryHasHead ? runGitAllowFailure(pi, repoRoot, ["diff", "--find-renames", "-M", "--numstat", "HEAD", ...diffPathArgs]) : Promise.resolve(""),
    repositoryHasHead ? runGitAllowFailure(pi, repoRoot, ["diff", "--find-renames", "-M", "--raw", "-z", "HEAD", ...diffPathArgs]) : Promise.resolve(""),
    runGitAllowFailure(pi, repoRoot, ["ls-files", "--others", "--exclude-standard", ...optionalPathArgs]),
    runGitAllowFailure(pi, repoRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all", ...optionalPathArgs]),
    runGitAllowFailure(pi, repoRoot, ["ls-files", "--cached", ...optionalPathArgs]),
    runGitAllowFailure(pi, repoRoot, ["ls-files", "--deleted", ...optionalPathArgs]),
    repositoryHasHead ? runGitAllowFailure(pi, repoRoot, ["diff-tree", "--root", "--find-renames", "-M", "--name-status", "--no-commit-id", "-r", "HEAD", ...optionalPathArgs]) : Promise.resolve(""),
    repositoryHasHead ? runGitAllowFailure(pi, repoRoot, ["diff-tree", "--root", "--find-renames", "-M", "--numstat", "--no-commit-id", "-r", "HEAD", ...optionalPathArgs]) : Promise.resolve(""),
    repositoryHasHead ? runGitAllowFailure(pi, repoRoot, ["diff-tree", "--root", "--find-renames", "-M", "--raw", "-z", "--no-commit-id", "-r", "HEAD", ...optionalPathArgs]) : Promise.resolve(""),
    repositoryHasHead ? getBranchBaseRevision(pi, repoRoot) : Promise.resolve(null),
  ]);
  const [branchDiffOutput, branchNumStatOutput, branchRawOutput] = branchBaseRevision == null
    ? ["", "", ""]
    : await Promise.all([
        runGitAllowFailure(pi, repoRoot, ["diff", "--find-renames", "-M", "--name-status", branchBaseRevision, "HEAD", ...diffPathArgs]),
        runGitAllowFailure(pi, repoRoot, ["diff", "--find-renames", "-M", "--numstat", branchBaseRevision, "HEAD", ...diffPathArgs]),
        runGitAllowFailure(pi, repoRoot, ["diff", "--find-renames", "-M", "--raw", "-z", branchBaseRevision, "HEAD", ...diffPathArgs]),
      ]);

  const untrackedChanges = parseUntrackedPaths(untrackedOutput);
  const statusChanges = parseStatusPorcelain(statusOutput);
  const diffChanges = mergeChangedPaths(parseNameStatus(trackedDiffOutput), untrackedChanges);
  const localChanges = statusChanges.length > 0 ? mergeMissingChangedPaths(statusChanges, diffChanges) : diffChanges;
  const lastCommitStats = parseNumStat(lastCommitNumStatOutput);
  const branchStats = parseNumStat(branchNumStatOutput);
  const worktreeRaw = rawDiffMap(parseRawDiff(worktreeRawOutput));
  const lastCommitRaw = rawDiffMap(parseRawDiff(lastCommitRawOutput));
  const branchRaw = rawDiffMap(parseRawDiff(branchRawOutput));
  const worktreeChanges = limitReviewItems(localChanges
    .filter((change) => isReviewableFilePath(change.newPath ?? change.oldPath ?? "", options)));
  const worktreeStats = parseNumStat(worktreeNumStatOutput);
  await mapWithConcurrency(worktreeChanges, 8, async (change) => {
    if (change.oldPath != null || change.newPath == null || worktreeStats.has(normalizeGitPath(change.newPath))) return;
    const content = await getWorkingTreeContent(repoRoot, change.newPath);
    worktreeStats.set(normalizeGitPath(change.newPath), { additions: countContentLines(content), deletions: 0 });
  });
  const deletedPaths = new Set(parseTrackedPaths(deletedFilesOutput));
  const statusCurrentPaths = statusChanges.flatMap((change) => (change.newPath == null ? [] : [change.newPath]));
  const currentPaths = limitReviewItems(uniquePaths([...parseTrackedPaths(trackedFilesOutput), ...parseTrackedPaths(untrackedOutput), ...statusCurrentPaths])
    .filter((path) => !deletedPaths.has(path))
    .filter((path) => isReviewableFilePath(path, options)));
  const currentPathSet = new Set(currentPaths);
  const lastCommitChanges = limitReviewItems(parseNameStatus(lastCommitOutput)
    .filter((change) => isReviewableFilePath(change.newPath ?? change.oldPath ?? "", options)));
  const branchChanges = limitReviewItems(parseNameStatus(branchDiffOutput)
    .filter((change) => isReviewableFilePath(change.newPath ?? change.oldPath ?? "", options)));
  const branchContentsByPath = new Map<string, string>();
  const relationshipChanges = branchChanges.filter((change) => change.newPath != null && canContainImportSpecifiers(change.newPath));
  await mapWithConcurrency(relationshipChanges, 8, async (change) => {
    if (change.newPath == null) return;
    branchContentsByPath.set(normalizeGitPath(change.newPath), await getWorkingTreeContent(repoRoot, change.newPath));
  });
  const branchReferenceGraph = getChangedFileReferenceGraph(branchChanges, branchContentsByPath, options);

  const seeds = new Map<string, ReviewFileSeed>();

  for (const change of worktreeChanges) {
    const key = getChangeKey(change);
    const seed = upsertSeed(seeds, key, () => createSeed(key, change.newPath != null));
    seed.worktreeStatus = change.status;
    seed.hasWorkingTreeFile = change.newPath != null;
    seed.inGitDiff = true;
    seed.gitDiff = toComparison(change, worktreeStats.get(normalizeGitPath(key)), undefined, worktreeRaw.get(normalizeGitPath(key)));
  }

  for (const change of branchChanges) {
    const key = getChangeKey(change);
    const seed = upsertSeed(seeds, key, () => createSeed(key, change.newPath != null && currentPathSet.has(change.newPath)));
    seed.inAllFiles = true;
    seed.allFiles = toComparison(change, branchStats.get(normalizeGitPath(key)), undefined, branchRaw.get(normalizeGitPath(key)));
    seed.allFilesReferenceCount = branchReferenceGraph.counts.get(normalizeGitPath(key)) ?? 0;
    seed.allFilesOutgoingReferences = branchReferenceGraph.outgoing.get(normalizeGitPath(key)) ?? [];
    seed.allFilesIncomingReferences = branchReferenceGraph.incoming.get(normalizeGitPath(key)) ?? [];
  }

  for (const change of lastCommitChanges) {
    const key = getChangeKey(change);
    const seed = upsertSeed(seeds, key, () => createSeed(key, change.newPath != null && currentPathSet.has(change.newPath)));
    seed.inLastCommit = true;
    seed.lastCommit = toComparison(change, lastCommitStats.get(normalizeGitPath(key)), undefined, lastCommitRaw.get(normalizeGitPath(key)));
  }

  const markSubmodules = async (scope: ReviewScope, rawChanges: Map<string, RawDiffChange>, stats: Map<string, ChangeStats>): Promise<void> => {
    for (const [key, raw] of rawChanges.entries()) {
      if (!isSubmoduleRawChange(raw)) continue;
      const seed = upsertSeed(seeds, key, () => createSeed(key, raw.newPath != null));
      if (scope === "git-diff") {
        seed.worktreeStatus = raw.status;
        seed.hasWorkingTreeFile = raw.newPath != null;
        seed.inGitDiff = true;
        seed.gitDiff ??= toComparison(raw, stats.get(key), undefined, raw);
      } else if (scope === "last-commit") {
        seed.inLastCommit = true;
        seed.lastCommit ??= toComparison(raw, stats.get(key), undefined, raw);
      } else {
        seed.inAllFiles = true;
        seed.allFiles ??= toComparison(raw, stats.get(key), undefined, raw);
      }
      seed.submodule = { ...(seed.submodule ?? {}), [scope]: await resolveSubmoduleInfo(pi, repoRoot, raw) };
    }
  };

  await markSubmodules("git-diff", worktreeRaw, worktreeStats);
  await markSubmodules("last-commit", lastCommitRaw, lastCommitStats);
  await markSubmodules("all-files", branchRaw, branchStats);

  if (seeds.size === 0) {
    for (const path of currentPaths) {
      const seed = createSeed(path, true);
      seed.inAllFiles = true;
      seeds.set(path, seed);
    }
  }

  const files = limitReviewItems([...seeds.values()].map(createReviewFile).sort(compareLocalReviewFilesForLimit));
  const visibleScopes: ReviewScope[] = [];
  if (files.some((file) => file.inGitDiff)) visibleScopes.push("git-diff");
  if (files.some((file) => file.inAllFiles)) visibleScopes.push("all-files");
  if (files.some((file) => file.inLastCommit)) visibleScopes.push("last-commit");
  return { repoRoot, files, branchBaseRevision, visibleScopes, workspacePath };
}

export async function getReviewWindowDataForRevisionRange(pi: ExtensionAPI, cwd: string, branchBaseRevision: string, modifiedRevision: string, options: RevisionRangeOptions = {}): Promise<ReviewWindowData> {
  const repoRoot = await getRepoRoot(pi, cwd);
  const resolvedBaseRevision = options.mergeBase
    ? (await runGit(pi, repoRoot, ["merge-base", branchBaseRevision, modifiedRevision])).trim()
    : branchBaseRevision;
  if (resolvedBaseRevision.length === 0) throw new Error(`Could not resolve merge base for ${branchBaseRevision}...${modifiedRevision}.`);
  const requestedWorkspace = options.workspacePath == null ? inferWorkspacePath(repoRoot, cwd) : normalizeGitPath(options.workspacePath);
  const workspacePath = options.wholeRepo || requestedWorkspace?.startsWith("../") ? undefined : requestedWorkspace;
  const configuredPathspecs = options.wholeRepo ? [] : options.pathspecs ?? (workspacePath == null ? [] : [workspacePath]);
  const pathspecs = [...new Set(configuredPathspecs.map(normalizeGitPath).filter((path) => path !== "." && !path.startsWith("../")))];
  const pathArgs = pathspecs.length > 0 ? ["--", ...pathspecs] : ["--"];
  const branchDiffOutput = await runGitAllowFailure(pi, repoRoot, ["diff", "--find-renames", "-M", "--name-status", resolvedBaseRevision, modifiedRevision, ...pathArgs]);
  const branchNumStatOutput = await runGitAllowFailure(pi, repoRoot, ["diff", "--find-renames", "-M", "--numstat", resolvedBaseRevision, modifiedRevision, ...pathArgs]);
  const branchRawOutput = await runGitAllowFailure(pi, repoRoot, ["diff", "--find-renames", "-M", "--raw", "-z", resolvedBaseRevision, modifiedRevision, ...pathArgs]);
  const branchStats = parseNumStat(branchNumStatOutput);
  const branchRaw = rawDiffMap(parseRawDiff(branchRawOutput));
  const branchChanges = limitReviewItems(parseNameStatus(branchDiffOutput)
    .filter((change) => isReviewableFilePath(change.newPath ?? change.oldPath ?? "", options)));
  const branchContentsByPath = new Map<string, string>();
  const relationshipChanges = branchChanges.filter((change) => change.newPath != null && canContainImportSpecifiers(change.newPath));

  await mapWithConcurrency(relationshipChanges, 8, async (change) => {
    if (change.newPath == null) return;
    branchContentsByPath.set(normalizeGitPath(change.newPath), await getRevisionContent(pi, repoRoot, modifiedRevision, change.newPath));
  });

  const branchReferenceGraph = getChangedFileReferenceGraph(branchChanges, branchContentsByPath, options);
  const seeds = new Map<string, ReviewFileSeed>();

  for (const change of branchChanges) {
    const key = getChangeKey(change);
    const seed = upsertSeed(seeds, key, () => createSeed(key, false));
    seed.inAllFiles = true;
    seed.allFiles = toComparison(change, branchStats.get(normalizeGitPath(key)), {
      originalRevision: resolvedBaseRevision,
      modifiedRevision,
    }, branchRaw.get(normalizeGitPath(key)));
    seed.allFilesReferenceCount = branchReferenceGraph.counts.get(normalizeGitPath(key)) ?? 0;
    seed.allFilesOutgoingReferences = branchReferenceGraph.outgoing.get(normalizeGitPath(key)) ?? [];
    seed.allFilesIncomingReferences = branchReferenceGraph.incoming.get(normalizeGitPath(key)) ?? [];
  }

  for (const [key, raw] of branchRaw.entries()) {
    if (!isSubmoduleRawChange(raw)) continue;
    const seed = upsertSeed(seeds, key, () => createSeed(key, raw.newPath != null));
    seed.inAllFiles = true;
    seed.allFiles ??= toComparison(raw, branchStats.get(key), {
      originalRevision: resolvedBaseRevision,
      modifiedRevision,
    }, raw);
    seed.submodule = { ...(seed.submodule ?? {}), "all-files": await resolveSubmoduleInfo(pi, repoRoot, raw) };
  }

  const files = limitReviewItems([...seeds.values()].map(createReviewFile).sort(compareReviewFiles));
  return {
    repoRoot,
    files,
    branchBaseRevision: resolvedBaseRevision,
    modifiedRevision,
    visibleScopes: ["all-files"],
    workspacePath: workspacePath ?? (pathspecs.length === 1 ? pathspecs[0] : undefined),
  };
}

export async function loadReviewFileContents(pi: ExtensionAPI, repoRoot: string, file: ReviewFile, scope: ReviewScope, branchBaseRevision?: string | null, modifiedRevision = "HEAD"): Promise<ReviewFileContents> {
  const comparison = scope === "git-diff" ? file.gitDiff : scope === "last-commit" ? file.lastCommit : file.allFiles;
  const unavailable: LoadedReviewContent = { content: "", available: false };

  if (scope === "all-files" && comparison == null) {
    const loaded = file.hasWorkingTreeFile ? await getWorkingTreeContentResult(repoRoot, file.path) : unavailable;
    return {
      originalContent: loaded.content,
      modifiedContent: loaded.content,
      originalAvailable: loaded.available,
      modifiedAvailable: loaded.available,
    };
  }

  if (comparison == null) {
    return { originalContent: "", modifiedContent: "", originalAvailable: false, modifiedAvailable: false };
  }

  const allFilesBaseRevision = scope === "all-files" && comparison.originalRevision === undefined
    ? branchBaseRevision ?? await getBranchBaseRevision(pi, repoRoot)
    : null;
  const originalRevision = comparison.originalRevision !== undefined
    ? comparison.originalRevision
    : scope === "git-diff"
      ? "HEAD"
      : scope === "last-commit"
        ? "HEAD^"
        : allFilesBaseRevision;
  const comparisonModifiedRevision = comparison.modifiedRevision !== undefined
    ? comparison.modifiedRevision
    : scope === "git-diff"
      ? null
      : scope === "last-commit"
        ? "HEAD"
        : modifiedRevision;

  const original = comparison.oldPath == null || originalRevision == null
    ? unavailable
    : await getRevisionContentResult(pi, repoRoot, originalRevision, comparison.oldPath);
  const modified = comparison.newPath == null
    ? unavailable
    : comparisonModifiedRevision == null
      ? await getWorkingTreeContentResult(repoRoot, comparison.newPath)
      : await getRevisionContentResult(pi, repoRoot, comparisonModifiedRevision, comparison.newPath);

  return {
    originalContent: original.content,
    modifiedContent: modified.content,
    originalAvailable: original.available,
    modifiedAvailable: modified.available,
  };
}
