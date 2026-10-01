# Contributing to Keel Agent

Thanks for your interest in making Keel better. Keel is small on purpose — most contributions should stay small too.

**English** · [中文](./CONTRIBUTING.zh-CN.md)

## The one thing to understand first

Keel is an append-only event stream with a fold. Before changing behavior, ask: *does my change keep every state derivable from the log alone?* If a feature needs state that only lives outside `events.jsonl`, it belongs somewhere else.

## Dev setup

```bash
git clone https://github.com/dangzitou/keel-agent.git
cd keel-agent
npm install && npm run build
npm test                      # full suite; must be green
KEEL_MOCK=1 node dist/index.js run "write a hello"   # no API key needed
```

Requirements: Node ≥ 18.17. No other tooling — the repo is zero-dependency at runtime and near-zero at dev time on purpose. resist adding dependencies.

## Code map

```text
src/events/types.ts   event schema — the contract of everything
src/core/store.ts     append-only JSONL store
src/core/fold.ts      state = fold(events); add new state here
src/core/loop.ts      agent loop: completion contract, budget, compaction
src/llm/              providers (openai/anthropic/responses), router, retry, cost
src/tools/            plan/read/write/edit/bash/glob/grep/verify
src/policy/           declarative policy engine
src/ui/render.ts      terminal rendering + deterministic replay rendering
```

## What makes a good contribution

- **A new provider preset or protocol fix** — small, testable against a local SSE mock (see `test/helpers/sse-server.ts`).
- **A new tool** — must compose with policy (`checkPolicy`), emit its own events if it changes state, and have a test in `test/`.
- **Replay rendering improvements** — `renderEventLine` is pure; changes are easy to verify.
- **Docs and examples** — especially real usage stories: fork workflows, CI setups, budget saves.

## Ground rules

1. **Runtime code paths need runtime-level tests.** A green unit test over a mocked path does not cover the real path (see the SSE/SIGINT lessons in the test suite). If you touch streaming, write a local-server integration test.
2. **New state must be fold-derived.** New event types go in `src/events/types.ts` with data interfaces, and `fold()` must reconstruct them.
3. **Keep diffs minimal.** Match surrounding style; don't reformat untouched code.
4. **Commits:** `type: 摘要`（中文）with `feat | fix | docs | test | chore`; breaking changes note `BREAKING` in the body. Releases use `vX.Y.Z: ...`.
5. **Security-relevant changes** (policy engine, sandboxing, bash handling) need a careful README "Security boundaries" update in the same PR.

## Pull requests

1. Fork, branch, commit (see rules above), run `npm run build && npm test`.
2. Open the PR with the template filled in — especially the "how is this tested at runtime level" section.
3. For feature-sized changes, open an issue or Discussion first to align on the design.

## Issue guidelines

- Bugs: keel version, Node version, provider + protocol, and the `keel replay <id>` excerpt if a session was involved — events usually tell the whole story.
- Features: describe the *workflow* you want, not just the mechanism. Keel picks mechanisms that fit the event-stream model.
