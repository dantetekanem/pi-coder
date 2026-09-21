import { describe, expect, it, vi } from "vitest";
import * as ai from "@earendil-works/pi-ai";
import { createStoryAgentGenerator } from "../diff-story/agent.js";
import { createStorySnapshot, uncoveredStoryChanges } from "../diff-story/plan.js";
import { generateDiffStory } from "../diff-story/generate.js";
import { DEFAULT_STORY_AGENT } from "../review-agent.js";
import type { StoryAgentActivity } from "../diff-story/activity.js";

const model = { id: "gpt-5.6-luna", provider: "openai-codex", thinkingLevelMap: { max: "max" } };
const snapshot = createStorySnapshot([{
  fileId: "app", path: "app.ts", scope: "git-diff",
  contents: { originalContent: "return 1;\n", modifiedContent: "return 2;\n" },
}]);
function context(streamSimple: ReturnType<typeof vi.fn>) {
  return { cwd: process.cwd(), modelRegistry: {
    find: () => model,
    getProvider: () => ({ streamSimple }),
    getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "test-secret", headers: { "x-test": "1" } })),
  } };
}
async function* response(reason = "stop") {
  yield { type: "thinking_delta", delta: "private reasoning" };
  yield { type: "text_delta", delta: '{"order":[],"pairs":[]}' };
  yield { type: "done", reason, message: { content: [{ type: "text", text: '{"order":[],"pairs":[]}' }], stopReason: reason } };
}

describe("single-request story arrangement", () => {
  it("sends precomputed units once, preserves exact effort, and streams only public output", async () => {
    const provider = vi.fn((_model: unknown, _context: {
      systemPrompt?: string; tools?: unknown[];
      messages: Array<{ role: string; content: string; toolsAdded?: unknown[] }>;
    }, _options: Record<string, unknown>) => response());
    const activities: StoryAgentActivity[] = [];
    const generate = createStoryAgentGenerator(context(provider) as never, DEFAULT_STORY_AGENT, (event) => activities.push(event));
    const story = await generateDiffStory(snapshot, generate, new AbortController().signal, () => {});
    expect(provider).toHaveBeenCalledOnce();
    const request = provider.mock.calls[0]![1];
    const system = request.systemPrompt ?? request.messages.find((message: { role: string }) => message.role === "system")?.content;
    expect(system).toContain("prepared");
    expect(request.tools ?? request.messages.flatMap((message: { toolsAdded?: unknown[] }) => message.toolsAdded ?? [])).toEqual([]);
    const user = request.messages.find((message: { role: string }) => message.role === "user");
    expect(user?.content).toContain('"id":"u1"');
    expect(user?.content).toContain('"references":[]');
    expect(provider.mock.calls[0]![2]).toMatchObject({ apiKey: "test-secret", reasoning: "max" });
    expect(activities).toContainEqual({ kind: "text", id: "order", text: '{"order":[],"pairs":[]}' });
    expect(JSON.stringify(activities)).not.toMatch(/private reasoning|test-secret/);
    expect(uncoveredStoryChanges(story, snapshot)).toEqual([]);
  });

  it.each(["toolUse", "length"])("rejects %s rather than starting another model turn or accepting a partial plan", async (reason) => {
    const provider = vi.fn(() => response(reason));
    const generate = createStoryAgentGenerator(context(provider) as never, DEFAULT_STORY_AGENT, () => {});
    await expect(generate("system", "prompt", new AbortController().signal)).rejects.toThrow(/complete|limit/i);
    expect(provider).toHaveBeenCalledOnce();
  });

  it("cancels a noncooperating provider without forwarding late output", async () => {
    const pending = ai.createAssistantMessageEventStream();
    const provider = vi.fn(() => pending);
    const controller = new AbortController();
    const activities: StoryAgentActivity[] = [];
    const generate = createStoryAgentGenerator(context(provider) as never, DEFAULT_STORY_AGENT, (event) => activities.push(event));
    const running = generate("system", "prompt", controller.signal);
    await vi.waitFor(() => expect(provider).toHaveBeenCalledOnce());
    controller.abort();
    await expect(running).rejects.toThrow(/cancelled/i);
    const count = activities.length;
    pending.push({ type: "text_delta", delta: "late", contentIndex: 0, partial: {} as never });
    await Promise.resolve();
    expect(activities).toHaveLength(count);
  });
});
