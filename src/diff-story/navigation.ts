import type { ReviewLineTarget } from "../types.js";
import type { DiffStory, StoryAnchor } from "./plan.js";

export type StoryMember = "implementation" | "tests";
export interface StoryViewport {
  scroll: number;
  selection?: ReviewLineTarget;
  initialized?: boolean;
}
export interface StorySessionData {
  plan: DiffStory;
  step: number;
  member: StoryMember;
  related: Record<StoryMember, number>;
  viewedStepIds: string[];
  viewports: Record<string, StoryViewport>;
}

export function restoreStoryNavigation(plan: DiffStory, saved?: StorySessionData): StorySessionData {
  const same = saved?.plan?.snapshot === plan.snapshot;
  return {
    plan,
    step: same && Number.isSafeInteger(saved.step) ? Math.max(0, Math.min(plan.steps.length - 1, saved.step)) : 0,
    member: same && saved.member === "tests" ? "tests" : "implementation",
    related: {
      implementation: same && Number.isSafeInteger(saved.related?.implementation) ? saved.related.implementation : 0,
      tests: same && Number.isSafeInteger(saved.related?.tests) ? saved.related.tests : 0,
    },
    viewedStepIds: same && Array.isArray(saved.viewedStepIds) ? saved.viewedStepIds.filter((id) => plan.steps.some((step) => step.id === id)) : [],
    viewports: same && saved.viewports != null && typeof saved.viewports === "object" ? { ...saved.viewports } : {},
  };
}

export function storyAnchors(story: StorySessionData, member = story.member): StoryAnchor[] {
  const grouped = new Map<string, StoryAnchor>();
  for (const anchor of story.plan.steps[story.step]?.[member] ?? []) {
    const key = anchor.unitId ?? JSON.stringify([anchor.fileId, anchor.side, anchor.startLine, anchor.endLine]);
    const current = grouped.get(key);
    if (current == null || current.side === "deleted" && anchor.side === "added") grouped.set(key, anchor);
  }
  return [...grouped.values()];
}

export function storyAnchor(story: StorySessionData, member = story.member): StoryAnchor | undefined {
  const anchors = storyAnchors(story, member);
  return anchors[Math.max(0, Math.min(anchors.length - 1, story.related[member]))];
}

export function storyViewportKey(story: StorySessionData, member = story.member): string {
  return JSON.stringify([story.plan.steps[story.step]?.id, member, story.related[member]]);
}
