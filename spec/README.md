# Architecture draft

This describes pi-coder at source revision `aa43d71ca47defc481a397a6fd3452db8dbda9ed` (0.9.10), inspected from a clean checkout. It awaits the user's design confirmation; it is not a new architectural rule.

pi-coder lets a person review changes, leave feedback for an agent, and browse or edit source in a terminal. The Pi extension and experimental standalone command share command orchestration, review state, and the Workbench. A remote review can also submit explicitly confirmed feedback through a configured provider.

- [Architecture and flows](architecture.md) describes responsibility boundaries, persistence, lifecycle, and data access.
- [Decisions and open questions](decisions.md) separates recorded constraints from inferred trade-offs and intended-design questions.

## Folder responsibilities

| Location | Responsibility |
| --- | --- |
| [`src/index.ts`](../src/index.ts), [`src/pi/`](../src/pi/) | Register Pi commands/tools, adapt Pi context and models, refresh the repository footer. |
| [`bin/`](../bin/), [`src/cli/`](../src/cli/) | Bootstrap TypeScript through jiti; parse standalone commands; own terminal/pane launches, model commands, result envelopes, and MCP transport. |
| [`src/host/`](../src/host/), [`src/engine.ts`](../src/engine.ts) | Define host interfaces and runtime hooks; orchestrate the shared review, story, Workbench, and submission flows. |
| [`src/adapters/pi/`](../src/adapters/pi/) | Mount the Workbench overlay and coordinate Pi-facing invocation and review-to-code transitions. |
| [`src/workbench/`](../src/workbench/) | Buffer, tree, navigation, target and UI contracts; `node/` owns filesystem/Git/highlighter adapters, and `standalone.ts` owns its separate terminal lifecycle. |
| [`src/ui/`](../src/ui/) | Review/story screens, exact-text editing, overlays, and terminal interaction. |
| [`src/diff-story/`](../src/diff-story/) | Capture/validate story plans, extract and pair code/test units, arrange steps, and locate existing tests. |
| Top-level [`src/`](../src/) modules | Git comparisons, remote/provider settings and reads, review state/drafts/compositions, submission journal/receipts/recovery, sanitization, and agent handoffs. These are collaborators of the engine, not another application server. |
| [`prompts/`](../prompts/), [`skills/`](../skills/) | Model instructions and agent-facing workflows. Story generation reads bundled Markdown at runtime. |
| [`src/test/`](../src/test/), [`src/benchmark/`](../src/benchmark/), [`scripts/`](../scripts/) | Automated contracts, performance measurements, package checks, and standalone Workbench build/start tooling. None were executed for this draft. |
| [`docs/`](../docs/) | Existing usage and access guides; this spec links them rather than repeating their option/key catalogues. |

## Existing guides and inspection limits

Start with the [product README](../README.md), [Workbench guide](../docs/workbench.md), [CLI guide](../docs/cli.md), [harness integration](../docs/harnesses.md), [remote-provider contract](../docs/remote-providers.md), and [access inventory](../docs/access.md). Known stale Workbench guide details are called out in [decisions](decisions.md); source takes precedence for this snapshot.

Inspection covered the manifest, these guides, entrypoints and selected source spans cited in the two documents. Git history supplied recorded change subjects, not evidence of unspoken author intent. This is a static documentation pass, not exhaustive call-graph analysis, a security audit, or runtime proof. No builds, tests, model/provider calls, browser checks, installs, or live/deployment probes ran. Installed package behavior, current upstream compatibility, remote state, other branches, and production use remain unverified.
