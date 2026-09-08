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

## Conversation retrieval

The default GitHub provider supplies `pullRequestDetails`, check fields, cursor-paginated review threads and nested comments, and REST pagination for PR comments and reviews. Context and Replies share in-flight reads for the opened target. Refresh starts a new generation even if the code head has not changed; load more continues the existing generation. A generation describes a fetch, not an atomic snapshot of remote activity. Supplied context is used without provider reads by default; explicit refresh or continuation requests fetch current data.

Default budgets are 12 requests, 30 seconds, and 2,000,000 accepted response bytes per load, with 8,000,000 bytes of retained reader state across continuations. Because `pi.exec` buffers output, these are acceptance budgets, not streaming, network-byte, or peak-memory caps. Budget exhaustion keeps partial data and a continuation where available. Unavailable resolution stays unknown, not unresolved or resolved.

Custom providers can configure `reviewCommentsPage`, `pullRequestCommentsPage`, and `pullRequestReviewsPage` operations with a `{page}` argument. Each paginated REST response must include an HTTP status/header block and JSON body; `Link` headers supply the next numeric page, never a host or command to execute. Existing operations remain supported but do not establish complete pagination without page metadata. The `graphqlReviewThreads` capability uses cursor connections with `pageInfo` for both threads and comments.

For REST code anchors, `commentSide` maps `RIGHT`/`LEFT` (or `added`/`deleted`) and `commentCommitId` identifies the comment's immutable head. Missing proof leaves code jumps unavailable. GitHub browser links prefer `html_url` over API `url`. Custom context sources can still implement `load()` with no arguments; shared reader metadata and incremental callbacks are optional.
