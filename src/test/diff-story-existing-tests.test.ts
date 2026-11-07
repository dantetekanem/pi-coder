import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { execCommand } from "../cli/host.js";
import { classifyStoryStep, createGitTestSource, findExistingStoryTests, MAX_EXISTING_TESTS, type ExistingTestReport, type ExistingTestSource } from "../diff-story/existing-tests.js";
import { createStorySnapshot, type StoryFile, type StoryStep } from "../diff-story/plan.js";
import { isStoryTestPath, prepareStoryUnits } from "../diff-story/units.js";

function change(path: string, before: string, after: string): StoryFile {
  return { fileId: path, path, scope: "all-files", contents: { originalContent: before, modifiedContent: after } };
}

/** An in-memory repository at the reviewed revision; it matches whole words in test files, as `git grep -w` does. */
function repository(files: Record<string, string>) {
  const paths = Object.keys(files).sort();
  const word = (text: string, name: string) => new RegExp(`(?<![\\w$])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w$])`).test(text);
  return {
    list: vi.fn(async (directory: string) => [...new Set(paths
      .filter((path) => directory === "" || path.startsWith(`${directory}/`))
      .map((path) => path.slice(directory === "" ? 0 : directory.length + 1).split("/")[0]!))]),
    mentions: vi.fn(async (root: string, words: readonly string[]): Promise<ReadonlyMap<string, ReadonlySet<string>>> => new Map(words
      .map((name) => [name, new Set(paths.filter((path) => (root === "" || path.startsWith(`${root}/`)) && isStoryTestPath(path) && word(files[path]!, name)))] as const)
      .filter(([, found]) => found.size > 0))),
    read: vi.fn(async (path: string): Promise<string | undefined> => files[path]),
  } satisfies ExistingTestSource;
}

function lookup(report: ExistingTestReport, symbol: string) {
  const found = [...report.units.values()].find((entry) => entry.symbol === symbol);
  if (found == null) throw new Error(`No lookup for ${symbol}`);
  return found;
}

function shown(report: ExistingTestReport, symbol: string) {
  return lookup(report, symbol).files.map((file) => ({
    path: file.path,
    reasons: file.reasons,
    code: file.ranges.map((range) => file.lines.slice(range.startLine - 1, range.endLine).join("\n")),
  }));
}

const order = (tax: number) => `class Order
  def initialize(lines:)
    @lines = lines
  end

  def total
    @lines.sum + tax
  end

  private

  def tax
    ${tax}
  end
end
`;

const orderTest = `require "test_helper"

class OrderTest < ActiveSupport::TestCase
  test "total sums line prices" do
    order = Order.new(lines: [1, 2])
    assert_equal 3, order.total
  end

  test "lines are kept" do
    assert Order.new(lines: []).frozen?
  end
end
`;

describe("existing tests for story steps", () => {
  it("shows unchanged tests that reach a private method through its caller in the same file", async () => {
    const source = repository({ "Gemfile": "", "app/models/order.rb": order(1), "test/models/order_test.rb": orderTest });
    const report = await findExistingStoryTests(createStorySnapshot([change("app/models/order.rb", order(0), order(1))]), source, new AbortController().signal);

    expect(lookup(report, "tax")).toMatchObject({ status: "found", root: "", names: ["tax"], callers: ["total"], tests: 1, unread: 0 });
    expect(shown(report, "tax")).toEqual([{
      path: "test/models/order_test.rb",
      reasons: [{ name: "total", reaches: "tax", tests: 1 }],
      code: ["  test \"total sums line prices\" do\n    order = Order.new(lines: [1, 2])\n    assert_equal 3, order.total\n  end"],
    }]);
    expect(source.mentions).toHaveBeenCalledWith("", ["tax", "total", "Order", "order"], expect.anything());
  });

  it("matches a direct call before a caller, counts test names, and reads through test helpers", async () => {
    const tests = `describe Order do
  it "tax is zero by default" do
    expect(1).to eq(1)
  end

  it "adds line prices to the total" do
    expect(build.total).to eq(3)
  end

  def build
    Order.new(lines: [1, 2])
  end
end
`;
    const helperTests = `class OrderHelperTest < Minitest::Test
  def test_reports_the_total
    assert_equal 3, priced.call
  end

  def priced
    -> { Order.new(lines: [3]).total }
  end
end
`;
    const source = repository({
      "Gemfile": "",
      "app/models/order.rb": order(1),
      "spec/models/order_spec.rb": tests,
      "test/helpers/order_helper_test.rb": helperTests,
    });
    const report = await findExistingStoryTests(createStorySnapshot([change("app/models/order.rb", order(0), order(1))]), source, new AbortController().signal);

    expect(shown(report, "tax")).toEqual([
      {
        path: "spec/models/order_spec.rb",
        reasons: [{ name: "tax", tests: 1 }, { name: "total", reaches: "tax", tests: 1 }],
        code: [
          "  it \"tax is zero by default\" do\n    expect(1).to eq(1)\n  end",
          "  it \"adds line prices to the total\" do\n    expect(build.total).to eq(3)\n  end",
        ],
      },
      {
        path: "test/helpers/order_helper_test.rb",
        reasons: [{ name: "total", reaches: "tax", tests: 1 }],
        code: [
          "  def test_reports_the_total\n    assert_equal 3, priced.call\n  end",
          "  def priced\n    -> { Order.new(lines: [3]).total }\n  end",
        ],
      },
    ]);
  });

  it("keeps tests of other code out, even when they use the same method name", async () => {
    const source = repository({
      "Gemfile": "",
      "app/models/order.rb": order(1),
      "test/models/invoice_test.rb": "test \"invoice total\" do\n  assert_equal 2, Invoice.new.total\nend\n",
      "test/integration/checkout_test.rb": "test \"checkout charges the order total\" do\n  assert_equal 3, Order.new(lines: [3]).total\nend\n",
    });
    const report = await findExistingStoryTests(createStorySnapshot([change("app/models/order.rb", order(0), order(1))]), source, new AbortController().signal);

    expect(shown(report, "tax").map((file) => file.path)).toEqual(["test/integration/checkout_test.rb"]);
  });

  it("matches constructor changes by the class name and loose changes by the constants they assign", async () => {
    const cart = (items: string) => `class Cart\n  def initialize(items)\n    @items = ${items}\n  end\nend\n`;
    const limits = (size: number) => `module Limits\n  CART = ${size}\nend\n`;
    const source = repository({
      "Gemfile": "",
      "lib/cart.rb": cart("items.compact"),
      "lib/limits.rb": limits(3),
      "test/cart_test.rb": "test \"drops empty items\" do\n  assert_equal [1], Cart.new([1, nil]).items\nend\n\ntest \"is full at the limit\" do\n  assert_equal 3, Limits::CART\nend\n",
    });
    const report = await findExistingStoryTests(createStorySnapshot([
      change("lib/cart.rb", cart("items"), cart("items.compact")),
      change("lib/limits.rb", limits(2), limits(3)),
    ]), source, new AbortController().signal);

    expect(lookup(report, "initialize")).toMatchObject({ status: "found", names: ["Cart"], callers: [], tests: 1 });
    expect(shown(report, "initialize")[0]!.code).toEqual(["test \"drops empty items\" do\n  assert_equal [1], Cart.new([1, nil]).items\nend"]);
    expect(lookup(report, "lines 2–2")).toMatchObject({ status: "found", names: ["CART", "Limits"], tests: 1 });
    expect(shown(report, "lines 2–2")[0]!.code).toEqual(["test \"is full at the limit\" do\n  assert_equal 3, Limits::CART\nend"]);
  });

  it("finds tests that import a script by path, and marks the tests this review changes", async () => {
    const before = "export function pairTests(units) {\n  return units.map(pair);\n}\n\nfunction pair(unit) {\n  return unit;\n}\n";
    const after = "export function pairTests(units) {\n  return units.map(pair);\n}\n\nfunction pair(unit) {\n  return { ...unit };\n}\n";
    const oldTests = "import { pairTests } from \"../story/pairing.js\";\n\nit(\"pairs nothing\", () => {\n  expect(pairTests([])).toEqual([]);\n});\n\nit(\"pairs one\", () => {\n  expect(pairTests([1])).toEqual([1]);\n});\n";
    const newTests = oldTests.replace("toEqual([1])", "toEqual([{ 0: 1 }])");
    const source = repository({
      "package.json": "{}",
      "src/story/pairing.ts": after,
      "src/test/pairing.test.ts": newTests,
      "src/test/other.test.ts": "import { pairTests } from \"../elsewhere.js\";\nit(\"is unrelated\", () => pairTests());\n",
    });
    const report = await findExistingStoryTests(createStorySnapshot([
      change("src/story/pairing.ts", before, after),
      change("src/test/pairing.test.ts", oldTests, newTests),
    ]), source, new AbortController().signal);

    expect(shown(report, "pair")).toEqual([{
      path: "src/test/pairing.test.ts",
      reasons: [{ name: "pairTests", reaches: "pair", tests: 2 }],
      code: [
        "it(\"pairs nothing\", () => {\n  expect(pairTests([])).toEqual([]);\n});",
        "it(\"pairs one\", () => {\n  expect(pairTests([1])).toEqual([{ 0: 1 }]);\n});",
      ],
    }]);
    expect(lookup(report, "pair").files[0]!.ranges.map((range) => [range.name, range.changed])).toEqual([["pairs nothing", false], ["pairs one", true]]);
    expect(source.read).not.toHaveBeenCalledWith("src/test/pairing.test.ts", expect.anything());
  });

  it("follows changed callers into one other file, where a one-word name also needs the class named", async () => {
    const context = (value: string) => `class Context\n  def save_locale!(locale)\n    @locale = ${value}\n  end\n\n  def call\n    ${value}\n  end\nend\n`;
    const turn = (step: number) => `class Turn\n  def prepare(context)\n    context.save_locale!(:en)\n    ${step}\n  end\n\n  def run(client)\n    client.call\n  end\nend\n`;
    const tests = "test \"prepare saves the locale\" do\n  Turn.new.prepare(Context.new)\nend\n\ntest \"run asks the client\" do\n  Turn.new.run(client)\nend\n";
    const source = repository({ "Gemfile": "", "app/models/context.rb": context("locale.to_s"), "app/models/turn.rb": turn(2), "test/models/turn_test.rb": tests });
    const report = await findExistingStoryTests(createStorySnapshot([
      change("app/models/context.rb", context("locale"), context("locale.to_s")),
      change("app/models/turn.rb", turn(1), turn(2)),
    ]), source, new AbortController().signal);

    expect(lookup(report, "save_locale!")).toMatchObject({ status: "found", callers: ["prepare"] });
    expect(shown(report, "save_locale!")).toEqual([{
      path: "test/models/turn_test.rb",
      reasons: [{ name: "prepare", reaches: "save_locale!", tests: 1 }],
      code: ["test \"prepare saves the locale\" do\n  Turn.new.prepare(Context.new)\nend"],
    }]);
    expect(lookup(report, "call")).toMatchObject({ status: "none", callers: [] });
    expect(lookup(report, "prepare")).toMatchObject({ status: "found", tests: 1 });
  });

  it("searches for the function around a changed local binding and reads whole tests, local bindings included", async () => {
    const build = (field: string) => `export function build(items) {\n  const pick = (item) => item.${field};\n  return items.map(pick);\n}\n`;
    const tests = "import { build } from \"./build\";\n\nit(\"builds keys\", () => {\n  const items = [{ key: 1 }].map((item) => item);\n  expect(build(items)).toEqual([1]);\n});\n";
    const source = repository({ "package.json": "{}", "src/build.ts": build("key"), "src/build.test.ts": tests });
    const report = await findExistingStoryTests(createStorySnapshot([change("src/build.ts", build("id"), build("key"))]), source, new AbortController().signal);

    expect(lookup(report, "pick")).toMatchObject({ status: "found", names: ["build"] });
    expect(shown(report, "pick")).toEqual([{
      path: "src/build.test.ts",
      reasons: [{ name: "build", tests: 1 }],
      code: ["it(\"builds keys\", () => {\n  const items = [{ key: 1 }].map((item) => item);\n  expect(build(items)).toEqual([1]);\n});"],
    }]);
  });

  it("searches the whole package, not a nested test folder, and searches import paths that are not identifiers", async () => {
    const parse = (value: number) => `export function parse() {\n  return ${value};\n}\n`;
    const page = (title: string) => `export default function Page() {\n  return "${title}";\n}\n`;
    const source = repository({
      "package.json": "{}",
      "src/foo/parse.ts": parse(2),
      "src/foo/__tests__/other.test.ts": "it(\"is about something else\", () => {});\n",
      "tests/parse.test.ts": "import { parse } from \"../src/foo/parse\";\n\nit(\"parses\", () => {\n  expect(parse()).toBe(2);\n});\n",
      "pages/[id].tsx": page("New"),
      "tests/page.test.tsx": "import Page from \"../pages/[id]\";\n\nit(\"renders the page\", () => {\n  expect(Page()).toBe(\"New\");\n});\n",
    });
    const report = await findExistingStoryTests(createStorySnapshot([
      change("src/foo/parse.ts", parse(1), parse(2)),
      change("pages/[id].tsx", page("Old"), page("New")),
    ]), source, new AbortController().signal);

    expect(lookup(report, "parse")).toMatchObject({ status: "found", root: "" });
    expect(shown(report, "parse").map((file) => file.path)).toEqual(["tests/parse.test.ts"]);
    expect(lookup(report, "Page")).toMatchObject({ status: "found", skipped: [] });
    expect(shown(report, "Page").map((file) => file.path)).toEqual(["tests/page.test.tsx"]);
  });

  it("names what it could not search instead of reporting a clean miss", async () => {
    const odd = (value: number) => `export function oddValue() {\n  return ${value};\n}\n`;
    const source = repository({ "package.json": "{}", "src/-odd.ts": odd(2) });
    const report = await findExistingStoryTests(createStorySnapshot([change("src/-odd.ts", odd(1), odd(2))]), source, new AbortController().signal);

    expect(lookup(report, "oddValue")).toMatchObject({ status: "none", skipped: ["-odd"] });
    expect(source.mentions).toHaveBeenCalledWith("", ["oddValue"], expect.anything());
  });

  it("searches the nearest folder with a package manifest", async () => {
    const source = repository({
      "Gemfile": "",
      "services/shop/Gemfile": "",
      "services/shop/app/models/order.rb": order(1),
      "services/shop/test/models/order_test.rb": orderTest,
    });
    const report = await findExistingStoryTests(createStorySnapshot([change("services/shop/app/models/order.rb", order(0), order(1))]), source, new AbortController().signal);

    expect(lookup(report, "tax")).toMatchObject({ status: "found", root: "services/shop" });
    expect(source.mentions).toHaveBeenCalledWith("services/shop", expect.anything(), expect.anything());
    expect(source.list.mock.calls.map(([directory]) => directory)).toEqual(["services/shop/app/models", "services/shop/app", "services/shop"]);
  });

  it("caps the tests it shows and counts the rest", async () => {
    const many = Array.from({ length: MAX_EXISTING_TESTS + 3 }, (_, index) => `test "total ${index}" do\n  Order.new(lines: [${index}]).total\nend\n`).join("\n");
    const source = repository({ "Gemfile": "", "app/models/order.rb": order(1), "test/models/order_test.rb": many });
    const report = await findExistingStoryTests(createStorySnapshot([change("app/models/order.rb", order(0), order(1))]), source, new AbortController().signal);

    expect(lookup(report, "tax")).toMatchObject({ status: "found", tests: MAX_EXISTING_TESTS + 3 });
    expect(lookup(report, "tax").files[0]!.ranges).toHaveLength(MAX_EXISTING_TESTS);
  });

  it("reports no tests, unreadable files, search failures, and unsupported languages distinctly", async () => {
    const snapshot = createStorySnapshot([change("app/models/order.rb", order(0), order(1))]);
    const none = await findExistingStoryTests(snapshot, repository({ "Gemfile": "", "app/models/order.rb": order(1) }), new AbortController().signal);
    expect(lookup(none, "tax")).toMatchObject({ status: "none", root: "", names: ["tax"], callers: ["total"], files: [] });

    const unreadable = repository({ "Gemfile": "", "app/models/order.rb": order(1), "test/models/order_test.rb": orderTest });
    unreadable.read.mockResolvedValue(undefined);
    expect(lookup(await findExistingStoryTests(snapshot, unreadable, new AbortController().signal), "tax"))
      .toMatchObject({ status: "failed", reason: "1 test file could not be read." });

    const broken = repository({ "Gemfile": "" });
    broken.mentions.mockRejectedValue(new Error("git grep failed: bad object"));
    expect(lookup(await findExistingStoryTests(snapshot, broken, new AbortController().signal), "tax"))
      .toMatchObject({ status: "failed", reason: "git grep failed: bad object" });

    const go = createStorySnapshot([change("server/handler.go", "package server\n\nvar limit = 1\n", "package server\n\nvar limit = 2\n")]);
    const goSource = repository({ "go.mod": "" });
    expect([...(await findExistingStoryTests(go, goSource, new AbortController().signal)).units.values()])
      .toMatchObject([{ status: "failed", reason: "pi-coder cannot read tests for .go files yet." }]);
    expect(goSource.mentions).not.toHaveBeenCalled();
  });

  it("does not search prose, configuration, removed code, or tests", async () => {
    const source = repository({ "Gemfile": "" });
    const report = await findExistingStoryTests(createStorySnapshot([
      change("README.md", "Old\n", "New\n"),
      change("config/settings.yml", "a: 1\n", "a: 2\n"),
      change("app/models/legacy.rb", "def gone\n  1\nend\n", ""),
      change("test/models/order_test.rb", orderTest, orderTest.replace("3, order", "4, order")),
    ]), source, new AbortController().signal);

    expect(report.units.size).toBe(0);
    expect(source.mentions).not.toHaveBeenCalled();
  });

  it("classifies story steps by what their code needs from the test pane", () => {
    const snapshot = createStorySnapshot([
      change("README.md", "Old\n", "New\n"),
      change("app/models/order.rb", order(0), order(1)),
      change("app/models/legacy.rb", "def gone\n  1\nend\n", ""),
      change("test/models/order_test.rb", orderTest, orderTest.replace("3, order", "4, order")),
    ]);
    const units = prepareStoryUnits(snapshot);
    const step = (symbol: string): StoryStep => ({
      id: symbol, title: symbol, explanation: "", tests: [],
      implementation: units.find((unit) => unit.symbol === symbol)!.anchors.map((anchor) => ({ ...anchor, unitId: undefined, hash: "" })),
    });

    expect(classifyStoryStep(step("lines 1–1"), units)).toEqual({ kind: "not-code" });
    expect(classifyStoryStep(step("tax"), units)).toEqual({ kind: "code", unitIds: [units.find((unit) => unit.symbol === "tax")!.id] });
    expect(classifyStoryStep(step("gone"), units)).toEqual({ kind: "removed" });
    expect(classifyStoryStep(step("total sums line prices"), units)).toEqual({ kind: "tests" });
    expect(classifyStoryStep({ ...step("tax"), implementation: [{ fileId: "app/models/order.rb", side: "added", startLine: 1, endLine: 1, hash: "" }] }, units))
      .toEqual({ kind: "unknown" });
  });
});

describe("git test source", () => {
  it("refuses a revision that git would read as an option, without running git", async () => {
    const exec = vi.fn();
    const source = createGitTestSource({ exec }, "/repo", "-O/tmp/pager.sh");
    const signal = new AbortController().signal;

    await expect(source.list("", signal)).rejects.toThrow("pi-coder does not search revision \"-O/tmp/pager.sh\".");
    await expect(source.mentions("", ["total"], signal)).rejects.toThrow("pi-coder does not search revision");
    await expect(source.read("test/order_test.rb", signal)).rejects.toThrow("pi-coder does not search revision");
    expect(exec).not.toHaveBeenCalled();
  });

  it("fails instead of finding nothing when git cannot run in the checkout", async () => {
    const missing = join(tmpdir(), "pi-coder-existing-tests-missing", "checkout");
    const signal = new AbortController().signal;
    await expect(createGitTestSource({ exec: execCommand }, missing, "HEAD").mentions("", ["total"], signal)).rejects.toThrow("git rev-parse failed");
    await expect(createGitTestSource({ exec: execCommand }, missing, null).mentions("", ["total"], signal)).rejects.toThrow("git rev-parse failed");
  });

  it("lists, indexes, and reads test files at the reviewed revision and in the working tree, literally and without binary files", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-coder-existing-tests-"));
    const git = promisify(execFile);
    const mentions = (index: ReadonlyMap<string, ReadonlySet<string>>) => Object.fromEntries([...index].map(([word, paths]) => [word, [...paths].sort()]));
    try {
      await mkdir(join(root, "we[ir]d/lib"), { recursive: true });
      await mkdir(join(root, "we[ir]d/test"));
      await mkdir(join(root, "weid/test"), { recursive: true });
      await writeFile(join(root, "we[ir]d/Gemfile"), "");
      await writeFile(join(root, "we[ir]d/lib/order.rb"), order(0));
      await writeFile(join(root, "we[ir]d/test/order_test.rb"), orderTest);
      await writeFile(join(root, "we[ir]d/test/blob_test.rb"), Buffer.from([0, 116, 111, 116, 97, 108, 10]));
      await writeFile(join(root, "weid/test/decoy_test.rb"), "test \"decoy total\" do\n  Order.new(lines: []).total\nend\n");
      await git("git", ["init", "-q", root]);
      await git("git", ["add", "."], { cwd: root });
      await git("git", ["-c", "user.name=Story test", "-c", "user.email=story@example.invalid", "-c", "commit.gpgsign=false",
        "-c", "core.hooksPath=/dev/null", "commit", "-qm", "Fixture"], { cwd: root });
      const head = (await git("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
      await writeFile(join(root, "we[ir]d/lib/order.rb"), order(1));
      await writeFile(join(root, "we[ir]d/test/cart_test.rb"), "test \"cart total\" do\n  Order.new(lines: []).total\nend\n");

      const revision = createGitTestSource({ exec: execCommand }, root, head);
      const signal = new AbortController().signal;
      expect((await revision.list("", signal)).sort()).toEqual(["we[ir]d", "weid"]);
      expect((await revision.list("we[ir]d", signal)).sort()).toEqual(["Gemfile", "lib", "test"]);
      expect(mentions(await revision.mentions("we[ir]d", ["total", "nothing_mentions_this"], signal))).toEqual({ total: ["we[ir]d/test/order_test.rb"] });
      expect(mentions(await revision.mentions("", ["total"], signal))).toEqual({ total: ["we[ir]d/test/order_test.rb", "weid/test/decoy_test.rb"] });
      const many = [...Array.from({ length: 900 }, (_, index) => `missing_name_${index}`), "Order", "-e"];
      expect(mentions(await revision.mentions("we[ir]d", many, signal))).toEqual({ Order: ["we[ir]d/test/order_test.rb"] });
      expect(await revision.read("we[ir]d/test/order_test.rb", signal)).toBe(orderTest);
      expect(await revision.read("we[ir]d/test/blob_test.rb", signal)).toBeUndefined();
      await expect(revision.read("we[ir]d/test/missing_test.rb", signal)).rejects.toThrow("git cat-file failed");

      const worktree = createGitTestSource({ exec: execCommand }, root, null);
      expect((await worktree.list("", signal)).sort()).toEqual([".git", "we[ir]d", "weid"]);
      expect(mentions(await worktree.mentions("we[ir]d", ["total"], signal))).toEqual({ total: ["we[ir]d/test/cart_test.rb", "we[ir]d/test/order_test.rb"] });
      expect(await worktree.read("we[ir]d/test/cart_test.rb", signal)).toContain("cart total");

      const report = await findExistingStoryTests(createStorySnapshot([change("we[ir]d/lib/order.rb", order(0), order(1))]), worktree, signal);
      expect(lookup(report, "tax")).toMatchObject({ status: "found", root: "we[ir]d", tests: 2 });
      expect(lookup(report, "tax").files.map((file) => file.path)).toEqual(["we[ir]d/test/order_test.rb", "we[ir]d/test/cart_test.rb"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
