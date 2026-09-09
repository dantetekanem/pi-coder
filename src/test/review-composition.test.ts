import { mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInitialReviewState } from "../state.js";
import { createReviewInstanceId, deleteReviewSession, listReviewSessions, loadReviewSession, saveReviewSession, saveReviewSessionWithStatus, type ReviewSessionData } from "../review-session.js";
import { listReviewCompositions, removeReviewComposition, saveReviewComposition, COMPOSITION_MAX_BYTES, COMPOSITION_MAX_RECORDS, COMPOSITION_STORE_MAX_BYTES, COMPOSITION_TTL_MS } from "../review-composition.js";
import type { ReviewComposition } from "../types.js";
import { ReviewApp } from "../ui/review-app.js";

const identity = "/repo|working|local";
const sessionId = "instance";
const originalDirectory = process.env.PI_CODE_DIFF_SESSIONS_DIR;
let directory: string;
const session: ReviewSessionData = {
  state: createInitialReviewState([]), diffViewMode: "unified", navigatorTreeMode: false,
  contextLineNavigation: false, commentsGlobal: false, reviewedFileIds: [],
  navigatorScroll: 0, diffScroll: 0, commentsScroll: 0,
};
function composition(text = "unfinished"): ReviewComposition {
  return { id: createReviewInstanceId(), repoRoot: "/repo", target: { kind: "all", intent: "discuss", initialBody: "" }, baseBody: "", text, cursor: { line: 0, col: text.length } };
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "pi-composition-"));
  process.env.PI_CODE_DIFF_SESSIONS_DIR = directory;
  saveReviewSession(identity, session, { id: sessionId, revision: "worktree" });
});
afterEach(() => {
  vi.useRealTimers();
  if (originalDirectory == null) delete process.env.PI_CODE_DIFF_SESSIONS_DIR;
  else process.env.PI_CODE_DIFF_SESSIONS_DIR = originalDirectory;
  rmSync(directory, { recursive: true, force: true });
});

describe("independent editor compositions", () => {
  it("makes a first unfinished comment discoverable before any feedback is committed", async () => {
    const id = createReviewInstanceId();
    let generation: number | null = null;
    const loadFileContents = vi.fn(async () => ({ originalContent: "old\n", modifiedContent: "new\n" }));
    const file = { id: "app.ts", path: "app.ts", worktreeStatus: "modified" as const, hasWorkingTreeFile: true, inGitDiff: true, inLastCommit: false, inAllFiles: false, gitDiff: null, lastCommit: null, allFiles: null };
    const app = new ReviewApp({ requestRender() {} } as never, { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text } as never, vi.fn(), {
      files: [file], repoRoot: "/repo", visibleScopes: ["git-diff"], loadFileContents, commentShortcuts: [], notify: vi.fn(),
      onSessionChange: (data) => {
        const result = saveReviewSessionWithStatus(identity, data, { id, revision: "worktree", expectedGeneration: generation });
        if (result.saved) generation = result.generation;
        return result.saved;
      },
      onCompositionSave: (data) => { saveReviewComposition(identity, id, data); return true; },
    });
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());
    vi.useFakeTimers();
    try {
      app.handleInput("\r"); app.handleInput("c"); app.handleInput("first interrupted comment");
      vi.advanceTimersByTime(2_000);
      expect(listReviewSessions().map((entry) => entry.id)).toContain(id);
      expect(loadReviewSession(identity, id)?.state.draft.comments).toEqual([]);
      expect(listReviewCompositions(identity, id)[0]?.text).toBe("first interrupted comment");
    } finally { app.dispose(); }
  });

  it("retains both explicit-resume writers without changing committed feedback or its generation", () => {
    const a = composition("writer A");
    const b = composition("writer B");
    saveReviewComposition(identity, sessionId, a);
    saveReviewComposition(identity, sessionId, b);
    saveReviewComposition(identity, sessionId, { ...a, text: "A keeps typing" });
    expect(listReviewCompositions(identity, sessionId).map((item) => item.text).sort()).toEqual(["A keeps typing", "writer B"]);
    expect(loadReviewSession(identity, sessionId)).toMatchObject({ generation: 1, state: session.state });
    expect(listReviewSessions().map((item) => item.id)).toContain(sessionId);
    removeReviewComposition(identity, sessionId, a.id);
    expect(listReviewCompositions(identity, sessionId).map((item) => item.id)).toEqual([b.id]);
  });

  it("refuses orphan and terminal writes and never resurrects them in the picker", () => {
    expect(() => saveReviewComposition(identity, "unknown", composition())).toThrow(/active review/i);
    const saved = composition();
    saveReviewComposition(identity, sessionId, saved);
    expect(deleteReviewSession(identity, sessionId, 1).deleted).toBe(true);
    expect(() => saveReviewComposition(identity, sessionId, { ...saved, text: "stale writer" })).toThrow(/active review/i);
    expect(listReviewCompositions(identity, sessionId)).toEqual([]);
    expect(listReviewSessions()).toEqual([]);
  });

  it("shares the store mutex and leaves all text unchanged on contention", () => {
    const saved = composition();
    saveReviewComposition(identity, sessionId, saved);
    mkdirSync(join(directory, ".write-lock"));
    expect(() => saveReviewComposition(identity, sessionId, { ...saved, text: "not written" })).toThrow(/locked/i);
    expect(readFileSync(join(directory, "compositions", `${saved.id}.json`), "utf8")).toContain("unfinished");
  });

  it("rejects oversized text and capacity exhaustion without truncating or evicting fresh versions", () => {
    const saved = composition();
    saveReviewComposition(identity, sessionId, saved);
    expect(() => saveReviewComposition(identity, sessionId, { ...saved, text: "é".repeat(COMPOSITION_MAX_BYTES) })).toThrow(/bytes/i);
    for (let i = 1; i < COMPOSITION_MAX_RECORDS; i += 1) saveReviewComposition(identity, sessionId, composition(`copy ${i}`));
    expect(() => saveReviewComposition(identity, sessionId, composition("one too many"))).toThrow(/capacity/i);
    expect(listReviewCompositions(identity, sessionId)).toHaveLength(COMPOSITION_MAX_RECORDS);
    expect(listReviewCompositions(identity, sessionId).find((item) => item.id === saved.id)?.text).toBe("unfinished");
  });

  it("counts interrupted-write bytes against the aggregate budget without discarding existing text", () => {
    const saved = composition();
    saveReviewComposition(identity, sessionId, saved);
    const interrupted = join(directory, "compositions", "interrupted.tmp");
    writeFileSync(interrupted, "");
    truncateSync(interrupted, COMPOSITION_STORE_MAX_BYTES);
    expect(() => saveReviewComposition(identity, sessionId, { ...saved, text: "new text" })).toThrow(/capacity/i);
    expect(listReviewCompositions(identity, sessionId)[0]?.text).toBe("unfinished");
  });

  it("expires only old valid recovery records, not refreshed or unknown records", () => {
    vi.useFakeTimers();
    const old = composition("old");
    const fresh = composition("fresh");
    saveReviewComposition(identity, sessionId, old);
    saveReviewComposition(identity, sessionId, fresh);
    writeFileSync(join(directory, "compositions", "unknown.tmp"), "not json");
    vi.advanceTimersByTime(COMPOSITION_TTL_MS);
    saveReviewComposition(identity, sessionId, fresh);
    vi.advanceTimersByTime(1);
    expect(listReviewCompositions(identity, sessionId).map((item) => item.text)).toEqual(["fresh"]);
    expect(readFileSync(join(directory, "compositions", "unknown.tmp"), "utf8")).toBe("not json");
  });

  it("validates persisted record identity, cursor and size before offering recovery", () => {
    const saved = composition();
    saveReviewComposition(identity, sessionId, saved);
    const path = join(directory, "compositions", `${saved.id}.json`);
    const raw = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...raw, cursor: { line: -1, col: 0 } }));
    expect(() => listReviewCompositions(identity, sessionId)).toThrow(/invalid/i);
    expect(() => saveReviewComposition(identity, sessionId, { ...saved, id: "../escape" })).toThrow(/identity/i);
  });
});
