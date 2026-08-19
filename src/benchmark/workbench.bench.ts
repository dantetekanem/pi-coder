import { bench, describe } from "vitest";
import { createWorkbench } from "../workbench/app.js";
import { filterRepositoryFiles, parseGitFileList } from "../workbench/navigator.js";
import { createRepositoryTree, type RepositoryTreeRow } from "../workbench/tree.js";
import { WorkbenchComponent } from "../workbench/ui/component.js";

const DEFAULT_FILE_COUNT = 100_000;
const MAX_FILE_COUNT = 1_000_000;

function benchmarkFileCount(value: string | undefined): number {
  if (value == null || value.length === 0) return DEFAULT_FILE_COUNT;
  const count = Number(value);
  if (!Number.isFinite(count) || !Number.isInteger(count) || count <= 0 || count > MAX_FILE_COUNT) {
    throw new Error(`WORKBENCH_BENCH_FILES must be a positive integer no greater than ${MAX_FILE_COUNT.toLocaleString("en-US")}; received ${JSON.stringify(value)}.`);
  }
  return count;
}

const fileCount = benchmarkFileCount(process.env.WORKBENCH_BENCH_FILES);
const countLabel = fileCount.toLocaleString("en-US");
let consumed = 0;

function consume(value: number): number {
  consumed = (consumed + value) | 0;
  return consumed;
}

function consumeStrings(values: readonly string[]): number {
  return consume(values.length + (values[0]?.length ?? 0) + (values.at(-1)?.length ?? 0));
}

function consumeRows(rows: readonly RepositoryTreeRow[]): number {
  return consume(rows.length + (rows[0]?.key.length ?? 0) + (rows.at(-1)?.key.length ?? 0));
}

function consumeRender(lines: readonly string[]): number {
  let checksum = lines.length;
  for (const line of lines) checksum += line.length;
  return consume(checksum);
}

function makeWideDeepPaths(count: number): string[] {
  return Array.from({ length: count }, (_, index) => {
    const packageName = String(index % 256).padStart(3, "0");
    const domain = String(Math.floor(index / 256) % 64).padStart(2, "0");
    return `packages/package-${packageName}/src/domain-${domain}/feature-${index}-ReactComponent${index}.tsx`;
  });
}

function makeSingleFolderPaths(count: number): string[] {
  const width = String(Math.max(0, count - 1)).length;
  const paths = Array.from({ length: count }, (_, index) => `bulk/file-${String(index).padStart(width, "0")}.ts`);
  let state = 0x9e3779b9;
  for (let index = paths.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const swapIndex = state % (index + 1);
    [paths[index], paths[swapIndex]] = [paths[swapIndex]!, paths[index]!];
  }
  return paths;
}

function createComponent(workbench: ReturnType<typeof createWorkbench>): WorkbenchComponent {
  const tui = { requestRender() {}, terminal: { rows: 24 } };
  const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    searchMatch: (text: string) => text,
  };
  return new WorkbenchComponent(tui as never, theme, workbench, () => {});
}

const wideDeepPaths = makeWideDeepPaths(fileCount);
const singleFolderPaths = makeSingleFolderPaths(fileCount);
const wideDeepMetadata = `${wideDeepPaths.join("\0")}\0`;
const singleFolderMetadata = `${singleFolderPaths.join("\0")}\0`;
// Each persistent model exists for a distinct cold or warm measurement. Async
// metadata startup is complete before any synchronous component render is timed.
// Cold pools provide one warmup plus three measured samples at the default scale
// (six fixtures including Tinybench's two untimed synchronous probes). Larger smoke
// datasets use one measured tree to avoid multiplying wide-tree
// metadata; the harness line calls out that deliberate limitation.
const useMultiSamplePools = fileCount <= DEFAULT_FILE_COUNT;
const coldMeasuredIterations = useMultiSamplePools ? 3 : 1;
const coldWarmupIterations = useMultiSamplePools ? 1 : 0;
const coldSample = { time: 0, iterations: coldMeasuredIterations, warmupTime: 0, warmupIterations: coldWarmupIterations } as const;
const repeatedColdSample = { time: 0.001, iterations: 5, warmupTime: 0.001, warmupIterations: 1 } as const;
// Tinybench probes synchronous callbacks once for async detection in each warmup/run
// phase, so each pool also reserves two untimed probe trees.
const coldTreePoolSize = coldMeasuredIterations + coldWarmupIterations + 2;
const firstVisibleTrees = useMultiSamplePools ? Array.from({ length: coldTreePoolSize }, () => {
  const tree = createRepositoryTree(wideDeepPaths);
  tree.expandFolder("packages");
  return tree;
}) : [];
const firstSingleTrees = useMultiSamplePools ? Array.from({ length: coldTreePoolSize }, () => createRepositoryTree(singleFolderPaths)) : [];
const expandSingleTrees = useMultiSamplePools ? Array.from({ length: 8 }, () => createRepositoryTree(singleFolderPaths)) : [];
// Keep the cold reveal pool bounded: revealing is page-sized, but its first call
// still sorts the huge folder and an additional 1M tree pool would multiply metadata.
const revealBenchEnabled = fileCount <= DEFAULT_FILE_COUNT;
const firstRevealTrees = revealBenchEnabled
  ? Array.from({ length: coldTreePoolSize }, () => createRepositoryTree(singleFolderPaths))
  : [];
let firstVisibleCall = 0;
let firstSingleCall = 0;
let expandSingleCall = 0;
let firstRevealCall = 0;
const cachedWideTree = createRepositoryTree(wideDeepPaths);
cachedWideTree.expandFolder("packages");
cachedWideTree.rows();
const warmSingleTree = createRepositoryTree(singleFolderPaths);
warmSingleTree.expandFolder("bulk");
warmSingleTree.rows();

const benchmarkRepository = {
  listFiles: async () => wideDeepMetadata,
  readText: async (path: string) => ({ text: path, revision: path }),
  saveText: async () => ({ status: "error" as const, message: "benchmark does not save" }),
  maxReadBytes: 1024,
};
const firstRenderWorkbench = createWorkbench(benchmarkRepository);
await firstRenderWorkbench.start();
const wideWorkbench = createWorkbench({
  listFiles: async () => wideDeepMetadata,
  readText: async (path) => ({ text: path, revision: path }),
  saveText: async () => ({ status: "error", message: "benchmark does not save" }),
  maxReadBytes: 1024,
});
await wideWorkbench.start();
const singleWorkbench = createWorkbench({
  listFiles: async () => singleFolderMetadata,
  readText: async (path) => ({ text: path, revision: path }),
  saveText: async () => ({ status: "error", message: "benchmark does not save" }),
  maxReadBytes: 1024,
});
await singleWorkbench.start();

const hotWideComponent = createComponent(wideWorkbench);
hotWideComponent.render(120);
hotWideComponent.handleInput("\x1b[B");
hotWideComponent.handleInput("\x1b[C");
hotWideComponent.render(120);
const toggleComponent = createComponent(singleWorkbench);
toggleComponent.render(120);
toggleComponent.handleInput("\x1b[B");
toggleComponent.handleInput("\x1b[C");
toggleComponent.render(120);
const cachedQueryComponent = createComponent(singleWorkbench);
cachedQueryComponent.render(120);
cachedQueryComponent.handleInput("/");
for (const character of "file-00042") cachedQueryComponent.handleInput(character);
cachedQueryComponent.render(120);

const coldSampleLabel = useMultiSamplePools
  ? "cold pools: 1 warmup + 3 measured samples (plus 2 untimed probes)"
  : "cold pooled-row cases omitted at larger scale; lifecycle samples: 1 measured (plus untimed probes)";
const revealSampleLabel = revealBenchEnabled
  ? "reveal pool: 1 warmup + 3 measured samples (plus 2 untimed probes)"
  : "cold reveal pool omitted above 100,000 paths to avoid duplicating million-path metadata";
console.log(`[workbench bench] Node ${process.version}; deterministic metadata-only workspace: ${countLabel} paths (scale with WORKBENCH_BENCH_FILES=1..${MAX_FILE_COUNT}); ${coldSampleLabel}; ${revealSampleLabel}`);

describe(`workbench metadata and search (${countLabel} paths)`, () => {
  bench(`Workbench.start: parse, tree construction, and initial rows warm for ${countLabel} paths`, async () => {
    const workbench = createWorkbench(benchmarkRepository);
    await workbench.start();
    consume(workbench.repositoryTree.rows().length);
  }, coldSample);
  bench(`parse ${countLabel} NUL-delimited repository paths`, () => { consumeStrings(parseGitFileList(wideDeepMetadata)); });
  bench(`fuzzy-filter ${countLabel} repository paths`, () => { consumeStrings(filterRepositoryFiles(wideDeepPaths, "ractcomp42")); });
  bench(`fuzzy-filter an existing ${countLabel}-path tree`, () => { consumeRows(cachedWideTree.searchFiles("ractcomp42") ?? []); });
});

describe(`repository tree (${countLabel} paths)`, () => {
  bench("construct metadata-only wide/deep tree", () => {
    const tree = createRepositoryTree(wideDeepPaths);
    consume((tree.parentFolder(wideDeepPaths.at(-1)!)?.length ?? 0) + 1);
  });
  // These cold operations are intentionally bounded samples: rows() memoizes by
  // contract, and Vitest 3 does not expose Tinybench's untimed per-iteration hooks.
  // They are omitted from the 1M smoke because retaining probe pools would multiply
  // the million-path tree; the 100k run remains the measured cold-row benchmark.
  if (useMultiSamplePools) {
    bench("first visible-row derivation on a wider tree (packages expanded; cold rows())", () => {
      const tree = firstVisibleTrees[firstVisibleCall++];
      if (tree == null) throw new Error("first-row cold tree sample pool exhausted");
      consumeRows(tree.rows());
    }, coldSample);
    bench("cached rows() access on a wide/deep tree (packages expanded)", () => { consumeRows(cachedWideTree.rows()); });
    bench(`single folder with ${countLabel} files: first default rows`, () => {
      const tree = firstSingleTrees[firstSingleCall++];
      if (tree == null) throw new Error("default-row cold tree sample pool exhausted");
      consumeRows(tree.rows());
    }, coldSample);
    bench(`single folder with ${countLabel} files: first expand (shuffle + first sort + capped rows())`, () => {
      const tree = expandSingleTrees[expandSingleCall++];
      if (tree == null) throw new Error("cold tree sample pool exhausted");
      tree.expandFolder("bulk");
      consumeRows(tree.rows());
    }, repeatedColdSample);
  }
  if (revealBenchEnabled) {
    bench(`single folder with ${countLabel} files: first reveal (first sort + one bounded page)`, () => {
      const tree = firstRevealTrees[firstRevealCall++];
      if (tree == null) throw new Error("first-reveal tree sample pool exhausted");
      tree.expandFolder("bulk");
      tree.revealFolder("bulk");
      consumeRows(tree.rows());
    }, coldSample);
  }
  bench("single huge folder: warmed toggle and visible-row derivation", () => {
    warmSingleTree.toggleFolder("bulk");
    consumeRows(warmSingleTree.rows());
  });
});

describe(`workbench component (${countLabel} paths, 24-row terminal)`, () => {
  // This fixture is never expanded or revealed: every component shares the exact
  // prebuilt, initially warmed tree published by start(), and render does not mutate it.
  bench("first component render from a started Workbench with prebuilt initial rows", () => { consumeRender(createComponent(firstRenderWorkbench).render(120)); });
  bench("hot render of a cached wide/deep tree with no source loaded", () => { consumeRender(hotWideComponent.render(120)); });
  bench("cached contextual file-query result render", () => { consumeRender(cachedQueryComponent.render(120)); });
  bench("warmed huge-folder toggle and component re-render", () => {
    toggleComponent.handleInput("\r");
    consumeRender(toggleComponent.render(120));
  });
});
