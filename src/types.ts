export type ReviewScope = "git-diff" | "last-commit" | "all-files";

export type ChangeStatus = "modified" | "added" | "deleted" | "renamed";

export interface ReviewFileComparison {
  status: ChangeStatus;
  oldPath: string | null;
  newPath: string | null;
  displayPath: string;
  hasOriginal: boolean;
  hasModified: boolean;
  additions?: number;
  deletions?: number;
  originalRevision?: string | null;
  modifiedRevision?: string | null;
  originalBlobSha?: string | null;
  modifiedBlobSha?: string | null;
}

export interface ReviewSubmoduleInfo {
  repoRoot: string;
  path: string;
  oldSha: string | null;
  newSha: string | null;
  available: boolean;
  unavailableReason?: string;
}

export type ReviewSubmoduleByScope = Partial<Record<ReviewScope, ReviewSubmoduleInfo>>;

export interface ReviewFile {
  id: string;
  path: string;
  pathPrefix?: string;
  worktreeStatus: ChangeStatus | null;
  hasWorkingTreeFile: boolean;
  inGitDiff: boolean;
  inLastCommit: boolean;
  inAllFiles: boolean;
  gitDiff: ReviewFileComparison | null;
  lastCommit: ReviewFileComparison | null;
  allFiles: ReviewFileComparison | null;
  allFilesReferenceCount?: number;
  allFilesOutgoingReferences?: string[];
  allFilesIncomingReferences?: string[];
  submodule?: ReviewSubmoduleByScope;
}

export interface ReviewFileContents {
  originalContent: string;
  modifiedContent: string;
  /** False when the requested comparison side could not be read; omitted means available for compatibility. */
  originalAvailable?: boolean;
  modifiedAvailable?: boolean;
}

export interface ReviewContextPanelSource {
  title: string;
  loadingText: string;
  load: () => Promise<string>;
  /** Canonical http(s) URL opened from the PR context pane. */
  url?: string;
}

export interface ReviewReplyItem {
  /** Stable selection key: `<threadId>:<commentId>`. */
  id: string;
  threadId: string;
  commentId: string;
  author: string;
  /** Bounded, control-character-escaped reply text. Never rendered raw. */
  body: string;
  createdAt?: string;
  url?: string;
  path?: string;
  line: number | null;
  resolved: boolean;
}

export interface ReviewRepliesSnapshot {
  replies: ReviewReplyItem[];
  selfLogin: string;
  fetchedAt: string;
}

export interface ReviewRepliesPanelSource {
  title: string;
  loadingText: string;
  /** Reads only the current pull request; the pane never queues a second one. */
  load: () => Promise<ReviewRepliesSnapshot>;
  /** On-demand, read-only analysis. Never posts anything back to the provider. */
  analyze?: (reply: ReviewReplyItem) => Promise<string>;
}

export type CommentSide = "added" | "deleted" | "file";

export type CommentIntent = "discuss" | "comment" | "modify";
export type FileCommentTarget = "file" | "all-lines";

export interface ReviewAnchorHash {
  algorithm: "sha256";
  value: string;
}

export type ReviewAnchorStatus = "mapped" | "stale";

export interface DiffReviewComment {
  id: string;
  fileId: string;
  scope: ReviewScope;
  side: CommentSide;
  intent: CommentIntent;
  startLine: number | null;
  endLine: number | null;
  body: string;
  fileTarget?: FileCommentTarget;
  /** Original source text of the edited line(s), captured when a CHANGE edit is started. */
  originalText?: string;
  /** Capture-time source hash for line/range drafts. File drafts do not require one. */
  captureHash?: ReviewAnchorHash;
  /** Unresolved drafts remain visible but are not submittable. */
  anchorStatus?: ReviewAnchorStatus;
}

export interface ReviewDraft {
  allComment: string;
  allIntent: CommentIntent;
  comments: DiffReviewComment[];
}

export type ReviewFocus = "navigator" | "diff" | "comments" | "context" | "replies";

export interface ReviewLineTarget {
  side: Exclude<CommentSide, "file">;
  /** Active cursor line for the selection. */
  line: number;
  /** Anchor line when the selection spans multiple diff lines. */
  endLine?: number;
}

export interface ReviewState {
  activeScope: ReviewScope;
  activeFileId: string | null;
  searchQuery: string;
  focus: ReviewFocus;
  wrapLines: boolean;
  hideUnchanged: boolean;
  selectedCommentIndex: number;
  selectedLineTargetByScopeFile: Record<string, ReviewLineTarget>;
  draft: ReviewDraft;
}

export interface ReviewSubmitPayload extends ReviewDraft {
  type: "submit";
}

export type ReviewExitDisposition = "park" | "discard";

export interface ReviewCancelPayload {
  type: "cancel";
  /** Park keeps the saved session for a later resume; discard deletes it. Defaults to park. */
  disposition?: ReviewExitDisposition;
}

export interface ReviewResumeReference {
  /** v2 separates the exact selected bytes from bounded relocation context. */
  version: 1 | 2;
  repository: string;
  sessionId: string;
  identity: string;
  scope: "git-diff";
  /** Deterministic local review-discovery frame fingerprint (v2). */
  scopeFingerprint?: string;
  path: string;
  side: "added";
  range: { startLine: number; endLine: number };
  focus: { pane: ReviewFocus; fileIndex?: number; navigatorScroll: number; diffScroll: number; commentsScroll: number };
  /** v1 exact selected-slice hash; retained only for safe legacy tokens. */
  contextHash: ReviewAnchorHash;
  /** v2 exact selected-slice hash. */
  selectedHash?: ReviewAnchorHash;
  /** v2 bounded surrounding context used only to relocate an eligible selected target. */
  context?: { before: number; after: number; hash: ReviewAnchorHash };
}

export interface ReviewOpenCodePayload {
  type: "open-code";
  target: import("./workbench/contracts.js").CodeTarget;
  resume: ReviewResumeReference;
}

export interface ReviewOpenEditorPayload {
  type: "open-editor";
  command: string;
  args: string[];
  filePath: string;
  line: number;
  resume?: ReviewResumeReference;
}

export type ReviewResult = ReviewSubmitPayload | ReviewCancelPayload | ReviewOpenCodePayload | ReviewOpenEditorPayload;

export function formatScopeLabel(scope: ReviewScope): string {
  switch (scope) {
    case "git-diff": return "git diff";
    case "last-commit": return "last commit";
    case "all-files": return "all files";
  }
}

export function scopeFileKey(scope: ReviewScope, fileId: string): string {
  return `${scope}::${fileId}`;
}

export function formatIntentLabel(intent: CommentIntent): string {
  switch (intent) {
    case "discuss": return "DISCUSS";
    case "comment": return "COMMENT";
    case "modify": return "MODIFY";
  }
}

export function getSubmoduleInfo(file: ReviewFile | null | undefined, scope: ReviewScope): ReviewSubmoduleInfo | null {
  return file?.submodule?.[scope] ?? null;
}

export function hasExactSubmoduleRange(submodule: ReviewSubmoduleInfo): submodule is ReviewSubmoduleInfo & { oldSha: string; newSha: string } {
  return submodule.oldSha != null && submodule.newSha != null && submodule.oldSha !== submodule.newSha;
}

export function joinReviewPath(prefix: string | undefined, path: string): string {
  return prefix == null || prefix.length === 0 ? path : `${prefix}/${path}`;
}

export function getReviewFileDisplayPath(file: ReviewFile | null | undefined, scope: ReviewScope): string {
  if (file == null) return "(no file)";
  const comparison = scope === "git-diff" ? file.gitDiff : scope === "last-commit" ? file.lastCommit : file.allFiles;
  if (comparison == null) return joinReviewPath(file.pathPrefix, file.path);
  if (comparison.status === "renamed" && comparison.oldPath != null && comparison.newPath != null) {
    return `${joinReviewPath(file.pathPrefix, comparison.oldPath)} -> ${joinReviewPath(file.pathPrefix, comparison.newPath)}`;
  }
  return joinReviewPath(file.pathPrefix, comparison.displayPath);
}
