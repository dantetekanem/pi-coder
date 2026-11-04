# The pi-coder command

`pi-coder` runs the same review, diff story, and code workbench as the Pi extension, without Pi. Use it in a terminal, or let an agent call it. It reads the same settings, drafts, and submissions as the extension, so a review parked in Pi resumes in the command and the other way around.

## Install

```bash
npm install -g pi-coder
pi-coder --version
```

Use Node.js 22.19.0 or newer. Pi is not required.

## Review in a terminal

```bash
pi-coder diff                          # uncommitted changes
pi-coder diff main...HEAD              # a Git range
pi-coder diff remote <branch-or-url>   # a remote branch or configured pull request
pi-coder diff --resume                 # pick a parked review
pi-coder story main...HEAD             # walk through a change as a story
pi-coder code app/models/user.rb       # open a file in the workbench
```

`pi-coder review` is an alias for `pi-coder diff`. The targets are the same as `/diff`, `/diff-story`, and `/code` in Pi, including `fullscreen on|off`, `story agent`, and `code syntax`.

When you finish a review, the command prints the text Pi would hand to its agent: your review feedback, or the DISCUSS notes with their code. Paste it into any agent, or let the agent that started the command read it. Notices go to standard error.

## Results for agents

Add `--json` to print one JSON object, or `--output <file>` to also write it to a file (mode `0600`):

```json
{
  "piCoder": 1,
  "command": "diff",
  "ok": true,
  "started": true,
  "text": "Code diff review finished.",
  "prompt": "...the handoff for the agent...",
  "details": {},
  "messages": [],
  "notices": [{ "level": "info", "text": "Review parked. Resume with ..." }]
}
```

- `ok` is false only when pi-coder could not run the command: bad arguments, no terminal, or a crash. `error` then says why.
- `started` is true when a review, story, or workbench opened, or a setting changed.
- `prompt` is the text for the agent. It is missing when the user closed or parked the review without feedback.
- `messages` holds follow-up messages pi-coder sends to the agent's conversation inside Pi, such as a submission result or a grammar handoff.
- `details` matches the details of the Pi tool result.

Exit codes: `0` success, `1` failure, `2` usage error.

## Agent tools from any shell

`pi-coder tool <name>` runs one of the agent tools with the same JSON input and the same result as in Pi:

```bash
pi-coder tool open_code_diff --input '{"args": "main...HEAD", "cwd": "/path/to/repo"}'
pi-coder tool open_code_diff_story --input-file request.json
pi-coder tool open_code --input '{"path": "src/app.ts"}'
echo '{"provider": "github", ...}' | pi-coder tool submit_pr_review --input -
```

The tools are `open_code`, `open_code_diff`, `open_code_diff_story`, and `submit_pr_review`. Prompts that pi-coder writes for agents name these tools. An agent without the tools runs the matching `pi-coder tool` command instead.

## Where the screen opens

The review needs a terminal. `--terminal` picks where it opens:

- `auto` (default): the current terminal when standard input and output are both terminals. Otherwise a new Herdr pane when Herdr runs, then a new tmux pane when tmux runs, then the configured `terminal.command`.
- `inline`: the current terminal.
- `herdr`, `tmux`, `command`: a new pane of that kind.

An agent's shell tool usually has no terminal, so `auto` opens a pane next to the agent, waits until the user finishes, closes the pane, and prints the result. Add `--detach` to return at once with a launch id, then collect the result later:

```bash
pi-coder tool open_code_diff --input '{"args": ""}' --detach --json
pi-coder wait <launch-id> --timeout 90 --json
```

`wait` returns the result when the review ends. It returns the launch with `"state": "open"` when the timeout ends first, and `"state": "closed"` when the pane closed without a result.

For another terminal, set a command that opens a pane. pi-coder replaces `{cwd}` and appends `/bin/sh` and the path of the launch script, which runs pi-coder in the new pane:

```json
{
  "terminal": {
    "command": ["wezterm", "cli", "split-pane", "--cwd", "{cwd}", "--"]
  }
}
```

## Models

Inside Pi, the grammar pass, the story agent, and reply analysis use Pi's models. Outside Pi, pi-coder runs a command you choose for each purpose. It writes the prompt to the command's standard input and reads the answer from its standard output.

```json
{
  "models": {
    "default": { "command": ["claude", "-p"] },
    "story": { "command": ["pi", "-p", "--no-session", "--no-tools", "--model", "{provider}/{model}", "--thinking", "{thinking}"] }
  }
}
```

- Purposes: `grammar` (checks review text before it posts), `story` (orders a diff story), `analysis` (explains a PR reply and writes the PR explanation), and `default` (used when a purpose has no command).
- `{provider}`, `{model}`, and `{thinking}` come from the saved story agent (`/diff-story agent` in Pi). It starts as `anthropic/claude-opus-5-5` with `low` thinking.
- `{system}` puts the system instructions in that argument. Without it, the instructions come first on standard input.

When a purpose has no command and `pi` is on the path, pi-coder runs `pi -p` without a session or tools: the story with the saved story agent, and the grammar pass and analysis with Pi's default model at `low` thinking.

With no command and no `pi`, the grammar pass hands the review back to the agent with the `submit_pr_review` arguments, the same way Pi does when the grammar check fails. Diff stories and reply analysis then report that no model command is set.

## Settings and data

The command uses Pi's agent directory: `PI_CODING_AGENT_DIR`, or `~/.pi/agent` when that is not set.

- Settings: `pi-coder-settings.json` (`providers`, `repositories`, `code`, `search`, `models`, `terminal`). The Pi extension before 1.0 rejects `models` and `terminal`, so update it before you add them.
- Drafts, submissions, and receipts: `cache/pi-coder/`.
- Launches for other panes: `cache/pi-coder/launches/<id>/` (directories `0700`, files `0600`). A new launch removes launches older than seven days.
- Compiled sources for the command: `cache/pi-coder/jiti/`.
- Theme: the Pi theme named in `settings.json`, from `themes/<name>.json`, or the built-in dark theme. `NO_COLOR` turns colors off.

## MCP server

`pi-coder mcp` serves the four agent tools over MCP on standard input and output, plus `pi_coder_wait`. See [Use pi-coder from other agents](harnesses.md).
