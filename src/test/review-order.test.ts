import { describe, expect, it } from "vitest";
import { parsePullRequestHandoff } from "../pr-handoff.js";
import type { PiCoderSettings } from "../provider-settings.js";
import { buildReviewOrderSignals, compareReviewFilesByRisk, countHandoffThreads, getReviewFileRiskScore, orderNavigatorFiles, pairTestFiles } from "../review-order.js";
import type { ChangeStatus, ReviewFile } from "../types.js";

function makeFile(
  path: string,
  options: { additions?: number; deletions?: number; status?: ChangeStatus; incoming?: string[] } = {},
): ReviewFile {
  const comparison = {
    status: options.status ?? ("modified" as ChangeStatus),
    oldPath: path,
    newPath: path,
    displayPath: path,
    hasOriginal: true,
    hasModified: true,
    additions: options.additions ?? 0,
    deletions: options.deletions ?? 0,
  };
  return {
    id: `${path}::git-diff`,
    path,
    worktreeStatus: comparison.status,
    hasWorkingTreeFile: true,
    inGitDiff: true,
    inLastCommit: false,
    inAllFiles: false,
    gitDiff: comparison,
    lastCommit: null,
    allFiles: null,
    allFilesIncomingReferences: options.incoming,
  };
}

function order(files: ReviewFile[], signals?: ReturnType<typeof buildReviewOrderSignals>): string[] {
  return [...files].sort(compareReviewFilesByRisk("git-diff", signals)).map((file) => file.path);
}

const testSettings: PiCoderSettings = {
  version: 1,
  providers: {
    github: {
      id: "github",
      label: "GitHub",
      executable: "gh",
      urls: {
        patterns: [{ host: "github.com", path: "/{repo}/pull/{number}" }],
        canonical: "https://github.com/{repo}/pull/{number}",
      },
      operations: {},
      refs: {},
      fields: {},
      capabilities: {},
    },
  },
  repositories: {},
};

function handoff(overrides: Record<string, unknown>) {
  return parsePullRequestHandoff({
    provider: "github",
    repo: "example/widgets",
    number: "1",
    url: "https://github.com/example/widgets/pull/1",
    title: "Add review mode",
    authorLogin: "alice",
    state: "OPEN",
    baseRefName: "main",
    headRefName: "feature",
    headRefOid: "a".repeat(40),
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    ...overrides,
  }, testSettings);
}

describe("review order signals", () => {
  it("keeps the caller's file priority ahead of every derived signal", () => {
    const files = [
      makeFile("src/huge.ts", { additions: 400, deletions: 200, incoming: ["a", "b", "c"] }),
      makeFile("docs/readme.md", { additions: 1 }),
      makeFile("src/small.ts", { additions: 2 }),
    ];
    const signals = buildReviewOrderSignals(handoff({
      filePriority: [{ path: "docs/readme.md", reason: "contract change" }, { path: "src/small.ts" }],
    }));

    expect(order(files, signals)).toEqual(["docs/readme.md", "src/small.ts", "src/huge.ts"]);
  });

  it("ranks unresolved threads above churn and references", () => {
    const files = [
      makeFile("src/big.ts", { additions: 300, deletions: 50, incoming: ["a", "b"] }),
      makeFile("src/threaded.ts", { additions: 3 }),
    ];
    const signals = buildReviewOrderSignals(handoff({
      threads: [
        { path: "src/threaded.ts", comments: [{ author: "bob", body: "why?" }] },
        { path: "src/threaded.ts", resolved: true, comments: [{ author: "bob", body: "done" }] },
        { path: "src/big.ts", outdated: true, comments: [{ author: "bob", body: "stale" }] },
      ],
    }));

    expect(signals?.unresolvedThreadsByPath).toEqual({ "src/threaded.ts": 1 });
    expect(order(files, signals)).toEqual(["src/threaded.ts", "src/big.ts"]);
  });

  it("orders by blast radius and change size, then status, then path without handoff signals", () => {
    const files = [
      makeFile("src/added.ts", { additions: 5, status: "added" }),
      makeFile("src/edited.ts", { additions: 5 }),
      makeFile("src/wide.ts", { additions: 5, incoming: ["one", "two", "three", "four", "five", "six"] }),
      makeFile("src/rewritten.ts", { additions: 120, deletions: 40 }),
    ];

    expect(order(files)).toEqual(["src/wide.ts", "src/rewritten.ts", "src/edited.ts", "src/added.ts"]);
  });

  it("returns no signals when the handoff carries neither priority nor open threads", () => {
    expect(buildReviewOrderSignals(undefined)).toBeUndefined();
    expect(buildReviewOrderSignals(handoff({ threads: [{ path: "src/app.ts", resolved: true, comments: [{ author: "bob", body: "ok" }] }] }))).toBeUndefined();
  });

  it("counts open threads and the ones waiting on the reviewer", () => {
    const counts = countHandoffThreads(handoff({
      threads: [
        { path: "src/app.ts", comments: [{ author: "bob", body: "why?" }, { author: "alice", body: "because" }] },
        { path: "src/app.ts", comments: [{ author: "bob", body: "still open" }] },
        { path: "src/app.ts", resolved: true, comments: [{ author: "bob", body: "done" }] },
      ],
    }));

    expect(counts).toEqual({ open: 2, awaitingReply: 1 });
    expect(countHandoffThreads(handoff({}))).toBeUndefined();
  });
});

describe("navigator ordering", () => {
  const files = [
    makeFile("packages/ui/button.ts", { additions: 4 }),
    makeFile("packages/core/engine.ts", { additions: 300, deletions: 100 }),
    makeFile("packages/core/util.ts", { additions: 2 }),
    makeFile("app/main.ts", { additions: 10 }),
  ];

  it("puts the riskiest group first while keeping packages together", () => {
    const ordered = orderNavigatorFiles(files, {
      mode: "risk",
      scope: "git-diff",
      treeMode: true,
      groupOf: (file) => file.path.split("/").slice(0, 2).join("/"),
    });

    expect(ordered.map((file) => file.path)).toEqual([
      "packages/core/engine.ts",
      "packages/core/util.ts",
      "app/main.ts",
      "packages/ui/button.ts",
    ]);
  });

  it("sorts strictly by path when the reviewer toggles alphabetical order", () => {
    const ordered = orderNavigatorFiles(files, {
      mode: "alphabetical",
      scope: "git-diff",
      treeMode: false,
      groupOf: (file) => file.path,
    });

    expect(ordered.map((file) => file.path)).toEqual([
      "app/main.ts",
      "packages/core/engine.ts",
      "packages/core/util.ts",
      "packages/ui/button.ts",
    ]);
  });

  it("scores a priority file above the highest possible derived score", () => {
    const signals = buildReviewOrderSignals(handoff({ filePriority: [{ path: "src/small.ts" }] }));
    const priority = getReviewFileRiskScore(makeFile("src/small.ts"), "git-diff", signals);
    const derivedMax = getReviewFileRiskScore(
      makeFile("src/huge.ts", { additions: 900, deletions: 900, incoming: Array.from({ length: 30 }, (_, index) => `f${index}`) }),
      "git-diff",
      signals,
    );

    expect(priority).toBeGreaterThan(derivedMax);
  });
});

describe("navigator test pairing", () => {
  const paths = (files: ReviewFile[]) => files.map((file) => file.path);
  const pairedPaths = (files: ReviewFile[]) => Object.fromEntries(
    [...pairTestFiles(files)].map(([testId, implementation]) => [files.find((file) => file.id === testId)!.path, implementation.path]),
  );
  const topFolder = (file: ReviewFile) => file.path.split("/")[0]!;

  it("pairs tests with the files they test in Rails, engine, lib and JavaScript layouts", () => {
    const files = [
      makeFile("app/models/user.rb"),
      makeFile("test/models/user_test.rb"),
      makeFile("spec/models/user_spec.rb"),
      makeFile("engines/messaging/app/mailers/messages_mailer.rb"),
      makeFile("engines/messaging/test/mailers/messages_mailer_test.rb"),
      makeFile("lib/billing/invoice.rb"),
      makeFile("test/lib/billing/invoice_test.rb"),
      makeFile("src/ui/button.tsx"),
      makeFile("src/ui/button.test.tsx"),
      makeFile("src/review-order.ts"),
      makeFile("src/test/review-order.test.ts"),
    ];

    expect(pairedPaths(files)).toEqual({
      "test/models/user_test.rb": "app/models/user.rb",
      "spec/models/user_spec.rb": "app/models/user.rb",
      "engines/messaging/test/mailers/messages_mailer_test.rb": "engines/messaging/app/mailers/messages_mailer.rb",
      "test/lib/billing/invoice_test.rb": "lib/billing/invoice.rb",
      "src/ui/button.test.tsx": "src/ui/button.tsx",
      "src/test/review-order.test.ts": "src/review-order.ts",
    });
  });

  it("leaves helpers, tests without a changed subject and look-alike names unpaired", () => {
    const files = [
      makeFile("app/models/ab_test.rb"),
      makeFile("test/models/ab_test_test.rb"),
      makeFile("test/test_helper.rb"),
      makeFile("test/integration/checkout_test.rb"),
      makeFile("app/models/admin/user.rb"),
      makeFile("test/models/user_test.rb"),
    ];

    expect(pairedPaths(files)).toEqual({ "test/models/ab_test_test.rb": "app/models/ab_test.rb" });
  });

  it("never pairs files from different repositories", () => {
    const vendored = { ...makeFile("lib/foo.rb"), id: "vendor/gem/lib/foo.rb::git-diff", pathPrefix: "vendor/gem" };

    expect(pairTestFiles([vendored, makeFile("test/foo_test.rb")]).size).toBe(0);
  });

  it("lists a changed test right after its implementation, where the riskier of the two would rank", () => {
    const files = [
      makeFile("app/models/order.rb", { additions: 30 }),
      makeFile("test/models/user_test.rb", { additions: 80 }),
      makeFile("test/integration/checkout_test.rb", { additions: 5 }),
      makeFile("app/models/user.rb", { additions: 1 }),
    ];
    const expected = ["app/models/user.rb", "test/models/user_test.rb", "app/models/order.rb", "test/integration/checkout_test.rb"];

    expect(paths(orderNavigatorFiles(files, { mode: "risk", scope: "git-diff", treeMode: false, groupOf: topFolder }))).toEqual(expected);
    expect(paths(orderNavigatorFiles(files, { mode: "risk", scope: "git-diff", treeMode: true, groupOf: topFolder }))).toEqual(expected);
  });

  it("keeps the implementation ahead of its test in alphabetical order", () => {
    const files = [makeFile("src/ui/button.test.tsx"), makeFile("src/ui/button.tsx"), makeFile("src/ui/alert.tsx")];
    const ordered = orderNavigatorFiles(files, { mode: "alphabetical", scope: "git-diff", treeMode: true, groupOf: topFolder });

    expect(paths(ordered)).toEqual(["src/ui/alert.tsx", "src/ui/button.tsx", "src/ui/button.test.tsx"]);
  });
});
