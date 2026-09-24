import { showOnlyStructuredDiffRows, type StructuredDiff, type StructuredDiffRow } from "../diff.js";
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

/** One bounded view per file of a step member: the ranges it shows and where the cursor starts. */
export interface StoryPage {
  key: string;
  fileId: string;
  anchor: StoryAnchor;
  anchors: StoryAnchor[];
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

export function storyPages(story: StorySessionData, member = story.member): StoryPage[] {
  const grouped = new Map<string, Omit<StoryPage, "key">>();
  for (const anchor of story.plan.steps[story.step]?.[member] ?? []) {
    const page = grouped.get(anchor.fileId);
    if (page == null) grouped.set(anchor.fileId, { fileId: anchor.fileId, anchor, anchors: [anchor] });
    else page.anchors.push(anchor);
  }
  return [...grouped.values()].map((page) => ({
    ...page,
    key: JSON.stringify([page.fileId, ...page.anchors.map((anchor) => [anchor.side, anchor.startLine, anchor.endLine])]),
  }));
}

export function storyPage(story: StorySessionData, member = story.member): StoryPage | undefined {
  const pages = storyPages(story, member);
  return pages[Math.max(0, Math.min(pages.length - 1, story.related[member]))];
}

export function storyAnchors(story: StorySessionData, member = story.member): StoryAnchor[] {
  return storyPages(story, member).map((page) => page.anchor);
}

export function storyAnchor(story: StorySessionData, member = story.member): StoryAnchor | undefined {
  return storyPage(story, member)?.anchor;
}

/** A page shows its anchored lines plus nearby unchanged lines, never another step's changes. */
export function storyPageDiff(diff: StructuredDiff, anchors: readonly StoryAnchor[], contextLines: number): StructuredDiff {
  const covers = (side: StoryAnchor["side"], line: number | undefined) =>
    line != null && anchors.some((anchor) => anchor.side === side && anchor.startLine <= line && line <= anchor.endLine);
  const visible = new Set<number>();
  diff.rows.forEach((row, index) => {
    if (covers("added", row.newLineNumber) || covers("deleted", row.oldLineNumber)) visible.add(index);
  });
  for (const index of [...visible]) {
    for (const step of [-1, 1]) {
      for (let next = index + step, count = 0; count < contextLines && diff.rows[next]?.kind === "equal"; next += step, count += 1) {
        visible.add(next);
      }
    }
  }
  const page = showOnlyStructuredDiffRows(diff, visible, (count) => `${count.toLocaleString()} line${count === 1 ? "" : "s"} outside this step`);
  return {
    ...page,
    visibleItems: page.visibleItems.map((item) => {
      if (item.type !== "row" || item.row.kind !== "replace") return item;
      const added = covers("added", item.row.newLineNumber);
      if (added === covers("deleted", item.row.oldLineNumber)) return item;
      const row: StructuredDiffRow = added
        ? { ...item.row, kind: "insert", oldLineNumber: undefined, oldText: "", oldHighlights: [] }
        : { ...item.row, kind: "delete", newLineNumber: undefined, newText: "", newHighlights: [] };
      return { ...item, row };
    }),
  };
}

export function storyViewportKey(story: StorySessionData, member = story.member): string {
  return JSON.stringify([story.plan.steps[story.step]?.id, member, story.related[member]]);
}
