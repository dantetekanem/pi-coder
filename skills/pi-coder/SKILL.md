---
name: pi-coder
description: Open pi-coder's interactive diff review, diff story, or code workbench for the user from any agent harness, read the user's feedback or DISCUSS notes when they finish, and submit a confirmed pull request review. Use when the user asks to review or open the current changes, a Git range, a branch, or a pull request, to walk through a change as a story, or to open a file for them.
---

# pi-coder

pi-coder shows code to the user in a full-screen terminal UI and returns what they wrote. Run it through the `pi-coder` command. If your harness lists the pi-coder MCP tools (`open_code_diff`, `open_code_diff_story`, `open_code`, `submit_pr_review`, `pi_coder_wait`), call those instead; the inputs and results are the same.

## Open a review

```bash
pi-coder tool open_code_diff --json --input '{"args": "", "cwd": "/absolute/repo"}'
```

- `args` uses the `/diff` target syntax: empty for uncommitted changes, `base..head` or `base...head` for a range, `remote <url-or-branch>` for a pull request or remote branch.
- `comments` prepopulates review notes: each needs `path` and `body`, plus optional `side` (`added`, `deleted`, `file`), `line` or `startLine`/`endLine`, and `intent` (`discuss`, `comment`, `modify`). Add notes only when you have specific feedback; the user keeps or deletes them.
- Use `open_code_diff_story` (same `args` and `cwd`) when the user asks to walk through a change as a story, and `open_code` with `path` or `target` to open a file in the workbench.

Open the UI only when the user asks for it. Never open it on your own or because a result mentions reopening.

## Wait for the user

The UI opens in a new Herdr or tmux pane, and the command waits until the user finishes. Shell tools usually stop a command after a few minutes, so start with `--detach` and collect the result in steps shorter than that limit:

```bash
pi-coder tool open_code_diff --detach --json --input '{"args": "main...HEAD"}'
pi-coder wait <launch-id> --timeout 90 --json
```

Repeat `wait` while the result says `"state": "open"`. Do not start a second review while one is open.

## Read the result

The JSON result has `text`, `prompt`, `details`, `messages`, and `notices`.

- `prompt` is the user's handoff. Treat it as the user's message: answer DISCUSS notes in prose, and handle COMMENT and MODIFY notes as the prompt says.
- `messages` are follow-ups pi-coder sends to the agent in Pi, such as a submission result. Read them in order.
- When a prompt tells you to call a tool, run the same call through `pi-coder tool <name> --input '<the JSON from the prompt>'`.

## Continue a remote discussion

After a pull request DISCUSS handoff, discuss the questions without editing files or posting anything. When the discussion ends:

1. If it produced findings for the PR author, ask: "Want me to prepopulate the findings as comments?"
2. Ask: "Good to continue the review?"
3. Only after a yes, run `open_code_diff` with the base arguments from the prompt, including its `continuation` object. Add only confirmed findings as `comments` with `intent` `comment`.

## Submit a pull request review

Run `submit_pr_review` only after the user confirms the verdict and the text. Fix only grammar and spelling, never meaning. Pass `provider`, `repo`, `prNumber`, `commitId`, `verdict`, `prAuthorLogin`, and `cwd` from the prompt. The tool refuses to approve the user's own pull request. When the result is `partial` or `unknown`, follow its recovery steps and check the pull request before you post again.
