import type { ReplyThread } from "./review-replies.js";

export type ReviewThreadSide = "added" | "deleted";

export interface PlacedReviewThread {
  thread: ReplyThread;
  side: ReviewThreadSide;
  startLine: number;
  endLine: number;
  /** Provider line the thread was written on, when its code now sits on another line. */
  movedFrom?: number;
}

export interface ReviewThreadFrame {
  side: ReviewThreadSide;
  lines: readonly string[];
  /** The provider anchored the thread to exactly this side's reviewed revision. */
  sameRevision: boolean;
}

const ANCHOR_LINES = 3;
const MAX_ANCHOR_LINE_LENGTH = 500;
const RELOCATION_WINDOW = 400;
const MIN_RELOCATION_TEXT = 12;

export function isOpenReviewThread(thread: ReplyThread): boolean {
  return thread.resolved !== true;
}

/** The last diff-hunk lines on the commented side, ending with the commented line. */
export function anchorTextFromDiffHunk(hunk: unknown, side: ReviewThreadSide | undefined): string[] | undefined {
  if (typeof hunk !== "string" || side == null) return undefined;
  const own = side === "added" ? "+" : "-";
  const lines: string[] = [];
  const rows = hunk.split(/\r\n|\n|\r/);
  while (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();
  for (let index = rows.length - 1; index >= 0 && lines.length < ANCHOR_LINES; index -= 1) {
    const row = rows[index]!;
    if (row.startsWith("@@")) break;
    if (row.startsWith("\\")) continue;
    if (row[0] !== " " && row[0] !== own) {
      if (lines.length === 0) return undefined;
      continue;
    }
    lines.unshift(row.slice(1, 1 + MAX_ANCHOR_LINE_LENGTH));
  }
  return lines.length > 0 ? lines : undefined;
}

function sameText(left: string | undefined, right: string): boolean {
  return left != null && left.slice(0, MAX_ANCHOR_LINE_LENGTH).trimEnd() === right.trimEnd();
}

function anchorEndsAt(lines: readonly string[], endLine: number, anchor: readonly string[]): boolean {
  const first = endLine - anchor.length;
  if (first < 0 || endLine > lines.length) return false;
  return anchor.every((text, offset) => sameText(lines[first + offset], text));
}

function relocateAnchor(lines: readonly string[], origin: number, anchor: readonly string[]): number | null {
  if (anchor.map((text) => text.trim()).join("").length < MIN_RELOCATION_TEXT) return null;
  for (let distance = 1; distance <= RELOCATION_WINDOW; distance += 1) {
    const above = origin - distance >= 1 && anchorEndsAt(lines, origin - distance, anchor);
    const below = origin + distance <= lines.length && anchorEndsAt(lines, origin + distance, anchor);
    if (above && below) return null;
    if (above) return origin - distance;
    if (below) return origin + distance;
  }
  return null;
}

/**
 * Places an open thread only where its anchor is verified: its diff-hunk text ends on that line,
 * or, without hunk text, the provider anchored it to this exact revision and it is current.
 */
export function placeReviewThread(thread: ReplyThread, frame: ReviewThreadFrame): PlacedReviewThread | null {
  if (!isOpenReviewThread(thread) || (thread.side ?? "added") !== frame.side) return null;
  const origin = thread.line ?? thread.originalLine ?? null;
  if (origin == null || !Number.isSafeInteger(origin) || origin < 1) return null;
  const anchor = thread.anchorText;
  let endLine: number | null = null;
  if (anchor != null && anchor.length > 0) {
    endLine = anchorEndsAt(frame.lines, origin, anchor) ? origin : relocateAnchor(frame.lines, origin, anchor);
  } else if (frame.sameRevision && thread.outdated !== true && thread.line != null && thread.line <= frame.lines.length) {
    endLine = thread.line;
  }
  if (endLine == null) return null;
  const start = thread.startLine;
  const span = start != null && Number.isSafeInteger(start) && start >= 1 && start <= origin ? origin - start : 0;
  return {
    thread,
    side: frame.side,
    startLine: Math.max(1, endLine - span),
    endLine,
    ...(endLine === origin ? {} : { movedFrom: origin }),
  };
}
