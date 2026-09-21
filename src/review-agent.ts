import * as piAi from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface ReviewAgentSelection {
  provider: string;
  model: string;
  thinking: string;
}

export const DEFAULT_STORY_AGENT: ReviewAgentSelection = {
  provider: "openai-codex",
  model: "gpt-5.6-luna",
  thinking: "max",
};

export interface ReviewAgentRequest {
  system: string;
  prompt: string;
  signal: AbortSignal;
  onText: (text: string) => void;
}

type StreamEvent = {
  type: string;
  delta?: string;
  reason?: string;
  message?: { content?: Array<{ type: string; text?: string }>; stopReason?: string };
  error?: { errorMessage?: string };
};
type Stream = (model: unknown, context: unknown, options: Record<string, unknown>) => AsyncIterable<StreamEvent>;
type PublicAi = { streamSimple?: Stream; normalizeContext?: (context: unknown) => unknown };

function waitFor<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    pending.then((value) => {
      signal.removeEventListener("abort", abort);
      resolve(value);
    }, (error) => {
      signal.removeEventListener("abort", abort);
      reject(error);
    });
  });
}

export function validateReviewAgent(ctx: ExtensionContext, selection: ReviewAgentSelection) {
  const model = ctx.modelRegistry.find(selection.provider, selection.model);
  if (model == null || model.provider !== selection.provider || model.id !== selection.model) {
    throw new Error(`Review agent ${selection.provider}/${selection.model} is unavailable.`);
  }
  if ((model.thinkingLevelMap as Record<string, string | null> | undefined)?.[selection.thinking] == null) {
    throw new Error(`Review agent ${selection.provider}/${selection.model} does not support thinking level ${selection.thinking}.`);
  }
  return model;
}

/** Uses the host's public provider/auth APIs without creating an agent session or tool loop. */
export async function streamReviewAgent(ctx: ExtensionContext, selection: ReviewAgentSelection, request: ReviewAgentRequest): Promise<string> {
  request.signal.throwIfAborted();
  const model = validateReviewAgent(ctx, selection);
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("Story generation cancelled."));
  request.signal.addEventListener("abort", abort, { once: true });
  let iterator: AsyncIterator<StreamEvent> | undefined;
  try {
    const context = {
      systemPrompt: request.system,
      tools: [],
      messages: [{ role: "user", content: request.prompt, timestamp: Date.now() }],
    };
    const options = { signal: controller.signal, reasoning: selection.thinking };
    const registry = ctx.modelRegistry as unknown as {
      streamSimple?: Stream;
      getProvider?: (id: string) => { streamSimple?: Stream };
    };
    let stream: AsyncIterable<StreamEvent> | undefined;
    if (registry.streamSimple != null) {
      stream = registry.streamSimple(model, context, options);
    } else {
      const auth = await waitFor(ctx.modelRegistry.getApiKeyAndHeaders(model), controller.signal);
      controller.signal.throwIfAborted();
      if (!auth.ok) throw new Error(`Review agent authentication failed: ${auth.error}`);
      const authenticated = { ...options, apiKey: auth.apiKey, headers: auth.headers };
      const runtime = piAi as unknown as PublicAi;
      const provider = registry.getProvider?.(model.provider);
      // Pi 0.86 providers receive normalized system messages; older hosts use Context directly.
      stream = provider?.streamSimple?.(model, runtime.normalizeContext?.(context) ?? context, authenticated)
        ?? runtime.streamSimple?.(model, context, authenticated);
    }
    if (stream == null) throw new Error("This Pi runtime does not expose a public streaming API for the selected story agent.");
    iterator = stream[Symbol.asyncIterator]();
    let answer = "";
    while (true) {
      const next = await waitFor(iterator.next(), controller.signal);
      controller.signal.throwIfAborted();
      if (next.done) throw new Error("Story generation ended before a complete response was received.");
      const event = next.value;
      if (event.type === "text_delta") {
        answer += event.delta ?? "";
        request.onText(answer);
      } else if (event.type === "error") {
        throw new Error(event.error?.errorMessage ?? "Story generation failed.");
      } else if (event.type === "done") {
        const reason = event.reason ?? event.message?.stopReason;
        if (reason === "length") throw new Error("Story generation reached the model's output limit before finishing.");
        if (reason !== "stop") throw new Error("Story generation did not return a complete response.");
        const text = event.message?.content?.filter((part) => part.type === "text").map((part) => part.text ?? "").join("") ?? "";
        if (text !== answer) request.onText(text);
        return text;
      }
    }
  } finally {
    request.signal.removeEventListener("abort", abort);
    controller.abort();
    // Cleanup must not wait for a provider that ignores cancellation.
    try {
      void Promise.resolve(iterator?.return?.()).catch(() => undefined);
    } catch {
      // Preserve the request result if synchronous provider cleanup fails.
    }
  }
}
