# Decisions, trade-offs, and open questions

This is a descriptive draft for the revision in the [index](README.md), not a set of newly approved ADRs. No user confirmation of this version has been recorded.

## Recorded constraints and implementation choices

| Choice | Evidence and consequence |
| --- | --- |
| Share orchestration across hosts. | [`host/engine.ts`](../src/host/engine.ts), [`engine.ts`](../src/engine.ts), [`index.ts`](../src/index.ts), and [`cli/main.ts`](../src/cli/main.ts) expose/use one engine. The history subject for `5eaf7ca` records running outside Pi. Host context/models/terminal behavior vary; review and editing contracts remain shared. This does not establish a promise of compatibility with every harness. |
| Keep standalone surfaces experimental. | The inspected [README](../README.md#use-it-outside-pi) explicitly distinguishes supported Pi surfaces from experimental CLI, agent-tool and MCP surfaces pending rework before 1.0. Version 0.9.10 does not by itself remove that qualification. |
| Keep Workbench saves separate from Git actions. | The [Workbench guide](../docs/workbench.md) states no staging, commit, push or LSP. [`node/repository.ts`](../src/workbench/node/repository.ts) saves file bytes using expected revisions and a cooperative lock. It does not provide atomic conflict protection against arbitrary non-cooperating writers. |
| Let models arrange captured code, not invent source geometry. | The explicit contract in [`diff-story/generate.ts`](../src/diff-story/generate.ts) keeps ranges and coverage local; the model orders known IDs and supplies optional display notes. Notes add source excerpts to the request, so they affect both preparation cost and data disclosure. |
| Treat remote uncertainty as durable state. | [`review-submit.ts`](../src/review-submit.ts) and the [submission contract](../docs/remote-providers.md#confirmed-submission-intents) preserve accepted/unknown steps and distinguish remote acceptance from local cleanup. Unknown outcomes cannot authorize a blind repost. |
| Keep drafts conflict-aware and unfinished typing separate. | [`review-session.ts`](../src/review-session.ts) compares generations under a lock; engine recovery loads compositions independently. Persistence failure is visible and does not authorize silent overwrite or submission. |

These are recorded product constraints or observed implementation choices. Their citations establish what exists, not that the user approved this document or every historical motivation.

## Inferred rationale, not recorded decisions

- Shared host interfaces reduce duplicated workflows, but the engine remains a substantial coordinator and the common contracts retain pi-tui dependencies. The likely benefit is reuse, not full dependency isolation.
- Lazy file reads, bounded explorer views and local story capture limit eager work. They do not make every operation incremental: file reconstruction and some indexing still scale with the buffer or workspace.
- A journal and conservative replay rules favor avoiding duplicate remote feedback over automatically retrying every failure. That interpretation follows the implementation; no broader reliability guarantee is implied.

## Intended-design questions for confirmation

1. Does the shared-engine boundary describe the intended design: hosts own terminal/model integration, while review state, story validation and Workbench editing remain common? No refactor is proposed by this question.
2. Should the experimental standalone/agent-tool/MCP qualification remain the intended support boundary until an explicit release decision changes it? This draft preserves the current README's wording rather than promising support inferred from available entrypoints.

The draft stays repository-local: `package.json` does not include `spec/` in its published file allowlist. Adding it to the package would be a separate packaging change, not part of this documentation item.

## Existing documentation drift and smallest correction

The [Workbench guide](../docs/workbench.md#rendering-and-safety-boundaries) names Shiki 3.23 and a 256 KiB source-read limit. The inspected [`package.json`](../package.json) pins Shiki **4.6.0** and [`node/workspace.ts`](../src/workbench/node/workspace.ts) sets **2 MiB**. The engine also supports a saved syntax-theme selection, with `github-dark` as the Node adapter's default rather than its only theme.

The smallest correction is to update those guide statements to the source-backed version, cap and default-versus-selected-theme distinction. This draft does not edit the guide or change behavior. No source-versus-user-intended-design contradiction was established; confirmation of intended design remains open. No installs or runtime checks were used to claim the installed renderer's version or live behavior.
