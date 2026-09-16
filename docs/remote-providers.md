# Remote providers

GitHub pull requests work through the authenticated [`gh`](https://cli.github.com/) CLI without extra provider configuration:

```text
/diff remote https://github.com/owner/repository/pull/123
```

Run `gh auth login` first.

Add other providers in `~/.pi/agent/pi-code-diff-settings.json`. Local settings extend the built-in GitHub provider; a local `providers.github` entry explicitly overrides it. Provider operations are executable-plus-argument arrays, never shell commands. Template values such as `{repo}`, `{number}`, `{branch}`, and `{payloadPath}` are passed as individual arguments.

```json
{
  "version": 1,
  "providers": {
    "secondary": {
      "label": "Secondary code host",
      "executable": "forge",
      "urls": {
        "patterns": [
          { "host": "code.example", "path": "/{repo}/change/{number}" }
        ],
        "canonical": "https://code.example/{repo}/change/{number}",
        "clone": "https://code.example/{repo}.git"
      },
      "operations": {
        "pullRequest": { "args": ["change", "show", "{repo}", "{number}"] },
        "reviews": { "args": ["change", "reviews", "{repo}", "{number}"] },
        "branchLookup": { "args": ["change", "list", "{repo}", "--head", "{branch}"] },
        "identity": { "args": ["identity", "--json"] },
        "submitReview": { "args": ["change", "review", "{repo}", "{number}", "--input", "{payloadPath}"] }
      },
      "refs": {
        "head": "refs/changes/{number}/head"
      },
      "fields": {
        "number": "id",
        "title": "subject",
        "body": "description",
        "additions": "metrics.added",
        "deletions": "metrics.removed",
        "changedFiles": "metrics.files",
        "author": ["actor.handle", "user.handle"],
        "state": "phase",
        "reviewState": "decision",
        "headRefName": "source.name",
        "headRefOid": "source.oid",
        "baseRefName": "target.name",
        "identityLogin": "login",
        "submissionId": "id",
        "submissionState": "state"
      },
      "capabilities": {
        "atomicReview": true,
        "baseRevisionRequired": false,
        "fileComments": false,
        "requestChangesBodyRequired": false,
        "validateSubmitResponse": true,
        "validateTargetBeforeSubmit": true
      }
    }
  },
  "repositories": {
    "owner/repository": {
      "cwd": "/absolute/path/to/checkout",
      "subdir": "packages/app",
      "pathspecs": ["packages/app", "shared/ui"],
      "importAliases": { "@shared": "shared/ui" }
    }
  }
}
```

`pullRequest` must return JSON addressable through the configured `fields`. `reviews`, `branchLookup`, reply operations, and repository profiles are optional. `submitReview` receives the generated review payload through `{payloadPath}`. Set `baseRevisionRequired` only when the provider returns and pins `baseRefOid`.

## Submission evidence

The submission service returns `submitted`, `partial`, `unknown`, or `rejected`, with each provider step's remote review ID and body/comment-index scope. `ok` is true only for `submitted`. A partial result may contain an unknown step; inspect each step before deciding what remains.

A successful response must contain a usable `submissionId` and a matching `submissionState`: `APPROVED`, `CHANGES_REQUESTED`, or `COMMENTED` for the requested verdict. A zero exit code, including with `validateSubmitResponse: false`, cannot substitute for this evidence. Pending reviews, malformed responses, unexpected states, timeouts, and ambiguous command failures remain unknown.

Optional field mappings are `submissionCommitId`, `submissionUrl`, and `submissionAuthor`. A returned commit must match the reviewed commit. Review links must share the configured target's origin and contain no credentials. GitHub maps these fields to `commit_id`, `html_url`, and `user.login`, and requests HTTP headers so explicit permission/validation rejection can be distinguished from uncertain transport failures. Its [create-review API](https://docs.github.com/en/rest/pulls/reviews#create-a-review-for-a-pull-request) returns a review ID; that ID is not an individual inline-comment ID.

An `identity` operation is required before creating a submission intent for any verdict. A usable `identityId` captures a stable actor ID; otherwise the journal explicitly records login identity. A response that supplies actor evidence must agree with the captured reviewer. A rejection-shaped response that also returns a possible review ID remains unknown rather than authorizing another create operation.

Both the UI and `submit_pr_review` use the same receipt writer. Receipts record confirmed steps only; a failed approval cannot be recorded as an approval. They keep remote review IDs, body hashes and bounded snippets, with `commentsTotal` and `commentsTruncated` qualifying the 200-comment diagnostic limit. A local receipt-write failure is reported separately and never changes confirmed remote acceptance into a reason to repost. The result keeps the reviewed commit separate from the current PR head; later head movement is not covered by that review.

The shared service also returns `draftConsumption`. Cleanup uses the intent's saved stable IDs and full source fingerprints, not receipt snippets or current UI indexes. Only submitted step scope is eligible; edits, new IDs and unsubmitted feedback remain. Draft cleanup failure leaves the remote outcome unchanged. If confirmed response evidence could not be saved in the journal, drafts are retained rather than consumed from transient evidence.

## Confirmed submission intents

Before a provider write, the service stores the approved input, reviewer, provider contract, exact target, reviewed commit and step plan under a unique attempt ID. It copies caller data before awaiting preflight. Each step is recorded as uncertain before the command starts, then updated with the observed result under a generation check. A competing or stale caller cannot admit the same step again.

Completed steps are retained. Retries can resume pending or known-rejected steps after checking the reviewer and current head. Unknown steps cannot be automatically reposted. An identical later review may belong to a different client or intent, even when actor, commit, text and timing match. It cannot discharge this attempt without attribution. Intent records distinguish IDs returned by their own write from unrelated search results; receipts are bounded diagnostics, not matching authority.

Use `attemptId` to resume a confirmed decision. Set `newIntent: true` only after explicitly approving an intentionally new review, not to bypass an unknown result. The UI resumes saved final input without repeating verdict or grammar dialogs while an attempt is incomplete or exact accepted feedback still awaits cleanup. Once that scope is settled, retained unsubmitted feedback regains review and discussion actions; an already-bound raw handoff does not intercept those choices.

A grammar-error fallback saves a separate, **unconfirmed** handoff in the same journal. Resuming it continues the agent's grammar and approval flow; it does not submit raw text. The tool receives only an opaque `handoffId` and `handoffCommentIndexes`, one original zero-based index per final comment. Keep those indexes when omitting or reordering comments. The service checks the captured target, revision, execution directory, provider contract and comment locations before binding approved text to an intent. It obtains draft IDs from the saved context, never tool-supplied deletion metadata. A different handoff that collides with an existing intent requires an explicit choice to resume that attempt or create a new one.

Recovery uses only a review ID returned by this step's own write. The scoped review and complete original-comment scope must match the captured actor, commit, verdict and wire payload; uncertain or remapped anchors remain unknown. The read adapter allows at most 12 requests, 30 seconds and 2 MiB of accepted stdout/stderr per recovery. These are buffered acceptance budgets, not transport-memory or process-shutdown guarantees. No-ID searches and partial matches cannot authorize replay.

The result exposes `attemptId` and separate `journalStatus`. If the server accepted the review but its local journal update failed, the result retains that remote evidence and warns against reposting. A repeated completed intent reports its previous acceptance without inventing a new posting time. Client admission and observation timestamps do not establish when the server finished processing an uncertain request.

The journal is stored in `~/.pi/agent/cache/pi-code-diff/submissions` (override with `PI_CODE_DIFF_SUBMISSIONS_DIR`). Attempts and unconfirmed handoffs share a limit of 1,024 records, 4 MiB per record and 64 MiB of retained data including atomic replacement. Capacity and corruption failures preserve existing records; they do not truncate or evict intents. Do not delete an uncertain record to force a retry. The local filesystem mutex uses the draft store's manual-only lock recovery: stop all writers before recovery. Atomic replacement covers process interruption, not power loss, shared filesystems or older writers that bypass the mutex. These storage bounds are not peak-memory guarantees.
