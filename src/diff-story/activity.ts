/** Public output from this story request, never private reasoning or the outer conversation. */
export type StoryAgentActivity =
  | { kind: "status" | "error"; text: string }
  | { kind: "text"; id: string; text: string };

export type StoryActivityListener = (activity: StoryAgentActivity) => void;
