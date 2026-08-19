export function parseGitFileList(output: string): string[] {
  return output.split("\0").filter((path) => path.length > 0);
}

export function filterDeletedGitFiles(filesOutput: string, deletedOutput: string): string {
  const deleted = new Set(parseGitFileList(deletedOutput));
  const files = parseGitFileList(filesOutput).filter((path) => !deleted.has(path));
  return files.length === 0 ? "" : `${files.join("\0")}\0`;
}

export function isRepositoryRelativePath(path: string): boolean {
  return path.length > 0
    && !path.startsWith("/")
    && !path.startsWith("\\")
    && !path.split(/[\\/]/).includes("..");
}

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, "");
}

function score(query: string, candidate: string): number {
  let queryIndex = 0;
  let total = 0;
  for (let index = 0; index < candidate.length && queryIndex < query.length; index += 1) {
    if (candidate[index] !== query[queryIndex]) continue;
    total += index === 0 || "/_.-".includes(candidate[index - 1]!) ? 3 : 1;
    queryIndex += 1;
  }
  return queryIndex === query.length ? total : -1;
}

const FILE_SEARCH_RESULT_CAP = 200;

type RankedFile = { path: string; score: number };

function compareRank(left: RankedFile, right: RankedFile): number {
  if (left.score !== right.score) return right.score - left.score;
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function isWorse(left: RankedFile, right: RankedFile): boolean {
  return compareRank(left, right) > 0;
}

function addTopRanked(heap: RankedFile[], candidate: RankedFile): void {
  if (heap.length < FILE_SEARCH_RESULT_CAP) {
    heap.push(candidate);
    for (let index = heap.length - 1; index > 0;) {
      const parent = Math.floor((index - 1) / 2);
      if (!isWorse(heap[index]!, heap[parent]!)) break;
      [heap[index], heap[parent]] = [heap[parent]!, heap[index]!];
      index = parent;
    }
    return;
  }
  if (compareRank(candidate, heap[0]!) >= 0) return;
  heap[0] = candidate;
  for (let index = 0;;) {
    const left = index * 2 + 1;
    const right = left + 1;
    let worst = index;
    if (left < heap.length && isWorse(heap[left]!, heap[worst]!)) worst = left;
    if (right < heap.length && isWorse(heap[right]!, heap[worst]!)) worst = right;
    if (worst === index) break;
    [heap[index], heap[worst]] = [heap[worst]!, heap[index]!];
    index = worst;
  }
}

export function filterRepositoryFiles(files: readonly string[], query: string): string[] {
  const normalized = normalizeQuery(query);
  if (normalized.length === 0) return [...files];
  const ranked: RankedFile[] = [];
  for (const path of files) {
    const fileScore = score(normalized, path.toLowerCase());
    if (fileScore >= 0) addTopRanked(ranked, { path, score: fileScore });
  }
  return ranked.sort(compareRank).map((entry) => entry.path);
}
