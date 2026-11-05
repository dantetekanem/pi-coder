# Access and data handling

`pi-coder` runs inside Pi or as the `pi-coder` command, and operates on the repository selected by the user. Its access is limited to the configured commands and local paths described below. Both use the same agent directory: `PI_CODING_AGENT_DIR`, or `~/.pi/agent`.

## Subprocesses

- It runs `git` with fixed argument vectors to inspect local changes, revisions, and file lists. Remote review fetches run `git fetch` against the selected repository remote or configured provider clone URL.
- Remote pull-request support runs the provider executable configured in `~/.pi/agent/pi-coder-settings.json` (GitHub is available through authenticated `gh`). Provider operations are executable-plus-argument arrays, not shell commands.
- A configured `code.command` is run as direct argv. `$EDITOR` is run as direct argv when the review UI opens an external editor.
- Opening a URL starts the platform URL opener: `open` on macOS, `rundll32.exe url.dll,FileProtocolHandler` on Windows, or `xdg-open` elsewhere. Only credential-free `http` and `https` URLs are accepted.
- The standalone Workbench build invokes the package's local TypeScript compiler and its generated standalone entry point.
- Outside Pi, the grammar pass, the story agent, reply analysis, and the PR explanation run the model commands configured under `models` in `pi-coder-settings.json`, as direct argv. Without one, they run `pi -p` when `pi` is on the path. The prompt goes to the command's standard input.
- When the `pi-coder` command has no terminal, it opens a pane with `herdr pane split` and `herdr pane run`, with `tmux split-window`, or with the configured `terminal.command`. The pane runs `/bin/sh` on a script in the launch folder, so the arguments, the working directory, and the forwarded `PI_CODER_*` settings never pass through the pane's own shell. It checks that pane and the script's process while it waits, and closes only a Herdr pane it opened.
- Model commands run without a shell, in their own process group. pi-coder stops the group with `SIGTERM` on a timeout or cancel, then `SIGKILL` 5 seconds later, and kills any that still run when it exits.
- `pi-coder mcp` reads JSON-RPC requests from standard input and writes responses to standard output. It opens panes as above and runs `submit_pr_review` like the Pi tool.

## Filesystem access

- Local review and Workbench features read files inside the selected repository. The Workbench rejects paths outside that repository, follows no escaping symlinks, and limits text reads and writes.
- Workbench saves use a same-directory temporary file and lock file before an atomic rename. It can therefore create and remove temporary and lock files beside the edited file.
- Review preferences are read and written at `~/.pi/agent/extensions/code-diff-preferences.json`; comment shortcuts are read from `~/.pi/agent/extensions/code-diff.json`.
- Provider and code-command settings are read from `~/.pi/agent/pi-coder-settings.json`.
- Review sessions are read and written under `~/.pi/agent/cache/pi-coder/sessions/`, and submitted-review receipts under `~/.pi/agent/cache/pi-coder/receipts/`. Sessions include saved feedback and may include story plans, exact source-anchor hashes, and unsent comment text. Historical discussion records are preserved when resuming or consuming submitted feedback. Saved history follows normal session expiry/discard rules.
- Remote pull-request repositories are cached under `~/.pi/agent/cache/pi-coder/remotes/` unless the configured remote cache root overrides it.
- Standalone Workbench builds are staged and promoted under `~/.pi/agent/cache/pi-coder/workbench/`; the launcher is written atomically to `~/.pi/agent/bin/pi-code-workbench`.
- The `pi-coder` command keeps each pane launch under `~/.pi/agent/cache/pi-coder/launches/<id>/` (directories `0700`, files `0600`): the request, the tool input, the pane id, the launch script (`0700`), the child's process id, and the result. A result holds the same text and details the agent receives. A new launch removes launches older than seven days. `--output` and `--result-file` write the same result to the given file with mode `0600`.
- The `pi-coder` command compiles its TypeScript sources once and caches them under `~/.pi/agent/cache/pi-coder/jiti/` (`0700`). Without that folder it runs uncached.
- Review submission writes a mode-`0600` JSON payload under the operating system temporary directory as `pi-coder-review-*`, passes it to the provider command, and removes the directory afterward.

## Network access

Git remote fetches, configured provider commands such as `gh`, and the operating-system URL opener use the subprocesses above. Inside Pi, model-backed features make requests through Pi's configured model providers and authentication. Outside Pi, they make whatever requests the configured model commands make.

Starting `/diff-story` captures the selected before/after files locally. It skips non-English/non-pt-BR locale files, extracts changed code units, and pairs obvious related tests. One request sends unit identifiers, paths, symbols (including test names), local identifier-reference matches, proposed test pairs, and the bundled story instructions to the chosen model. The model returns ordering and pairing identifiers; exact ranges and hashes come from the local capture. While the step sidebar is on (the default), the request also sends each unit's changed lines, up to 60 per unit, and the model also returns a summary and a title and note for each step. Press `1` in a story to turn the sidebar and the notes off. Public output, progress, and errors appear in a five-line preparation strip.

Finishing a review hands saved DISCUSS notes and their source context to the main conversation through the normal review flow.

The story model/thinking preference is independent of the main conversation. Requests use Pi's public authentication APIs; credentials stay outside prompts and persisted transcripts. Preparation supports explicit cancellation and follows the provider's context, output, timeout, and retry policies. The story orders captured code for human review; approvals and provider comments require the normal deliberate end action.

## Release access

Publishing is staged only for a pushed `v*` Git tag whose name exactly matches `package.json`'s version. The GitHub Actions publish job has read-only repository contents permission plus `id-token: write` for npm provenance; it runs `npm stage publish` and does not use a repository write token. A maintainer must review and approve the staged release with 2FA before it becomes public.
