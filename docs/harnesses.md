# Use pi-coder from other agents

pi-coder opens its screen for the user and returns what they wrote to the agent that asked. Inside Pi, the extension does this with its own tools. Other agents use the `pi-coder` command or its MCP server. Both need the command on the path:

```bash
npm install -g pi-coder
```

The screen needs a terminal. When an agent runs pi-coder from a tool call, pi-coder opens a new Herdr or tmux pane next to the agent. Run the agent inside Herdr or tmux, or set `terminal.command` (see [The pi-coder command](cli.md#where-the-screen-opens)).

## MCP clients

`pi-coder mcp` serves these tools on standard input and output:

| Tool | What it does |
| --- | --- |
| `open_code_diff` | Opens the review for local changes, a range, or a pull request, with optional prepopulated comments and a DISCUSS continuation. |
| `open_code_diff_story` | Opens the diff story for the same targets. |
| `open_code` | Opens the code workbench at a path or target. |
| `submit_pr_review` | Posts a review the user confirmed. It needs no screen. |
| `pi_coder_wait` | Waits for a review that is still open. |

A tool that opens the screen waits up to 45 seconds for the user. When the user takes longer, it returns a launch id, and the agent calls `pi_coder_wait` until the review ends. Most MCP clients stop a tool call after about a minute, so keep the wait under that. `pi-coder mcp --wait <seconds>` or `PI_CODER_MCP_WAIT_SECONDS` changes it; `0` waits until the user finishes. While it waits, pi-coder sends a progress notification every 15 seconds when the client asks for progress.

The result of a finished review holds the tool text first, then each follow-up message as its own text block, and the tool details as structured content.

### Claude Code

```bash
claude mcp add --scope user pi-coder -- pi-coder mcp
```

Without `--scope user`, the server is added for the current project only. Claude Code names the tools `mcp__pi-coder__open_code_diff` and so on.

### Codex

```bash
codex mcp add pi-coder -- pi-coder mcp
```

Or add it to `~/.codex/config.toml`:

```toml
[mcp_servers.pi-coder]
command = "pi-coder"
args = ["mcp"]
```

Codex stops a tool call after 60 seconds unless `tool_timeout_sec` is higher. The default 45-second wait fits. If you set the wait to `0`, also set `tool_timeout_sec`, for example to `3600`.

## Agents with a shell

Any agent that runs shell commands can use `pi-coder tool`:

```bash
pi-coder tool open_code_diff --json --input '{"args": "main...HEAD", "cwd": "/path/to/repo"}'
```

The agent reads `prompt` and `messages` from the JSON result. A shell tool usually stops a command after a few minutes; Claude Code's Bash tool stops it after 2 minutes unless the agent asks for more. For long reviews, start with `--detach` and collect the result in steps that fit the limit:

```bash
pi-coder tool open_code_diff --detach --json --input '{"args": ""}'
pi-coder wait <launch-id> --timeout 90 --json
```

Give the agent the bundled skill so it knows the flow:

```bash
# Claude Code
mkdir -p ~/.claude/skills/pi-coder
cp "$(npm root -g)/pi-coder/skills/pi-coder/SKILL.md" ~/.claude/skills/pi-coder/

# Codex
mkdir -p ~/.agents/skills/pi-coder
cp "$(npm root -g)/pi-coder/skills/pi-coder/SKILL.md" ~/.agents/skills/pi-coder/
```

## Models outside Pi

The grammar pass, the story agent, and reply analysis need a model. When `pi` is installed, pi-coder uses `pi -p`. Otherwise, point it at your harness's headless mode in `pi-coder-settings.json`:

```json
{
  "models": {
    "default": { "command": ["claude", "-p", "--model", "sonnet", "--output-format", "text", "--tools", "", "--no-session-persistence", "--system-prompt", "{system}"] }
  }
}
```

```json
{
  "models": {
    "default": { "command": ["codex", "exec", "--ephemeral", "--skip-git-repo-check", "-"] }
  }
}
```

## Other tools

A tool that opens its own pane can run `pi-coder diff <target> --terminal inline --result-file <file>` there and read the result file when the pane exits.

## What the agent gets back

The result is the same in every harness:

- `prompt`: the handoff for the agent. A local review returns the COMMENT, MODIFY, and DISCUSS notes with their code. A pull request review offers "Start discussion with agents" for DISCUSS notes and keeps COMMENT and MODIFY notes in the saved review for the author.
- A pull request discussion ends with "Good to continue the review?". A yes lets the agent reopen the saved review with the `open_code_diff` arguments in the prompt.
- `messages`: follow-ups, such as the result of a submission or a request to finish the grammar check. Read them after the prompt, in order.

The agent never posts to a pull request unless the user confirms the exact action.
