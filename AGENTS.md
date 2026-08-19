# AGENTS.md

## Project overview

`pi-coder` is a local Pi coding-agent extension that adds the `/diff` terminal review UI and `/code` full-screen workbench. `/diff` is the only review slash command; `/code-diff` does not exist. The `open_code_diff` agent tool remains a diff-review tool, unrelated to `/code`. It lets users review diffs, annotate lines/files/whole changes, browse and edit repository files, and insert follow-up prompts back into Pi.

The package is local-only for Leo and is loaded by Pi from `./src/index.ts`.

## Git guidance

Use Conventional Commits for commit messages, for example `feat: add shortcut customization`, `fix: handle empty diffs`, or `docs: update install instructions`.

