import { afterEach, describe, expect, it, vi } from "vitest";

const ai = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock("@earendil-works/pi-ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@earendil-works/pi-ai")>()),
  complete: ai.complete,
}));

const { createPiModelGateway } = await import("../pi/models.js");

const model = { id: "test-model", provider: "test-provider" };

function gateway(ctx: Record<string, unknown> = {}, exec = vi.fn(async () => ({ code: 0, stdout: "answer\n", stderr: "", killed: false }))) {
  return { models: createPiModelGateway({ exec } as never, { model, modelRegistry: {}, ...ctx } as never), exec };
}

afterEach(() => vi.clearAllMocks());

describe("Pi model gateway labels", () => {
  it("reads the active model on every call", () => {
    const ctx: { model?: { id: string } } = { model: { id: "first" } };
    const models = createPiModelGateway({} as never, ctx as never);

    expect(models.label("grammar")).toBe("first");
    expect(models.label("analysis")).toBe("first");
    expect(models.label("story")).toBeUndefined();
    ctx.model = { id: "second" };
    expect(models.label("grammar")).toBe("second");
    ctx.model = undefined;
    expect(models.label("grammar")).toBeUndefined();
  });
});

describe("Pi grammar completion", () => {
  const registry = (auth: unknown) => ({ getApiKeyAndHeaders: vi.fn(async () => auth) });

  it("sends the prompt to the selected model with its credentials", async () => {
    ai.complete.mockResolvedValue({ stopReason: "stop", content: [{ type: "text", text: " one " }, { type: "thinking", thinking: "x" }, { type: "text", text: "two" }] });
    const signal = new AbortController().signal;
    const { models } = gateway({ modelRegistry: registry({ ok: true, apiKey: "key", headers: { "x-test": "1" } }) });

    await expect(models.complete("grammar", { system: "Fix grammar.", prompt: '{"body":"a"}', signal })).resolves.toBe("one \ntwo");

    expect(ai.complete).toHaveBeenCalledExactlyOnceWith(
      model,
      { systemPrompt: "Fix grammar.", messages: [expect.objectContaining({ role: "user", content: [{ type: "text", text: '{"body":"a"}' }] })] },
      { apiKey: "key", headers: { "x-test": "1" }, signal },
    );
  });

  it.each([
    ["no model", { model: undefined }, "No Pi model is selected for grammar review."],
    ["no key", { modelRegistry: registry({ ok: true }) }, "No API key for test-provider."],
    ["auth failure", { modelRegistry: registry({ ok: false, error: "login required" }) }, "login required"],
  ])("rejects with %s", async (_label, ctx, message) => {
    const { models } = gateway(ctx);
    await expect(models.complete("grammar", { prompt: "{}" })).rejects.toThrow(message);
    expect(ai.complete).not.toHaveBeenCalled();
  });

  it.each([
    [{ stopReason: "aborted", content: [] }, "Grammar review was cancelled."],
    [{ stopReason: "stop", content: [{ type: "text", text: "  " }] }, "Grammar model returned no text."],
  ])("rejects an unusable response", async (response, message) => {
    ai.complete.mockResolvedValue(response);
    const { models } = gateway({ modelRegistry: registry({ ok: true, apiKey: "key" }) });
    await expect(models.complete("grammar", { prompt: "{}" })).rejects.toThrow(message);
  });
});

describe("Pi analysis completion", () => {
  const expectedArgs = (prompt: string, ...extra: string[]) => [
    "--no-tools", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-session",
    ...extra, "--thinking", "minimal", "-p", prompt,
  ];

  it("runs an isolated pi process with the session model, directory, and timeout", async () => {
    const { models, exec } = gateway();

    await expect(models.complete("analysis", { prompt: "Explain", cwd: "/repo", timeoutMs: 60_000 })).resolves.toBe("answer\n");

    expect(exec).toHaveBeenCalledExactlyOnceWith("pi", expectedArgs("Explain", "--model", "test-provider/test-model"), { cwd: "/repo", timeout: 60_000 });
  });

  it("omits the model flag when the session has no model", async () => {
    const { models, exec } = gateway({ model: undefined });

    await models.complete("analysis", { prompt: "Explain", cwd: "/repo", timeoutMs: 90_000 });

    expect(exec).toHaveBeenCalledWith("pi", expectedArgs("Explain"), { cwd: "/repo", timeout: 90_000 });
  });

  it.each([
    ["a failing process reports its error", { code: 1, stdout: "partial", stderr: " boom \n" }, "boom"],
    ["an empty answer reports the error output", { code: 0, stdout: "  \n", stderr: "warning" }, "warning"],
  ])("%s", async (_label, result, message) => {
    const { models } = gateway({}, vi.fn(async () => ({ ...result, killed: false })));
    await expect(models.complete("analysis", { prompt: "Explain" })).rejects.toThrow(message);
  });

  it("returns an empty answer when the process fails without saying why", async () => {
    for (const result of [{ code: 1, stdout: "", stderr: "" }, { code: 0, stdout: "\n", stderr: "" }]) {
      const { models } = gateway({}, vi.fn(async () => ({ ...result, killed: false })));
      await expect(models.complete("analysis", { prompt: "Explain" })).resolves.toBe("");
    }
  });
});

describe("Pi story agents", () => {
  const registry = (models: unknown[]) => ({ getAvailable: () => models, find: (provider: string, id: string) => (models as Array<{ provider: string; id: string }>).find((entry) => entry.provider === provider && entry.id === id) });

  it("lists available models with only their supported thinking levels", () => {
    const { models } = gateway({ modelRegistry: registry([
      { provider: "anthropic", id: "claude-opus-5-5", thinkingLevelMap: { off: null, low: "low", high: "high" } },
      { provider: "local", id: "plain" },
    ]) });

    expect(models.storyAgents()).toEqual([
      { provider: "anthropic", model: "claude-opus-5-5", label: "anthropic/claude-opus-5-5", thinkingLevels: ["low", "high"] },
      { provider: "local", model: "plain", label: "local/plain", thinkingLevels: [] },
    ]);
  });

  it("validates a saved selection against the registry", () => {
    const { models } = gateway({ modelRegistry: registry([{ provider: "anthropic", id: "claude-opus-5-5", thinkingLevelMap: { low: "low" } }]) });

    expect(() => models.validateStoryAgent({ provider: "anthropic", model: "claude-opus-5-5", thinking: "low" })).not.toThrow();
    expect(() => models.validateStoryAgent({ provider: "anthropic", model: "claude-opus-5-5", thinking: "max" })).toThrow(/does not support thinking level max/);
    expect(() => models.validateStoryAgent({ provider: "anthropic", model: "missing", thinking: "low" })).toThrow(/unavailable/);
  });

  it("streams a story through the registry", async () => {
    const entry = { provider: "anthropic", id: "claude-opus-5-5", thinkingLevelMap: { low: "low" } };
    const streamSimple = vi.fn(async function* () {
      yield { type: "text_delta", delta: "order" };
      yield { type: "done", reason: "stop", message: { content: [{ type: "text", text: "order" }] } };
    });
    const { models } = gateway({ modelRegistry: { ...registry([entry]), streamSimple } });
    const onText = vi.fn();

    await expect(models.streamStory({ provider: "anthropic", model: "claude-opus-5-5", thinking: "low" }, {
      system: "Arrange.", prompt: "Units", signal: new AbortController().signal, onText,
    })).resolves.toBe("order");

    expect(streamSimple).toHaveBeenCalledOnce();
    expect(onText).toHaveBeenCalledWith("order");
  });
});
