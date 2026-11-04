import type { StoryAgentSelection } from "./host/types.js";

export type ReviewAgentSelection = StoryAgentSelection;

export const DEFAULT_STORY_AGENT: ReviewAgentSelection = {
  provider: "anthropic",
  model: "claude-opus-5-5",
  thinking: "low",
};
