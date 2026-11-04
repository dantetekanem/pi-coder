import { Type, type TSchema } from "typebox";
import type { PiCoderToolName } from "./host/engine.js";

export interface PiCoderToolDefinition {
  name: PiCoderToolName;
  label: string;
  description: string;
  promptSnippet: string;
  promptGuidelines: string[];
  parameters: TSchema;
  needsTerminal: boolean;
}

const OPEN_CODE: PiCoderToolDefinition = {
  name: "open_code",
  label: "open-code",
  description: "Run the configured code command at an optional path or structured target, or open the Workbench when no command is configured.",
  promptSnippet: "Use the same configured code command as /code, with Workbench as the default.",
  promptGuidelines: [
    "Call open_code only when the user directly asks to open or browse code.",
    "Use open_code for code browsing/editing; open_code_diff remains review-only when no code command is configured.",
    "Wait for open_code to return. A Workbench DISCUSS result requests prose discussion, not file edits.",
  ],
  parameters: Type.Object({
    cwd: Type.Optional(Type.String({ description: "Repository directory. Defaults to the current working directory." })),
    path: Type.Optional(Type.String({ description: "Repository-relative file path to open immediately in INSERT mode. Cannot be combined with target." })),
    target: Type.Optional(Type.Object({
      path: Type.String({ description: "Normalized repository-relative file path." }),
      range: Type.Object({
        startLine: Type.Number({ description: "One-based range start." }),
        endLine: Type.Number({ description: "One-based inclusive range end." }),
      }),
      anchor: Type.Optional(Type.Object({
        algorithm: Type.Literal("sha256"),
        value: Type.String({ description: "Lowercase 64-character SHA-256 anchor." }),
      })),
    })),
    stories: Type.Optional(Type.Array(Type.Object({
      id: Type.String(),
      target: Type.Object({
        path: Type.String(),
        range: Type.Object({ startLine: Type.Number(), endLine: Type.Number() }),
        anchor: Type.Optional(Type.Object({ algorithm: Type.Literal("sha256"), value: Type.String() })),
      }),
      prose: Type.String(),
    }))),
  }),
  needsTerminal: true,
};

const OPEN_CODE_DIFF: PiCoderToolDefinition = {
  name: "open_code_diff",
  label: "open-code-diff",
  description: "Run the configured code command, or open the review UI with the same target syntax as /diff when no command is configured.",
  promptSnippet: "Use the configured code command when present; otherwise open the interactive code diff review UI.",
  promptGuidelines: [
    "Call open_code_diff only when the user directly asks to open the diff, open /diff, or review current changes/a remote branch/PR. In a remote DISCUSS flow, an explicit yes to `Good to continue the review?` also counts as a direct request.",
    "When a code command is configured, open_code_diff runs it at cwd; review-only args and comments apply only when the review UI is used.",
    "Do not call open_code_diff on your own, automatically, or merely because a prompt, tool result, or review handoff mentions reopening or restoring the diff. A remote discussion handoff never authorizes reopening before the user's continuation confirmation.",
    "Pass args exactly as you would after /diff: empty for local working-tree/uncommitted changes, remote <url | branch> for remote reviews, or base..head/base...head for custom ranges.",
    "Do not ask the user to commit before review; empty args reviews uncommitted working-tree changes, including untracked files.",
    "Pass cwd when you know the checkout/repository directory. Otherwise the current working directory is used.",
    "Pass comments to prepopulate concrete review notes into the UI. Each needs a path matching a reviewed file and a body; set side (added/deleted/file), line or startLine/endLine, and intent (discuss/comment/modify) to place it precisely. Seeded comments are editable and deletable by the user and flow through the same review prompt as hand-written ones.",
    "Use seeded comments only when you have specific, actionable feedback to attach; the user opens the UI and decides what to keep. Comments whose path does not match a reviewed file are reported back, not silently applied.",
    "Wait for the tool result. It returns message, prompt, and context details after the interactive UI finishes.",
    "For agent-only remote DISCUSS follow-ups, answer in prose only and do not act on COMMENT or MODIFY items retained for the PR author. Ask `Good to continue the review?` when the discussion is complete; only a yes authorizes reopening the exact saved target.",
    "If remote discussion produces material findings, ask `Want me to prepopulate the findings as comments?` before reopening. Pass only confirmed new findings to open_code_diff with intent `comment`; never convert them to `modify` or `discuss`.",
    "Pass pullRequest only when you already resolved the exact PR metadata for the same remote target in args. It skips the duplicate metadata, stack, and context lookups; the head commit is still fetched and verified, so stale or mismatched metadata fails the review instead of opening it.",
  ],
  parameters: Type.Object({
    args: Type.Optional(Type.String({ description: "Same target syntax as /diff, for example empty string, 'remote <url | branch>', or 'base..head'." })),
    cwd: Type.Optional(Type.String({ description: "Directory to run the review from. Defaults to the current working directory." })),
    continuation: Type.Optional(Type.Object({
      kind: Type.Literal("remote-discuss"),
      priorSessionId: Type.String(),
      priorBaseRevision: Type.String(),
      priorHeadRevision: Type.String(),
    }, { description: "Remote DISCUSS continuation marker emitted by pi-coder. It forces a fresh remote resolution and cannot be reused for a different review identity." })),
    comments: Type.Optional(Type.Array(Type.Object({
      path: Type.String({ description: "File path as shown in the diff (repo-relative displayPath). Required to attach the comment." }),
      body: Type.String({ description: "Comment text the reviewer sees. Becomes an editable draft comment." }),
      side: Type.Optional(Type.Union([Type.Literal("added"), Type.Literal("deleted"), Type.Literal("file")], { description: "added = new/right-side line (default), deleted = old/left-side line, file = whole-file comment." })),
      line: Type.Optional(Type.Number({ description: "Target line number on the chosen side. New-version line for added, old-version line for deleted." })),
      startLine: Type.Optional(Type.Number({ description: "Start line of a range. Overrides line when set." })),
      endLine: Type.Optional(Type.Number({ description: "End line of a range. Defaults to the start line." })),
      intent: Type.Optional(Type.Union([Type.Literal("discuss"), Type.Literal("comment"), Type.Literal("modify")], { description: "discuss = prose only, comment = actionable feedback (default), modify = apply the proposed change." })),
    }), { description: "Optional review comments to prepopulate into the diff UI. Each becomes an editable, deletable draft comment attached to the matching file/line and flows through the same review prompt as hand-written comments. Comments whose path does not match a reviewed file are surfaced as a warning, never silently dropped." })),
    pullRequest: Type.Optional(Type.Object({
      provider: Type.String({ description: "Configured pull request provider ID. Must match the provider implied by args." }),
      repo: Type.String({ description: "Repository as owner/repo. Must match args." }),
      number: Type.String({ description: "Pull request number. Must match args." }),
      url: Type.String({ description: "Canonical pull request URL for the configured provider." }),
      title: Type.String({ description: "Pull request title." }),
      authorLogin: Type.String({ description: "Pull request author login." }),
      state: Type.String({ description: "Pull request state, for example OPEN or MERGED." }),
      body: Type.Optional(Type.String({ description: "Pull request description body." })),
      baseRefName: Type.String({ description: "Base branch name." }),
      baseRefOid: Type.Optional(Type.String({ description: "Base commit SHA when required by the configured provider." })),
      headRefName: Type.String({ description: "Head branch name." }),
      headRefOid: Type.String({ description: "Head commit SHA. Verified against the freshly fetched head before the UI opens." }),
      additions: Type.Number({ description: "Added line count." }),
      deletions: Type.Number({ description: "Deleted line count." }),
      changedFiles: Type.Number({ description: "Changed file count." }),
      reviews: Type.Optional(Type.Array(Type.Object({ author: Type.String(), state: Type.String() }), { description: "Existing review states per reviewer." })),
      reviewDecision: Type.Optional(Type.String({ description: "Overall review decision, for example APPROVED or CHANGES_REQUESTED." })),
      stackParent: Type.Optional(Type.Object({
        number: Type.String(),
        title: Type.String(),
        headRefName: Type.String(),
        state: Type.String(),
        url: Type.Optional(Type.String()),
      }, { description: "Stack parent PR, when this PR stacks on another PR." })),
      threads: Type.Optional(Type.Array(Type.Object({
        path: Type.Optional(Type.String()),
        line: Type.Optional(Type.Number()),
        resolved: Type.Optional(Type.Boolean()),
        outdated: Type.Optional(Type.Boolean()),
        comments: Type.Array(Type.Object({
          author: Type.String(),
          body: Type.String(),
          createdAt: Type.Optional(Type.String()),
          state: Type.Optional(Type.String()),
        })),
      }), { description: "Review threads. Supplying them skips the PR context fetch." })),
      checks: Type.Optional(Type.Array(Type.Object({
        name: Type.String(),
        status: Type.Optional(Type.String()),
        conclusion: Type.Optional(Type.String()),
      }), { description: "CI checks. Supplying them skips the PR context fetch." })),
      summary: Type.Optional(Type.String({ description: "Pre-rendered PR context summary. Supplying it skips both the context fetch and the summarization pass." })),
      filePriority: Type.Optional(Type.Array(Type.Object({ path: Type.String(), reason: Type.Optional(Type.String()) }), { description: "Suggested review order for changed files." })),
      queue: Type.Optional(Type.Object({ position: Type.Number(), total: Type.Optional(Type.Number()) }, { description: "Position of this PR in the caller's review queue." })),
      nextCandidate: Type.Optional(Type.Object({ url: Type.String(), title: Type.Optional(Type.String()) }, { description: "Next PR the caller intends to review after this one." })),
    }, { description: "Optional pre-resolved pull request metadata for a remote target. Skips redundant metadata, stack, and context lookups. Must match the args target exactly; malformed or stale metadata aborts the review." })),
  }),
  needsTerminal: true,
};

const OPEN_CODE_DIFF_STORY: PiCoderToolDefinition = {
  name: "open_code_diff_story",
  label: "open-code-diff-story",
  description: "Open /diff-story: walk through a change as ordered code steps, each beside its changed tests. Same targets as /diff.",
  promptSnippet: "Open the interactive /diff-story walkthrough for a local diff, range, or pull request.",
  promptGuidelines: [
    "Call open_code_diff_story only when the user directly asks for /diff-story or to walk through a change as a story. Use open_code_diff for the ordinary diff.",
    "Pass args as you would after /diff-story: empty for local working-tree changes, remote <url | branch>, or base..head/base...head. Pass cwd when you know the checkout.",
    "Wait for the tool result. It returns message, prompt, and context details after the story UI finishes.",
  ],
  parameters: Type.Object({
    args: Type.Optional(Type.String({ description: "Same target syntax as /diff, for example empty string, 'remote <url | branch>', or 'base..head'." })),
    cwd: Type.Optional(Type.String({ description: "Directory to run the story from. Defaults to the current working directory." })),
  }),
  needsTerminal: true,
};

const SUBMIT_PR_REVIEW: PiCoderToolDefinition = {
  name: "submit_pr_review",
  label: "submit-pr-review",
  description: "Submit a confirmed pull request review. Resume with attemptId; an intentional identical new review requires explicit newIntent. Never use newIntent to blindly retry an unknown write. Refuses self-approval and checks drift.",
  promptSnippet: "Submit a confirmed pull request review verdict through the matching configured provider.",
  promptGuidelines: [
    "Only call submit_pr_review after the user explicitly confirms the verdict and review text. The review UI confirmation also authorizes grammar, spelling, capitalization, punctuation, and meaning-preserving syntax corrections without another confirmation.",
    "Fix only grammar and English in the body and comment text; never change meaning, intent, tone, technical substance, or requested scope. Only changes that may cross those boundaries require exact approval before submission.",
    "Never approve a pull request the user authored; the tool blocks self-approval and you should not retry as approve.",
    "When a submission fails or its outcome is unknown, follow the recovery steps in the result: check the PR first, then finish posting the missing review, through the provider CLI if the tool keeps failing.",
    "Keep existing inline comments in the comments array for approve, request_changes, and comment verdicts.",
    "After a successful submission, report the PR link and short summary returned by the tool.",
    "Pass repo as owner/repo, the prNumber, the commitId (PR head SHA), and prAuthorLogin so self-approval can be blocked.",
    "Pass the provider ID from the reviewed target; configured capabilities determine live-head validation and submission behavior.",
    "Pass cwd to the local checkout of the repository so the provider CLI runs in the right place.",
  ],
  parameters: Type.Object({
    provider: Type.String({ description: "Configured pull request provider ID" }),
    repo: Type.String({ description: "Repository as owner/repo" }),
    prNumber: Type.String({ description: "Pull request number" }),
    commitId: Type.String({ description: "PR head commit SHA (headRefOid)" }),
    baseCommitId: Type.Optional(Type.String({ description: "PR base SHA retained for compatibility; normal base-branch movement does not block submission" })),
    verdict: Type.Union([
      Type.Literal("approve"),
      Type.Literal("request_changes"),
      Type.Literal("comment"),
    ], { description: "Review verdict" }),
    body: Type.Optional(Type.String({ description: "Overall review body text" })),
    comments: Type.Optional(Type.Array(Type.Object({
      path: Type.String(),
      line: Type.Optional(Type.Number()),
      side: Type.Optional(Type.Union([Type.Literal("LEFT"), Type.Literal("RIGHT")])),
      body: Type.String(),
      start_line: Type.Optional(Type.Number()),
      start_side: Type.Optional(Type.Union([Type.Literal("LEFT"), Type.Literal("RIGHT")])),
      subject_type: Type.Optional(Type.Literal("file")),
    }), { description: "Line review comments, plus file comments when supported by the configured provider" })),
    prAuthorLogin: Type.Optional(Type.String({ description: "PR author login, used to block self-approval" })),
    cwd: Type.Optional(Type.String({ description: "Local checkout directory for the configured provider command" })),
    attemptId: Type.Optional(Type.String({ description: "Saved confirmed submission attempt to resume" })),
    handoffId: Type.Optional(Type.String({ description: "Opaque saved raw grammar handoff; requires final text approval before submission" })),
    handoffCommentIndexes: Type.Optional(Type.Array(Type.Number({ description: "Original comment index, one unique index per final comment in final order" }))),
    newIntent: Type.Optional(Type.Boolean({ description: "Explicitly authorize an intentional identical new review, never an unknown-write retry" })),
  }),
  needsTerminal: false,
};

export const PI_CODER_TOOLS: readonly PiCoderToolDefinition[] = [OPEN_CODE, OPEN_CODE_DIFF, OPEN_CODE_DIFF_STORY, SUBMIT_PR_REVIEW];
