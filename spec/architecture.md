# Architecture and flows

Status and inspected revision: [draft index](README.md). Statements below describe the inspected implementation unless explicitly qualified.

## Hosts and shared orchestration

```text
Pi commands/tools -> Pi context/model adapters ----+
                                                  +-> engine -> Git/remote review -> review/story UI
CLI / tool / MCP -> terminal context/model gateway +          -> Workbench adapter -> shared core/UI -> Node file access
                                                             -> confirmed submission -> journal/provider/receipts
```

[`createPiCoderEngine`](../src/engine.ts) exposes `diff`, `diffStory`, `code`, `runTool`, and `shutdown`. [`host/engine.ts`](../src/host/engine.ts) defines their results. [`host/types.ts`](../src/host/types.ts) supplies `CommandRunner`, `HostApi`, `HostContext`, `HostUI`, and `ModelGateway`: the engine asks a host to run commands, mount components, notify, and reach a model. These interfaces still use pi-tui types; host independence does not mean zero Pi-family dependencies.

[`src/index.ts`](../src/index.ts) registers `/diff` (`/review` alias), `/diff-story`, `/code`, and the four agent tools. [`pi/context.ts`](../src/pi/context.ts) adapts the context and lazily supplies models. Commands put completed feedback into Pi's editor; tools return text and details. Pi event hooks refresh the footer after relevant repository tools and stop engine/status work on shutdown.

[`bin/pi-coder.mjs`](../bin/pi-coder.mjs) checks Node compatibility and loads the standalone entry through jiti. [`cli/main.ts`](../src/cli/main.ts) constructs the same engine with terminal services, validates tool input, and packages results as text or JSON containing prompts, messages, notices, and details. Interactive work needs a TTY: automatic selection uses the current terminal, then Herdr, tmux, or a configured terminal command. Headless submission needs no screen. MCP is another transport for these tools, not another review engine. See [CLI](../docs/cli.md) and [harnesses](../docs/harnesses.md).

The shared [`host/runtime.ts`](../src/host/runtime.ts) hooks supply agent-directory lookup, clipboard, and highlighting. Pi configures them at registration; the terminal host configures its own services. This mutable process-level configuration is not a per-workspace dependency container.

## Reviewing local and remote changes

1. The engine parses a local working-tree target, explicit range, resume request, or remote target. [`git.ts`](../src/git.ts), especially `getReviewWindowData`, `getReviewWindowDataForRevisionRange`, and `loadReviewFileContents`, separates file metadata from content loading. Local review includes tracked and untracked changes; a three-dot range resolves a merge base. Workspace/pathspec filtering limits discovery unless whole-repository mode is selected.
2. [`remote.ts`](../src/remote.ts), through `resolveRemoteReviewTarget`, resolves repository/provider settings, obtains metadata and fetches comparison refs. Supplied PR handoffs must match the target and do not eliminate fetch/head verification. Ordinary remote resolution has a short-lived in-process cache; discussion continuation bypasses it.
3. `openReviewData` in the engine builds target/revision identity, session context and loaders, mounts review UI, and connects PR context/replies. Review invocation coordination and an active-review check reject overlapping review sessions within the engine. This is not a repository-wide lock against other processes.
4. The person records line, file, or review-wide feedback with DISCUSS, COMMENT, or MODIFY intent. Completion can park feedback, hand it to the agent, start a remote discussion, or enter the deliberate remote submission flow. A discussion handoff does not post author-facing notes. Configured-provider read coverage and uncertainty are specified in the [provider guide](../docs/remote-providers.md).

## Diff stories

The engine uses the same captured comparison for a story and its full-diff view. [`diff-story/generate.ts`](../src/diff-story/generate.ts) extracts local units and initial code/test pairs, then asks a model to order prepared identifiers and adjust pairings. With notes enabled it also sends bounded changed-line excerpts and requests titles, notes, and a summary. Model prose is sanitized; local code owns ranges, hashes, omitted-unit inclusion, and plan validation. The model does not supply arbitrary file ranges.

The story UI shows tests beside implementation, with step navigation and optional notes/sidebar. Existing-test discovery is a static search, not execution or a guarantee of test coverage. Preparation supports cancellation; a failed or stale plan is not silently accepted. See the [README story workflow](../README.md#follow-a-diff-story) for recovery and display behavior.

## Workbench and editing

`runCode` in the engine first checks for a configured `code.command`. That command uses direct argv and optional target arguments; it replaces `/code`, `open_code`, and `open_code_diff` behavior. `open_code_diff_story` retains the built-in story flow. Code stories require the built-in Workbench.

Without an override, [`adapters/pi/index.ts`](../src/adapters/pi/index.ts) starts the shared Workbench, opens an optional target, mounts its component, and disposes it after completion. [`workbench/app.ts`](../src/workbench/app.ts) owns buffer/revision state, dirty decisions, selection, and saved paths. [`workbench/contracts.ts`](../src/workbench/contracts.ts) defines repository and completion interfaces; hosts handle terminal lifecycle rather than duplicating buffer logic.

[`node/workspace.ts`](../src/workbench/node/workspace.ts) canonicalizes the root and assembles file listing, file access and lazy Shiki highlighting. A valid bounded Git listing is preferred; ordinary Git failure falls back to bounded filesystem discovery. Cancellation or unconfirmed child closure does not trigger that fallback. The current default read/write cap is **2 MiB**, not the older guide's 256 KiB. Source contents are read on selection rather than indexed eagerly.

[`node/repository.ts`](../src/workbench/node/repository.ts) checks canonical path containment and regular UTF-8 files. Reads capture a byte hash. Saves acquire an exclusive per-target lock, compare the expected revision, write and sync a same-directory temporary file, recheck, then rename. A conflict keeps the buffer dirty. A committed save with lock-cleanup failure reports success plus a warning; it must not be treated as an uncommitted write. Locks coordinate cooperating writers, not arbitrary editors, hostile directory changes, or every filesystem's semantics.

Switching files or closing with edits requires Save/Discard/Cancel. Failed saves preserve the pending decision; `dispose` refuses a dirty buffer. Completion reports changed paths or a lifecycle failure. Saving changes working-tree bytes, not Git staging or refs. The Workbench is a bounded source editor, not an LSP/IDE.

## Persistence and failure ownership

The default agent directory is `PI_CODING_AGENT_DIR` or `~/.pi/agent`. Settings, preferences, drafts, compositions, submissions, receipts and remote caches are local files, not a database service. Exact locations and subprocess access are in the [access inventory](../docs/access.md).

The engine creates a fresh review instance unless explicitly resuming. [`review-session.ts`](../src/review-session.ts), `saveReviewSessionWithStatus`, compares generations while holding the session-store lock, then atomically replaces the snapshot and separately updates the picker index. An index failure can coexist with a durable snapshot. Conflicts retain the attempted text and notify instead of overwriting another writer. Unfinished editor compositions are recoverable independently of committed feedback; recovery never submits them.

[`review-submit.ts`](../src/review-submit.ts), `submitPullRequestReview`, captures input before awaiting preflight, checks reviewer identity and the live target, and stores a confirmed intent before provider writes. Each step becomes uncertain before execution. Submitted steps are not replayed; unknown steps require attributable reconciliation evidence. Provider acceptance, journal/receipt persistence and draft consumption are separate outcomes. Cleanup consumes only confirmed matching draft scope. A timeout or local persistence failure does not prove that the remote write failed. The UI confirms the action; direct tool callers must already have approval. The tool is not an independent user-consent mechanism.

## Presentation and authority boundaries

[`workbench/ui/component.ts`](../src/workbench/ui/component.ts) uses semantic theme colors, an accent outer frame, focused-pane borders, EXPLORER/SOURCE panes, NORMAL/INSERT modes, and a compact resize screen below its two-pane allocation. Pi maps its active theme into the component. Syntax themes are selected separately through `/code syntax`; invalid highlighting falls back to sanitized source rather than changing buffer bytes. Review/story controls and precise key bindings remain in the existing guides.

Repository paths, terminal text, remote metadata and model output cross distinct validation boundaries. File containment and sanitization reduce particular risks; they do not sandbox the process. Configured provider, code, model and terminal commands execute with the host user's permissions and are trusted configuration. Remote fetches, provider writes and model requests can leave the machine. Stories can send source excerpts; DISCUSS can send selected context to the owning agent. The [access guide](../docs/access.md) describes those data paths, not permission to use them automatically.
