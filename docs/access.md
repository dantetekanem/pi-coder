# Access and data handling

`pi-coder` runs inside Pi and operates on the repository selected by the user. Its access is limited to the configured commands and local paths described below.

## Subprocesses

- It runs `git` with fixed argument vectors to inspect local changes, revisions, and file lists. Remote review fetches run `git fetch` against the selected repository remote or configured provider clone URL.
- Remote pull-request support runs the provider executable configured in `~/.pi/agent/pi-code-diff-settings.json` (GitHub is available through authenticated `gh`). Provider operations are executable-plus-argument arrays, not shell commands.
- A configured `code.command` is run as direct argv. `$EDITOR` is run as direct argv when the review UI opens an external editor.
- Opening a URL starts the platform URL opener: `open` on macOS, `rundll32.exe url.dll,FileProtocolHandler` on Windows, or `xdg-open` elsewhere. Only credential-free `http` and `https` URLs are accepted.
- The standalone Workbench build invokes the package's local TypeScript compiler and its generated standalone entry point.

## Filesystem access

- Local review and Workbench features read files inside the selected repository. The Workbench rejects paths outside that repository, follows no escaping symlinks, and limits text reads and writes.
- Workbench saves use a same-directory temporary file and lock file before an atomic rename. It can therefore create and remove temporary and lock files beside the edited file.
- Review preferences are read and written at `~/.pi/agent/extensions/code-diff-preferences.json`; comment shortcuts are read from `~/.pi/agent/extensions/code-diff.json`.
- Provider and code-command settings are read from `~/.pi/agent/pi-code-diff-settings.json`.
- Review sessions are read and written under `~/.pi/agent/cache/pi-code-diff/sessions/`, and submitted-review receipts under `~/.pi/agent/cache/pi-code-diff/receipts/`.
- Remote pull-request repositories are cached under `~/.pi/agent/cache/pi-code-diff/remotes/` unless the configured remote cache root overrides it.
- Standalone Workbench builds are staged and promoted under `~/.pi/agent/cache/pi-code-diff/workbench/`; the launcher is written atomically to `~/.pi/agent/bin/pi-code-workbench`.
- Review submission writes a mode-`0600` JSON payload under the operating system temporary directory as `pi-code-diff-review-*`, passes it to the provider command, and removes the directory afterward.

## Network access

`pi-coder` has no direct HTTP client. Network traffic occurs only through the subprocesses above: Git remote fetches, configured provider commands such as `gh`, and the operating-system URL opener after the user selects a URL.

## Release access

Publishing is staged only for a pushed `v*` Git tag whose name exactly matches `package.json`'s version. The GitHub Actions publish job has read-only repository contents permission plus `id-token: write` for npm provenance; it runs `npm stage publish` and does not use a repository write token. A maintainer must review and approve the staged release with 2FA before it becomes public.
