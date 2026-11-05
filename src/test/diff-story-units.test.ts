import { describe, expect, it, vi } from "vitest";
import { generateDiffStory } from "../diff-story/generate.js";
import { completeDiffStory, createStorySnapshot, uncoveredStoryChanges, validateDiffStory, validateSavedDiffStory, type StoryFile } from "../diff-story/plan.js";
import { restoreStoryNavigation, storyAnchors, storyPages } from "../diff-story/navigation.js";
import { prepareStoryUnits, splitStoryTests, STORY_TEST_FILE_LINES, type StoryUnit } from "../diff-story/units.js";

function file(path: string, before: string, after: string): StoryFile {
  return {
    fileId: path,
    path,
    scope: "git-diff",
    contents: { originalContent: before, modifiedContent: after },
  };
}

const source = (value: number) => `export function parse() {
  return ${value};
}
export function print() {
  return ${value};
}
`;
const tests = (value: number) => `import { parse, print } from './parser';
it('parses input', () => {
  expect(parse()).toBe(${value});
});
it('prints output', () => {
  expect(print()).toBe(${value});
});
`;
const snapshot = () => createStorySnapshot([
  file("src/parser.ts", source(0), source(1)),
  file("src/test/parser.test.ts", tests(0), tests(1)),
]);

function payload(prompt: string) {
  return JSON.parse(prompt.split("\n").at(-1)!);
}

describe("prepared story units", () => {
  it("extracts changed functions and individual tests, pairing same-name files before the model call", async () => {
    const captured = snapshot();
    const generate = vi.fn(async (_system: string, prompt: string) => {
      const context = payload(prompt);
      expect(context.units.map((unit: { symbol: string }) => unit.symbol)).toEqual([
        "parse", "print", "parses input", "prints output",
      ]);
      expect(context.pairs).toEqual([["u1", "u3"], ["u2", "u4"]]);
      expect(context.units[2].references).toEqual(["u1"]);
      expect(context.units[3].references).toEqual(["u2"]);
      return JSON.stringify({ order: ["u2", "u1"], pairs: [] });
    });
    const story = await generateDiffStory(captured, generate, new AbortController().signal, () => {});
    expect(generate).toHaveBeenCalledOnce();
    expect(story.steps.map((step) => step.title)).toEqual(["src/parser.ts · print", "src/parser.ts · parse"]);
    expect(story.steps.map((step) => step.tests.map((anchor) => anchor.startLine))).toEqual([[5, 5], [2, 2]]);
    expect(uncoveredStoryChanges(story, captured)).toEqual([]);
  });

  it("prepares uniquely prefixed test filenames and puts code before supporting prose", async () => {
    const captured = createStorySnapshot([
      file("CHANGELOG.md", "", "Fix touching composite keys.\n"),
      file("lib/belongs_to.rb", "", "def touch_record\n  record.touch\nend\n"),
      file("test/belongs_to_associations_test.rb", "", "test 'touches the parent' do\n  book.save!\nend\n"),
    ]);
    const generate = vi.fn(async (_system: string, prompt: string) => {
      const context = payload(prompt);
      expect(context.units[0].symbol).toBe("touch_record");
      expect(context.pairs).toEqual([["u1", "u3"]]);
      return '{"order":[],"pairs":[]}';
    });

    const story = await generateDiffStory(captured, generate, new AbortController().signal, () => {});

    expect(story.steps[0]!.title).toBe("lib/belongs_to.rb · touch_record");
    expect(story.steps[0]!.tests).toHaveLength(1);
    expect(uncoveredStoryChanges(story, captured)).toEqual([]);
  });

  it("prepares references from the whole changed function, including calls away from the changed line", async () => {
    const before = `function entry() {
  helper();
  const a = 1;
  const b = 2;
  const c = 3;
  const d = 4;
  return 0;
}
function helper() {
  return 0;
}
`;
    const captured = createStorySnapshot([file("entry.ts", before, before.replaceAll("return 0", "return 1"))]);
    const generate = vi.fn(async (_system: string, prompt: string) => {
      expect(payload(prompt).units[0].references).toEqual(["u2"]);
      return '{"order":[],"pairs":[]}';
    });

    await generateDiffStory(captured, generate, new AbortController().signal, () => {});
  });

  it("splits adjacent added functions instead of treating a whole-file hunk as one step", () => {
    const captured = createStorySnapshot([file("parser.ts", "", source(1))]);
    const units = prepareStoryUnits(captured);
    expect(units.map((unit) => unit.symbol)).toEqual(["parse", "print"]);
    expect(units.map((unit) => unit.anchors.map((anchor) => [anchor.startLine, anchor.endLine]))).toEqual([[[1, 3]], [[4, 6]]]);
  });

  it("keeps multiline signatures with their body and separates nested declarations", () => {
    const captured = createStorySnapshot([file("request.ts", "", `export async function request(
  value: number,
): Promise<number> {
  function nested() {
    return value;
  }
  return nested();
}
const next = (
  value: number,
) => {
  return value;
};
`)]);
    const units = prepareStoryUnits(captured);
    expect(units.map((unit) => unit.symbol)).toEqual(["request", "nested", "next"]);
    expect(units[0]!.anchors.map(({ startLine, endLine }) => [startLine, endLine])).toEqual([[1, 3], [7, 8]]);
    expect(units[2]!.anchors[0]).toMatchObject({ startLine: 9, endLine: 13 });
  });

  it("keeps blank lines between added tests with their test instead of revisiting the same code as a whitespace step", () => {
    const captured = createStorySnapshot([file("test/order_test.rb", "", `test 'first' do
  assert first
end

test 'second' do
  assert second
end
`)]);

    const units = prepareStoryUnits(captured);

    expect(units.map((unit) => unit.symbol)).toEqual(["first", "second"]);
    expect(units[0]!.anchors[0]).toMatchObject({ startLine: 1, endLine: 4 });
  });

  it("folds loose changes into the nearest declaration and keeps a file without declarations in one unit", () => {
    const captured = createStorySnapshot([
      file("lib/order.rb", "class Order\n  LIMIT = 1\n\n  def total\n    1\n  end\nend\n", "class Order\n  LIMIT = 2\n\n  def total\n    2\n  end\nend\n"),
      file("config/app.yml", "a: 1\nb: 2\nc: 3\nd: 4\ne: 5\nf: 6\ng: 7\n", "a: 0\nb: 2\nc: 3\nd: 4\ne: 5\nf: 6\ng: 0\n"),
    ]);

    const units = prepareStoryUnits(captured);

    expect(units.map((unit) => unit.symbol)).toEqual(["total", "lines 1–7"]);
    expect(units[0]!.anchors.map(({ side, startLine, endLine }) => [side, startLine, endLine])).toEqual([
      ["added", 2, 2], ["deleted", 2, 2], ["added", 4, 6], ["deleted", 4, 6],
    ]);
    expect(units[1]!.anchors).toHaveLength(4);
  });

  it("attaches setup and helpers to the nearest paired test's step and gives an unpaired test file one step", async () => {
    const captured = createStorySnapshot([
      file("lib/parser.rb", "", "def parse\n  1\nend\n\ndef print\n  2\nend\n"),
      file("test/parser_test.rb", "", "def setup\n  @value = 1\nend\n\ntest 'parses' do\n  assert parse\nend\n\ndef helper\n  2\nend\n"),
      file("test/other_test.rb", "", "test 'first' do\n  assert true\nend\n\ntest 'second' do\n  assert true\nend\n"),
    ]);

    const story = await generateDiffStory(captured, async () => '{"order":[],"pairs":[]}', new AbortController().signal, () => {});

    expect(story.steps.map((step) => step.title)).toEqual([
      "lib/parser.rb · parse", "lib/parser.rb · print", "test/other_test.rb · first and 1 more",
    ]);
    expect(story.steps[0]!.tests.map(({ startLine, endLine }) => [startLine, endLine])).toEqual([[1, 4], [5, 8], [9, 11]]);
    expect(story.steps[1]!.tests).toEqual([]);
    expect(story.steps[2]!.implementation.map(({ startLine, endLine }) => [startLine, endLine])).toEqual([[1, 4], [5, 7]]);
    expect(uncoveredStoryChanges(story, captured)).toEqual([]);
  });

  it("handles Ruby methods, test blocks, deletion-only units and supporting changes", async () => {
    const captured = createStorySnapshot([
      file("lib/order.rb", "class Order\n  def total\n    1\n  end\n  def legacy\n    0\n  end\nend\n", "class Order\n  def total\n    2\n  end\nend\n"),
      file("test/order_test.rb", "", "require 'test_helper'\nclass OrderTest\n  test \"total\" do\n    assert_equal 2, Order.new.total\n  end\nend\n"),
      file("README.md", "old\n", "new\n"),
    ]);
    const units = prepareStoryUnits(captured);
    expect(units.find((unit) => unit.symbol === "legacy")?.anchors).toEqual([
      expect.objectContaining({ side: "deleted", startLine: 5, endLine: 7 }),
    ]);
    expect(units.filter((unit) => unit.symbol === "total")).toHaveLength(2);
    const story = await generateDiffStory(captured, async () => '{"order":[],"pairs":[]}', new AbortController().signal, () => {});
    expect(uncoveredStoryChanges(story, captured)).toEqual([]);
    const total = story.steps.find((step) => step.title === "lib/order.rb · total")!;
    expect(total.tests).toEqual(expect.arrayContaining([expect.objectContaining({ fileId: "test/order_test.rb", startLine: 3, endLine: 5 })]));
  });

  it("accepts ID-only reassignment, includes omitted units, and rejects fabricated IDs without another call", async () => {
    const captured = snapshot();
    const generate = vi.fn(async () => '{"order":["u2"],"pairs":[["u2","u3"]]}');
    const story = await generateDiffStory(captured, generate, new AbortController().signal, () => {});
    expect(story.steps.map((step) => step.id)).toEqual(["u2", "u1"]);
    expect(story.steps[0]!.tests).toHaveLength(4);
    expect(story.steps[1]!.tests).toEqual([]);
    expect(uncoveredStoryChanges(story, captured)).toEqual([]);
    generate.mockResolvedValue('{"order":["outside"],"pairs":[]}');
    await expect(generateDiffStory(captured, generate, new AbortController().signal, () => {})).rejects.toThrow(/unknown unit/i);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("visits a paired test once even when both endpoints change and the model repeats its IDs", async () => {
    const captured = snapshot();
    const story = await generateDiffStory(captured, async () => '{"order":["u1","u1","u3"],"pairs":[["u1","u3"],["u2","u3"]]}', new AbortController().signal, () => {});
    expect(story.steps).toHaveLength(2);
    const navigation = restoreStoryNavigation(story);
    expect(storyAnchors(navigation)).toHaveLength(1);
    navigation.step = 1;
    const pages = storyPages(navigation, "tests");
    expect(pages).toHaveLength(1);
    expect(pages[0]!.anchors.map((anchor) => [anchor.unitId, anchor.side])).toEqual([
      ["u3", "added"], ["u3", "deleted"], ["u4", "added"], ["u4", "deleted"],
    ]);
    expect(pages[0]!.anchor).toMatchObject({ unitId: "u3", side: "added" });
    expect(uncoveredStoryChanges(story, captured)).toEqual([]);
  });

  it.each([
    ["src/rename.ts", "export function oldName() {\n  return 1;\n}\n"],
    ["src/rename.test.ts", "it('oldName', () => {\n  expect(value).toBe(1);\n});\n"],
  ])("keeps both endpoints of a renamed declaration in one visit for %s", async (path, before) => {
    const captured = createStorySnapshot([file(path, before, before.replace("oldName", "newName"))]);

    const story = await generateDiffStory(captured, async () => '{"order":[],"pairs":[]}', new AbortController().signal, () => {});

    expect(story.steps).toHaveLength(1);
    expect(story.steps[0]!.implementation.map(({ side, unitId }) => ({ side, unitId }))).toEqual([
      { side: "added", unitId: "u1" },
      { side: "deleted", unitId: "u1" },
    ]);
    expect(storyAnchors(restoreStoryNavigation(story))).toHaveLength(1);
    expect(uncoveredStoryChanges(story, captured)).toEqual([]);
  });

  it("completes a partial test anchor without appending the same test as an independent step", () => {
    const captured = snapshot();
    const partial = validateDiffStory({
      version: 1,
      snapshot: captured.fingerprint,
      summary: "",
      steps: [
        {
          id: "parse",
          title: "parse",
          explanation: "",
          implementation: [{ fileId: "src/parser.ts", side: "added", startLine: 1, endLine: 3 }],
          tests: [{ fileId: "src/test/parser.test.ts", side: "added", startLine: 3, endLine: 3 }],
        },
        {
          id: "repeated-test",
          title: "same test",
          explanation: "",
          implementation: [{ fileId: "src/test/parser.test.ts", side: "added", startLine: 2, endLine: 4 }],
          tests: [{ fileId: "src/test/parser.test.ts", side: "added", startLine: 3, endLine: 3 }],
        },
      ],
    }, captured);
    const completed = completeDiffStory(partial, captured);
    expect(completed.steps[0]!.tests).toEqual([
      expect.objectContaining({ side: "added", startLine: 2, endLine: 4 }),
      expect.objectContaining({ side: "deleted", startLine: 2, endLine: 4 }),
    ]);
    expect(completed.steps.slice(1).flatMap((step) => [...step.tests, ...step.implementation]).some((anchor) =>
      anchor.fileId === "src/test/parser.test.ts" && anchor.startLine <= 4 && anchor.endLine >= 2,
    )).toBe(false);
    expect(uncoveredStoryChanges(completed, captured)).toEqual([]);
    expect(completeDiffStory(completed, captured)).toEqual(completed);
  });

  describe("task-sized steps", () => {
    const unitOf = (id: string, path: string, lines: number): StoryUnit => ({
      id, path, symbol: id, test: true, code: "",
      anchors: [{ fileId: path, side: "added", startLine: 1, endLine: lines }],
    });
    const cases = (count: number, prefix = "case") => Array.from({ length: count }, (_, index) =>
      `it('${prefix} ${index}', () => {\n${Array.from({ length: 10 }, (_, line) => `  expect(charge(${line})).toBe(${line});`).join("\n")}\n});\n`).join("");
    const billing = "export function charge(amount: number) {\n  return amount;\n}\n";
    const arranged = (files: StoryFile[]) => {
      const captured = createStorySnapshot(files);
      return generateDiffStory(captured, async () => '{"order":[],"pairs":[]}', new AbortController().signal, () => {}).then((story) => ({ captured, story }));
    };
    const places = (anchors: ReadonlyArray<{ fileId: string; side: string; startLine: number; endLine: number }>) =>
      anchors.map((anchor) => `${anchor.fileId}:${anchor.side}:${anchor.startLine}-${anchor.endLine}`);

    it("splits whole tests greedily in source order, per file", () => {
      expect(STORY_TEST_FILE_LINES).toBe(30);
      expect(splitStoryTests([], 30)).toEqual([[]]);
      const long = unitOf("a", "a.test.ts", 45);
      expect(splitStoryTests([long], 30)).toEqual([[long]]);

      const a1 = unitOf("a1", "a.test.ts", 15);
      const a2 = unitOf("a2", "a.test.ts", 15);
      const a3 = unitOf("a3", "a.test.ts", 1);
      expect(splitStoryTests([a1, a2], 30)).toEqual([[a1, a2]]);
      expect(splitStoryTests([a1, a2, a3], 30)).toEqual([[a1, a2], [a3]]);

      const b1 = unitOf("b1", "b.test.ts", 20);
      const a4 = unitOf("a4", "a.test.ts", 20);
      const a5 = unitOf("a5", "a.test.ts", 20);
      expect(splitStoryTests([a4, b1, a5], 30).map((chunk) => chunk.map((unit) => unit.id))).toEqual([["a4", "b1"], ["a5"]]);
      expect(splitStoryTests([a4, b1, unitOf("b2", "b.test.ts", 9)], 30).map((chunk) => chunk.map((unit) => unit.id))).toEqual([["a4", "b1", "b2"]]);
    });

    it("splits a long test file into steps that repeat the implementation", async () => {
      const { captured, story } = await arranged([
        file("lib/billing.ts", billing, billing.replace("return amount;", "return amount + 1;")),
        file("test/billing.test.ts", "", cases(3)),
      ]);

      expect(story.steps.map((step) => step.id)).toEqual(["u1", "u1~2"]);
      expect(story.steps.map((step) => step.title)).toEqual(["lib/billing.ts \u00b7 charge \u00b7 tests 1/2", "lib/billing.ts \u00b7 charge \u00b7 tests 2/2"]);
      expect(story.steps[1]!.implementation).toEqual(story.steps[0]!.implementation);
      expect(story.steps.map((step) => step.tests.length)).toEqual([2, 1]);
      const [first, second] = story.steps.map((step) => places(step.tests));
      expect(first!.filter((place) => second!.includes(place))).toEqual([]);
      expect(uncoveredStoryChanges(story, captured)).toEqual([]);
      expect(completeDiffStory(story, captured)).toEqual(story);
      expect(() => validateSavedDiffStory(JSON.parse(JSON.stringify(story)), captured)).not.toThrow();

      const navigation = restoreStoryNavigation(story);
      const pages = [0, 1].map((step) => storyPages({ ...navigation, step }, "implementation").map((page) => page.key));
      expect(pages[1]).toEqual(pages[0]);
    });

    it("keeps short tests in one step", async () => {
      const { captured, story } = await arranged([
        file("lib/billing.ts", billing, billing.replace("return amount;", "return amount + 1;")),
        file("test/billing.test.ts", "", cases(2)),
      ]);

      expect(story.steps.map((step) => [step.id, step.title, step.tests.length])).toEqual([["u1", "lib/billing.ts \u00b7 charge", 2]]);
      expect(uncoveredStoryChanges(story, captured)).toEqual([]);
    });

    it("counts each test file on its own and keeps several short files with their change", async () => {
      const { story } = await arranged([
        file("lib/billing.ts", billing, billing.replace("return amount;", "return amount + 1;")),
        file("test/billing.test.ts", "", cases(2)),
        file("test/billing_refund.test.ts", "", cases(2, "refund")),
      ]);

      expect(story.steps).toHaveLength(1);
      expect(story.steps[0]!.tests.map((anchor) => anchor.fileId)).toEqual(["test/billing.test.ts", "test/billing.test.ts", "test/billing_refund.test.ts", "test/billing_refund.test.ts"]);
    });

    it("splits a long unpaired test file with the same limit", async () => {
      const { captured, story } = await arranged([file("test/misc.test.ts", "", cases(4))]);

      expect(story.steps.map((step) => [step.id, step.title])).toEqual([
        ["u1", "test/misc.test.ts \u00b7 case 0 and 1 more \u00b7 tests 1/2"],
        ["u1~2", "test/misc.test.ts \u00b7 case 2 and 1 more \u00b7 tests 2/2"],
      ]);
      expect(story.steps.map((step) => step.tests)).toEqual([[], []]);
      expect(story.steps.map((step) => step.implementation.length)).toEqual([2, 2]);
      expect(uncoveredStoryChanges(story, captured)).toEqual([]);
      expect(completeDiffStory(story, captured)).toEqual(story);
    });
  });

  it("prepares 4,000 changed lines with complete coverage and a compact response", async () => {
    const captured = createStorySnapshot(Array.from({ length: 40 }, (_, index) => file(
      `src/part${index}.ts`, "", Array.from({ length: 20 }, (_, method) =>
        `export function part${index}_${method}() {\n  const value = ${method};\n  const result = value + 1;\n  return result;\n}\n`).join(""),
    )));
    expect(captured.additions).toBe(4000);
    const generate = vi.fn(async (_system: string, prompt: string) => {
      expect(payload(prompt).units).toHaveLength(800);
      return '{"order":[],"pairs":[]}';
    });
    const started = performance.now();
    const story = await generateDiffStory(captured, generate, new AbortController().signal, () => {});
    expect(story.steps).toHaveLength(800);
    expect(uncoveredStoryChanges(story, captured)).toEqual([]);
    expect(generate).toHaveBeenCalledOnce();
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("story notes", () => {
  const arrange = (captured: ReturnType<typeof snapshot>, output: unknown) =>
    generateDiffStory(captured, async () => JSON.stringify(output), new AbortController().signal, () => {}, { notes: true });

  it("sends each unit's changed lines and puts the agent's titles, notes and summary on the steps", async () => {
    const captured = snapshot();
    const generate = vi.fn(async (_system: string, prompt: string) => {
      expect(prompt).toContain("Add two fields to the JSON");
      const context = payload(prompt);
      expect(context.units[0].changes).toBe("-   return 0;\n+   return 1;");
      expect(context.units[2].changes).toBe("-   expect(parse()).toBe(0);\n+   expect(parse()).toBe(1);");
      return JSON.stringify({
        order: ["u2", "u1"],
        pairs: [],
        summary: "Both helpers return one.",
        notes: {
          u1: { title: "Return one from parse", text: "parse returns 1 now." },
          u2: { title: "Return one from print", text: "print follows parse.\nIts test checks the new value." },
        },
      });
    });

    const story = await generateDiffStory(captured, generate, new AbortController().signal, () => {}, { notes: true });

    expect(generate).toHaveBeenCalledOnce();
    expect(story.summary).toBe("Both helpers return one.");
    expect(story.steps.map((step) => [step.title, step.explanation])).toEqual([
      ["Return one from print", "print follows parse. Its test checks the new value."],
      ["Return one from parse", "parse returns 1 now."],
    ]);
    expect(uncoveredStoryChanges(story, captured)).toEqual([]);
  });

  it("sends no changed lines and asks for no notes when notes are off", async () => {
    const generate = vi.fn(async (_system: string, prompt: string) => {
      expect(prompt).not.toContain("Add two fields to the JSON");
      expect(payload(prompt).units.some((unit: object) => "changes" in unit)).toBe(false);
      return '{"order":[],"pairs":[]}';
    });

    const story = await generateDiffStory(snapshot(), generate, new AbortController().signal, () => {});

    expect(generate).toHaveBeenCalledOnce();
    expect(story.summary).toBe("");
    expect(story.steps.map((step) => step.explanation)).toEqual(["", ""]);
  });

  it("keeps the host title when a note is missing or malformed, and strips control characters", async () => {
    const story = await arrange(snapshot(), {
      order: [],
      pairs: [],
      summary: 42,
      notes: { u1: "parse", u2: { title: "Print\u001b[31m one\u202e\n", text: 7 } },
    });

    expect(story.summary).toBe("");
    expect(story.steps.map((step) => [step.title, step.explanation])).toEqual([
      ["src/parser.ts \u00b7 parse", ""],
      ["Print [31m one", ""],
    ]);
  });

  it("finds a test file's note on any of its tests and repeats a note on split steps", async () => {
    const billing = "export function charge(amount: number) {\n  return amount;\n}\n";
    const cases = Array.from({ length: 3 }, (_, index) =>
      `it('case ${index}', () => {\n${Array.from({ length: 10 }, (_, line) => `  expect(charge(${line})).toBe(${line});`).join("\n")}\n});\n`).join("");
    const captured = createStorySnapshot([
      file("lib/billing.ts", billing, billing.replace("return amount;", "return amount + 1;")),
      file("test/billing.test.ts", "", cases),
      file("test/misc.test.ts", "", "it('first', () => {\n  expect(1).toBe(1);\n});\nit('second', () => {\n  expect(2).toBe(2);\n});\n"),
    ]);

    const story = await arrange(captured, {
      order: [],
      pairs: [],
      notes: {
        u1: { title: "Add one to every charge", text: "charge adds one." },
        u6: { title: "Check the basics", text: "Two sanity tests." },
      },
    });

    expect(story.steps.map((step) => [step.id, step.title, step.explanation])).toEqual([
      ["u1", "Add one to every charge \u00b7 tests 1/2", "charge adds one."],
      ["u1~2", "Add one to every charge \u00b7 tests 2/2", "charge adds one."],
      ["u5", "Check the basics", "Two sanity tests."],
    ]);
  });

  it("cuts a long unit's changed lines short", async () => {
    const body = Array.from({ length: 100 }, (_, index) => `  const v${index} = ${index};`).join("\n");
    const captured = createStorySnapshot([file("src/big.ts", "", `export function big() {\n${body}\n}\n`)]);
    const generate = vi.fn(async (_system: string, prompt: string) => {
      const changes = payload(prompt).units[0].changes.split("\n");
      expect(changes).toHaveLength(61);
      expect(changes[0]).toBe("+ export function big() {");
      expect(changes.at(-1)).toBe("\u2026 42 more changed lines");
      return '{"order":[],"pairs":[]}';
    });

    await generateDiffStory(captured, generate, new AbortController().signal, () => {}, { notes: true });

    expect(generate).toHaveBeenCalledOnce();
  });
});
