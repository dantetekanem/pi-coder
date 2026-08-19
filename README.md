# pi-coder

`pi-coder` adds two full-screen coding tools to [Pi](https://github.com/badlogic/pi-mono):

- `/diff` reviews local changes, commits, branches, ranges, and configured remote pull requests.
- `/code` browses and edits a workspace without leaving Pi.

It also keeps a compact repository summary in Pi's footer so you can see the current file count, additions, and deletions between reviews.

## Install

```bash
pi install https://github.com/dantetekanem/pi-coder
```

Restart Pi or run `/reload`.

## Review changes

Run `/diff` inside a repository:

```text
/diff
```

![Review changes with pi-coder](docs/assets/code.gif)

Useful targets:

```text
/diff                         # uncommitted changes
/diff main...HEAD             # a Git range
/diff remote <branch-or-url>  # a remote branch or configured pull request
/diff --resume                # a parked review
```

The review UI supports line, file, and review-wide feedback. Feedback can be marked as:

- `DISCUSS` — send the question back to the agent.
- `COMMENT` — keep review feedback for a local or remote review.
- `MODIFY` — propose or apply an exact code change.

Remote pull-request reviews use locally configured providers. Confirmed reviews receive a grammar-safety pass before submission, and saved drafts are revalidated when the reviewed revision changes.

Common review controls:

| Key | Action |
| --- | --- |
| Arrow keys | Navigate files and diff lines |
| `c` / `d` | Add a comment / discussion |
| `Enter` or `m` | Edit the selected line |
| `v` | Toggle unified and side-by-side views |
| `s` | Finish the review |
| `Esc` | Go back or close safely |

## Browse and edit code

Run:

```text
/code
```

![Browse and edit code with pi-coder](docs/assets/diff.gif)

The Workbench provides a Git-aware file explorer, exact whole-file editing, syntax highlighting, buffer search, revision-conflict detection, and Save / Discard / Cancel protection for dirty files. It never stages, commits, pushes, or changes Git refs.

Common Workbench controls:

| Key | Action |
| --- | --- |
| Arrow keys or `j` / `k` | Navigate files and source lines |
| `Enter` | Open a file or enter INSERT mode |
| `Tab` / `Shift+Tab` | Move between Explorer and Source |
| `/` | Find a file or search the current buffer |
| `n` / `N` | Move through buffer matches |
| `Ctrl+S` | Save |
| `Esc` | Leave INSERT, return to Explorer, or close safely |

See [docs/workbench.md](docs/workbench.md) for the full Workbench behavior and standalone runner.

## Agent tools

Agents can use the same interfaces through:

- `open_code` — open the Workbench at an optional file, range, or guided code story.
- `open_code_diff` — open `/diff` with an optional target and prepopulated comments.
- `submit_pr_review` — submit a confirmed configured-provider review.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
```

Build the standalone Workbench with `pnpm workbench:build`.

## Acknowledgments

Inspired by Mario Zechner's [pi-diff-review](https://github.com/badlogic/pi-diff-review), with thanks to [Rob Zolkos](https://github.com/robzolkos) for his contributing work on the review workflow.

## License

MIT
