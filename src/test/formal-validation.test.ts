import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { createStorySnapshot, type StoryFile } from "../diff-story/plan.js";
import * as capture from "../formal-validation/capture.js";
import { buildGuide, linkClaim, readDescription, type FormalValidationGuide, type GuideTarget } from "../formal-validation/guide.js";
import { classifyUnitRisk } from "../formal-validation/priority.js";
import { applyRefinement, buildRefinementPrompt, refineGuide } from "../formal-validation/refine.js";
import { renderGuide } from "../formal-validation/render.js";
import { runFormalValidation } from "../formal-validation/run.js";

function file(path: string, before: string, after: string): StoryFile {
  return { fileId: path, path, scope: "all-files", contents: { originalContent: before, modifiedContent: after } };
}

const target: GuideTarget = { kind: "range", label: "base..head", repoRoot: "/repo", scope: "all-files", base: "base", head: "head" };

const subscriptionBefore = `class Subscription
  def cancel!
    update!(status: "cancelled")
  end
end
`;
const subscriptionAfter = `class Subscription
  def cancel!
    with_lock do
      return if cancelled?
      refund_prorated
      update!(status: "cancelled")
    end
  end

  def refund_prorated
    Refund.create!(amount: prorated_amount)
  end
end
`;
const subscriptionTest = `require "test_helper"

class SubscriptionTest < ActiveSupport::TestCase
  setup do
    Billing::Gateway.stubs(:charge).returns(true)
  end

  test "cancel! refunds the prorated amount once" do
    subscription = subscriptions(:active)
    assert_difference -> { Refund.count }, 1 do
      subscription.cancel!
    end
    assert_equal "cancelled", subscription.reload.status
  end

  test "cancel! twice does not refund again" do
    subscription = subscriptions(:active)
    subscription.cancel!
    assert_no_difference -> { Refund.count } do
      subscription.cancel!
    end
  end

  test "cancel! with a stubbed refund" do
    subscription = subscriptions(:active)
    subscription.stubs(:refund_prorated)
    subscription.cancel!
    assert_equal "cancelled", subscription.status
  end

  test "cancel! runs" do
    subscriptions(:active).cancel!
  end
end
`;
const billingBefore = `export function total(items: number[]) {
  return items.reduce((sum, item) => sum + item, 0);
}
`;
const billingAfter = `export function total(items: number[], discount = 0) {
  const gross = items.reduce((sum, item) => sum + item, 0);
  return Math.max(0, gross - discount);
}
`;
const billingTest = `import { expect, it, vi } from "vitest";
import { total } from "./billing";

it.each([
  [[1, 2], 0, 3],
  [[5], 10, 0],
])("totals %j with a discount of %d", (items, discount, expected) => {
  const run = () => total(items, discount);
  expect(run()).toBe(expected);
});

it("doesn't log while totalling", () => {
  const log = vi.spyOn(console, "log");
  expect(total([1], 0)).toBe(1);
  expect(log).not.toHaveBeenCalled();
});
`;
const checkoutTest = `import { expect, it, vi } from "vitest";
import { checkout } from "./checkout";

vi.mock("./billing", () => ({ total: () => 0 }));

it("checks out an empty cart", () => {
  expect(checkout([])).toEqual({ paid: 0 });
});
`;
const description = `## Problem

Cancelling twice refunded twice.

## Solution

- \`cancel!\` takes a row lock and returns early when already cancelled.
- Refunds are prorated before the status changes.

## Checklist

- [x] I added a changelog entry for this change.

## How to test

- Run \`bin/rails test test/models/subscription_test.rb\` twice.
`;

function snapshot() {
  return createStorySnapshot([
    file("app/models/subscription.rb", subscriptionBefore, subscriptionAfter),
    file("test/models/subscription_test.rb", "", subscriptionTest),
    file("db/migrate/20261001000000_add_refunded_at.rb", "", "class AddRefundedAt < ActiveRecord::Migration[7.1]\n  def change\n    add_column :subscriptions, :refunded_at, :datetime\n  end\nend\n"),
    file("src/billing.ts", billingBefore, billingAfter),
    file("src/billing.test.ts", "", billingTest),
    file("src/checkout.test.ts", "", checkoutTest),
    file("prompts/review.md", "Review the change.\n", "Review the change and list each risk.\n"),
    file("README.md", "Old words.\n", "New words.\n"),
    file("src/format.ts", "export const value = 1;\n", "export const value =  1;\n"),
  ]);
}

function prepare() {
  return buildGuide({ snapshot: snapshot(), target, description });
}

function unitId(guide: FormalValidationGuide, path: string, symbol: string): string {
  const unit = Object.values(guide.units).find((entry) => entry.path === path && entry.symbol === symbol && entry.root == null);
  if (unit == null) throw new Error(`No root unit ${path} · ${symbol}`);
  return unit.id;
}

function testNamed(guide: FormalValidationGuide, name: string) {
  const test = Object.values(guide.tests).find((entry) => entry.name === name);
  if (test == null) throw new Error(`No test named ${name}`);
  return test;
}

describe("formal validation risk ranking", () => {
  it("minimizes docs, lockfiles and mechanical edits, and keeps model instructions", () => {
    expect(classifyUnitRisk({ path: "README.md", symbol: "lines 1–1" }, ["New words."], ["Old words."])).toMatchObject({ priority: "minor", reasons: ["documentation"] });
    expect(classifyUnitRisk({ path: "pnpm-lock.yaml", symbol: "lines 1–3" }, ["a: 2"], ["a: 1"])).toMatchObject({ priority: "minor", categories: ["lockfile"] });
    expect(classifyUnitRisk({ path: "src/a.ts", symbol: "run" }, ["  // explain the refund"], ["  // old note"])).toMatchObject({ priority: "minor", categories: ["comments"] });
    expect(classifyUnitRisk({ path: "src/a.ts", symbol: "run" }, ["  return  value;"], ["  return value;"])).toMatchObject({ priority: "minor", categories: ["formatting"] });
    expect(classifyUnitRisk({ path: "prompts/review.md", symbol: "lines 1–1" }, ["List each risk."], ["List risks."])).toMatchObject({ priority: "needed", reasons: ["model instructions"] });
  });

  it("raises money, migrations and order-dependent writes to critical and names the matched terms", () => {
    expect(classifyUnitRisk({ path: "src/billing.ts", symbol: "total" }, ["  return Math.max(0, gross - discount);"], [])).toMatchObject({
      priority: "critical",
      reasons: ["money or billing (discount)"],
    });
    expect(classifyUnitRisk({ path: "db/migrate/1_add.rb", symbol: "change" }, ["    add_column :subscriptions, :refunded_at, :datetime"], [])).toMatchObject({
      priority: "critical",
      ordering: true,
    });
    const lockedWrite = classifyUnitRisk({ path: "app/models/subscription.rb", symbol: "cancel!" }, ["    with_lock do", "      update!(status: \"cancelled\")"], []);
    expect(lockedWrite).toMatchObject({ priority: "critical", ordering: true });
    expect(lockedWrite.reasons[0]).toMatch(/^order of steps with state writes/);
    expect(classifyUnitRisk({ path: "src/ui.ts", symbol: "render" }, ["  if (error) hint = \"r retry\";"], [])).toMatchObject({ priority: "needed", ordering: true });
  });
});

describe("formal validation guide", () => {
  it.each(['"a b"', "'a b'", "`a b`"])("keeps changed quoted values in a validation step: %s", (literal) => {
    const before = `export function message() {\n  return ${literal};\n}\n`;
    const after = before.replace("a b", "ab");
    const { guide } = buildGuide({
      snapshot: createStorySnapshot([file("src/message.ts", before, after)]),
      target,
    });
    const id = unitId(guide, "src/message.ts", "message");

    expect(guide.steps).toContainEqual(expect.objectContaining({
      priority: "needed",
      units: expect.arrayContaining([id]),
    }));
  });

  it("keeps every changed test case whole and reads what it asserts, fakes and runs for real", () => {
    const { guide } = prepare();
    expect(testNamed(guide, "cancel! refunds the prorated amount once")).toMatchObject({
      kind: "test",
      quality: "strong",
      assertions: 2,
      real: expect.arrayContaining(["fixtures", "persisted records"]),
      negative: false,
    });
    expect(testNamed(guide, "cancel! twice does not refund again")).toMatchObject({ quality: "strong", negative: true });
    const stubbed = testNamed(guide, "cancel! with a stubbed refund");
    expect(stubbed.quality).toBe("weak");
    expect(stubbed.flags.map((flag) => flag.code)).toContain("stubs-changed-code");
    expect(stubbed.doubles).toContainEqual(expect.objectContaining({ target: "subscription#refund_prorated", boundary: "changed-code" }));
    expect(testNamed(guide, "cancel! runs")).toMatchObject({ quality: "weak", assertions: 0, flags: [expect.objectContaining({ code: "no-assertions" })] });

    const table = testNamed(guide, "totals %j with a discount of %d");
    expect(table).toMatchObject({ kind: "test", quality: "strong", assertions: 1 });
    expect(table.members.length).toBeGreaterThan(0);
    const spied = testNamed(guide, "doesn't log while totalling");
    expect(spied).toMatchObject({ quality: "strong", negative: true });
    expect(spied.doubles).toEqual([expect.objectContaining({ kind: "spy", boundary: "external" })]);
    const mocked = testNamed(guide, "checks out an empty cart");
    expect(mocked.quality).toBe("weak");
    expect(mocked.doubles).toEqual([
      expect.objectContaining({ kind: "module-mock", target: "./billing", boundary: "changed-code", line: 4 }),
    ]);
  });

  it.each(["vi", "jest"])("includes an unchanged file-level %s.mock in a modified test profile", (mockApi) => {
    const before = checkoutTest.replace("vi.mock", `${mockApi}.mock`);
    const after = before.replace("paid: 0", "paid: 1");
    const { guide } = buildGuide({
      snapshot: createStorySnapshot([
        file("src/billing.ts", billingBefore, billingAfter),
        file("src/checkout.test.ts", before, after),
      ]),
      target,
    });
    const profile = testNamed(guide, "checks out an empty cart");

    expect(profile.quality).toBe("weak");
    expect(profile.doubles).toEqual([
      expect.objectContaining({ kind: "module-mock", target: "./billing", boundary: "changed-code", line: 4 }),
    ]);
    expect(profile.flags).toContainEqual(expect.objectContaining({ code: "stubs-changed-code" }));
  });

  it("keeps a case-local module mock out of another changed case", () => {
    const before = `it("mocks billing locally", () => {
  vi.doMock("./billing", () => ({ total: () => 0 }));
  expect(total([])).toBe(0);
});
it("checks total", () => {
  expect(total([1])).toBe(1);
});
`;
    const after = before.replace("toBe(1)", "toBe(2)");
    const { guide } = buildGuide({
      snapshot: createStorySnapshot([
        file("src/billing.ts", billingBefore, billingAfter),
        file("src/billing.test.ts", before, after),
      ]),
      target,
    });

    expect(testNamed(guide, "checks total")).toMatchObject({ quality: "strong", doubles: [] });
  });

  it("orders critical steps first, keeps nested code with its declaration and minimizes mechanical edits", () => {
    const { guide } = prepare();
    const priorities = guide.steps.map((step) => step.priority);
    expect(priorities).toEqual([...priorities].sort((a, b) => ["critical", "needed", "minor"].indexOf(a) - ["critical", "needed", "minor"].indexOf(b)));
    const subscription = guide.steps.find((step) => step.units.includes(unitId(guide, "app/models/subscription.rb", "cancel!")))!;
    expect(subscription).toMatchObject({ priority: "critical", ordering: true });
    expect(subscription.units).toContain(unitId(guide, "app/models/subscription.rb", "refund_prorated"));
    expect(subscription.tests.map((id) => guide.tests[id]!.name)).toEqual(expect.arrayContaining([
      "cancel! refunds the prorated amount once",
      "cancel! twice does not refund again",
      "cancel! with a stubbed refund",
      "cancel! runs",
    ]));
    expect(subscription.gaps).toContainEqual(expect.stringMatching(/^Weak test "cancel! runs": No assertion/));
    const billing = guide.steps.find((step) => step.units.includes(unitId(guide, "src/billing.ts", "total")))!;
    expect(billing.priority).toBe("critical");
    expect(billing.units.filter((id) => guide.units[id]!.root == null)).toHaveLength(1);
    expect(guide.steps.find((step) => step.title === "src/checkout.test.ts · changed tests")?.tests).toBeUndefined();
    expect(billing.tests.map((id) => guide.tests[id]!.name)).toEqual(expect.arrayContaining([
      "totals %j with a discount of %d",
      "checks out an empty cart",
    ]));
    expect(guide.minimized.map((id) => guide.units[id]!.path).sort()).toEqual(["README.md", "src/format.ts"]);

    const placed = guide.steps.flatMap((step) => step.units);
    const implementation = Object.values(guide.units).filter((unit) => !unit.test).map((unit) => unit.id);
    expect([...placed, ...guide.minimized].sort()).toEqual([...implementation].sort());
    const tests = guide.steps.flatMap((step) => step.tests);
    expect(tests.sort()).toEqual(Object.keys(guide.tests).sort());
  });

  it("maps description claims to steps and keeps the author's test steps apart", () => {
    const { guide } = prepare();
    expect(guide.claims.map((claim) => claim.text)).toEqual([
      "Cancelling twice refunded twice.",
      "`cancel!` takes a row lock and returns early when already cancelled.",
      "Refunds are prorated before the status changes.",
    ]);
    const subscriptionStep = guide.steps.find((step) => step.units.includes(unitId(guide, "app/models/subscription.rb", "cancel!")))!.id;
    expect(guide.claims[1]!.steps).toEqual([subscriptionStep]);
    expect(guide.claims[2]!.units).toEqual([unitId(guide, "app/models/subscription.rb", "refund_prorated")]);
    expect(guide.authorChecks).toEqual(["Run `bin/rails test test/models/subscription_test.rb` twice."]);
    expect(guide.gaps).toContainEqual(expect.stringContaining("db/migrate/20261001000000_add_refunded_at.rb"));
    expect(guide.gaps).toContainEqual(expect.stringContaining("src/billing.ts · total"));
  });

  it("reads claims from bullets and sentences but not template sections", () => {
    expect(readDescription("Intro sentence that matters. Another claim here.\n\n## Screenshots\n\n- An image caption that is long\n\n## Testing\n\n1. Open the page twice")).toEqual({
      claims: ["Intro sentence that matters.", "Another claim here."],
      checks: ["Open the page twice"],
    });
    const units = [{ id: "u1", path: "src/story.ts", symbol: "storyPageDiff", test: false, status: "added" as const, additions: 1, deletions: 0, anchors: [] }];
    expect(linkClaim("Each diff story page shows its lines once", units)).toEqual(["u1"]);
    expect(linkClaim("Pages are faster", units)).toEqual([]);
  });
});

describe("formal validation refinement", () => {
  it("sends root units with diff excerpts and the description, never nested helpers", () => {
    const prepared = prepare();
    const prompt = buildRefinementPrompt(prepared, description);
    const data = JSON.parse(prompt.slice(prompt.indexOf("\n") + 1));
    expect(data.pr.description).toContain("row lock");
    const cancel = data.units.find((unit: { symbol: string }) => unit.symbol === "cancel!");
    expect(cancel.excerpt).toContain("+    3     with_lock do");
    expect(data.units.map((unit: { id: string }) => unit.id).every((id: string) => prepared.guide.units[id]!.root == null)).toBe(true);
    expect(data.units.find((unit: { path: string }) => unit.path === "README.md").excerpt).toBeUndefined();
    expect(data.tests.map((test: { name: string }) => test.name)).toContain("totals %j with a discount of %d");
  });

  it("applies model groupings and prose while the host keeps coverage, priorities and IDs honest", () => {
    const prepared = prepare();
    const { guide } = prepared;
    const cancel = unitId(guide, "app/models/subscription.rb", "cancel!");
    const refund = unitId(guide, "app/models/subscription.rb", "refund_prorated");
    const migration = Object.values(guide.units).find((unit) => unit.path.startsWith("db/migrate/") && unit.root == null)!.id;
    const strong = testNamed(guide, "cancel! refunds the prorated amount once").unitId;
    const refined = applyRefinement(prepared, JSON.stringify({
      summary: "Cancel takes a lock and refunds once.",
      steps: [
        { units: [migration], title: "Add the refunded_at column", priority: "minor", why: "Schema only." },
        { units: [cancel, refund], tests: [strong], title: "Refund once per cancellation", priority: "critical", why: "Money moves.", property: "A subscription is refunded at most once.", ordering: true, checks: ["Cancel twice at once; expect one refund row."] },
        { units: ["u404"], title: "Ghost" },
      ],
      tests: [{ id: strong, verifies: "One cancel creates one refund and marks the subscription cancelled." }],
      claims: [{ id: "c2", steps: [2] }],
    }), "model/test");

    expect(refined.refinement).toMatchObject({ status: "applied", model: "model/test" });
    expect(refined.refinement.warnings).toEqual(expect.arrayContaining([
      "Kept step 1 at needed: it holds critical code.",
      "Step 3 named no known unit and was dropped.",
    ]));
    const [first] = refined.steps;
    expect(first).toMatchObject({ id: "s1", title: "Refund once per cancellation", priority: "critical", property: "A subscription is refunded at most once." });
    expect(first!.checks).toEqual(["Cancel twice at once; expect one refund row."]);
    expect(first!.reasons[0]).toBe("Money moves.");
    expect(first!.tests).toContain(strong);
    expect(first!.tests.map((id) => refined.tests[id]!.name)).toContain("cancel! runs");
    expect(refined.steps.find((step) => step.title === "Add the refunded_at column")).toMatchObject({ priority: "needed" });
    expect(refined.tests[strong]!.verifies).toBe("One cancel creates one refund and marks the subscription cancelled.");
    expect(refined.claims.find((claim) => claim.id === "c2")!.steps).toEqual(["s1"]);

    const placed = refined.steps.flatMap((step) => step.units);
    expect(new Set(placed).size).toBe(placed.length);
    const implementation = Object.values(refined.units).filter((unit) => !unit.test).map((unit) => unit.id);
    expect([...placed, ...refined.minimized].sort()).toEqual([...implementation].sort());
    const tests = refined.steps.flatMap((step) => step.tests);
    expect(tests.sort()).toEqual(Object.keys(refined.tests).sort());
  });

  it("keeps the host guide when the model answer is unusable and stops when cancelled", async () => {
    const prepared = prepare();
    const generate = vi.fn(async () => "Here is my plan, no JSON.");
    const failed = await refineGuide(prepared, description, generate, new AbortController().signal, "model/test");
    expect(generate).toHaveBeenCalledOnce();
    expect(failed.refinement).toEqual({ status: "failed", model: "model/test", message: "The guideline model did not return valid JSON." });
    expect(failed.steps).toEqual(prepared.guide.steps);

    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(refineGuide(prepared, description, generate, controller.signal)).rejects.toThrow("cancelled");
    expect(generate).toHaveBeenCalledOnce();
  });
});

describe("formal validation output", () => {
  it("renders critical steps first, test quality per test and minimized mechanical work", () => {
    const { guide } = prepare();
    const text = renderGuide(guide, { path: "/tmp/guide.json" });
    const critical = text.indexOf("[critical]");
    const needed = text.indexOf("[needed]");
    expect(critical).toBeGreaterThan(-1);
    expect(needed).toBeGreaterThan(critical);
    expect(text).toContain("Host facts only: steps follow files, checks come from risk rules.");
    expect(text).toContain("- weak · test/models/subscription_test.rb · \"cancel! runs\"");
    expect(text).toContain("No assertion, so it cannot fail on a wrong result.");
    expect(text).toContain("  - README.md · lines 1–1 — documentation");
    expect(text).toContain("\"`cancel!` takes a row lock and returns early when already cancelled.\" → step ");
    expect(text).not.toMatch(/\bu\d+\b/);
  });

  it.each(["succeeds", "fails"])("handles a large guide when saving %s", async (saving) => {
    const root = await mkdtemp(join(tmpdir(), "pi-formal-validation-overflow-"));
    const captureSpy = vi.spyOn(capture, "captureChange");
    try {
      const files = Array.from({ length: 300 }, (_, index) =>
        file(`src/item${index}.ts`, "", `export function item${index}() {\n  return ${index};\n}\n`));
      const testCases = Array.from({ length: 8 }, (_, index) =>
        `it("checks item0 case ${index}", () => {\n  expect(item0()).toBe(0);\n});\n`);
      files.push(file("src/item0.test.ts", "", testCases.join("\n")));
      captureSpy.mockResolvedValue({
        snapshot: createStorySnapshot(files),
        target: { ...target, repoRoot: root },
        hiddenLocales: 0,
        skipped: [],
      });
      const directory = join(root, "guides");
      if (saving === "fails") {
        await writeFile(directory, "blocks directory creation");
      }

      const outcome = await runFormalValidation({} as never, {
        source: { kind: "range", cwd: root, base: "base", head: "head" },
        signal: new AbortController().signal,
        directory,
      });
      const lastStep = outcome.guide.steps.at(-1)!;

      expect(outcome.guide.steps).toHaveLength(300);
      expect(outcome.text).not.toContain(lastStep.title);
      if (saving === "succeeds") {
        expect(outcome.path).toBe(join(directory, `${outcome.guide.snapshot}.json`));
        const saved = JSON.parse(await readFile(outcome.path!, "utf8"));
        expect(saved.steps.at(-1)).toEqual(lastStep);
        expect(saved.steps[0].tests).toHaveLength(8);
        expect(outcome.text).toContain("2 more tests in the saved guide");
        expect(outcome.text).toContain("the saved guide has every step.");
      } else {
        expect(outcome.path).toBeUndefined();
        expect(outcome.text).toContain("Not saved:");
        expect(outcome.text).toContain("2 more tests omitted; the guide was not saved");
        expect(outcome.text).toContain("remaining steps are unavailable.");
      }
    } finally {
      captureSpy.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("captures a real range, writes a private guide and reports host facts without a model", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-formal-validation-"));
    const run = promisify(execFile);
    const git = (args: string[]) => run("git", ["-c", "user.name=Formal test", "-c", "user.email=formal@example.invalid",
      "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd: root });
    const exec = async (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => {
      try {
        const result = await run(command, args, { cwd: options?.cwd, timeout: options?.timeout, maxBuffer: 16 * 1024 * 1024 });
        return { code: 0, stdout: result.stdout, stderr: result.stderr, killed: false };
      } catch (error) {
        const failure = error as { code?: number; stdout?: string; stderr?: string };
        return { code: typeof failure.code === "number" ? failure.code : 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", killed: false };
      }
    };
    try {
      await git(["init", "-q"]);
      await writeFile(join(root, "billing.ts"), billingBefore);
      await git(["add", "."]);
      await git(["commit", "-qm", "Base"]);
      await writeFile(join(root, "billing.ts"), billingAfter);
      await writeFile(join(root, "billing.test.ts"), billingTest);
      await git(["add", "."]);
      await git(["commit", "-qm", "Discounts"]);

      const outcome = await runFormalValidation({ exec } as never, {
        source: { kind: "range", cwd: root, base: "HEAD~1", head: "HEAD" },
        skipReason: "refine=false",
        signal: new AbortController().signal,
        directory: join(root, "guides"),
      });

      expect(outcome.guide.target).toMatchObject({ kind: "range", label: "HEAD~1..HEAD", head: expect.stringMatching(/^[0-9a-f]{12}$/) });
      expect(outcome.guide.refinement).toEqual({ status: "skipped", message: "refine=false" });
      expect(outcome.text).toContain("Host facts only (refine=false)");
      expect(outcome.text).toContain("[critical] billing.ts · total");
      expect(outcome.path).toBe(join(root, "guides", `${outcome.guide.snapshot}.json`));
      expect(JSON.parse(await readFile(outcome.path!, "utf8"))).toEqual(outcome.guide);
      expect((await stat(outcome.path!)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
