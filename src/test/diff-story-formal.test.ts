import { describe, expect, it, vi } from "vitest";
import { generateFormalStory, reapplySavedGuide, storyFromGuide } from "../diff-story/formal.js";
import { createStorySnapshot, uncoveredStoryChanges, type DiffStory, type StoryAnchor, type StoryFile } from "../diff-story/plan.js";
import { buildGuide, type FormalValidationGuide, type GuideTarget } from "../formal-validation/guide.js";
import { applyRefinement } from "../formal-validation/refine.js";
import type { GuideStore } from "../formal-validation/run.js";

function file(path: string, before: string, after: string): StoryFile {
  return { fileId: path, path, scope: "all-files", contents: { originalContent: before, modifiedContent: after } };
}

const target: GuideTarget = { kind: "range", label: "base..head", repoRoot: "/repo", scope: "all-files", base: "base", head: "head" };

const snapshot = createStorySnapshot([
  file("app/models/subscription.rb", `class Subscription
  def cancel!
    update!(status: "cancelled")
  end
end
`, `class Subscription
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
`),
  file("test/models/subscription_test.rb", "", `require "test_helper"

class SubscriptionTest < ActiveSupport::TestCase
  test "cancel! refunds the prorated amount once" do
    subscription = subscriptions(:active)
    assert_difference -> { Refund.count }, 1 do
      subscription.cancel!
    end
  end

  test "cancel! twice does not refund again" do
    subscription = subscriptions(:active)
    subscription.cancel!
    assert_no_difference -> { Refund.count } do
      subscription.cancel!
    end
  end
end
`),
  file("test/lib/duration_test.rb", "", `require "test_helper"

class DurationTest < ActiveSupport::TestCase
  test "parses minutes" do
    assert_equal 60, Duration.parse("1m")
  end
end
`),
  file("README.md", "Old words.\n", "New words.\n"),
  file("src/format.ts", "export const value = 1;\n", "export const value =  1;\n"),
]);

const description = `## Solution

- \`cancel!\` takes a row lock and refunds once.
`;

function prepare() {
  return buildGuide({ snapshot, target, description });
}

function rootId(guide: FormalValidationGuide, path: string, symbol: string): string {
  const unit = Object.values(guide.units).find((entry) => entry.path === path && entry.symbol === symbol && entry.root == null);
  if (unit == null) throw new Error(`No root unit ${path} · ${symbol}`);
  return unit.id;
}

function testId(guide: FormalValidationGuide, name: string): string {
  const test = Object.values(guide.tests).find((entry) => entry.name === name);
  if (test == null) throw new Error(`No test ${name}`);
  return test.unitId;
}

function answer(guide: FormalValidationGuide) {
  const cancel = rootId(guide, "app/models/subscription.rb", "cancel!");
  const refund = rootId(guide, "app/models/subscription.rb", "refund_prorated");
  const once = testId(guide, "cancel! refunds the prorated amount once");
  const twice = testId(guide, "cancel! twice does not refund again");
  return {
    summary: "Cancel takes a lock and refunds once.",
    steps: [{
      units: [cancel, refund],
      tests: [once, twice],
      title: "Refund once per cancellation",
      priority: "critical",
      why: "Money moves.",
      property: "A subscription is refunded at most once.",
      ordering: true,
      checks: ["Cancel twice at once; expect one refund row."],
    }],
    tests: [{ id: once, verifies: "One cancel creates one refund." }],
    claims: [{ id: "c1", steps: [1] }],
  };
}

function overlapping(plan: DiffStory): Array<[StoryAnchor, StoryAnchor]> {
  const anchors = plan.steps.flatMap((step) => [...step.implementation, ...step.tests]);
  const pairs: Array<[StoryAnchor, StoryAnchor]> = [];
  anchors.forEach((left, index) => {
    for (const right of anchors.slice(index + 1)) {
      if (left.fileId === right.fileId && left.side === right.side && left.startLine <= right.endLine && right.startLine <= left.endLine) pairs.push([left, right]);
    }
  });
  return pairs;
}

function memoryStore(saved?: FormalValidationGuide): GuideStore & { saves: FormalValidationGuide[] } {
  const saves: FormalValidationGuide[] = [];
  return {
    saves,
    load: async (fingerprint) => saved?.snapshot === fingerprint ? structuredClone(saved) : undefined,
    save: async (guide) => {
      saves.push(structuredClone(guide));
      return { status: "saved", path: `/guides/${guide.snapshot}.json` };
    },
  };
}

describe("story from a validation guide", () => {
  it("orders steps by priority, keeps tests-only files readable and closes with the minor changes", () => {
    const { guide } = prepare();
    const plan = storyFromGuide(guide, snapshot);

    expect(plan.steps.map((step) => step.title)).toEqual([
      "Critical · app/models/subscription.rb · cancel!, refund_prorated",
      "Needed · test/lib/duration_test.rb · changed tests",
      "Minor · 2 mechanical changes",
    ]);
    const [subscription, duration, minor] = plan.steps;
    expect(new Set(subscription!.implementation.map((anchor) => anchor.fileId))).toEqual(new Set(["app/models/subscription.rb"]));
    expect(new Set(subscription!.tests.map((anchor) => anchor.fileId))).toEqual(new Set(["test/models/subscription_test.rb"]));
    expect(duration!.implementation.every((anchor) => anchor.fileId === "test/lib/duration_test.rb")).toBe(true);
    expect(duration!.tests).toEqual([]);
    expect(new Set(minor!.implementation.map((anchor) => anchor.fileId))).toEqual(new Set(["README.md", "src/format.ts"]));
    expect(subscription!.explanation.split("\n")[0]).toMatch(/^Why: /);
    expect(subscription!.explanation).toContain("Verify:");
    expect(subscription!.explanation).toContain('  - strong · "cancel! refunds the prorated amount once"');
    expect(minor!.explanation).toContain("  - README.md · lines 1–1 — documentation");
    expect(plan.summary.split("\n")).toContain("1 critical and 1 needed steps, then 2 minor changes.");
    expect(uncoveredStoryChanges(plan, snapshot)).toEqual([]);
    expect(overlapping(plan)).toEqual([]);
  });

  it("puts the model's property first and maps description claims to story steps", () => {
    const prepared = prepare();
    const refined = applyRefinement(prepared, JSON.stringify(answer(prepared.guide)), "model/test");
    const plan = storyFromGuide(refined, snapshot);

    expect(plan.steps[0]).toMatchObject({ id: "s1", title: "Critical · Refund once per cancellation" });
    expect(plan.steps[0]!.explanation.split("\n").slice(0, 3)).toEqual([
      "Property: A subscription is refunded at most once.",
      expect.stringMatching(/^Why: Money moves\./),
      "Order of steps matters: check concurrent callers, retries and partial failures.",
    ]);
    expect(plan.steps[0]!.explanation).toContain('strong · "cancel! refunds the prorated amount once" — One cancel creates one refund.');
    expect(plan.summary.split("\n")).toEqual(expect.arrayContaining([
      "Cancel takes a lock and refunds once.",
      'Claim "`cancel!` takes a row lock and refunds once." → step 1',
    ]));
    expect(uncoveredStoryChanges(plan, snapshot)).toEqual([]);
    expect(overlapping(plan)).toEqual([]);
  });
});

describe("formal story generation", () => {
  it("asks the model once, saves the guide and reuses it for the same bytes", async () => {
    const generate = vi.fn(async (_system: string, prompt: string) => {
      const data = JSON.parse(prompt.slice(prompt.indexOf("\n") + 1));
      expect(data.pr.description).toContain("row lock");
      return JSON.stringify(answer(prepare().guide));
    });
    const store = memoryStore();
    const phases: string[] = [];
    const first = await generateFormalStory(snapshot, generate, new AbortController().signal, (phase) => phases.push(phase), { target, description, store, model: "model/test" });

    expect(generate).toHaveBeenCalledOnce();
    expect(phases).toEqual(["Preparing code and test units", "Writing the validation guide", "Validating story"]);
    expect(first.guide.refinement).toMatchObject({ status: "applied", model: "model/test" });
    expect(store.saves).toHaveLength(1);
    expect(first.plan.steps[0]!.title).toBe("Critical · Refund once per cancellation");

    const reuse = memoryStore(store.saves[0]);
    const again = await generateFormalStory(snapshot, generate, new AbortController().signal, (phase) => phases.push(phase), { target, description, store: reuse, model: "model/test" });

    expect(generate).toHaveBeenCalledOnce();
    expect(reuse.saves).toEqual([]);
    expect(phases.slice(3)).toEqual(["Preparing code and test units", "Reusing the saved validation guide", "Validating story"]);
    expect(again.guide.refinement.model).toBe("model/test (saved)");
    expect(again.plan.steps).toEqual(first.plan.steps);
  });

  it("asks the model again when the saved guide was written for other units, another description or without a model", async () => {
    const prepared = prepare();
    const refined = applyRefinement(prepared, JSON.stringify(answer(prepared.guide)), "model/test");
    const cancel = rootId(refined, "app/models/subscription.rb", "cancel!");
    const renamed = structuredClone(refined);
    renamed.units[cancel]!.symbol = "close!";
    const reranked = structuredClone(refined);
    reranked.units[cancel]!.risk = { priority: "minor", categories: ["comments"], reasons: ["OLD HOST RULE"], ordering: false };

    expect(reapplySavedGuide(prepare(), refined)).toMatchObject({ refinement: { status: "applied" } });
    expect(reapplySavedGuide(prepare(), renamed)).toBeUndefined();
    expect(reapplySavedGuide(prepare(), reranked)).toBeUndefined();
    expect(reapplySavedGuide(buildGuide({ snapshot, target, description: "Cancelling now emails the merchant." }), refined)).toBeUndefined();
    expect(reapplySavedGuide(prepare(), { ...refined, refinement: { status: "failed", message: "Provider down." } })).toBeUndefined();

    const generate = vi.fn(async () => JSON.stringify(answer(prepare().guide)));
    await generateFormalStory(snapshot, generate, new AbortController().signal, () => {}, { target, description, store: memoryStore(renamed) });
    expect(generate).toHaveBeenCalledOnce();
  });

  it("treats a saved guide it cannot read as missing, then asks the model and saves over it", async () => {
    const prepared = prepare();
    const broken = structuredClone(applyRefinement(prepared, JSON.stringify(answer(prepared.guide)), "model/test")) as any;
    delete broken.steps[0].reasons;
    broken.claims[0].steps = undefined;
    expect(reapplySavedGuide(prepare(), broken)).toBeUndefined();

    const store = memoryStore(broken);
    const generate = vi.fn(async () => JSON.stringify(answer(prepare().guide)));
    const story = await generateFormalStory(snapshot, generate, new AbortController().signal, () => {}, { target, description, store });

    expect(generate).toHaveBeenCalledOnce();
    expect(story.guide.refinement.status).toBe("applied");
    expect(store.saves).toHaveLength(1);
  });

  it("keeps the formal path when the guide store throws instead of rejecting", async () => {
    const store: GuideStore = {
      load: () => { throw new Error("Store unreadable."); },
      save: () => { throw new Error("Store full."); },
    };
    const generate = vi.fn(async () => JSON.stringify(answer(prepare().guide)));
    const story = await generateFormalStory(snapshot, generate, new AbortController().signal, () => {}, { target, description, store });

    expect(generate).toHaveBeenCalledOnce();
    expect(story.plan.steps[0]!.title).toBe("Critical \u00b7 Refund once per cancellation");
  });

  it("keeps a complete story from host rules when the model fails, and stops when cancelled", async () => {
    const failing = vi.fn(async () => {
      throw new Error("Provider \u001b[31munavailable.");
    });
    const story = await generateFormalStory(snapshot, failing, new AbortController().signal, () => {}, { target });

    expect(story.guide.refinement).toMatchObject({ status: "failed", message: "Provider [31munavailable." });
    expect(story.plan.summary).toContain("The guideline model failed (Provider [31munavailable.), so steps follow host rules.");
    expect(uncoveredStoryChanges(story.plan, snapshot)).toEqual([]);

    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(generateFormalStory(snapshot, failing, controller.signal, () => {}, { target })).rejects.toThrow("cancelled");
    expect(failing).toHaveBeenCalledOnce();
  });
});
