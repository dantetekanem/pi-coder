import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_STORY_AGENT, streamReviewAgent, validateReviewAgent } from "../review-agent.js";

const mocks = vi.hoisted(() => ({
  streamSimple: vi.fn(),
  normalizeContext: vi.fn((context: { systemPrompt: string; messages: unknown[] }) => ({
    messages: [{ role: "system", content: context.systemPrompt, toolsAdded: [], timestamp: 0 }, ...context.messages],
  })),
}));
vi.mock("@earendil-works/pi-ai", () => mocks);
const model = { id: "gpt-5.6-luna", provider: "openai-codex", thinkingLevelMap: { max: "max" } };
const request = () => ({ system: "Arrange code.", prompt: "Prepared units", signal: new AbortController().signal, onText: vi.fn() });
function context() {
  return { modelRegistry: {
    find: vi.fn(() => model),
    getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "secret", headers: { "x-test": "1" } })),
  } };
}
async function* response() {
  yield { type: "thinking_delta", delta: "private" };
  yield { type: "text_delta", delta: "order" };
  yield { type: "done", reason: "stop", message: { content: [{ type: "text", text: "order" }] } };
}
afterEach(() => { vi.clearAllMocks(); });

describe("story provider transport", () => {
  it("uses the configured model and exact thinking, rejecting unavailable selections", () => {
    const ctx = context();
    expect(validateReviewAgent(ctx as never, DEFAULT_STORY_AGENT)).toBe(model);
    expect(() => validateReviewAgent(ctx as never, { ...DEFAULT_STORY_AGENT, thinking: "high" })).toThrow(/does not support/);
    ctx.modelRegistry.find.mockReturnValue(undefined as never);
    expect(() => validateReviewAgent(ctx as never, DEFAULT_STORY_AGENT)).toThrow(/unavailable/);
  });

  it("lets the host registry resolve authentication and normalize context in one request", async () => {
    const ctx = context();
    const send = vi.fn(() => response());
    Object.assign(ctx.modelRegistry, { streamSimple: send });
    const input = request();

    expect(await streamReviewAgent(ctx as never, DEFAULT_STORY_AGENT, input)).toBe("order");
    expect(send).toHaveBeenCalledWith(model, expect.objectContaining({ systemPrompt: input.system }), {
      reasoning: "max", signal: expect.any(AbortSignal),
    });
    expect(ctx.modelRegistry.getApiKeyAndHeaders).not.toHaveBeenCalled();
  });

  it.each(["legacy", "provider"])("uses the public %s stream API with the system instructions and resolved credentials", async (api) => {
    const ctx = context();
    const providerStream = vi.fn(() => response());
    if (api === "provider") Object.assign(ctx.modelRegistry, { getProvider: () => ({ streamSimple: providerStream }) });
    else mocks.streamSimple.mockReturnValue(response());
    const input = request();
    expect(await streamReviewAgent(ctx as never, DEFAULT_STORY_AGENT, input)).toBe("order");
    const send = api === "provider" ? providerStream : mocks.streamSimple;
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]![1]).toMatchObject(api === "provider"
      ? { messages: [expect.objectContaining({ role: "system", content: input.system }), expect.objectContaining({ role: "user", content: input.prompt })] }
      : { systemPrompt: input.system, tools: [], messages: [expect.objectContaining({ content: input.prompt })] });
    expect(send.mock.calls[0]![2]).toEqual({ apiKey: "secret", headers: { "x-test": "1" }, signal: expect.any(AbortSignal), reasoning: "max" });
    expect(input.onText.mock.calls).toEqual([["order"]]);
  });

  it.each(["auth", "stream"])("cancels promptly during pending %s without provider cooperation", async (stage) => {
    const ctx = context();
    if (stage === "auth") ctx.modelRegistry.getApiKeyAndHeaders.mockReturnValue(new Promise(() => {}));
    else mocks.streamSimple.mockReturnValue({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) });
    const controller = new AbortController();
    const input = { ...request(), signal: controller.signal };
    const running = streamReviewAgent(ctx as never, DEFAULT_STORY_AGENT, input);
    await Promise.resolve();
    controller.abort();
    await expect(running).rejects.toThrow(/cancelled/);
    expect(input.onText).not.toHaveBeenCalled();
  });

  it("reports incomplete or failed output instead of accepting it as a plan", async () => {
    mocks.streamSimple.mockReturnValue((async function* () { yield { type: "text_delta", delta: "partial" }; })());
    await expect(streamReviewAgent(context() as never, DEFAULT_STORY_AGENT, request())).rejects.toThrow(/complete response/);
    mocks.streamSimple.mockReturnValue((async function* () { yield { type: "error", error: { errorMessage: "Provider unavailable" } }; })());
    await expect(streamReviewAgent(context() as never, DEFAULT_STORY_AGENT, request())).rejects.toThrow("Provider unavailable");
  });
});
