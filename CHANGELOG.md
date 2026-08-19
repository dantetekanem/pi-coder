# Changelog

## 0.4.1 - 2026-08-18

### Added

- Keep parked review comments aligned across pushes and rebases: unchanged files retain exact anchors, changed files are flagged for another look, and comments from removed files move into the review-wide note.
- Open a newest-first picker with `/diff --resume` and clean up parked reviews after 30 days without an update.
- Sort Navigator files by review risk from unresolved threads, blast radius, and change size; toggle risk and alphabetical order with `O`.
- Open pull requests and selected review replies in the browser without suspending the review UI.
- Track replies to review comments in a fifth read-only pane with refresh, browser-open, and opt-in analysis actions.
- Remember the last review verdict and ask explicitly whether to park or discard draft work when exiting.

### Fixed

- Validate agent-supplied pull request context against the live repository, number, provider, and head revision before using it.
- Save bounded local review receipts only after confirmed successful submissions and protect them with owner-only permissions on POSIX systems.

## 0.4.0 - 2026-08-13

### Added

- Review pull requests from additional locally configured providers through the existing `/diff remote` workflow.

## 0.3.6 - 2026-08-12

### Added

- Submitting a local review with `s` and no comments now sends `PR approved` straight to the agent instead of blocking the submit.

## 0.3.4 - 2026-08-10

### Added

- Toggle Navigator, Diff, Comments, and PR context with `1` through `4`, preserving pane visibility across reviews.
- Expand up to 10 hidden file lines above or below the selected diff line with `k` or `j` (`K` and `J` remain aliases).

### Changed

- Move review-scope shortcuts from `1` through `3` to `Alt+1` through `Alt+3`.
- Reserve Up/Down for diff-line navigation and use `k`/`j` for contextual expansion.
- Wrap footer status and shortcut descriptions onto additional lines instead of truncating later actions.

## 0.3.3 - 2026-08-07

### Added

- Allow `Post Comments` to publish inline feedback and an optional general review comment together.

### Changed

- Rename the remote review action from `Comment` to `Post Comments`.
- Leave mouse selection and copying to the terminal or tmux instead of enabling extension-owned mouse reporting.

## 0.3.2 - 2026-07-29

### Added

- Resume remote PR reviews after agent-only `DISCUSS` conversations while preserving reviewer-facing `COMMENT` and `MODIFY` items.
- Prepopulate confirmed discussion findings as editable comments without replacing existing feedback.
- Remove the selected Comments-panel item with `r`, while retaining `d` as an existing shortcut.

### Changed

- Scope agent discussion prompts to `DISCUSS` items and reject saved review sessions when the pull request head changes.
