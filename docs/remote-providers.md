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

Optional `reviewCommentsPage`, `pullRequestCommentsPage`, and `pullRequestReviewsPage` operations receive `{repo}`, `{number}`, and `{page}`. GitHub uses `gh api --include` with 100 rows per page. Each response must include a successful HTTP status and JSON rows (or the configured collection field). Only an advancing numeric `page` from a valid `Link` next relation is reused; supplied hosts and paths are never followed. No Link header means the last page; malformed or unsupported links stop with partial coverage. Admitted REST pages can resume within the shared limits. ID-less rows remain visible in PR context but keep thread coverage partial. REST fallback after failed GraphQL remains incomplete because flat comments cannot recover thread resolution.

## Thread coverage

PR context and mounted Replies follow outer GraphQL thread cursors, then each thread's comment cursors, in pages of 100 within the shared read limits. Coverage is complete only when both levels report reliable terminal metadata. Missing metadata or malformed fragments remain incomplete and retryable; repeated cursors stop that connection with incomplete coverage. Usable GraphQL fragments survive errors and missing nested comments. Only an unusable first GraphQL read uses configured REST fallback; later failures preserve admitted GraphQL pages. Legacy REST operations have unverified pagination and remain incomplete; their ID-less comments are still retained in PR context. The read-only Replies `threadData` getter exposes admitted raw threads with their exact metadata object, even when viewer identity is unavailable; reading it or switching views does not fetch again. Press `t` for personal replies/all fetched threads, `Enter` for full comment text, and `o` for a browser link. Arrows, paging, and `gg`/`G` scroll without moving code; `Esc` returns. Refresh updates an open thread; if absent from new data, its previous copy remains with a warning. `A` uses the full fetched thread up to 24,000 characters, never posts, and preserves safe multiline output. Full text escapes terminal controls without decoding literal escape strings. Sources without raw threads retain the browser behavior on Enter.

## Read limits and generations

The mounted context and Replies sources share one reader. Pending ordinary loads join a generation; settled live loads start fresh. Explicit refresh supersedes pending work, whose waiters follow the replacement. Supplied context remains unchanged and read-free until refresh; its fetch time and viewer identity are unknown. Final source updates carry target identity, generation, attempt, checkpoint time, and coverage for details, comments, reviews, threads, checks, and identity. The last admitted checkpoint survives later failures; returning it without new data preserves its timestamp. This is not an atomic provider snapshot.

Each live attempt defaults to 12 provider commands, 30 seconds, and 2 MB of accepted output. The 8 MB cumulative serialized-retention ledger spans all attempts in a generation; it does not reset on retry. Identity and fallback commands count; optional model explanation does not. Output accounting uses the UTF-8 size of decoded stdout and stderr returned by `pi.exec`, not raw wire bytes. The reader stops waiting at its deadline, requests cancellation, and rejects late or killed results. These are acceptance/publication limits, not transport-buffer, peak-memory, or process-tree termination guarantees.

Paired source APIs accept the exact metadata `continuation` object in their load options (the second argument for context). It retries collection in the same generation with a new attempt, preserving admitted data and reusing a known authenticated identity. Tokens are local to that reader; foreign, consumed, or refresh-invalidated tokens are rejected. Optional `budgets` overrides are validated and inherited by subsequent continuations, including explicit increases; a new generation uses defaults unless overridden. The next fallback checkpoint must fit before a retry starts, otherwise its token remains usable. Page retries keep admitted GraphQL cursors or REST page numbers and reuse known facts and identity before retrying other failed sections. Page state is admitted with raw rows, context projection, and reply previews before advancing. PR panes use `r` to refresh and `m` to resume. Paired sources share the same `conversation` object; the read-only Replies `current` getter exposes the current settled snapshot without starting a read. Standalone sources retain fixed per-read limits and reject continuation and budget options; the standalone thread/Replies helpers still fetch one page.
