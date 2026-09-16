import { execFileSync, fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, rmdir, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getReviewSessionPathForDiagnostics, listReviewSessions, loadReviewSession, saveReviewSession, saveReviewSessionWithStatus, type ReviewSessionData } from "../review-session.js";
import { ReviewSessionLockedError } from "../review-session-persistence.js";

const originalDirectory = process.env.PI_CODE_DIFF_SESSIONS_DIR;
let directory: string;
let barrier: string;
let children: ChildProcess[];
const data = (): ReviewSessionData => ({
  state: {
    activeScope: "git-diff", activeFileId: "app.ts", searchQuery: "", focus: "diff", wrapLines: true,
    hideUnchanged: false, selectedCommentIndex: 0, selectedLineTargetByScopeFile: {},
    draft: { allComment: "Original note", allIntent: "comment", comments: [{
      id: "comment", fileId: "app.ts", scope: "git-diff", side: "file", intent: "comment",
      startLine: null, endLine: null, body: "Original comment",
    }] },
  },
  diffViewMode: "unified", navigatorTreeMode: false, contextLineNavigation: false, commentsGlobal: false,
  reviewedFileIds: [], navigatorScroll: 0, diffScroll: 0, commentsScroll: 0,
});

async function writer(identity: string): Promise<ChildProcess> {
  const child = fork(new URL("./helpers/review-session-process.mjs", import.meta.url), [], {
    silent: true, execArgv: ["--experimental-strip-types"],
    env: { ...process.env, PI_CODE_DIFF_SESSIONS_DIR: directory },
  });
  children.push(child);
  expect((await once(child, "message"))[0]).toEqual({ kind: "ready" });
  await command(child, { action: "load", identity, data: data() });
  return child;
}

async function command(child: ChildProcess, value: object) {
  const reply = once(child, "message");
  child.send(value);
  return (await reply)[0];
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "pi-session-processes-"));
  process.env.PI_CODE_DIFF_SESSIONS_DIR = directory;
  barrier = join(directory, "replacement-barrier");
  execFileSync("mkfifo", [barrier]);
  children = [];
});

afterEach(async () => {
  await Promise.all(children.map(async (child) => {
    if (child.exitCode != null || child.signalCode != null) return;
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
  }));
  if (originalDirectory == null) delete process.env.PI_CODE_DIFF_SESSIONS_DIR;
  else process.env.PI_CODE_DIFF_SESSIONS_DIR = originalDirectory;
  await rm(directory, { recursive: true, force: true });
});

describe("cross-process review persistence", () => {
  it("serializes comparison and replacement and returns both stale feedback versions", async () => {
    saveReviewSession("shared", data());
    const first = await writer("shared");
    const second = await writer("shared");
    expect(await command(first, { action: "save", comment: "First version", pause: barrier })).toEqual({ kind: "at-replace" });
    expect(await command(second, { action: "save", note: "Second version" })).toMatchObject({
      saved: false, status: "locked", lock: { ownerPid: first.pid, ownerStatus: "present-or-reused" },
    });
    expect(await command(second, { action: "delete" })).toMatchObject({ deleted: false, status: "locked" });
    const completed = once(first, "message");
    await writeFile(barrier, "x");
    expect((await completed)[0]).toMatchObject({ saved: true, generation: 2 });
    expect(await command(second, { action: "save" })).toMatchObject({
      saved: false, status: "conflict", reason: "generation-mismatch",
      current: { state: { draft: { comments: [{ body: "First version" }] } } },
      attempted: { state: { draft: { allComment: "Second version" } } },
    });
    expect(loadReviewSession("shared")?.state.draft.comments[0]?.body).toBe("First version");
  });

  it("keeps different-session index updates when a contending writer retries", async () => {
    const first = await writer("first-target");
    const second = await writer("second-target");
    expect(await command(first, { action: "save", pause: barrier })).toEqual({ kind: "at-replace" });
    expect(await command(second, { action: "save" })).toMatchObject({ saved: false, status: "locked" });
    const completed = once(first, "message");
    await writeFile(barrier, "x");
    expect((await completed)[0]).toMatchObject({ saved: true });
    expect(await command(second, { action: "save" })).toMatchObject({ saved: true });
    expect(listReviewSessions().map((entry) => entry.identity).sort()).toEqual(["first-target", "second-target"]);
  });

  it.each(["delete", "consume"])("does not let a stale process undo %s", async (action) => {
    saveReviewSession("shared", data());
    const first = await writer("shared");
    const second = await writer("shared");
    expect(await command(first, { action })).toMatchObject(action === "delete" ? { deleted: true } : { saved: true });
    expect(await command(second, { action: "save", note: "Late edit" })).toMatchObject({
      saved: false, status: "conflict", attempted: { state: { draft: { allComment: "Late edit" } } },
    });
    expect(loadReviewSession("shared")?.state.draft.comments ?? []).toEqual([]);
  });

  it("leaves a killed owner's lock intact and reports manual-only recovery", async () => {
    saveReviewSession("interrupted", data());
    const owner = await writer("interrupted");
    expect(await command(owner, { action: "save", pause: barrier })).toEqual({ kind: "at-replace" });
    const lock = join(directory, ".write-lock", "owner.json");
    const ownership = readFileSync(lock, "utf8");
    const exited = once(owner, "exit");
    owner.kill("SIGKILL");
    await exited;
    const result = saveReviewSessionWithStatus("interrupted", data());
    expect(result).toMatchObject({ saved: false, status: "locked", lock: { ownerStatus: "dead", recovery: "manual-only" } });
    expect(readFileSync(lock, "utf8")).toBe(ownership);
    expect(loadReviewSession("interrupted")?.generation).toBe(1);
    expect(loadReviewSession("interrupted")?.state.draft.allComment).toBe("Original note");
  });

  it.each(["create", "refresh"])("recovers an interrupted %s after snapshot commit and explicit ownership recovery", async (operation) => {
    saveReviewSession("indexed", data());
    const identity = "interrupted-index";
    const indexPath = join(directory, "index.json");
    if (operation === "refresh") {
      const id = saveReviewSession(identity, data());
      const oldTimestamp = "1970-01-01T00:00:00Z";
      await writeFile(getReviewSessionPathForDiagnostics(id), JSON.stringify({ ...loadReviewSession(identity), updatedAt: oldTimestamp }));
      const index = JSON.parse(readFileSync(indexPath, "utf8"));
      index.sessions.find((entry: { identity: string }) => entry.identity === identity).updatedAt = oldTimestamp;
      await writeFile(indexPath, JSON.stringify(index));
    }
    const previousIndex = readFileSync(indexPath, "utf8");
    const owner = await writer(identity);
    expect(await command(owner, { action: "save", note: "Committed before crash", pause: barrier, pauseAt: "index" })).toEqual({ kind: "at-index-replace" });
    const lock = join(directory, ".write-lock");
    const ownership = readFileSync(join(lock, "owner.json"), "utf8");
    const exited = once(owner, "exit");
    owner.kill("SIGKILL");
    await exited;

    const generation = operation === "create" ? 1 : 2;
    expect(loadReviewSession(identity)).toMatchObject({ generation, state: { draft: { allComment: "Committed before crash" } } });
    expect(readFileSync(indexPath, "utf8")).toBe(previousIndex);
    expect(() => listReviewSessions()).toThrow(ReviewSessionLockedError);
    expect(readFileSync(join(lock, "owner.json"), "utf8")).toBe(ownership);
    // Explicit operator recovery in this fixture only: its sole writer has exited.
    await rm(join(lock, "owner.json"));
    await rmdir(lock);

    const entries = listReviewSessions();
    expect(entries.map((entry) => entry.identity).sort()).toEqual(["indexed", identity]);
    expect(JSON.parse(readFileSync(indexPath, "utf8")).sessions).toEqual(entries);
    expect(loadReviewSession(identity)?.generation).toBe(generation);
  });

  it("never steals old ownership on PID reuse or incomplete lock metadata", () => {
    const lock = join(directory, ".write-lock");
    mkdirSync(lock);
    expect(saveReviewSessionWithStatus("shared", data())).toMatchObject({ status: "locked", lock: { ownerStatus: "unknown" } });
    const oldOwner = JSON.stringify({ pid: process.pid, host: hostname(), token: "previous-process", createdAt: "1970-01-01T00:00:00Z" });
    writeFileSync(join(lock, "owner.json"), oldOwner);
    expect(saveReviewSessionWithStatus("shared", data())).toMatchObject({
      saved: false, status: "locked", lock: { ownerStatus: "present-or-reused", recovery: "manual-only" },
    });
    expect(readFileSync(join(lock, "owner.json"), "utf8")).toBe(oldOwner);
  });
});
