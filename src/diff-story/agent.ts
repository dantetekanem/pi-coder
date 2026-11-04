import type { ModelGateway, StoryAgentSelection } from "../host/types.js";
import type { StoryActivityListener } from "./activity.js";
import type { DiffStoryGenerate } from "./generate.js";

/** One provider request over the prepared units, isolated from the outer conversation. */
export function createStoryAgentGenerator(
  models: Pick<ModelGateway, "streamStory">,
  selection: StoryAgentSelection,
  onActivity: StoryActivityListener,
): DiffStoryGenerate {
  return async (system, prompt, signal) => {
    signal.throwIfAborted();
    onActivity({ kind: "status", text: "Arranging prepared code and test units" });
    try {
      return await models.streamStory(selection, {
        system, prompt, signal,
        onText: (text) => onActivity({ kind: "text", id: "order", text }),
      });
    } catch (error) {
      if (!signal.aborted) onActivity({ kind: "error", text: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  };
}
