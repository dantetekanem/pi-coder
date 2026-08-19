import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hasHandoffContext, parsePullRequestHandoff, pullRequestMetadataFromHandoff } from "../pr-handoff.js";

const originalSettingsPath = process.env.PI_CODE_DIFF_SETTINGS_PATH;
let directory: string;
let settingsPath: string;

function neutralSettings() {
  const fields = {
    number: "id",
    title: "subject",
    body: "description",
    additions: "metrics.added",
    deletions: "metrics.removed",
    changedFiles: "metrics.files",
    author: "actor.handle",
    state: "phase",
    reviewState: "decision",
    headRefName: "source.name",
    headRefOid: "source.oid",
    baseRefName: "target.name",
    baseRefOid: "target.oid",
  };
  return {
    version: 1,
    providers: {
      primary: {
        label: "Primary code host",
        executable: "cli-one",
        urls: {
          patterns: [
            { host: "code.example", path: "/{repo}/change/{number}" },
            { host: "stack.example", path: "/review/{repo}/{number}" },
          ],
          canonical: "https://code.example/{repo}/change/{number}",
          clone: "https://code.example/{repo}.git",
        },
        operations: {
          pullRequest: { args: ["change", "show", "{repo}", "{number}"] },
          reviews: { args: ["change", "reviews", "{repo}", "{number}"] },
        },
        refs: { head: "refs/changes/{number}/head" },
        fields,
        capabilities: { baseRevisionRequired: false },
      },
      pinned: {
        label: "Pinned code host",
        executable: "cli-two",
        urls: {
          patterns: [{ host: "pinned.example", path: "/projects/{repo}/reviews/{number}" }],
          canonical: "https://pinned.example/projects/{repo}/reviews/{number}",
          clone: "https://mirror.example/{repo}.git",
        },
        operations: {
          pullRequest: { args: ["request", "{repo}", "{number}"] },
          reviews: { args: ["request-reviews", "{repo}", "{number}"] },
        },
        refs: { base: "review/{number}/base", head: "review/{number}/head" },
        fields,
        capabilities: { baseRevisionRequired: true },
      },
    },
    repositories: {},
  };
}

function fullPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: "primary",
    repo: "example/widgets",
    number: 123,
    url: "https://code.example/example/widgets/change/123",
    title: "Add review mode",
    authorLogin: "author-one",
    state: "open",
    body: "Problem statement.",
    baseRefName: "main",
    headRefName: "feature/review",
    headRefOid: "A".repeat(40),
    additions: 10,
    deletions: 4,
    changedFiles: 3,
    reviews: [{ author: "reviewer-one", state: "approved" }],
    reviewDecision: "approved",
    stackParent: { number: 6, title: "Parent change", headRefName: "parent/review", state: "merged", url: "https://code.example/example/widgets/change/6" },
    threads: [{ path: "src/app.ts", line: 12, resolved: false, comments: [{ author: "reviewer-one", body: "Why here?", createdAt: "2024-05-01T00:00:00Z" }] }],
    checks: [{ name: "build", status: "completed", conclusion: "failure" }],
    summary: "Title:\nAdd review mode",
    filePriority: [{ path: "src/app.ts", reason: "core change" }],
    queue: { position: 2, total: 5 },
    nextCandidate: { url: "https://stack.example/review/example/widgets/124", title: "Next change" },
    ...overrides,
  };
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "pi-code-diff-handoff-"));
  settingsPath = join(directory, "settings.json");
  writeFileSync(settingsPath, JSON.stringify(neutralSettings()), "utf8");
  process.env.PI_CODE_DIFF_SETTINGS_PATH = settingsPath;
});

afterEach(() => {
  if (originalSettingsPath == null) delete process.env.PI_CODE_DIFF_SETTINGS_PATH;
  else process.env.PI_CODE_DIFF_SETTINGS_PATH = originalSettingsPath;
  rmSync(directory, { recursive: true, force: true });
});

describe("pull request handoff schema", () => {
  it("normalizes a configured provider payload and maps it onto pull request metadata", () => {
    const handoff = parsePullRequestHandoff(fullPayload());

    expect(handoff).toMatchObject({
      provider: "primary",
      repo: "example/widgets",
      number: "123",
      url: "https://code.example/example/widgets/change/123",
      state: "OPEN",
      headRefOid: "a".repeat(40),
      reviews: [{ author: "reviewer-one", state: "APPROVED" }],
      reviewDecision: "APPROVED",
      stackParent: { number: "6", state: "MERGED" },
      queue: { position: 2, total: 5 },
      nextCandidate: { url: "https://code.example/example/widgets/change/124" },
    });
    expect(hasHandoffContext(handoff)).toBe(true);
    expect(pullRequestMetadataFromHandoff(handoff)).toMatchObject({
      number: "123",
      repo: "example/widgets",
      title: "Add review mode",
      authorLogin: "author-one",
      state: "OPEN",
      reviews: [{ author: { login: "reviewer-one" }, state: "APPROVED" }],
      headRefName: "feature/review",
      headRefOid: "a".repeat(40),
      baseRefName: "main",
    });
  });

  it("accepts a minimal payload and reports no supplied context", () => {
    const handoff = parsePullRequestHandoff({
      provider: "primary",
      repo: "example/widgets",
      number: "123",
      url: "https://code.example/example/widgets/change/123",
      title: "Add review mode",
      authorLogin: "author-one",
      state: "OPEN",
      baseRefName: "main",
      headRefName: "feature/review",
      headRefOid: "b".repeat(40),
      additions: 0,
      deletions: 0,
      changedFiles: 1,
    });

    expect(handoff.body).toBe("");
    expect(handoff.reviews).toEqual([]);
    expect(hasHandoffContext(handoff)).toBe(false);
  });

  it("requires configured providers, safe repositories, canonical URLs, and capability-driven base revisions", () => {
    expect(() => parsePullRequestHandoff(fullPayload({ provider: "missing" }))).toThrow(/provider missing is not configured/);
    expect(() => parsePullRequestHandoff(fullPayload({ repo: "../.." }))).toThrow(/repo must look like owner\/repo/);
    expect(() => parsePullRequestHandoff(fullPayload({ repo: "../sessions" }))).toThrow(/repo must look like owner\/repo/);
    expect(() => parsePullRequestHandoff(fullPayload({ url: "https://stack.example/review/example/widgets/123" }))).toThrow(/url must be exactly/);
    expect(() => parsePullRequestHandoff(fullPayload({
      provider: "pinned",
      url: "https://pinned.example/projects/example/widgets/reviews/123",
      stackParent: undefined,
      nextCandidate: undefined,
    }))).toThrow(/baseRefOid is required for provider pinned/);

    const handoff = parsePullRequestHandoff(fullPayload({
      provider: "pinned",
      url: "https://pinned.example/projects/example/widgets/reviews/123",
      baseRefOid: "c".repeat(40),
      stackParent: undefined,
      nextCandidate: undefined,
    }));
    expect(handoff.baseRefOid).toBe("c".repeat(40));
  });

  it("fails closed on malformed payloads", () => {
    const cases: Array<[Record<string, unknown> | unknown, RegExp]> = [
      ["not an object", /pullRequest must be an object/],
      [fullPayload({ repo: "widgets" }), /repo must look like owner\/repo/],
      [fullPayload({ number: 0 }), /number must be a positive pull request number/],
      [fullPayload({ url: "https://evil.example/https://code.example/example/widgets/change/123" }), /url must be exactly/],
      [fullPayload({ headRefOid: "abc123" }), /headRefOid must be a full commit SHA/],
      [fullPayload({ headRefName: "feature/../etc" }), /headRefName must be a safe git ref name/],
      [fullPayload({ headRefName: "--upload-pack=touch" }), /headRefName must be a safe git ref name/],
      [fullPayload({ additions: -1 }), /additions must be a non-negative integer/],
      [fullPayload({ reviews: [{ author: "reviewer-one" }] }), /reviews\[0\]\.state must be a non-empty string/],
      [fullPayload({ threads: [{ comments: [] }] }), /threads\[0\]\.comments must not be empty/],
      [fullPayload({ queue: { position: 3, total: 2 } }), /queue\.total must be at least queue.position/],
      [fullPayload({ nextCandidate: { url: "https://evil.example/change/1" } }), /nextCandidate\.url must match a configured pull request URL/],
      [fullPayload({ mergeNow: true }), /pullRequest has unsupported field\(s\): mergeNow/],
    ];

    for (const [payload, matcher] of cases) expect(() => parsePullRequestHandoff(payload)).toThrow(matcher);
  });
});
