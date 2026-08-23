# Experimental code workbench

`/code` opens the full-screen, two-pane **EXPLORER** / **SOURCE** workbench by default. Set `"code": "ttt-tmux"` to open TTT in a new tmux pane instead. The Workbench browses and edits a filesystem workspace whether or not that workspace is a Git repository. When Git is available, `/code` prefers Git-aware file discovery; Git absence or ordinary Git failure never blocks the workbench. Pass one normalized repository-relative path, such as `/code app/models/user.rb`, to open that file at line 1 already in INSERT mode. Quote a path that contains spaces. `/diff` is the only review slash command; `/code-diff` does not exist. The agent tool `open_code_diff` remains available for diff review and is unrelated to `/code`; the separate `open_code` tool opens this workbench.

The same core and component are used by Pi and the standalone application. It is not an IDE: there is no LSP, external editor, semantic symbol index, staging, commit, push, or eager workspace content/index loading. The agent-facing `open_code` tool accepts `cwd`, an optional repository-relative `path` that starts in INSERT mode, an optional structured target (`path`, line range, and anchor hash), and ordered code stories. The direct `path` and structured `target` are mutually exclusive; these are tool inputs, not a documentation skill.

## Build and run outside Pi

Requirements: Node **>=22.19.0** and an interactive TTY. The package installation supplies the dependencies used by the standalone build; Git is optional. Build the standalone runtime before starting it:

```bash
pnpm workbench:build
pnpm workbench:start /optional/workspace/path
pnpm workbench:start --help
```

Omit the path to use `process.cwd()`. The build stages and atomically promotes the runtime under `~/.pi/agent/cache/pi-code-diff/workbench/` and installs `~/.pi/agent/bin/pi-code-workbench`; it never writes `.workbench-dist/`, `dist/`, `build/`, or cache output into this checkout or an opened workspace. `pnpm workbench:start` invokes that global launcher. The standalone also accepts `--cwd`, structured `--path`/`--line` targeting, an optional `--end-line`/`--anchor-sha256`, and repeatable `--story-json`; run `pi-code-workbench --help` for the exact grammar.

## Explorer and source

The EXPLORER is a metadata-only folder tree. Its root is open by default; every other folder starts collapsed. Folders appear before files. Each folder initially shows at most 20 immediate files and then a `show more` row; each activation reveals one additional 20-file page for that folder only. Reopening never materializes more than 40 ordinary files per folder, and a remembered selected file beyond that window is added as one targeted row instead of revealing all of its siblings. Expanded folders, bounded reveal counts, the selected row, and its viewport position are remembered per canonical workspace in process memory. No state file is written: reopening `/code` in the same Pi process restores the tree, while a Pi restart or separate standalone invocation starts fresh.

- `↑`/`↓` or `j`/`k` in NORMAL — move through Explorer rows or source lines.
- `Enter` — toggle the selected folder, reveal `show more`, or open the selected file.
- `l`/`Right` — expand a folder.
- `h`/`Left` — collapse an expanded folder, or move to its parent.
- `Enter` in EXPLORER — open the selected file and focus SOURCE; `Esc` in NORMAL SOURCE returns to EXPLORER without closing `/code`.
- `Tab` / `Shift+Tab` in NORMAL — toggle focus between EXPLORER and SOURCE when a file is open.
- `Enter` in SOURCE — enter whole-file INSERT at the end of the selected logical line.
- Arrow keys in INSERT — move the cursor across logical and visually wrapped rows; hold `Shift` to extend an exact selection.
- `Option/Alt+Left` / `Option/Alt+Right` in INSERT — when the terminal forwards canonical modified-arrow keys, move across code-word boundaries; add `Shift` to extend the selection by words.
- `Home` (or `Ctrl+A`) / `End` in INSERT — move to the start / end of the logical line; `Shift+Home` / `Shift+End` extend the selection.
- `Command+A` in INSERT — select the complete buffer.
- `Command+C` / `Command+X` — copy / cut the selection. Pi uses its system clipboard helper; standalone emits OSC 52. `Ctrl+Shift+C` and `Ctrl+X` are in-app fallbacks.
- `Command+V` / `Ctrl+V` — paste the last in-workbench copy; the terminal's native paste shortcut continues to accept external bracketed paste. Either form replaces the active selection exactly.
- `Enter` in INSERT — replace the selection, if any, with a newline using the surrounding file's line-ending form.
- `Tab` in INSERT — replace the selection, if any, with a literal tab; it is not a pane shortcut.
- `Ctrl+Z` in INSERT — undo the latest bounded editor operation and restore its prior cursor/selection.
- `Esc` in INSERT — return to NORMAL while keeping the complete edited buffer.
- `Ctrl+S` — save the complete selected buffer and remain in INSERT when editing.

Opening a file defers its read until selection. INSERT edits the exact full buffer: existing mixed line endings, literal tabs, trailing newlines, and untouched bytes are retained. Newlines and multiline paste are supported; wrapping is visual only and never changes file bytes. An edit is dirty until saved. Saving uses the revision captured at read time: a changed-on-disk revision reports a conflict and leaves the buffer open. Switching files or exiting with a dirty buffer asks **Save / Discard / Cancel** (`s`/`d`/`c`); Cancel keeps the buffer. Saving updates the working-tree file, so Git and `/diff` see the change, but `/code` never stages it or mutates the Git index or refs.

The Node adapter serializes cooperating saves to one canonical target with an exclusively created `.pi-workbench-<sha256>.lock` beside the file. Same-directory temporary names use the same bounded internal prefix rather than copying the target basename. Workspace discovery excludes untracked `.pi-workbench-*` save artifacts, so another workbench cannot open a live lock or temporary file; a tracked Git file using that shape remains visible. A concurrent saver fails immediately with a retry message; locks are never stolen automatically. If a process crashes, remove a stale lock manually only after confirming no workbench is saving that file. If bytes were committed but lock cleanup failed, the buffer becomes clean at the returned revision and the UI keeps the cleanup warning visible. This is cooperative serialization, not an OS compare-and-swap against arbitrary editors or tools.

## Contextual search

`/` depends on focus:

- In EXPLORER, it fuzzy-searches workspace file paths at query time. Results are cached for rendering and capped at 200; `Enter` opens the selected file.
- In SOURCE, it literally searches the raw current buffer. ASCII smart-case applies: all-lowercase queries ignore case, while an uppercase character makes the query case-sensitive. It records the first occurrence on each matching line, caps matches at 10,000, and `Enter` jumps to the first match. Matches render in bright yellow, with inverse focus on the current match; `n`/`N` wrap forward/backward through them.

`Esc` leaves INSERT, cancels the current prompt, moves from SOURCE to EXPLORER, or closes from EXPLORER through the safe dirty-buffer flow.

## Rendering and safety boundaries

For a selected supported source file only, the Node host lazily loads Shiki **3.23** and renders its tokens with the `github-dark` theme as terminal-safe ANSI. The highlighter and loaded grammars are cached, but source output is not precomputed or indexed. Every exact renderer result is accepted atomically only when its line count, visible sanitized text, and conservative Shiki SGR sequences match the authoritative buffer; otherwise the entire result falls back to sanitized plain source. INSERT keeps validated styles visible around the inverse cursor. Editor changes are derived from validated ordered deltas, then project the prior palette only across the affected complete-line envelope. A 16,384-slot preflight caps style-map allocation: an over-budget affected envelope becomes exact plain text while untouched lines keep their colors. This budget and affected-envelope locality apply only to newly introduced highlight style-map parse/allocation/render work; they do not make total editing O(delta): immutable source-string reconstruction, `WorkbenchBufferEditor.reindexLines()` full line indexing, and `Workbench` source/plain/highlight line-array copy/splice remain proportional to buffer size or line count. Buffers up to 64 KiB receive an exact debounced Shiki refresh after 100 ms idle; larger buffers avoid idle full-file tokenization. A successful save always refreshes the exact current buffer.

Workspace listing is NUL-delimited and path-contained. A valid bounded Git listing is preferred; any ordinary Git listing failure falls back to deterministic, abortable, symlink-skipping filesystem traversal with bounded directory, file, and output limits. Caller cancellation and unconfirmed child closure still take precedence over fallback. During `Workbench.start()`, the core parses the metadata, builds the workspace tree, and warms its initial visible rows before either host mounts the component. The first and later renders only synchronize the prebuilt tree by object identity and format viewport rows; they do not iterate repository file metadata. Source reads remain deferred, bounded to 256 KiB, and revision-aware; expanded tree row derivation follows the visible rows. The shared `src/workbench/**` core does not import Pi runtime APIs; Pi mounts the same component in its full-screen overlay, while the standalone host owns terminal lifecycle. The workbench uses the same accent-colored outer frame, focused-pane boxes, and inset spacing as `/diff`; inside Pi those surfaces use the active Pi theme, including its configured pink accent. Below the 40-column × 12-row two-pane allocation, the shared component renders a bounded resize/close screen instead of drawing past the Pi or standalone viewport. Hosts must settle active work, preserve dirty Save/Discard/Cancel handling, and dispose only after a safe completion.

## Benchmark

Run the dedicated, machine-local benchmark:

```bash
pnpm workbench:bench
# Optional 1M-path smoke scale:
WORKBENCH_BENCH_FILES=1000000 pnpm workbench:bench
```

Vitest reports mean, p75, and p99 milliseconds. It is not a cross-machine performance gate. The 1M option is memory-safe in local verification. Its extra cold-reveal pool is intentionally omitted to avoid duplicating million-path metadata; reveal itself renders only one bounded page.

Known scaling limits are deliberate: startup tree construction is O(path segments), first folder sorting is O(k log k), each reveal adds at most 20 rows, preferred-file restoration adds at most one targeted row, explicit fuzzy search is O(files), and expanded-row derivation scales with bounded visible rows. Save locks depend on reliable exclusive creation on the local filesystem; non-cooperating writers, hostile directory churn, network-filesystem lock semantics, and crash-stale locks remain outside the strict guarantee.

## Future host adapter contract

A host supplies a workspace `cwd`, maps only the semantic `WorkbenchTheme` colors, and provides `WorkbenchRepository` (or `createNodeWorkspace(cwd)`). The Node workspace exposes its canonical root as an opaque `workspaceKey`; hosts may obtain an optional `ExplorerStateSession` from the bounded process store and pass it to `createWorkbenchComponent`. The host starts the core before mounting the component and treats completion as authoritative: normal closure returns `{ status: "closed", changedPaths }`; lifecycle failure returns `{ status: "failed", message, code? }`. Escape, SIGINT, and SIGTERM must request the same safe close flow. Pi reports failures after cleanup; standalone rejects after cleanup.
