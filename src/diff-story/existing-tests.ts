import { readdir, realpath } from "node:fs/promises";
import { posix, resolve } from "node:path";
import { getWorkingTreeContentResult, isPathInside, isReviewFileSizeAllowed, mapWithConcurrency } from "../git.js";
import type { CommandRunner } from "../host/types.js";
import { testedPathKey, testPairingPathKey } from "../review-order.js";
import type { StoryAnchor, StorySnapshot, StorySnapshotFile, StoryStep } from "./plan.js";
import { codeIdentifiers, functionOwners, isStoryTestPath, prepareStoryUnits, unitIdentifiers, type StoryUnit } from "./units.js";

/** A test case, or a helper one of them calls. `changed` marks a test this review edits, which another step shows as a change. */
export interface ExistingTestRange {
  name: string;
  startLine: number;
  endLine: number;
  helper: boolean;
  changed: boolean;
}

/** `tests` tests mention `name`. When `name` is code that calls the changed code, `reaches` is the changed name. */
export interface ExistingTestReason {
  name: string;
  reaches?: string;
  tests: number;
}

export interface ExistingTestFile {
  path: string;
  lines: string[];
  ranges: ExistingTestRange[];
  reasons: ExistingTestReason[];
}

export interface ExistingTestLookup {
  unitId: string;
  symbol: string;
  path: string;
  status: "found" | "none" | "failed";
  /** Repository directory searched; "" is the whole repository. */
  root: string;
  names: string[];
  /** Changed code that calls this code, in its own file or another changed file. */
  callers: string[];
  files: ExistingTestFile[];
  /** Matching tests, including any past the display limit. */
  tests: number;
  /** Test files that mention a searched name but were not read, past the read limit. */
  unread: number;
  /** Names and import paths that no search could carry, such as a file name that starts with `-`. */
  skipped: string[];
  reason?: string;
}

export interface ExistingTestReport {
  units: ReadonlyMap<string, ExistingTestLookup>;
}

export interface ExistingTestSource {
  /** Entry names directly inside a repository directory; "" is the repository root. */
  list(directory: string, signal: AbortSignal): Promise<string[]>;
  /** For each word, the test files under `root` that mention it as a whole word. */
  mentions(root: string, words: readonly string[], signal: AbortSignal): Promise<ReadonlyMap<string, ReadonlySet<string>>>;
  /** A text file's content, or undefined when it is missing, binary, or too large. */
  read(path: string, signal: AbortSignal): Promise<string | undefined>;
}

export type StoryStepTests =
  | { kind: "tests" }
  | { kind: "removed" }
  | { kind: "not-code" }
  | { kind: "unknown" }
  | { kind: "code"; unitIds: string[] };

export const EXISTING_TEST_SEARCH_MS = 20_000;
export const MAX_EXISTING_TESTS = 12;
const GIT_TIMEOUT_MS = 15_000;
/** Words per `git grep`, so a large change never passes the system's argument size limit. */
const GREP_WORDS = 400;
const MAX_TEST_FILES_READ = 80;
const MAX_CALLERS = 6;
const CALLER_DEPTH = 3;
const EXECUTABLE = /\.(?:rb|rake|py|[cm]?[jt]sx?|go|rs|java|kts?|scala|swift|mm?|c|cc|cpp|cxx|hh?|hpp|cs|php|exs?|erl|cljs?|lua|dart|vue|svelte|sh|bash|pl|pm|groovy|elm|hs|ml|fs)$/i;
const TYPE_DECLARATIONS = /\.d\.[cm]?ts$/i;
/** Languages whose test cases the story reads: `test`/`it`/`specify` blocks and `def test_` methods. */
const LANGUAGES: ReadonlyArray<readonly [RegExp, string]> = [[/\.(?:rb|rake)$/i, "ruby"], [/\.py$/i, "python"], [/\.(?:[cm]?[jt]sx?|vue|svelte)$/i, "script"]];
const TEST_GLOBS = ["**/test/**", "**/tests/**", "**/spec/**", "**/specs/**", "**/__tests__/**", "**/*[._]test.*", "**/*[._]spec.*", "**/*_tests.*"];
const SEARCHABLE = /^[A-Za-z_$][\w$]*[!?]?$/;
const MAX_WORD_LENGTH = 200;
const CONSTRUCTORS = new Set(["initialize", "constructor", "__init__", "new"]);
/** A component is the nearest folder with a package manifest; a nested test folder does not narrow the search. */
const ROOT_MARKERS = new Set(["package.json", "Gemfile", "package.yml", "component.yml", "go.mod", "Cargo.toml",
  "pyproject.toml", "setup.py", "pom.xml", "build.gradle", "build.gradle.kts", "mix.exs", "composer.json", "Package.swift"]);

/** Words `git grep -F -e` takes literally; a leading `-` is refused as well, so no word can ever read as an option. */
function greppable(word: string): boolean {
  return word.length > 0 && word.length <= MAX_WORD_LENGTH && !word.startsWith("-") && !/[\0\r\n]/.test(word);
}

/** Source files that run, so a change without tests is worth a question. Type declarations do not run. */
export function isExecutablePath(path: string): boolean {
  return EXECUTABLE.test(path) && !TYPE_DECLARATIONS.test(path);
}

function language(path: string): string | undefined {
  return TYPE_DECLARATIONS.test(path) ? undefined : LANGUAGES.find(([pattern]) => pattern.test(path))?.[1];
}

/** Changed code that runs and still exists at the reviewed revision. */
export function needsTestEvidence(unit: StoryUnit): boolean {
  return !unit.test && isExecutablePath(unit.path) && unit.anchors.some((anchor) => anchor.side === "added");
}

function overlaps(left: Omit<StoryAnchor, "hash">, right: Omit<StoryAnchor, "hash">): boolean {
  return left.fileId === right.fileId && left.side === right.side && left.startLine <= right.endLine && right.startLine <= left.endLine;
}

/** What a step's code needs from the test pane. Units match by range, so plans saved before unit IDs still classify. */
export function classifyStoryStep(step: StoryStep, units: readonly StoryUnit[]): StoryStepTests {
  const members = units.filter((unit) => unit.anchors.some((range) => step.implementation.some((anchor) => overlaps(range, anchor))));
  if (members.length === 0) return { kind: "unknown" };
  if (members.every((unit) => unit.test)) return { kind: "tests" };
  const code = members.filter((unit) => !unit.test && isExecutablePath(unit.path));
  if (code.length === 0) return { kind: "not-code" };
  const live = code.filter(needsTestEvidence);
  return live.length === 0 ? { kind: "removed" } : { kind: "code", unitIds: live.map((unit) => unit.id) };
}

interface Declaration {
  key: string;
  name: string;
  test: boolean;
  startLine: number;
  endLine: number;
  code: string;
}

function splitLines(text: string): string[] {
  if (!text) return [];
  const result = text.split(/\r\n|\r|\n/);
  if (result.at(-1) === "") result.pop();
  return result;
}

/** Declarations with their whole extent, nested declarations included, so a test or function reads every line it holds. */
function declarations(source: string[]): Declaration[] {
  const { cases, spans } = functionOwners(source);
  return [...spans].map(([key, [start, end]]) => ({
    key,
    name: key.split("\u001f")[0]!,
    test: cases.has(key),
    startLine: start + 1,
    endLine: end + 1,
    code: source.slice(start, end + 1).join("\n"),
  }));
}

function lastSegment(name: string): string {
  return name.split(/::|\./).at(-1)!;
}

/**
 * Class names a test would mention. The class named after the file wins, so namespaces and nested error classes do not
 * count; a file without classes falls back to its module named after the file, then its innermost module.
 */
function ownerNames(source: string, path: string): string[] {
  const stem = posix.basename(path).replace(/\..*$/, "").replace(/[-_]/g, "").toLowerCase();
  const named = (names: string[]) => names.find((name) => name.toLowerCase() === stem);
  const classes = [...new Set([...source.matchAll(/^[ \t]*(?:export[ \t]+)?(?:default[ \t]+)?(?:(?:abstract|data|sealed|final|public)[ \t]+)*(?:class|struct|interface|enum|object)[ \t]+([A-Z][\w:.]*)/gm)]
    .map((match) => lastSegment(match[1]!)))];
  const modules = [...source.matchAll(/^[ \t]*module[ \t]+([A-Z][\w:]*)/gm)].map((match) => lastSegment(match[1]!));
  const own = named(classes) ?? named(modules);
  if (own != null) return [own];
  return classes.length > 0 ? classes : modules.slice(-1);
}

/** Constants and module-level bindings a loose change assigns. */
function assignedNames(code: string): string[] {
  return [...code.matchAll(/^[ \t]*(?:export[ \t]+)?(?:(?:const|let|var)[ \t]+([A-Za-z_$][\w$]*)|([A-Z]\w*)[ \t]*=(?!=))/gm)]
    .map((match) => match[1] ?? match[2]!);
}

/** The name an import path ends with; an index file is imported by its folder. */
function importStem(path: string): string | undefined {
  const name = posix.basename(path).replace(/\.[^.]+$/, "");
  if (!/^(?:index|main|mod|__init__)$/.test(name)) return name;
  const folder = posix.basename(posix.dirname(path));
  return folder === "." || folder === "" ? undefined : folder;
}

function searchable(names: readonly string[]): string[] {
  return [...new Set(names)].filter((name) => name.length > 1 && name.length <= MAX_WORD_LENGTH && SEARCHABLE.test(name));
}

/** Multi-word names such as `save_locale!` or `pairTests` are specific enough to match code that does not name the class. */
function specificName(name: string): boolean {
  const bare = name.replace(/^_+|[!?=]$/g, "");
  return /[A-Za-z0-9]_[A-Za-z0-9]/.test(bare) || /[a-z0-9][A-Z]/.test(bare);
}

interface CodeEntry extends Declaration {
  reads: Set<string>;
  /** The outermost declaration around this one, such as the function that holds a local arrow function. */
  container?: Declaration;
}

interface CodeFile {
  path: string;
  language?: string;
  owners: string[];
  stem?: string;
  entries: CodeEntry[];
}

interface Target {
  file: CodeFile;
  reaches?: string;
}

interface UnitSearch {
  unit: StoryUnit;
  file: CodeFile;
  names: string[];
  callers: Map<string, Target>;
}

function repositoryPath(file: StorySnapshotFile, paths: ReadonlyMap<string, string>): string {
  return paths.get(file.fileId) ?? file.path.split(" -> ").at(-1)!;
}

function codeFile(file: StorySnapshotFile, paths: ReadonlyMap<string, string>): CodeFile {
  const path = repositoryPath(file, paths);
  const content = file.contents.modifiedContent;
  const entries = declarations(splitLines(content));
  return {
    path,
    language: language(path),
    owners: ownerNames(content, path),
    stem: importStem(path),
    entries: entries.map((entry) => {
      const container = entries.filter((outer) => outer.startLine < entry.startLine && outer.endLine >= entry.endLine)
        .sort((a, b) => a.startLine - b.startLine)[0];
      return { ...entry, reads: codeIdentifiers(entry.code), ...(container == null ? {} : { container }) };
    }),
  };
}

/**
 * Declarations that use one of the names, directly or through each other. The search may cross into one other changed
 * file of the same language, where a one-word name such as `call` counts only if that code also names the class.
 */
function callersOf(home: CodeFile, files: readonly CodeFile[], seeds: readonly string[]): Map<string, Target> {
  const callers = new Map<string, Target>();
  const scanned = [home, ...files.filter((file) => file !== home && file.language === home.language)];
  const origins = new Map(seeds.map((name) => [name, name]));
  let frontier = seeds.map((name) => ({ name, file: home, crossed: false }));
  for (let depth = 0; depth < CALLER_DEPTH && frontier.length > 0; depth += 1) {
    const next: typeof frontier = [];
    for (const file of scanned) {
      for (const entry of file.entries) {
        if (callers.size >= MAX_CALLERS) return callers;
        if (entry.container != null || origins.has(entry.name) || !SEARCHABLE.test(entry.name)) continue;
        const reached = frontier.find((item) => entry.reads.has(item.name) && (file === item.file
          || !item.crossed && (specificName(item.name) || item.file.owners.some((owner) => entry.reads.has(owner)))));
        if (reached == null) continue;
        const origin = origins.get(reached.name)!;
        callers.set(entry.name, { file, reaches: origin });
        origins.set(entry.name, origin);
        next.push({ name: entry.name, file, crossed: reached.crossed || file !== reached.file });
      }
    }
    frontier = next;
  }
  return callers;
}

/** Tests cannot call a local binding, so a change inside a function searches for that function. */
function planSearch(unit: StoryUnit, file: CodeFile, files: readonly CodeFile[]): UnitSearch {
  const line = unit.anchors.find((anchor) => anchor.side === "added")!.startLine;
  const own = file.entries.find((entry) => entry.name === unit.symbol && entry.startLine <= line && line <= entry.endLine);
  const declared = own?.container?.name ?? (unit.symbol.startsWith("lines ") ? undefined : unit.symbol);
  const symbol = declared?.replace(/=$/, "");
  const constants = symbol == null ? assignedNames(unit.code) : [];
  const names = symbol == null ? [...constants, ...file.owners] : CONSTRUCTORS.has(symbol) ? file.owners : [symbol];
  const seeds = symbol == null ? constants : CONSTRUCTORS.has(symbol) ? [] : [symbol];
  return { unit, file, names: searchable(names), callers: callersOf(file, files, searchable(seeds)) };
}

interface TestCase {
  entry: Declaration;
  /** The names the test mentions, read through the helpers it calls. */
  reads: Set<string>;
  changed: boolean;
}

interface TestFile {
  path: string;
  language?: string;
  lines: string[];
  cases: TestCase[];
  helpers: TestCase[];
  identifiers: Set<string>;
  imports: Set<string>;
}

/** Last path segments a test file imports or requires, by its language's syntax. */
function importedNames(content: string, kind: string | undefined): Set<string> {
  const names = new Set<string>();
  const add = (path: string) => names.add(posix.basename(path).replace(/\.[^.]*$/, ""));
  if (kind === "script") for (const match of content.matchAll(/["'`]([^"'`\n]*\/[^"'`\n]*)["'`]/g)) add(match[1]!);
  if (kind === "ruby") for (const match of content.matchAll(/^[ \t]*require(?:_relative)?[ \t(]+["']([^"'\n]+)["']/gm)) add(match[1]!);
  if (kind === "python") {
    for (const match of content.matchAll(/^[ \t]*(?:from[ \t]+([\w.]+)[ \t]+import[ \t]+([\w, \t]+)|import[ \t]+([\w.]+))/gm)) {
      const module = match[1] ?? match[3]!;
      names.add(module.split(".").at(-1)!);
      for (const name of match[2]?.split(",") ?? []) if (name.trim()) names.add(name.trim().split(/\s+/)[0]!);
    }
  }
  return names;
}

function parseTestFile(path: string, content: string, changed: ReadonlySet<number>): TestFile {
  const lines = splitLines(content);
  const entries = declarations(lines);
  const kind = language(path);
  const pseudo: StoryUnit[] = entries.map((entry) => ({ id: entry.key, path, symbol: entry.name, test: true, helper: !entry.test, anchors: [], code: entry.code }));
  const touched = (entry: Declaration) => {
    for (let line = entry.startLine; line <= entry.endLine; line += 1) if (changed.has(line)) return true;
    return false;
  };
  // Ruby blocks such as `assert_raises(Error) { ... }` parse as declarations; only `def` methods are helpers worth showing.
  const method = (entry: Declaration) => kind !== "ruby" || /^\s*(?:(?:private|protected|public)\s+)?def\s/.test(lines[entry.startLine - 1]!);
  return {
    path,
    language: kind,
    lines,
    cases: entries.flatMap((entry, index) => entry.test ? [{ entry, reads: unitIdentifiers(pseudo[index]!, pseudo), changed: touched(entry) }] : []),
    helpers: entries.filter((entry) => !entry.test && method(entry)).map((entry) => ({ entry, reads: codeIdentifiers(entry.code), changed: touched(entry) })),
    identifiers: codeIdentifiers(content),
    imports: importedNames(content, kind),
  };
}

function pathDistance(left: string, right: string): number {
  const a = posix.dirname(left).split("/");
  const b = posix.dirname(right).split("/");
  let common = 0;
  while (common < a.length && common < b.length && a[common] === b[common]) common += 1;
  return a.length + b.length - 2 * common;
}

/** Mirrored test paths come first, then tests beside the code, then the nearest folders. */
function pathRank(testPath: string, codePath: string): number {
  if (testedPathKey(testPath) === testPairingPathKey(codePath)) return 0;
  if (posix.dirname(testPath) === posix.dirname(codePath)) return 1;
  return 2 + pathDistance(testPath, codePath);
}

/** Tests that mirror the code's path, sit beside it, or import it are dedicated to it; tests that only name its class are not. */
function relation(test: TestFile, code: CodeFile): "dedicated" | "named" | undefined {
  if (test.language == null || test.language !== code.language) return undefined;
  if (pathRank(test.path, code.path) < 2 || code.stem != null && test.imports.has(code.stem)) return "dedicated";
  return code.owners.some((name) => test.identifiers.has(name)) ? "named" : undefined;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function titleMentions(title: string, name: string): boolean {
  if (title.startsWith("test_")) return `_${title}_`.includes(`_${name}_`);
  return new RegExp(`(?<![\\w$])${escapeRegExp(name)}(?![\\w$])`).test(title);
}

interface TestMatch {
  test: TestFile;
  testCase: TestCase;
  /** Closeness to the changed file first, then to the code the test names. */
  home: number;
  rank: number;
  name: string;
  reaches?: string;
  helpers: TestCase[];
}

/**
 * A test matches when it mentions the code's name or a caller's name and its file tests that code. In a file that only
 * names the class, a one-word name such as `call` also needs the test itself to name the class.
 */
function matchTests(search: UnitSearch, tests: readonly TestFile[]): TestMatch[] {
  const targets: Array<[string, Target]> = [...search.names.map((name): [string, Target] => [name, { file: search.file }]), ...search.callers];
  const matches: TestMatch[] = [];
  for (const test of tests) {
    const home = pathRank(test.path, search.file.path);
    const relations = new Map<CodeFile, ReturnType<typeof relation>>();
    const related = (code: CodeFile) => {
      if (!relations.has(code)) relations.set(code, relation(test, code));
      return relations.get(code);
    };
    for (const testCase of test.cases) {
      const { entry, reads } = testCase;
      const hit = targets.find(([name, target]) => {
        if (!reads.has(name) && !titleMentions(entry.name, name)) return false;
        const kind = related(target.file);
        return kind === "dedicated" || kind === "named" && (specificName(name) || target.file.owners.some((owner) => reads.has(owner)));
      });
      if (hit == null) continue;
      const [name, target] = hit;
      matches.push({
        test,
        testCase,
        home,
        rank: pathRank(test.path, target.file.path),
        name,
        ...(target.reaches == null ? {} : { reaches: target.reaches }),
        helpers: test.helpers.filter((helper) => reads.has(helper.entry.name) && helper.reads.has(name)
          && (helper.entry.endLine < entry.startLine || helper.entry.startLine > entry.endLine)),
      });
    }
  }
  return matches.sort((a, b) => a.home - b.home || Number(a.reaches != null) - Number(b.reaches != null) || a.rank - b.rank
    || Number(a.testCase.changed) - Number(b.testCase.changed) || a.test.path.localeCompare(b.test.path) || a.testCase.entry.startLine - b.testCase.entry.startLine);
}

function testFiles(matches: readonly TestMatch[]): ExistingTestFile[] {
  const byPath = new Map<string, { test: TestFile; ranges: Map<string, ExistingTestRange>; reasons: Map<string, ExistingTestReason> }>();
  for (const match of matches) {
    let entry = byPath.get(match.test.path);
    if (entry == null) byPath.set(match.test.path, entry = { test: match.test, ranges: new Map(), reasons: new Map() });
    for (const { entry: declaration, changed } of [match.testCase, ...match.helpers]) {
      entry.ranges.set(declaration.key, { name: declaration.name, startLine: declaration.startLine, endLine: declaration.endLine, helper: !declaration.test, changed });
    }
    const reason = entry.reasons.get(match.name) ?? { name: match.name, ...(match.reaches == null ? {} : { reaches: match.reaches }), tests: 0 };
    reason.tests += 1;
    entry.reasons.set(match.name, reason);
  }
  return [...byPath.values()].map(({ test, ranges, reasons }) => ({
    path: test.path,
    lines: test.lines,
    ranges: [...ranges.values()].sort((a, b) => a.startLine - b.startLine),
    reasons: [...reasons.values()].sort((a, b) => Number(a.reaches != null) - Number(b.reaches != null)),
  }));
}

async function componentRoot(path: string, list: (directory: string) => Promise<string[]>): Promise<string> {
  for (let directory = posix.dirname(path); ; directory = posix.dirname(directory)) {
    const current = directory === "." ? "" : directory;
    if ((await list(current)).some((name) => ROOT_MARKERS.has(name) || name.endsWith(".gemspec"))) return current;
    if (current === "") return "";
  }
}

function changedLines(snapshot: StorySnapshot, fileId: string): Set<number> {
  const lines = new Set<number>();
  for (const change of snapshot.changes) {
    if (change.fileId !== fileId || change.side !== "added") continue;
    for (let line = change.startLine; line <= change.endLine; line += 1) lines.add(line);
  }
  return lines;
}

/** The test files that may test a unit: each mentions a name and mirrors, sits beside, imports, or names the code that declares it. */
function candidateTests(search: UnitSearch, index: ReadonlyMap<string, ReadonlySet<string>>): string[] {
  const ranks = new Map<string, number>();
  const targets: Array<[string, CodeFile]> = [...search.names.map((name): [string, CodeFile] => [name, search.file]), ...[...search.callers].map(([name, target]): [string, CodeFile] => [name, target.file])];
  for (const [name, code] of targets) {
    const naming = new Set([...code.owners, ...code.stem == null ? [] : [code.stem]].flatMap((word) => [...index.get(word) ?? []]));
    for (const path of index.get(name) ?? []) {
      if (!isStoryTestPath(path) || language(path) !== code.language) continue;
      const rank = pathRank(path, code.path);
      if (rank < 2 || naming.has(path)) ranks.set(path, Math.min(ranks.get(path) ?? Infinity, rank));
    }
  }
  return [...ranks.keys()].sort((a, b) => ranks.get(a)! - ranks.get(b)! || a.localeCompare(b));
}

/**
 * Finds the tests of each changed unit of running code at the reviewed revision, inside the unit's component: tests that
 * mention the unit or changed code that calls it, in files that test that code. Tests this review edits count too and are
 * marked as changed. It never rejects; a failed search becomes a failed lookup.
 */
export async function findExistingStoryTests(
  snapshot: StorySnapshot,
  source: ExistingTestSource,
  signal: AbortSignal,
  paths: ReadonlyMap<string, string> = new Map(),
): Promise<ExistingTestReport> {
  const units = new Map<string, ExistingTestLookup>();
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(EXISTING_TEST_SEARCH_MS)]);
  const failure = (error: unknown) => deadline.aborted && !signal.aborted
    ? `The search timed out after ${EXISTING_TEST_SEARCH_MS / 1000} s.`
    : error instanceof Error ? error.message : String(error);
  const lookup = (search: UnitSearch, root: string, result: Partial<ExistingTestLookup> & Pick<ExistingTestLookup, "status">): ExistingTestLookup => ({
    unitId: search.unit.id,
    symbol: search.unit.symbol,
    path: search.file.path,
    root,
    names: search.names,
    callers: [...search.callers.keys()],
    files: [],
    tests: 0,
    unread: 0,
    skipped: [],
    ...result,
  });
  const wordsOf = (search: UnitSearch) => [
    ...search.names, ...search.callers.keys(),
    ...[search.file, ...[...search.callers.values()].map((target) => target.file)].flatMap((file) => [...file.owners, ...file.stem == null ? [] : [file.stem]]),
  ];
  try {
    const files = new Map(snapshot.files.filter((file) => file.hasModified).map((file) => [file.fileId, codeFile(file, paths)]));
    const code = [...files].filter(([fileId]) => !isStoryTestPath(snapshot.files.find((file) => file.fileId === fileId)!.path)).map(([, file]) => file);
    const captured = new Map(snapshot.files.filter((file) => file.hasModified).map((file) => [repositoryPath(file, paths), file]));
    const searches: UnitSearch[] = [];
    for (const unit of prepareStoryUnits(snapshot).filter(needsTestEvidence)) {
      const file = files.get(unit.anchors.find((anchor) => anchor.side === "added")!.fileId)!;
      const search = planSearch(unit, file, code);
      if (file.language != null) searches.push(search);
      else units.set(unit.id, lookup(search, "", { status: "failed", reason: `pi-coder cannot read tests for ${posix.extname(file.path) || "these"} files yet.` }));
    }
    const listings = new Map<string, Promise<string[]>>();
    const list = (directory: string) => {
      let listing = listings.get(directory);
      if (listing == null) listings.set(directory, listing = source.list(directory, deadline));
      return listing;
    };
    const roots = new Map<string, UnitSearch[]>();
    await Promise.all(searches.map(async (search) => {
      try {
        const root = await componentRoot(search.file.path, list);
        roots.set(root, [...roots.get(root) ?? [], search]);
      } catch (error) {
        units.set(search.unit.id, lookup(search, "", { status: "failed", reason: failure(error) }));
      }
    }));
    await mapWithConcurrency([...roots], 2, async ([root, group]) => {
      try {
        const words = new Set(group.flatMap(wordsOf).filter(greppable));
        const index = await source.mentions(root, [...words], deadline);
        const queues = group.map((search) => candidateTests(search, index));
        const chosen = new Set<string>();
        for (let position = 0; chosen.size < MAX_TEST_FILES_READ && queues.some((queue) => position < queue.length); position += 1) {
          for (const queue of queues) if (position < queue.length && chosen.size < MAX_TEST_FILES_READ) chosen.add(queue[position]!);
        }
        const read = new Map(await mapWithConcurrency([...chosen], 8, async (path) => {
          const file = captured.get(path);
          const content = file != null ? file.contents.modifiedContent : await source.read(path, deadline).catch(() => undefined);
          return [path, content == null ? undefined : parseTestFile(path, content, file == null ? new Set() : changedLines(snapshot, file.fileId))] as const;
        }));
        deadline.throwIfAborted();
        group.forEach((search, position) => {
          const queue = queues[position]!.filter((path) => chosen.has(path));
          const tests = queue.flatMap((path) => read.get(path) ?? []);
          const unreadable = queue.length - tests.length;
          const unread = queues[position]!.length - queue.length;
          const skipped = [...new Set(wordsOf(search).filter((word) => !greppable(word)))];
          const matches = matchTests(search, tests);
          units.set(search.unit.id, lookup(search, root, matches.length > 0
            ? { status: "found", files: testFiles(matches.slice(0, MAX_EXISTING_TESTS)), tests: matches.length, unread, skipped }
            : search.names.length === 0 ? { status: "failed", reason: "This code declares no name to search for." }
              : unreadable > 0 ? { status: "failed", reason: `${unreadable} test file${unreadable === 1 ? "" : "s"} could not be read.` }
                : { status: "none", unread, skipped }));
        });
      } catch (error) {
        for (const search of group) units.set(search.unit.id, lookup(search, root, { status: "failed", reason: failure(error) }));
      }
    });
  } catch {
    // Units without a lookup show as not searched.
  }
  return { units };
}

function escapeGlob(path: string): string {
  return path.replace(/[*?[\]\\]/g, "\\$&");
}

/**
 * Reads test files from the reviewed revision, or from the working tree when `revision` is null. Arguments never pass
 * through a shell: searched words follow `-e`, paths follow `--` or a `commit:` object name, and the revision is
 * resolved to its commit once, so nothing from a review can reach git as an option. That first call also proves git
 * runs in the checkout, so an empty search cannot come from a git that never started.
 */
export function createGitTestSource(runner: CommandRunner, repoRoot: string, revision: string | null): ExistingTestSource {
  const git = async (args: string[], signal: AbortSignal, noMatch = false): Promise<string> => {
    const result = await runner.exec("git", args, { cwd: repoRoot, timeout: GIT_TIMEOUT_MS, signal });
    signal.throwIfAborted();
    if (result.killed) throw new Error(`git ${args[0]} timed out.`);
    if (noMatch && result.code === 1 && result.stderr.trim() === "") return "";
    if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${(result.stderr.trim() || result.stdout.trim()).split("\n")[0]}`);
    return result.stdout;
  };
  let commit: Promise<string | null> | undefined;
  const resolveCommit = (signal: AbortSignal) => commit ??= revision == null
    ? git(["rev-parse", "--show-toplevel"], signal).then(() => null)
    : revision.startsWith("-")
      ? Promise.reject(new Error(`pi-coder does not search revision ${JSON.stringify(revision)}.`))
      : git(["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`], signal).then((output) => output.trim());
  return {
    async list(directory, signal) {
      const head = await resolveCommit(signal);
      if (head != null) return (await git(["ls-tree", "--name-only", "-z", directory === "" ? head : `${head}:${directory}`], signal)).split("\0").filter(Boolean);
      const root = await realpath(repoRoot);
      const target = resolve(root, directory);
      return isPathInside(root, target) ? readdir(target).catch(() => []) : [];
    },
    async mentions(root, words, signal) {
      const head = await resolveCommit(signal);
      const index = new Map<string, Set<string>>();
      const searched = words.filter(greppable);
      const prefix = root === "" ? "" : `${escapeGlob(root)}/`;
      const object = head == null ? "" : `${head}:`;
      for (let first = 0; first < searched.length; first += GREP_WORDS) {
        const output = await git([
          "grep", "-I", "-o", "-z", "-F", "-w", "--no-color", ...(head == null ? ["--untracked"] : []),
          ...searched.slice(first, first + GREP_WORDS).flatMap((word) => ["-e", word]),
          ...(head == null ? [] : [head]), "--", ...TEST_GLOBS.map((glob) => `:(glob)${prefix}${glob}`),
        ], signal, true);
        for (let start = 0; start < output.length;) {
          const separator = output.indexOf("\0", start);
          if (separator < 0) break;
          const end = output.indexOf("\n", separator);
          const path = output.slice(start, separator);
          const word = output.slice(separator + 1, end < 0 ? output.length : end);
          let mentioned = index.get(word);
          if (mentioned == null) index.set(word, mentioned = new Set());
          mentioned.add(path.startsWith(object) ? path.slice(object.length) : path);
          start = end < 0 ? output.length : end + 1;
        }
      }
      return index;
    },
    async read(path, signal) {
      const head = await resolveCommit(signal);
      if (head == null) {
        const loaded = await getWorkingTreeContentResult(repoRoot, path);
        return loaded.available && !loaded.content.includes("\0") ? loaded.content : undefined;
      }
      const object = `${head}:${path}`;
      const size = Number.parseInt(await git(["cat-file", "-s", object], signal), 10);
      if (!Number.isFinite(size) || !isReviewFileSizeAllowed(size)) return undefined;
      const content = await git(["cat-file", "blob", object], signal);
      return content.includes("\0") ? undefined : content;
    },
  };
}
