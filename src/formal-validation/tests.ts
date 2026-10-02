import type { StoryUnit } from "../diff-story/units.js";
import { isCommentLine, isImportLine } from "./priority.js";
import { fileStem, identifierWords, identifiers, splitLines, type NumberedLine } from "./source.js";

export type TestQuality = "strong" | "fair" | "weak";
export type TestLevel = "unit" | "component" | "integration" | "system";
export type TestLens = "tests_honesty" | "tests_coverage";
export type DoubleBoundary = "external" | "changed-code" | "owned" | "unknown";
export type DoubleKind = "stub" | "mock" | "spy" | "module-mock" | "http-stub" | "fake-fn";

export interface TestDouble {
  kind: DoubleKind;
  target: string;
  boundary: DoubleBoundary;
  line: number;
}

export interface TestFlag {
  code: string;
  lens: TestLens;
  severity: "weak" | "fair" | "info";
  message: string;
}

export interface TestProfile {
  /** The test case's own unit; nested helper units it encloses are listed in members. */
  unitId: string;
  members: string[];
  path: string;
  name: string;
  /** Setup, helpers and requires outside a test case are support code. */
  kind: "test" | "support";
  status: "added" | "modified" | "removed";
  level: TestLevel;
  assertions: number;
  doubles: TestDouble[];
  real: string[];
  flags: TestFlag[];
  /** The name or assertions reach a failure, denied, empty or off path. */
  negative: boolean;
  /** The implementation unit the host pairs this test with by filename and symbol. */
  pairedWith?: string;
  /** Changed implementation units this test names, its paired unit first. */
  targets: string[];
  quality?: TestQuality;
  /** What the test proves, in one sentence, when a guideline model supplied it. */
  verifies?: string;
}

/** Changed implementation code a test can reach by name. */
export interface ChangedCode {
  symbols: Map<string, string>;
  stems: Set<string>;
  classes: Set<string>;
}

export function changedCodeIndex(units: readonly StoryUnit[]): ChangedCode {
  const symbols = new Map<string, string>();
  const stems = new Set<string>();
  const classes = new Set<string>();
  for (const unit of units) {
    if (unit.test) continue;
    const stem = fileStem(unit.path);
    stems.add(stem);
    classes.add(stem.split(/[_.-]/).filter(Boolean).map((part) => part[0]!.toUpperCase() + part.slice(1)).join(""));
    if (unit.symbol.startsWith("lines ")) continue;
    if (!symbols.has(unit.symbol)) symbols.set(unit.symbol, unit.id);
    const bare = unit.symbol.replace(/[!?=]$/, "");
    if (!symbols.has(bare)) symbols.set(bare, unit.id);
  }
  return { symbols, stems, classes };
}

const EXTERNAL_TARGET = /^(?:Net::HTTP|HTTParty|Faraday|RestClient|Excon|Typhoeus|URI|Socket|TCPSocket|Resolv|Redis|Kafka|Aws::\w+|S3|Stripe|Braintree|Twilio|SendGrid|Mailgun|Octokit|Time|Date|DateTime|SecureRandom|Random|Kernel|ENV|File|FileUtils|Dir|IO|Process|Open3|Rails\.logger|Logger|StatsD|Statsd|Datadog|Sentry|Bugsnag|Honeybadger|fetch|window|document|navigator|location|localStorage|sessionStorage|globalThis|global|process|console|Math|crypto|performance|setTimeout|setInterval|axios|fs|os|child_process|http|https|net)(?:$|[.:#])|(?:Client|Gateway|Adapter|Api|API)(?:$|[.#])/;

function isRelativeModule(specifier: string): boolean {
  return /^(?:\.{1,2}\/|\/|~\/|@\/|src\/|#)/.test(specifier);
}

function classifyTarget(changed: ChangedCode, receiver: string | undefined, member: string | undefined): DoubleBoundary {
  const target = [receiver, member].filter(Boolean).join("#");
  if (target.length === 0) return "unknown";
  if (receiver != null && EXTERNAL_TARGET.test(receiver)) return "external";
  if (member != null && changed.symbols.has(member)) {
    const constant = receiver != null && /^[A-Z]/.test(receiver) ? receiver.split("::").at(-1)! : undefined;
    if (constant == null || changed.classes.has(constant)) return "changed-code";
  }
  return receiver == null ? "unknown" : "owned";
}

function classifyModule(changed: ChangedCode, specifier: string): DoubleBoundary {
  if (!isRelativeModule(specifier)) return "external";
  return changed.stems.has(fileStem(specifier.replace(/\/index(?:\.[^/]+)?$/, ""))) ? "changed-code" : "owned";
}

/** Finds the test doubles one source line creates and where each one points. */
export function findDoubles(text: string, line: number, changed: ChangedCode): TestDouble[] {
  const doubles: TestDouble[] = [];
  const add = (kind: DoubleKind, target: string, boundary: DoubleBoundary) => doubles.push({ kind, target, boundary, line });
  for (const match of text.matchAll(/([@\w:.]+?)\.(?:any_instance\.)?(stubs|expects)\(\s*:?["']?([\w]+[!?=]?)/g)) {
    add(match[2] === "expects" ? "mock" : "stub", `${match[1]}#${match[3]}`, classifyTarget(changed, match[1], match[3]));
  }
  for (const match of text.matchAll(/([@\w:.]+?)\.stub\(\s*:([\w]+[!?=]?)/g)) {
    add("stub", `${match[1]}#${match[2]}`, classifyTarget(changed, match[1], match[2]));
  }
  for (const match of text.matchAll(/\b(allow|expect)(?:_any_instance_of)?\(\s*([@\w:.]+)\s*\)\.to\s+(?:have_)?receive(?:_message_chain)?\(\s*:([\w]+[!?=]?)/g)) {
    // `and_call_original` keeps the real method, so it only observes the call.
    const kind = /\.and_call_original\b/.test(text) ? "spy" : match[1] === "expect" ? "mock" : "stub";
    add(kind, `${match[2]}#${match[3]}`, classifyTarget(changed, match[2], match[3]));
  }
  for (const match of text.matchAll(/\b(?:instance|class|object)_double\(\s*["']?([\w:]+)/g)) {
    add("mock", match[1]!, classifyTarget(changed, match[1], undefined));
  }
  for (const match of text.matchAll(/\bstub_const\(\s*["']([\w:]+)/g)) add("stub", match[1]!, classifyTarget(changed, match[1], undefined));
  if (/\bMinitest::Mock\.new\b|(?<![\w.])(?:double|spy)\(/.test(text)) add("mock", "test double", "unknown");
  if (/\b(?:stub_request|VCR\.use_cassette|nock|setupServer|fetchMock)\b/.test(text)) add("http-stub", "network", "external");
  for (const match of text.matchAll(/\b(?:vi|jest)\.(?:mock|doMock|unstable_mockModule)\(\s*["'`]([^"'`]+)/g)) {
    add("module-mock", match[1]!, classifyModule(changed, match[1]!));
  }
  for (const match of text.matchAll(/\b(?:vi|jest)\.spyOn\(\s*([\w$.]+)\s*,\s*["'`]([\w$]+)/g)) {
    // A spy calls through unless the same statement replaces the implementation.
    const replaced = /\.mock(?:Implementation|ReturnValue|ResolvedValue|RejectedValue)(?:Once)?\(/.test(text);
    add(replaced ? "stub" : "spy", `${match[1]}.${match[2]}`, classifyTarget(changed, match[1], match[2]));
  }
  for (const match of text.matchAll(/\bsinon\.(?:stub|replace|spy|mock)\(\s*([\w$.]+)(?:\s*,\s*["'`]([\w$]+))?/g)) {
    add("stub", [match[1], match[2]].filter(Boolean).join("."), classifyTarget(changed, match[1], match[2]));
  }
  for (const match of text.matchAll(/\bvi\.stubGlobal\(\s*["'`]([\w$]+)/g)) add("stub", match[1]!, "external");
  if (/\b(?:vi|jest)\.fn\(|\bsinon\.fake\b/.test(text)) add("fake-fn", "callback", "unknown");
  for (const match of text.matchAll(/\b(?:mock\.)?patch(?:\.object)?\(\s*["']([\w.]+)["']/g)) {
    const parts = match[1]!.split(".");
    add("mock", match[1]!, classifyTarget(changed, parts.slice(0, -1).join(".") || undefined, parts.at(-1)));
  }
  return doubles;
}

const SETUP_START = /^(\s*)(?:def\s+setup\b|setup\b|before(?:Each|All)?\b|before\s*\(\s*:(?:each|all)\s*\)|around\b)\s*(?:do\b|\{|\(|$)/;

/** Doubles created in shared setup run before every test in the file. */
export function sharedSetupDoubles(content: string, changed: ChangedCode): TestDouble[] {
  const lines = splitLines(content);
  const doubles: TestDouble[] = [];
  for (let start = 0; start < lines.length; start += 1) {
    const match = SETUP_START.exec(lines[start]!);
    if (match == null) continue;
    const indent = match[1]!.length;
    let end = start;
    const opensBlock = /(?:\bdo(?:\s*\|[^|]*\|)?|\{|\(|=>)\s*$/.test(lines[start]!) || /^\s*def\s/.test(lines[start]!);
    while (opensBlock && end + 1 < lines.length) {
      end += 1;
      const next = lines[end]!;
      if (next.trim().length > 0 && next.search(/\S/) <= indent) break;
    }
    for (let line = start; line <= end; line += 1) doubles.push(...findDoubles(lines[line]!, line + 1, changed));
    start = end;
  }
  return doubles.filter((double) => double.boundary !== "external" && !["fake-fn", "http-stub", "spy"].includes(double.kind));
}

const ASSERTION = /\b(?:assert|refute)(?:_\w+)?\b|\b(?:assert|expect|verify)[A-Z]\w*\s*\(|\bexpect(?:Type[Oo]f)?\s*[({]|\bis_expected\b|\.should\b|\bshould(?:_not)?\s|\bt\.(?:is|not|true|false|deepEqual|equal|throws|assert)\(|\bassert\.\w+\(|\b(?:require|assert)\.(?:Equal|NoError|Error|True|False|Nil|NotNil|Len|Contains)\w*\(|\bt\.(?:Error|Errorf|Fatal|Fatalf|Fail)\(/;
const SNAPSHOT_ASSERTION = /toMatch(?:Inline|File)?Snapshot\(|\bassert_(?:matches_)?snapshot\b|\bmatch_snapshot\b|\bexpect_snapshot\b/;
const EXISTENCE_ASSERTION = /\.toBeDefined\(\)|\.toBeTruthy\(\)|\.not\.toBe(?:Null|Undefined)\(\)|\.toBeInstanceOf\(|\bassert_not_nil\b|\brefute_nil\b|\bbe_present\b|\bbe_truthy\b/;
const STATUS_ASSERTION = /\bassert_response\s+:?(?:success|ok|200)\b|\bstatus\)?\.toBe\(\s*200\s*\)|\.toHaveStatus\(\s*200|\bhave_http_status\(\s*:?(?:ok|success|200)/;
const INCLUSION_ASSERTION = /\b(?:assert|refute)_includes\b|\.toContain(?:Equal)?\(|\binclude\(|\.toHaveProperty\(|\.toMatchObject\(|\.(?:object|array|string)Containing\(|\bassert_match\b|\.toMatch\(/;
const APPROXIMATE_ASSERTION = /\bassert_in_(?:delta|epsilon)\b|\.toBeCloseTo\(|\bbe_within\(/;
const NEGATIVE_ASSERTION = /\bassert_raises\b|\bassert_no_\w+|\brefute\w*\b|\bassert_not\w*\b|\.not\.|\.toThrow\w*\(|\.rejects\.|\braise_error\b|\bnot_to\b|\bto_not\b|\.toBeFalsy\(\)|\.toBe\(\s*false\s*\)|\bassert_nil\b|\.toBe(?:Null|Undefined)\(\)|\bassert_equal\s+(?:false|nil)\b/;
const NEGATIVE_WORDS = new Set([
  "not", "no", "without", "invalid", "deny", "denies", "denied", "reject", "rejects", "rejected", "refuse", "refuses", "refused",
  "fail", "fails", "failure", "failed", "error", "errors", "raise", "raises", "throw", "throws", "forbidden", "unauthorized",
  "unauthenticated", "missing", "empty", "nil", "null", "undefined", "expired", "stale", "duplicate", "duplicates", "twice",
  "again", "retry", "retries", "timeout", "disabled", "off", "blocked", "cannot", "never", "conflict", "conflicting", "wrong",
  "outside", "unknown", "unavailable", "unreadable", "malformed", "mismatch", "mismatched",
]);
const CONDITIONAL = /^\s*(?:if|unless|case|switch|elsif)\b|^\s*else\s+if\b/;
const SLEEP = /\bsleep\s*\(?\s*\d|\.waitForTimeout\(|\bTimeout\.timeout\b/;
const SET_TIMEOUT = /\bsetTimeout\s*\(/;
const SKIPPED = /^\s*skip\b|\bskip\(\s*["'`]|\b(?:xit|xtest|xdescribe|xcontext)\s*\(|\b(?:it|test|describe|context)\.(?:skip|todo)\s*\(|^\s*pending\b/;
const FOCUSED = /\b(?:it|test|describe|context)\.only\s*\(|\b(?:fit|fdescribe|fcontext)\s*\(/;

const REAL_SIGNALS: ReadonlyArray<readonly [string, RegExp]> = [
  ["fixtures", /\b[a-z_]+\(\s*:[a-z0-9_]+\s*\)|\bfixtures\s+:|\b(?:create|build|build_stubbed|create_list|build_list)\(\s*:\w+|\bFabricate\(|\bFactoryBot\b/],
  ["persisted records", /\.(?:save|create|update|destroy|reload)!?(?=[\s(]|$)|\bassert_difference\b|\bassert_changes\b/],
  ["HTTP request", /^\s*(?:get|post|put|patch|delete|head)\s*\(?\s*(?:["'/]|\w+_(?:path|url)\b)|\brequest\(\s*app\s*\)|\bsupertest\b/],
  ["rendered UI", /\b(?:render|mount|shallow)\s*\(|\bscreen\.|\b(?:getBy|findBy|queryBy|getAllBy|findAllBy|queryAllBy)\w+\(|\buserEvent\.|\bfireEvent\./],
  ["browser", /\bvisit\s|\bclick_on\b|\bfill_in\b|\bpage\.(?:goto|click|fill|getBy)/],
  ["jobs run", /\bperform_enqueued_jobs\b|\bassert_enqueued_with\b|\bassert_performed\w*\b|\.perform_now\b/],
  ["controlled clock", /\btravel_to\b|\bfreeze_time\b|\btravel\s+\d|\bTimecop\b|\buseFakeTimers\b|\bsetSystemTime\b/],
  ["real files", /\bmkdtemp(?:Sync)?\b|\btmpdir\(\)|\bDir\.mktmpdir\b|\bwriteFileSync\b|\bTempfile\b/],
  ["real git", /\bgit\s+(?:init|commit|add)\b|["'`]git["'`]/],
];

function testLevel(path: string, text: string, real: readonly string[]): TestLevel {
  if (/(?:^|\/)(?:test|spec)s?\/(?:system|features|e2e|acceptance)\/|\.e2e\.|(?:^|\/)(?:cypress|playwright|e2e)\//.test(path) || real.includes("browser")) return "system";
  if (/(?:^|\/)(?:test|spec)s?\/(?:integration|requests|controllers|api)\//.test(path) || /\bIntegrationTest\b/.test(text) || real.includes("HTTP request")) return "integration";
  if (real.includes("rendered UI")) return "component";
  return "unit";
}

/** Blanks string literals so test names and messages do not read as assertions or branches. */
function withoutStrings(text: string): string {
  return text.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g, (literal) => `${literal[0]}${literal[0]}`);
}

function describeTargets(doubles: readonly TestDouble[]): string {
  const targets = [...new Set(doubles.map((double) => double.target))];
  return `${targets.slice(0, 3).map((target) => `\`${target}\``).join(", ")}${targets.length > 3 ? ` and ${targets.length - 3} more` : ""}`;
}

export interface TestProfileInput {
  unit: StoryUnit;
  /** The enclosing test case's name when the changed unit is a helper inside it. */
  name?: string;
  members?: readonly string[];
  /** True when the unit declares a test case rather than a helper or setup code. */
  isCase: boolean;
  lines: readonly NumberedLine[];
  status: TestProfile["status"];
  changed: ChangedCode;
  pairedWith?: string;
  setupDoubles?: readonly TestDouble[];
}

/** Reads one changed test case for what it asserts, what it fakes and what it exercises for real. */
export function profileTest(input: TestProfileInput): TestProfile {
  const { unit, lines, status, changed } = input;
  const kind = input.isCase ? "test" : "support";
  const body = lines.filter((line) => !isImportLine(line.text) && !isCommentLine(line.text));
  const text = body.map((line) => line.text).join("\n");
  const stripped = body.map((line) => ({ line: line.line, text: withoutStrings(line.text) }));
  const strippedText = stripped.map((line) => line.text).join("\n");
  const assertionLines = stripped.filter((line) => ASSERTION.test(line.text));
  const doubles = body.flatMap((line) => findDoubles(line.text, line.line, changed));
  const real = REAL_SIGNALS.filter(([, pattern]) => body.some((line) => pattern.test(line.text))).map(([label]) => label);
  const level = testLevel(unit.path, strippedText, real);
  const flags: TestFlag[] = [];
  const flag = (code: string, lens: TestLens, severity: TestFlag["severity"], message: string) => flags.push({ code, lens, severity, message });
  const caseBody = stripped.slice(1);

  if (status === "removed") {
    if (kind === "test") flag("removed", "tests_coverage", "info", "Removed in this change; confirm the behavior is still covered or meant to go.");
  } else if (kind === "test") {
    if (stripped.some((line) => SKIPPED.test(line.text))) flag("skipped", "tests_coverage", "weak", "Skipped, so it never runs.");
    if (FOCUSED.test(strippedText)) flag("focused", "tests_coverage", "weak", "Focused with only; other tests in the file stop running.");
    if (assertionLines.length === 0) flag("no-assertions", "tests_honesty", "weak", "No assertion, so it cannot fail on a wrong result.");
    else if (assertionLines.every((line) => SNAPSHOT_ASSERTION.test(line.text))) flag("snapshot-only", "tests_honesty", "weak", "Only snapshot assertions; a regenerated snapshot passes whatever the code does.");
    else if (assertionLines.every((line) => EXISTENCE_ASSERTION.test(line.text))) flag("existence-only", "tests_honesty", "weak", "Only checks that a value exists, not what it is.");
    else if (assertionLines.every((line) => STATUS_ASSERTION.test(line.text))) flag("status-only", "tests_coverage", "fair", "Checks only the response status, not what the response says.");
    else if (assertionLines.every((line) => INCLUSION_ASSERTION.test(line.text))) {
      // Rendered output is usually checked by inclusion; elsewhere an exact comparison pins the whole result.
      flag("inclusion-only", "tests_coverage", level === "unit" || level === "integration" ? "fair" : "info", "Checks inclusion only; a wrong extra or missing value still passes.");
    }
    if (assertionLines.some((line) => APPROXIMATE_ASSERTION.test(line.text))) flag("approximate", "tests_honesty", "info", "Approximate comparison; confirm the math is not deterministic.");
    const fakes = doubles.filter((double) => double.kind !== "spy" && double.kind !== "fake-fn");
    const changedDoubles = fakes.filter((double) => double.boundary === "changed-code");
    if (changedDoubles.length > 0) flag("stubs-changed-code", "tests_honesty", "weak", `Fakes ${describeTargets(changedDoubles)}, which this change modifies, so the changed code never runs here.`);
    const ownedDoubles = fakes.filter((double) => double.boundary === "owned");
    if (ownedDoubles.length > 0) flag("stubs-owned-code", "tests_honesty", "fair", `Fakes owned code ${describeTargets(ownedDoubles)}; let it run and fake only the third party inside it.`);
    if (/\bany_instance\b|_any_instance_of\b/.test(strippedText)) flag("any-instance", "tests_honesty", "fair", "Stubs every instance of a class, so the real object never runs.");
    if ((input.setupDoubles?.length ?? 0) > 0) flag("stub-in-setup", "tests_honesty", "fair", `Shared setup fakes ${describeTargets(input.setupDoubles!)} for every test in this file.`);
    if (caseBody.some((line) => CONDITIONAL.test(line.text))) flag("conditional", "tests_honesty", "fair", "Branches inside the test; one path may never run. Split it into scenarios.");
    if (SLEEP.test(strippedText) || (SET_TIMEOUT.test(strippedText) && !real.includes("controlled clock"))) flag("sleep", "tests_honesty", "fair", "Waits on real time; slow and flaky.");
  }

  const name = input.name ?? unit.symbol;
  const negative = identifierWords(name).some((word) => NEGATIVE_WORDS.has(word))
    || assertionLines.some((line) => NEGATIVE_ASSERTION.test(line.text));
  const named = identifiers(text);
  const targets = [...new Set([
    ...(input.pairedWith == null ? [] : [input.pairedWith]),
    ...[...changed.symbols].filter(([symbol]) => named.has(symbol)).map(([, id]) => id),
  ])];
  const quality: TestQuality | undefined = kind === "support" || status === "removed"
    ? undefined
    : flags.some((entry) => entry.severity === "weak") ? "weak"
      : flags.some((entry) => entry.severity === "fair") ? "fair" : "strong";
  return {
    unitId: unit.id,
    members: [...(input.members ?? [unit.id])],
    path: unit.path,
    name: kind === "test" ? name : name.startsWith("lines ") ? `setup and helpers (${name})` : `helper ${name}`,
    kind,
    status,
    level,
    assertions: assertionLines.length,
    doubles,
    real,
    flags,
    negative,
    ...(input.pairedWith == null ? {} : { pairedWith: input.pairedWith }),
    targets,
    ...(quality == null ? {} : { quality }),
  };
}
