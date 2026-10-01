<div align="center">

<img src=".github/assets/banner.svg" alt="Keel Agent — replayable, verifiable, auditable coding agent CLI" width="880">

**A replayable, verifiable, auditable coding agent CLI.**

Event-sourced sessions · Evidence-driven completion · Zero runtime dependencies

**English** · [中文文档](./README.zh-CN.md)

![License](https://img.shields.io/badge/license-MIT-4C8DFF?style=flat)
![Node](https://img.shields.io/badge/node-%E2%89%A518.17-4C8DFF?style=flat)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-4C8DFF?style=flat)
![Runtime deps](https://img.shields.io/badge/runtime%20deps-0-4C8DFF?style=flat)

</div>

---

Keel is a coding agent harness that treats the **session as an append-only event log** and **"done" as a verifiable contract**. It runs on any OpenAI-compatible endpoint — DeepSeek, GLM, Kimi, Qwen, OpenAI — installs with zero runtime dependencies, and exits with status codes your CI can rely on.

```bash
keel run "fix the login timeout bug and make the tests pass"
```

## Why another agent CLI

By 2026 every agent CLI has the same feature list: tool loops, MCP, hooks, plugins, subagents. Keel does not compete on that list. It changes three core behaviors of the harness itself.

### 1. The session is an event stream

Traditional agents store conversations as a message array; "resume" just appends to it. A Keel session is an **append-only event stream** (`~/.keel/sessions/<id>/events.jsonl`): every LLM request/response, policy decision, tool call, verification result and context compaction is a numbered event. Message history, spend and verification state are **pure folds over events** — never a second source of truth.

That buys capabilities the message-array model cannot express:

- `keel fork <id> --at <seq>` — branch a new session from **any past event**: "what if it hadn't deleted that file" becomes a runnable experiment
- `keel replay <id>` — read-only replay of the full execution trace, including every policy decision and its cost
- `keel cost <id>` — spend audit per model and per turn, down to individual LLM calls
- `plan` — the task plan is an event too: every update lands in the stream, replays show how the plan evolved, and a fork restores the plan as it was at that point
- **Compaction is a view swap**: the event stream always keeps full history; fork back to the compaction point to restore what a traditional `/compact` discards forever

### 2. "Done" requires evidence

For other agents, "done" is the model's word. Keel enforces it in the harness: if any file was modified (write/edit), the model must pass the `verify` tool — tests, build, scripts — before it may declare completion. Evidence lands in the `evidence/` directory. Unverified wrap-ups get bounced (up to 2 times); if evidence never arrives, the session ends as `unverified` with a **non-zero exit code** that CI can branch on directly.

### 3. Policy first, audit everything

Every tool call passes a declarative policy engine before execution, and the decision itself is logged as an event:

- `denyPaths` — path blocklist (defaults: `.env`, private keys), enforced on **reads and writes**
- `bashDeny` / `bashApprove` — reject outright / require human approval
- `readOnly` — read-only sessions
- Budget fuse — the session halts automatically when spend exceeds the cap

## How Keel compares

| | Keel | Claude Code | Codex CLI | Apache Maka |
|---|---|---|---|---|
| Session model | append-only event log, state = fold | message array + checkpoint rewind | rollout records | RuntimeEvent log + projections |
| Fork at any event | ✅ `fork --at <seq>` | rewind only (discards the future) | — | resume only |
| Compaction reversible | ✅ view swap, history kept | ✗ detail lost after `/compact` | ✗ after auto-compact | ✅ leaves prompt, not log |
| Machine-checkable "done" | ✅ verify gate + exit codes | ✗ | ✗ | ✗ (eval measures the harness) |
| Models | any OpenAI-compatible endpoint | Anthropic | OpenAI ecosystem | bring your own |
| Runtime dependencies | **0** | — | — | large workspace app |

Keel is not trying to out-feature the others. It is the minimal, trustworthy harness for CI and automation: forkable like git, accountable like a ledger, and honest about completion.

## Quick start

```bash
git clone https://github.com/dangzitou/keel-agent.git
cd keel && npm install && npm run build
node dist/index.js init        # writes ~/.keel/config.json
export DEEPSEEK_API_KEY=sk-... # or ZHIPU_API_KEY / OPENAI_API_KEY / ...
node dist/index.js             # interactive REPL
```

No API key? The full pipeline runs on a deterministic mock model:

```bash
KEEL_MOCK=1 node dist/index.js run "write a hello world"
```

## CLI

| Command | What it does |
|---|---|
| `keel` | interactive REPL (`--session <id>` to continue) |
| `keel run "<task>"` | single task; exit code 3 if `unverified`, 1 on failure |
| `keel sessions` | list sessions (turns, spend, ⚠ unverified-change marker) |
| `keel replay <id>` | read-only replay of the event stream |
| `keel fork <id> [--at <seq>]` | branch a new session from event `seq` |
| `keel cost <id>` | cost report |
| `keel doctor` | environment check: node, config, keys, pricing, verify commands, writable dirs |
| `keel init` | write a config template |

REPL slash commands: `/help /new /sessions /replay /fork /cost /policy /exit`.

**Exit codes** (for CI): `0` done · `1` failure / budget / max turns · `3` unverified file changes · `130` interrupted.

**Reliability**: exponential backoff on 429/5xx/network errors (`llm.retries`, honors `Retry-After`), configurable per-request timeout; every retry lands as an auditable `llm.retry` event. Ctrl+C propagates an AbortSignal end-to-end — in-flight fetches and the bash process group are terminated, `turn.completed(aborted)` is persisted, and `keel run` exits 130. Text typed mid-turn in the REPL is queued, not dropped.

## Configuration

The lightest path needs no config file at all — environment variables win over everything:

```bash
# built-in provider, referenced directly
KEEL_MODEL=glm-anthropic/glm-5.3 keel run "..."
KEEL_MODEL=stepfun/step-5-preview keel run "..."

# or any custom endpoint (api: openai | anthropic | responses)
KEEL_MODEL=my-model KEEL_BASE_URL=https://gw.example/v1 KEEL_API_KEY=sk-... KEEL_API=anthropic keel run "..."
```

Three wire protocols are spoken natively: OpenAI chat/completions, Anthropic Messages, and OpenAI Responses — pick per provider with the `api` field. Built-in providers: `deepseek`, `zhipu`, `glm-anthropic` (BigModel's Anthropic gateway), `stepfun` (Responses), `moonshot`, `qwen`, `openai`.

Otherwise, global `~/.keel/config.json` merged with project `.keel.json` (project wins):

```jsonc
{
  "providers": {
    "stepfun": { "baseURL": "https://api.stepfun.com/step_plan", "apiKeyEnv": "STEPFUN_API_KEY", "api": "responses" }
  },
  "router": { "main": "stepfun/step-5-preview", "fast": "deepseek/deepseek-chat" },
  "budget": { "maxUsdPerSession": 2 },
  "llm": { "retries": 3, "timeoutMs": 600000, "stream": true },
  "verify": { "commands": ["npm test"] },
  "policy": {
    "denyPaths": ["**/.env", "**/*.pem"],
    "bashDeny": ["sudo *"],
    "bashApprove": ["git push*"],
    "readOnly": false,
    "constrainToWorkspace": true
  },
  "context": { "compactThresholdTokens": 48000, "keepRecentMessages": 6 },
  "maxTurns": 40
}
```

`router.main` does the work; `router.fast` handles compaction and other cheap tasks — routing is a first-class concern, multi-model is scheduling, not a checkbox. API keys are read **only** from environment variables (`providers.<name>.apiKeyEnv` names the variable); they never touch a config file.

## Architecture

```text
src/
├── events/types.ts     # 16 event types (versioned schema)
├── core/
│   ├── store.ts        # append-only JSONL store (~/.keel/sessions/<id>/)
│   ├── fold.ts         # state = fold(events): messages / spend / verification / plan / file changes
│   └── loop.ts         # agent loop: completion contract, budget fuse, compaction
├── llm/
│   ├── provider.ts     # OpenAI-compatible client + deterministic mock
│   ├── anthropic.ts    # Anthropic Messages protocol client
│   ├── responses.ts    # OpenAI Responses protocol client
│   ├── http.ts         # shared POST / SSE / abort semantics
│   ├── router.ts       # main/fast role routing
│   └── cost.ts         # pricing tables and billing
├── policy/policy.ts    # declarative policy engine (deny / approve / allow)
├── tools/              # plan / read / write / edit / bash / glob / grep / verify
├── ui/render.ts        # terminal rendering + event replay rendering
└── index.ts / repl.ts / commands.ts
```

Event envelope: `seq / id / ts / session / parent / forkedAtSeq / type / data`, with 16 types: `session.started`, `user.message`, `system.note`, `llm.request`, `llm.response`, `llm.retry`, `tool.call`, `tool.result`, `plan.updated`, `policy.decision`, `verify.started`, `verify.result`, `context.compacted`, `turn.completed`, `budget.exceeded`, `error`.

Invariants:

- events are append-only; fork copies a prefix, it never rewrites history
- any state can be re-derived by replay, so a replay *is* a regression test
- harness invariants (completion contract, policy, budget) are enforced in the loop layer, not delegated to prompt discipline

## Security boundaries — read this

Keel is a policy and audit layer, **not an OS-level sandbox**:

- `constrainToWorkspace` (default on) constrains read/write/edit/glob/grep only — **bash is not path-constrained**; `cat /etc/passwd` bypasses path policy and relies on `bashDeny`/`bashApprove` and human approval
- `bashDeny`/`bashApprove` is naive pattern matching; it can be bypassed with quoting or variables. Treat it as a guardrail, not a boundary
- For strong isolation, run keel inside a container/VM (built-in worktree/container isolation is on the roadmap)
- The event stream records tool inputs, including full file contents written by `write` — mind access permissions and retention for sensitive repos
- Models can be prompt-injected by repo content: the completion contract and policy layer are backstops; keep approvals on for high-risk operations

Platforms: macOS / Linux (bash required).

## Testing & CI

```bash
npm test   # 30 cases: glob / policy (incl. workspace constraints) / fold / fork / retry / stream aggregation
           # + full mock pipeline (contract bounce-back, budget fuse, policy interception)
           # + local SSE server integration test (real streaming chunks through the agent loop)
           # + real SIGINT delivery test (keel run child exits 130, aborted event persisted)
```

GitHub Actions runs build + tests + a mock-mode end-to-end smoke on Node 20/22.

## Roadmap

- What-if forks: swap a tool result and re-run — the full realization of `fork`
- Worktree / container isolation: planner-worker execution with branch/PR output; a hard sandbox for bash
- Session regression sets: export past sessions as eval cases (`exportEvents` hook already reserved)
- Subagents, an MCP compatibility layer, Windows support

## Contributing

Keel is small on purpose and contributions should stay small too — see [CONTRIBUTING](./CONTRIBUTING.md) ([中文](./CONTRIBUTING.zh-CN.md)). The one rule that matters: every state must stay derivable from the event stream alone. Good first contributions: provider presets, replay rendering, runtime-level tests, and real usage stories.

## Status

Experimental (v0.2.x). Developed in the open; the event schema, CLI and config are stable enough to try but may still change. Keel is a personal project exploring how far an agent harness can go on event sourcing alone — issues and discussions are welcome.

## License

[MIT](./LICENSE) © 2026 dangzitou
