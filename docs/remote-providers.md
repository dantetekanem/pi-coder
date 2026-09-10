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

## Thread coverage

PR context and mounted Replies follow outer GraphQL thread cursors in pages of 100, within the shared read limits. Each thread still includes at most its first 100 comments; further nested pages, missing metadata, malformed fragments, or repeated cursors keep coverage incomplete. Usable GraphQL fragments survive errors and missing nested comments. Only an unusable first GraphQL read uses configured REST fallback; later failures preserve admitted GraphQL pages. Legacy REST operations have unverified pagination and remain incomplete; their ID-less comments are still retained in PR context.

## Read limits and generations

The mounted context and Replies sources share one reader. Pending ordinary loads join a generation; settled live loads start fresh. Explicit refresh supersedes pending work, whose waiters follow the replacement. Supplied context remains unchanged and read-free until refresh; its fetch time and viewer identity are unknown. Final source updates carry target identity, generation, attempt, checkpoint time, and coverage for details, comments, reviews, threads, checks, and identity. The last admitted checkpoint survives later failures; returning it without new data preserves its timestamp. This is not an atomic provider snapshot.

Each live attempt defaults to 12 provider commands, 30 seconds, and 2 MB of accepted output. The 8 MB cumulative serialized-retention ledger spans all attempts in a generation; it does not reset on retry. Identity and fallback commands count; optional model explanation does not. Output accounting uses the UTF-8 size of decoded stdout and stderr returned by `pi.exec`, not raw wire bytes. The reader stops waiting at its deadline, requests cancellation, and rejects late or killed results. These are acceptance/publication limits, not transport-buffer, peak-memory, or process-tree termination guarantees.

Paired source APIs accept the exact metadata `continuation` object in their load options (the second argument for context). It retries collection in the same generation with a new attempt, preserving admitted data and reusing a known authenticated identity. Tokens are local to that reader; foreign, consumed, or refresh-invalidated tokens are rejected. Optional `budgets` overrides are validated and inherited by subsequent continuations, including explicit increases; a new generation uses defaults unless overridden. The next fallback checkpoint must fit before a retry starts, otherwise its token remains usable. Outer-page retries keep their admitted cursor and reuse known facts and identity before retrying other failed sections. Cursor and seen-page state are admitted with the raw threads, context projection, and reply previews before advancing. There are no new UI controls. Standalone sources retain fixed per-read limits and reject continuation and budget options; the standalone thread/Replies helpers still fetch one page.
