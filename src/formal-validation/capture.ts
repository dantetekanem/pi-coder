import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createStorySnapshot, storyFile, type StoryFile, type StorySnapshot } from "../diff-story/plan.js";
import {
  getReviewWindowData,
  getReviewWindowDataForRevisionRange,
  loadReviewFileContents,
  mapWithConcurrency,
  type ReviewWindowData,
  type ReviewWindowOptions,
  type RevisionRangeOptions,
} from "../git.js";
import { filterReviewFilesByLocale } from "../locale-files.js";
import { resolveRemoteReviewTarget, type RemoteReviewTarget } from "../remote.js";
import { getDefaultScope, getScopedFiles } from "../state.js";
import { getReviewFileDisplayPath } from "../types.js";
import type { GuideTarget } from "./guide.js";

export type FormalValidationSource =
  | { kind: "working"; cwd: string; options?: ReviewWindowOptions }
  | { kind: "range"; cwd: string; base: string; head: string; options?: RevisionRangeOptions }
  | { kind: "remote"; cwd: string; remote: string; explicitCwd?: string; options?: { includeGenerated?: boolean; wholeRepo?: boolean } };

export interface CapturedChange {
  snapshot: StorySnapshot;
  target: GuideTarget;
  description?: string;
  hiddenLocales: number;
  skipped: Array<{ path: string; reason: string }>;
}

// Story snapshots reject these bytes, so one binary file must not fail the whole capture.
const UNSAFE_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

async function shortRevision(pi: ExtensionAPI, cwd: string, revision: string | null | undefined): Promise<string | undefined> {
  if (revision == null || revision.length === 0) return undefined;
  const result = await pi.exec("git", ["rev-parse", "--short=12", `${revision}^{commit}`], { cwd, timeout: 10_000 });
  return result.code === 0 ? result.stdout.trim() : revision;
}

async function loadWindow(pi: ExtensionAPI, source: FormalValidationSource, onProgress: (message: string) => void): Promise<{ data: ReviewWindowData; remote?: RemoteReviewTarget; label: string }> {
  if (source.kind === "working") {
    onProgress("Reading local changes…");
    return { data: await getReviewWindowData(pi, source.cwd, source.options ?? {}), label: "working tree" };
  }
  if (source.kind === "range") {
    onProgress(`Reading ${source.base}..${source.head}…`);
    return {
      data: await getReviewWindowDataForRevisionRange(pi, source.cwd, source.base, source.head, source.options ?? {}),
      label: `${source.base}${source.options?.mergeBase ? "..." : ".."}${source.head}`,
    };
  }
  const remote = await resolveRemoteReviewTarget(pi, source.cwd, source.remote, source.explicitCwd, onProgress);
  onProgress(`Preparing diff for ${remote.repo ?? remote.branch}…`);
  const wholeRepo = source.options?.wholeRepo === true;
  const data = await getReviewWindowDataForRevisionRange(pi, remote.gitRoot, remote.baseRef, remote.headRef, {
    ...(source.options?.includeGenerated ? { includeGenerated: true } : {}),
    ...(wholeRepo ? { wholeRepo: true } : {}),
    ...(wholeRepo || remote.pathspecs == null ? {} : { pathspecs: remote.pathspecs }),
    ...(wholeRepo || remote.workspacePath == null ? {} : { workspacePath: remote.workspacePath }),
    ...(remote.importAliases == null ? {} : { importAliases: remote.importAliases }),
  });
  const label = remote.pullRequest == null ? `remote ${remote.branch}` : `${remote.repo ?? remote.pullRequest.repo ?? remote.remote}#${remote.pullRequest.number}`;
  return { data, remote, label };
}

/**
 * Captures a change with /diff-story's file order, locale policy and byte loading. It always uses the
 * default scope and skips files a story cannot hash, so /diff-story builds its own guide from what it shows.
 */
export async function captureChange(pi: ExtensionAPI, source: FormalValidationSource, onProgress: (message: string) => void = () => {}): Promise<CapturedChange> {
  const { data, remote, label } = await loadWindow(pi, source, onProgress);
  const scope = getDefaultScope(data.files);
  const scoped = getScopedFiles(data.files, scope);
  const files = filterReviewFilesByLocale(scoped, false);
  const skipped: CapturedChange["skipped"] = [];
  let read = 0;
  const loaded = await mapWithConcurrency(files, 8, async (file): Promise<StoryFile | undefined> => {
    const path = getReviewFileDisplayPath(file, scope);
    if (file.submodule?.[scope] != null) {
      skipped.push({ path, reason: "submodule" });
      return undefined;
    }
    const contents = await loadReviewFileContents(pi, data.repoRoot, file, scope, data.branchBaseRevision, data.modifiedRevision);
    read += 1;
    if (read % 10 === 0) onProgress(`Read ${read} of ${files.length} files…`);
    const captured = storyFile(file, scope, contents);
    if (((captured.hasOriginal ?? true) && contents.originalAvailable === false) || ((captured.hasModified ?? true) && contents.modifiedAvailable === false)) {
      skipped.push({ path, reason: "unreadable or too large" });
      return undefined;
    }
    if (UNSAFE_CONTROL.test(contents.originalContent) || UNSAFE_CONTROL.test(contents.modifiedContent)) {
      skipped.push({ path, reason: "binary content" });
      return undefined;
    }
    return captured;
  });
  const captured = loaded.filter((file): file is StoryFile => file != null);
  skipped.sort((a, b) => a.path.localeCompare(b.path));
  if (captured.length === 0) {
    const hidden = scoped.length - files.length;
    throw new Error(hidden > 0 && files.length === 0
      ? "This change only touches non-English/non-pt-BR locale files, which formal validation skips."
      : "No readable changed files found for this target.");
  }
  const snapshot = createStorySnapshot(captured);
  const pullRequest = remote?.pullRequest;
  const working = source.kind === "working";
  const baseRevision = !working ? data.branchBaseRevision : scope === "git-diff" ? "HEAD" : scope === "last-commit" ? "HEAD^" : data.branchBaseRevision;
  const headRevision = !working ? data.modifiedRevision : scope === "git-diff" ? undefined : "HEAD";
  const head = pullRequest?.headRefOid.slice(0, 12) ?? await shortRevision(pi, data.repoRoot, headRevision);
  const base = await shortRevision(pi, data.repoRoot, baseRevision);
  const workingLabel = scope === "git-diff" ? "uncommitted changes" : scope === "last-commit" ? "last commit" : "branch changes";
  return {
    snapshot,
    target: {
      kind: source.kind,
      label: working ? workingLabel : label,
      repoRoot: data.repoRoot,
      scope,
      ...(base == null ? {} : { base }),
      ...(head == null ? {} : { head }),
      ...(pullRequest == null ? {} : {
        pullRequest: {
          number: pullRequest.number,
          ...(remote?.repo == null ? {} : { repo: remote.repo }),
          ...(remote?.remote == null ? {} : { url: remote.remote }),
          title: pullRequest.title,
          author: pullRequest.authorLogin,
          state: pullRequest.state,
          headRefOid: pullRequest.headRefOid,
          baseRefName: pullRequest.baseRefName,
        },
      }),
    },
    ...(pullRequest?.body == null || pullRequest.body.trim().length === 0 ? {} : { description: pullRequest.body }),
    hiddenLocales: scoped.length - files.length,
    skipped,
  };
}
