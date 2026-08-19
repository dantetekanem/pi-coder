import { createHash } from "node:crypto";
import { resolve as resolvePath } from "node:path";
import type { DiffReviewComment, ReviewFile, ReviewFileComparison, ReviewFileContents, ReviewResumeReference, ReviewScope, ReviewState } from "../../types.js";
import { buildStructuredDiff } from "../../diff.js";
import { scopeFileKey } from "../../types.js";
import { hashTargetSlice, logicalLineCount } from "../../workbench/target.js";

const RESUME_SEARCH_WINDOW = 50;
const RESUME_CONTEXT_LIMIT = 8;

/** Stable and bounded identity for the exact local discovery closure, including absent-vs-empty options. */
export function createReviewScopeFingerprint(repository: string, cwd: string, options: Record<string, unknown> | undefined): string {
  const canonicalize = (value: unknown): unknown => {
    if (value === undefined) return { absent: true };
    if (value == null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return value;
    if (Array.isArray(value)) return value.slice(0, 128).map(canonicalize);
    if (typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).slice(0, 64).map(([key, item]) => [key, canonicalize(item)]));
    return String(value);
  };
  const frame = JSON.stringify({ repository: resolvePath(repository), cwd: resolvePath(cwd), options: canonicalize(options) });
  return createHash("sha256").update(frame.slice(0, 32 * 1024), "utf8").digest("hex");
}

function changedCurrentLines(contents: ReviewFileContents): number[] {
  return [...new Set(buildStructuredDiff(contents.originalContent, contents.modifiedContent, 0).rows
    .filter((row) => (row.kind === "insert" || row.kind === "replace") && row.newLineNumber != null)
    .map((row) => row.newLineNumber!))].sort((a, b) => a - b);
}

function isEligibleRange(range: { startLine: number; endLine: number }, changed: readonly number[], lineCount: number): boolean {
  return range.startLine >= 1 && range.endLine >= range.startLine && range.endLine <= lineCount
    && Array.from({ length: range.endLine - range.startLine + 1 }, (_, index) => range.startLine + index).every((line) => changed.includes(line));
}

function contextHashForRange(content: string, range: { startLine: number; endLine: number }, before: number, after: number) {
  const lineCount = logicalLineCount(content);
  return hashTargetSlice(content, { startLine: Math.max(1, range.startLine - before), endLine: Math.min(lineCount, range.endLine + after) });
}

function getScopeComparison(file: ReviewFile, scope: ReviewScope): ReviewFileComparison | null {
  if (scope === "git-diff") return file.gitDiff;
  if (scope === "last-commit") return file.lastCommit;
  return file.allFiles;
}

function hasScope(file: ReviewFile, scope: ReviewScope): boolean {
  if (scope === "git-diff") return file.inGitDiff;
  if (scope === "last-commit") return file.inLastCommit;
  return file.inAllFiles;
}

function hasAnchorSource(file: ReviewFile, comment: DiffReviewComment): boolean {
  if (!hasScope(file, comment.scope)) return false;
  const comparison = getScopeComparison(file, comment.scope);
  if (comparison != null) return comment.side === "deleted" ? comparison.hasOriginal : comparison.hasModified;
  return comment.scope === "all-files" && comment.side === "added" && file.hasWorkingTreeFile;
}

function hasValidCaptureHash(comment: DiffReviewComment): comment is DiffReviewComment & { captureHash: NonNullable<DiffReviewComment["captureHash"]> } {
  return comment.captureHash?.algorithm === "sha256" && /^[0-9a-f]{64}$/.test(comment.captureHash.value);
}

function getAnchorRange(comment: DiffReviewComment): { startLine: number; endLine: number } | null {
  const { startLine, endLine } = comment;
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine == null || endLine == null) return null;
  if (startLine < 1 || endLine < startLine) return null;
  return { startLine, endLine };
}

export function validateReviewDraftAnchor(
  comment: DiffReviewComment,
  file: ReviewFile | undefined,
  contents: ReviewFileContents | undefined,
): "mapped" | "stale" {
  if (comment.side === "file") return "mapped";
  if (comment.anchorStatus === "stale") return "stale";
  if (file == null || contents == null || !hasAnchorSource(file, comment) || !hasValidCaptureHash(comment)) return "stale";
  const range = getAnchorRange(comment);
  if (range == null) return "stale";
  const sourceAvailable = comment.side === "deleted" ? contents.originalAvailable !== false : contents.modifiedAvailable !== false;
  if (!sourceAvailable) return "stale";
  const source = comment.side === "deleted" ? contents.originalContent : contents.modifiedContent;
  const lineCount = logicalLineCount(source);
  if (range.startLine > lineCount || range.endLine > lineCount) return "stale";
  return hashTargetSlice(source, range).value === comment.captureHash.value ? "mapped" : "stale";
}

/** Validates every persisted line/range draft against bytes from its own file and scope. */
export async function revalidateReviewDraftAnchors(
  state: ReviewState,
  files: readonly ReviewFile[],
  loadContents: (file: ReviewFile, scope: ReviewScope) => Promise<ReviewFileContents>,
): Promise<ReviewState> {
  const byId = new Map(files.map((file) => [file.id, file]));
  const loaded = new Map<string, Promise<ReviewFileContents>>();
  const comments = await Promise.all(state.draft.comments.map(async (comment) => {
    if (comment.side === "file") return { ...comment, anchorStatus: "mapped" as const };
    if (comment.anchorStatus === "stale") return { ...comment, anchorStatus: "stale" as const };
    const file = byId.get(comment.fileId);
    if (file == null || !hasAnchorSource(file, comment)) return { ...comment, anchorStatus: "stale" as const };
    try {
      const key = `${comment.scope}::${file.id}`;
      let pending = loaded.get(key);
      if (pending == null) {
        pending = Promise.resolve().then(() => loadContents(file, comment.scope));
        loaded.set(key, pending);
      }
      const anchorStatus = validateReviewDraftAnchor(comment, file, await pending);
      return { ...comment, anchorStatus };
    } catch {
      return { ...comment, anchorStatus: "stale" as const };
    }
  }));
  return { ...state, draft: { ...state.draft, comments } };
}

export interface ReviewResumeResolution {
  state: ReviewState;
  stale: boolean;
  banner?: string;
}

export interface ReviewResumeExpectedFrame {
  repository: string;
  identity: string;
  sessionId: string;
  scopeFingerprint: string;
}

function currentPath(file: ReviewFile): string {
  const path = file.gitDiff?.newPath ?? file.path;
  return file.pathPrefix == null || file.pathPrefix.length === 0 ? path : `${file.pathPrefix}/${path}`;
}

function withLocation(state: ReviewState, file: ReviewFile, line: number, resume: ReviewResumeReference): ReviewState {
  const width = resume.range.endLine - resume.range.startLine;
  const target = width === 0 ? { side: "added" as const, line } : { side: "added" as const, line: line + width, endLine: line };
  return {
    ...state,
    activeScope: "git-diff",
    activeFileId: file.id,
    focus: resume.focus.pane,
    selectedLineTargetByScopeFile: {
      ...state.selectedLineTargetByScopeFile,
      [scopeFileKey("git-diff", file.id)]: target,
    },
  };
}

/** Resolves only against freshly loaded working-tree content; the token carries no source bytes. */
export async function resolveReviewResume(
  resume: ReviewResumeReference,
  state: ReviewState,
  files: readonly ReviewFile[],
  repository: string,
  loadCurrentContent: (file: ReviewFile) => Promise<ReviewFileContents>,
  expected?: ReviewResumeExpectedFrame,
): Promise<ReviewResumeResolution> {
  if (resume.repository !== repository || resume.scope !== "git-diff"
    || (expected != null && (resume.repository !== expected.repository || resume.identity !== expected.identity || resume.sessionId !== expected.sessionId || resume.scopeFingerprint !== expected.scopeFingerprint))) {
    return { state, stale: true, banner: "Review location is stale because its repository frame changed." };
  }
  const diffFiles = files.filter((file) => file.inGitDiff);
  const currentFiles = diffFiles.filter((file) => file.hasWorkingTreeFile && file.gitDiff?.hasModified !== false && file.submodule?.["git-diff"] == null);
  if (currentFiles.length === 0) {
    const empty = diffFiles.length === 0;
    return { state: { ...state, activeScope: "git-diff", activeFileId: null }, stale: true, banner: empty ? "Review location is stale; the fresh working-tree diff is empty." : "Review location is stale; the fresh diff has no writable current-side target." };
  }

  const sameFile = currentFiles.find((file) => currentPath(file) === resume.path);
  const candidates = sameFile == null ? currentFiles : [sameFile, ...currentFiles.filter((file) => file !== sameFile)];
  let sameFileContents: ReviewFileContents | null = null;
  if (sameFile != null) {
    sameFileContents = await loadCurrentContent(sameFile);
    const content = sameFileContents.modifiedContent;
    const lineCount = logicalLineCount(content);
    const changed = changedCurrentLines(sameFileContents);
    const selectedHash = resume.selectedHash ?? resume.contextHash;
    if (isEligibleRange(resume.range, changed, lineCount) && hashTargetSlice(content, resume.range).value === selectedHash.value) {
      return { state: withLocation(state, sameFile, resume.range.startLine, resume), stale: false };
    }
    const width = resume.range.endLine - resume.range.startLine;
    const min = Math.max(1, resume.range.startLine - RESUME_SEARCH_WINDOW);
    const max = Math.min(lineCount - width, resume.range.startLine + RESUME_SEARCH_WINDOW);
    const context = resume.context;
    if (context != null) {
      const relocated = Array.from({ length: Math.max(0, max - min + 1) }, (_, index) => min + index)
        .filter((startLine) => {
          const range = { startLine, endLine: startLine + width };
          return isEligibleRange(range, changed, lineCount) && contextHashForRange(content, range, Math.min(context.before, RESUME_CONTEXT_LIMIT), Math.min(context.after, RESUME_CONTEXT_LIMIT)).value === context.hash.value;
        })
        .sort((a, b) => Math.abs(a - resume.range.startLine) - Math.abs(b - resume.range.startLine) || a - b)[0];
      if (relocated != null) return { state: withLocation(state, sameFile, relocated, resume), stale: true, banner: "Review location moved within the file after refreshing the working-tree diff." };
    }
    if (changed.length > 0) {
      const nearest = changed.slice().sort((a, b) => Math.abs(a - resume.range.startLine) - Math.abs(b - resume.range.startLine) || a - b)[0]!;
      return { state: withLocation(state, sameFile, nearest, resume), stale: true, banner: "Review location is stale; selected the nearest current-side changed line." };
    }
  }

  const ranked = await Promise.all(candidates.filter((file) => file !== sameFile).map(async (file, index) => ({ file, index, contents: await loadCurrentContent(file) })));
  const eligible = ranked.map(({ file, index, contents }) => ({ file, index, lines: changedCurrentLines(contents) })).filter((candidate) => candidate.lines.length > 0);
  if (eligible.length === 0) return { state: { ...state, activeScope: "git-diff", activeFileId: null }, stale: true, banner: "Review location is stale; the fresh diff has no writable current-side changed line." };
  const fallback = eligible.sort((a, b) => Math.abs(a.index - (resume.focus.fileIndex ?? 0)) - Math.abs(b.index - (resume.focus.fileIndex ?? 0)) || currentPath(a.file).localeCompare(currentPath(b.file)))[0]!;
  return { state: withLocation(state, fallback.file, fallback.lines[0]!, resume), stale: true, banner: `Review location is stale; selected a current-side changed line in ${currentPath(fallback.file)}.` };
}
