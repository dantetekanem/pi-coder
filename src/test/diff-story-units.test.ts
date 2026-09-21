import { describe, expect, it, vi } from "vitest";
import { generateDiffStory } from "../diff-story/generate.js";
import { completeDiffStory, createStorySnapshot, uncoveredStoryChanges, validateDiffStory, type StoryFile } from "../diff-story/plan.js";
import { restoreStoryNavigation, storyAnchors } from "../diff-story/navigation.js";
import { prepareStoryUnits } from "../diff-story/units.js";

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
    expect(storyAnchors(navigation, "tests").map((anchor) => anchor.unitId)).toEqual(["u3", "u4"]);
    expect(storyAnchors(navigation, "tests").every((anchor) => anchor.side === "added")).toBe(true);
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
