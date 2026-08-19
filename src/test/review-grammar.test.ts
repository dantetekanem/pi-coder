import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ complete: vi.fn() }));

vi.mock("@earendil-works/pi-ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@earendil-works/pi-ai")>()),
  complete: mocks.complete,
}));

const { classifyGrammarReview, reviewGrammar } = await import("../review-grammar.js");

const original = {
  body: undefined,
  comments: [
    "can we have these 2 components in variables and isolated, so we can simplify this rendering?",
    "This dont handle the empty state.",
  ],
};

describe("grammar review classification", () => {
  beforeEach(() => vi.clearAllMocks());

  it("auto-accepts grammar and clarity corrections that preserve technical meaning", () => {
    const result = classifyGrammarReview(
      original,
      JSON.stringify({
        body: null,
        comments: [
          "Can we isolate these two components in variables so we can simplify this rendering?",
          "This doesn't handle the empty state.",
        ],
      }),
      JSON.stringify({
        items: [
          { key: "comment:0", grammarOnly: true, reason: "Grammar and word order only." },
          { key: "comment:1", grammarOnly: true, reason: "Subject-verb agreement only." },
        ],
      }),
    );

    expect(result.status).toBe("safe");
    expect(result.corrected.comments).toEqual([
      "Can we isolate these two components in variables so we can simplify this rendering?",
      "This doesn't handle the empty state.",
    ]);
    expect(result.changes.every((change) => change.grammarOnly)).toBe(true);
  });

  it("requires approval only for corrections that may alter meaning or intent", () => {
    const result = classifyGrammarReview(
      original,
      JSON.stringify({
        body: null,
        comments: [
          "Can we isolate these two components in variables so we can simplify this rendering?",
          "This must handle every empty state.",
        ],
      }),
      JSON.stringify({
        items: [
          { key: "comment:0", grammarOnly: true, reason: "Grammar and word order only." },
          { key: "comment:1", grammarOnly: false, reason: "Changes the request from observation to requirement." },
        ],
      }),
    );

    expect(result.status).toBe("review");
    expect(result.changes.filter((change) => !change.grammarOnly).map((change) => change.key)).toEqual(["comment:1"]);
  });

  it("runs correction and semantic validation before authorizing automatic submission", async () => {
    mocks.complete
      .mockResolvedValueOnce({
        stopReason: "stop",
        content: [{ type: "text", text: JSON.stringify({
          body: null,
          comments: [
            "Can we isolate these two components in variables so we can simplify this rendering?",
            "This doesn't handle the empty state.",
          ],
        }) }],
      })
      .mockResolvedValueOnce({
        stopReason: "stop",
        content: [{ type: "text", text: JSON.stringify({
          items: [
            { key: "comment:0", grammarOnly: true, reason: "Grammar and word order only." },
            { key: "comment:1", grammarOnly: true, reason: "Subject-verb agreement only." },
          ],
        }) }],
      });
    const ctx = {
      model: { id: "test-model", provider: "test-provider" },
      modelRegistry: { getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "test-key" })) },
    };

    const result = await reviewGrammar(ctx as never, original);

    expect(result.status).toBe("safe");
    expect(mocks.complete).toHaveBeenCalledTimes(2);
  });

  it("fails closed when model output cannot be validated against the original review", () => {
    const result = classifyGrammarReview(original, "not json", "not json");

    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("Expected grammar review failure");
    expect(result.error).toMatch(/grammar correction response/i);
  });
});
