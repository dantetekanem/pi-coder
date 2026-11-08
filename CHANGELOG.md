# Changelog

## 0.9.10 - 2026-11-08

### Fixed

- Declare Pi's host-provided packages as wildcard peer dependencies. Move Pi TUI and TypeBox out of runtime dependencies to resolve the extension warning about duplicate runtime modules, keeping them as development dependencies for local tooling.

## 0.9.9 - 2026-11-07

### Experimental

The standalone command, MCP server, and agent-tool surfaces ship here for testing only. They are not part of the supported 0.9.9 behavior and may change before 1.0. Expect them to be reworked.

- Run pi-coder without Pi. The `pi-coder` command opens the same review, diff story, and code workbench in any terminal: `pi-coder diff`, `pi-coder story`, and `pi-coder code` take the same targets as `/diff`, `/diff-story`, and `/code`. It shares settings, drafts, and submissions with the Pi extension, so a review parked in one resumes in the other.
- Hand feedback to any agent. When a review ends, the command prints the text Pi gives its agent: review feedback, DISCUSS notes, or a code discussion. `--json` prints one result object with the prompt, the tool details, follow-up messages, and notices.
- `pi-coder tool <name>` runs `open_code`, `open_code_diff`, `open_code_diff_story`, and `submit_pr_review` with the same JSON input and result as the Pi tools, so agents in other harnesses can reopen a discussed review and submit a confirmed one.
- Open the screen from an agent's shell. Without a terminal, pi-coder opens a new Herdr or tmux pane (or a configured terminal command), waits for the user, closes the pane, and prints the result. `--detach` returns a launch id, and `pi-coder wait <id>` collects the result later.
- `pi-coder mcp` serves the four tools over MCP, plus `pi_coder_wait`, for Claude Code, Codex, and other MCP clients.
- Configure model commands for the grammar pass, the story agent, and reply analysis outside Pi with `models` in `pi-coder-settings.json`. Without one, pi-coder runs `pi -p` when Pi is installed.
- A `pi-coder` skill tells agents in other harnesses how to open reviews, read feedback, continue a discussion, and submit a review.

### Added

- Configure how a pull request review fetches from a provider with an optional `fetch` block in its settings. `progress` passes `--progress` to `git fetch`, `timeoutSeconds` limits each attempt, and `retry` fetches again after a doubling delay when the git error contains a listed text, such as a busy server's request to retry later. Without the block, each fetch sequence makes one quiet attempt with a 60-second timeout, as before. An existing fallback can start a separate sequence.
- `Ctrl+?` opens a popup with every shortcut, in the review and in the diff story. `?` and `Ctrl+/` also open it, for terminals that send `Ctrl+?` as Backspace.
- In a diff story, `Option+Up/Down` scrolls the other pane without moving focus, `Option+PgUp/PgDn` pages it, and `Option+Shift+Up/Down` or `Option+Home/End` jump it to its top or bottom. `Home`/`End` jump the focused pane, in the review too.
- In a diff story, `i` opens the story info in a popup: the step, the pull request, totals, captured files, and every step.
- A diff story step without a changed test shows the existing tests of its code. pi-coder searches the reviewed revision, inside the code's package, for tests that name the changed code or changed code that calls it, in test files that mirror, sit beside, import, or name that code. Each file says why its tests match, and tests that this review changes are marked. When no test reaches the code, the pane says **No tests found for this code** and names what it searched, which marks the code as untested unless a test reaches it through files the change does not touch. A failed or timed-out search says it is a pi-coder gap. Steps that change only tests, remove code, or change files that do not run say so too.
- A diff story shows a **Steps** sidebar on the left. It lists every step, highlights the current one with a short note from the story agent, and points down to the steps that follow. It moves with `Shift+Left/Right`. For the notes, the story agent receives each unit's changed lines and writes a summary plus a title and note for each step. The sidebar is on by default. `1` hides it and saves the choice; while it is hidden, new stories skip the notes.

### Changed

- The diff story is task-first: each step puts the changed tests on the left and the code they exercise on the right, and the code pane has focus when the story opens, when it resumes, and on every new step. When a step's tests in one file pass 30 changed lines, they split across steps that repeat the same code. Saved stories keep their steps.
- The story header shows only the step title and its number. The review and the story footers are one line: `Shortcuts: c (Comment) - d (Discuss with Agent) - Ctrl+? (All Shortcuts)`, plus `i (Info)` in the story. The hint line inside the diff pane is gone.
- In a diff story, `Option` no longer moves the cursor onto unchanged lines; `C` still lets the arrows reach them. `Shift+Tab` now cycles the story panes backward, and `t` templates open only in the full diff.
- The story agent starts as `anthropic/claude-opus-5-5` with `low` thinking, instead of `openai-codex/gpt-5.6-luna` with `max`. A saved selection is kept.
- The Pi coding agent and Pi AI packages are optional peers. pi-coder uses them only inside Pi; Pi TUI is now a regular dependency.

### Fixed

- Stop a pinned review from fetching a second time from `urls.clone` after `origin` fails when both are the same URL and `origin` has no extra remote-specific settings. Keep direct clone fallback for distinct paths and transport overrides such as `remote.origin.proxy`.
- A diff story no longer pairs a helper method from a test file, such as a private method the tests call, with code as if it were a test. A helper follows the first test that calls it, and a split never leaves a helper on its own. A test pairs through the helpers it calls, quoted strings such as test names no longer count as code references, and a changed file named like the test file wins over name matches in other files.

## 0.9.8 - 2026-11-04

### Added

- Mark open PR threads on the diff lines they belong to. A remote review reads the threads in the background when it opens, even with PR context and Replies hidden. A `○` marks each line whose thread anchor matches the reviewed code, and the Navigator shows each file's count. Press `I` to show or hide the thread text under its line. The threads are read-only: they never join your draft, the Comments pane, the submission, or the agent prompt.
- A REST provider can map `commentDiffHunk` to each comment's diff hunk (`diff_hunk` in GitHub-shaped APIs), so a thread written on an older push still finds its line after the code moves. GitHub reviews read it through GraphQL without extra settings.

## 0.9.7 - 2026-11-03

### Changed

- Require matching Pi AI, coding-agent, and TUI releases at 0.79.10 or newer, with Node.js 22.19.0 or newer. The lockfile tests that minimum; newer hosts still need their own compatibility checks.

### Security

- Upgrade development tooling to Vitest 4.1.12 and Vite 7.3.7, removing the vulnerable mocker and Tinypool dependency paths.
- Refresh the locked Pi packages to 0.79.10 and compatible protobufjs, zod, and brace-expansion resolutions. Known upstream advisories remain; this does not update an installed Pi host or sandbox extensions.

### Fixed

- Show each line of a multi-line review comment on its own row in the Comments and Replies panes, instead of printing the line break as `\x0a`. A preview that stops early ends its last shown line with `…`.
- Ctrl+J adds a line break in the comment, modify, and thread response editors, like Shift+Enter. A plain line feed now adds a line break instead of saving a comment or closing a response editor.

## 0.9.6 - 2026-11-02

### Changed

- Remove the pull request lines above the review panes, so the panes start right below the top padding. The removed lines showed the repository and number, commit, state, review progress, title, description brief, and conversation status. The PR context pane still shows the brief and the conversation status.

## 0.9.5 - 2026-10-29

### Changed

- Keep each review on its requested comparison. Remove scope tabs, Alt+1/2/3 switching, and automatic last-commit and all-files loading from local reviews. Explicit ranges and pull requests remain supported.
- Fill the terminal without an outer frame, with two columns of side padding and a blank row at the top and below the footer.

### Fixed

- Preserve saved feedback from unavailable comparisons without remapping it, and keep comments with old file IDs visible.
- Keep mouse hit areas and text selection aligned with the review layout, including footer text.

## 0.9.4 - 2026-10-27

### Changed

- Settings, caches, and environment variables now use the pi-coder name: `~/.pi/agent/pi-coder-settings.json`, `~/.pi/agent/cache/pi-coder/`, and `PI_CODER_*` variables such as `PI_CODER_SETTINGS_PATH` and `PI_CODER_HERDR_FULLSCREEN`. Rename an existing settings file, cache folder, and variables to these names when you upgrade.
- List each changed test right after the file it tests in the `/diff` Navigator, such as `test/models/user_test.rb` after `app/models/user.rb`. The test joins that file's folder group in risk and a-z order. A test without a changed match keeps its place.
- Color each Navigator status letter. `A`, `M`, `D`, and `R` use soft versions of the theme's success, warning, error, and link colors, and the change counts match. File names keep the text color. Terminals without truecolor keep the theme colors.
- Show the file count and total line changes at the top of the Navigator, such as `7 files - +123/-321`, in place of the reviewed count and order hint. `O` still reports the new order.
- Give the Navigator 20% more width, inner padding, a blank line between folders, and aligned change counts. Long file names keep both ends, so `messages_mailer_test.rb` stays distinct from `messages_mailer.rb`.

### Fixed

- Fetch a pinned review's base and head branches again from the provider's `urls.clone` when the checkout's `origin` lacks them, serves an older head, or serves a base without `baseRefOid`. A checkout whose `origin` is a mirror or another host no longer fails the review while the provider has the right commits.
- Submit a review with `s` at any time, even when every comment is stale. A stale comment still posts on its lines when the diff shows them and they hold the code it was written on. Otherwise it posts as a file comment that names its original lines and quotes that code when known. Comments on files that left the review stay in the saved draft, and a local review with nothing else to send is not reported as approved.
- Anchor comments that agents prepopulate through `open_code_diff` to the reviewed code when the diff shows their lines, so they no longer start stale. A prepopulated MODIFY comment now carries the original lines and posts as a suggested change. When a parked review moves to a new pull request head, comments on unchanged files keep their anchors.
- Post reviews to a code host that is slow or busy. A review write now waits up to two minutes instead of 20 seconds. A write refused with HTTP 429 saved nothing, so it is sent again after its Retry-After delay, up to four times. If a confirmed review still fails or ends uncertain, pi-coder gives the agent the exact review, its attempt, the provider command, and the payload, with steps to check the PR before it posts what is missing. A refused self-approval tells the agent to post nothing.

## 0.9.3 - 2026-10-20

### Fixed

- Disable `gf` inside submodules with an explanatory message instead of opening a parent-repository URL for a child file. Links work again after returning to the parent review.

## 0.9.2 - 2026-10-20

### Added

- Select text with the mouse in `/diff` and `/diff-story`, and copy it when you release. A selection in a diff copies the exact source code, with tabs, and leaves out line numbers, `+`/`-` signs, and the other side of a side-by-side view. It continues across wrapped and truncated lines, and the diff scrolls while you drag past its edge. Double-click selects a word and triple-click a line. Drags in other panes copy that pane's text without its borders. Clicks, wheel scrolling, and keyboard controls work as before.
- Open the selected line on the code host with `gf`, at the reviewed pull request's exact commit. Search for a symbol's definition with `gd` after double-clicking it, or Ctrl+click the symbol. Both are off until their URL templates are set: `urls.file` on the provider and top-level `search`.

## 0.9.1 - 2026-09-27

### Added

- Show a short author-derived PR brief, title, and reviewed revision in remote `/diff`, `/diff-story`, and story preparation.
- Toggle the complete author description with `D` in PR context, preserving each view's scroll position. In stories, `4` opens context and `Esc` returns to the same step and selection.

### Changed

- Place the optional generated explanation above fetched PR facts under its own label, keeping the original description separate.

## 0.9.0 - 2026-09-24

### Added

- Let agents open `/diff-story` with the `open_code_diff_story` tool. It takes the same targets and `cwd` as `open_code_diff`, waits for the story to finish, and returns its feedback. It always opens the built-in story view and needs the terminal UI.

### Changed

- Skip non-English/non-pt-BR locale files in `/diff-story`, as the `/diff` file list does. Preparation shows how many files it hid. A change with only those files shows why no story was built instead of a capture error. `F` and then `L` still show them in the full diff.

### Fixed

- Count each untracked file and its text additions in the repository footer, including when Pi runs from a subdirectory. Hide incomplete line totals when Git cannot return complete counts.
- Show each changed line on exactly one `/diff-story` page. A story pane now shows only its step's lines of one file, plus a few unchanged lines of context. Code owned by another step stays collapsed, and each side of a replaced line appears only on the step that owns it. Movement stays inside the page; `F` still opens the full diff.
- Build fewer, fuller story steps. Changed lines outside a function join the nearest function in their file, and a file without functions becomes one step. Setup, helpers, and other unpaired tests join the step that owns the nearest paired test in their file; a test file without pairs gets one step. Related tests show one page per file.

## 0.8.0 - 2026-09-21

### Added

- Walk through local diffs, ranges, and pull requests with `/diff-story`, pairing implementation and changed tests in ordered steps. Changed units are prepared locally; one metadata-only model request orders them, while the extension supplies exact ranges, complete coverage, and unique test visits.
- Choose the story model and thinking level independently, follow generation progress, and resume paired panes, step marks, and saved feedback.
- Hold Option/Alt with movement keys to navigate unchanged source in `/diff` and `/diff-story`; add Shift to select a range for feedback.

### Fixed

- Preserve story progress and historical discussion records when accepted review feedback is consumed.
- Preserve syntax colors across selected, wrapped diff lines, with subtle added/removed backgrounds and per-hunk change counts.

## 0.7.0 - 2026-09-16

### Added

- Persist approved PR submission intents and per-step outcomes. Resume confirmed decisions without repeating grammar dialogs or replaying uncertain writes; reconcile only attributable, complete provider evidence.
- Keep failed grammar verification in a separate unconfirmed handoff, with trusted source bindings and explicit original comment indexes.
- Share confirmed-scope draft cleanup between UI and tool submissions, preserving edited/unsubmitted feedback and reporting local failures separately from remote acceptance.
- Give fresh reviews independent instance IDs, with explicit resume for existing and legacy drafts. Generation-checked saves reject stale overwrites; terminal tombstones prevent discarded or consumed instances from returning.
- Recover picker membership from valid snapshots after interrupted index writes, and check the snapshot's current timestamp before 30-day expiry.
- Save active editor compositions separately on a fixed two-second typing deadline. Explicit completion and editor parking flush before reporting success; failures keep the editor open. Recovery restores editable text and cursor, validates the original anchor, and requires an explicit decision before replacing conflicting feedback while preserving its current version as another recovery.

### Changed

- Pin all built-in GitHub review verdicts to the reviewed commit and submit approvals with inline comments atomically. Return typed submitted/partial/unknown/rejected evidence and shared diagnostic receipts.
- Keep completed COMMENT/DISCUSS pastes expanded for cursor recovery. Recovered buffers use the owned exact-text editor. Recovery storage has seven-day retention, 256 KiB per record and shared 64-record/16 MiB limits; capacity errors preserve existing text instead of truncating it.
- Require manual orphan-lock recovery with all writers stopped. Draft persistence covers local process interruption, not `fsync` or power-loss durability.

### Fixed

- Show fetched PR facts before optional model explanations, without replacing facts or moving the context pane's scroll position.
- Keep known PR facts visible when context sections fail, and label unavailable data instead of reporting an empty conversation.
- Preserve replies from unknown authors and distinguish unknown thread resolution from unresolved in PR context and Replies.
- Use consistent thread reads in PR context and Replies, label incomplete coverage, and avoid REST fallback for valid empty GraphQL results.
- Bound provider reads and show known PR facts while conversation sections are pending, preserving useful facts when limits or errors stop a read.
- Share pending PR context and Replies reads, preserve supplied context without provider calls, and let explicit refresh start a new conversation generation.
- Preserve admitted conversation checkpoints across interrupted reads and support bounded same-generation retries without accepting stale model updates.
- Page through PR review threads within read limits, resume admitted outer cursors, and keep usable GraphQL fragments when later data is unavailable.
- Read additional comment pages within review threads and resume each thread from admitted progress.
- Page through REST comments and reviews within shared read limits, honoring HTTP status and retaining interrupted progress without following supplied Link hosts.
- Refresh or resume PR conversation from either pane without losing review position, retaining usable data on failure and separating fetched coverage from preview limits.
- Inspect all fetched thread text beyond reply previews, retain missing refreshed threads with a warning, and analyze full threads read-only with safe multiline text.
- Navigate from a PR thread only to a verified current-revision code location, revealing unchanged lines and cancelling delayed jumps after later interaction.
- Edit per-thread response buffers within the open review window without submitting feedback, sending replies, or saving responses across close.

## 0.6.2 - 2026-09-02

### Changed

- Put `Start discussion with agents` first among remote review completion actions when discussion items are present.

## 0.6.1 - 2026-09-01

### Added

- Allow launchers to override Herdr fullscreen for one Pi process with `PI_CODER_HERDR_FULLSCREEN=on|off` without changing the saved preference.

## 0.6.0 - 2026-08-24

### Added

- Toggle persistent Herdr pane zoom with `/diff fullscreen on|off`.
- Use one configured code command for `/code`, `open_code`, `open_code_diff`, and review open-code actions.

## 0.5.0 - 2026-08-21

### Added

- Open `/code <repository-relative-path>` directly in whole-buffer INSERT mode, with equivalent `open_code.path` support for explicitly requested agent launches.

## 0.4.6 - 2026-08-19

### Changed

- Publish `pi-coder` as a public npm Pi package with gallery, repository, and install metadata for pi.dev.
- Declare Pi-provided runtime modules as peer dependencies while keeping third-party runtime packages self-contained.

## 0.4.5 - 2026-08-19

### Added

- Choose, autocomplete, and persist any bundled Shiki theme through `/code syntax`.
- Review GitHub pull requests through the authenticated `gh` CLI without provider configuration, while retaining local configuration for other code hosts.

### Fixed

- Expand Explorer ancestor folders when opening nested search results without disrupting normal file opens or Enter handling.

### Changed

- Remove the stale GitHub Actions workflow.

## 0.4.4 - 2026-08-19

### Changed

- Document `/review` alongside `/diff` and explain how `/code` keeps developers in a lightweight human-agent coding loop.

### Fixed

- Select the first changed row when opening a file whose diff begins with unchanged context.
- Keep the repository footer focused on `/diff` and avoid reporting a discard when no useful feedback was produced.

## 0.4.3 - 2026-08-19

### Fixed

- Show the `/diff` and `/code` demos in their correct README sections.

## 0.4.2 - 2026-08-19

### Added

- Use `/review` as an alias for `/diff`, surface both commands in the repository footer, and show `/diff` and `/code` demos in the README.

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
