<div align="center">

<img src=".github/assets/banner.svg" alt="Keel Agent — replayable, verifiable, auditable coding agent CLI" width="880">

**A replayable, verifiable, auditable coding agent CLI.**

Event-sourced sessions · Evidence-driven completion · Zero runtime dependencies

**English** · [中文文档](./README.zh-CN.md)

![License](https://img.shields.io/badge/license-MIT-4C8DFF?style=flat)
![Node](https://img.shields.io/badge/node-%E2%89%A520-4C8DFF?style=flat)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-4C8DFF?style=flat)
![Runtime deps](https://img.shields.io/badge/runtime%20deps-0-4C8DFF?style=flat)

</div>

---

Keel is a coding agent harness that treats the **session as an append-only event log** and **"done" as a verifiable contract**. It runs on any OpenAI-compatible endpoint — DeepSeek, GLM, Kimi, Qwen, OpenAI — installs with zero runtime dependencies, and exits with status codes your CI can rely on.

```bash
keel run "fix the login timeout bug and make the tests pass"
```

## Why another agent CLI

Keel focuses on a small execution core for CI and automated code maintenance, with three explicit contracts and a set of controls that confine, gate and undo what the agent does.

### 1. The session is an event stream

A Keel session is an **append-only event stream** (`~/.keel/sessions/<id>/events.jsonl`): every LLM request/response, policy decision, tool call, verification result and context compaction is a numbered event. Message history, spend and verification state are **pure folds over events**.

The same history supports:

- `keel fork <id> --at <seq>` — branch a new session from **any past event**; workspace files are not copied or rolled back
- `keel replay <id>` — read-only replay of the full execution trace, including every policy decision and its cost
- `keel cost <id>` — spend audit per model and per turn, down to individual LLM calls
- `plan` — the task plan is an event too: every update lands in the stream, replays show how the plan evolved, and a fork restores the plan as it was at that point
- **Compaction is a view swap**: the event stream keeps the recorded history even when the model receives a summary

### 2. "Done" requires evidence

After any potentially mutating call (write/edit/bash, including failure or interruption), the model must pass the `verify` tool — tests, build, scripts — before it may declare completion. Configured `verify.commands` are mandatory and run after any extra model-supplied checks. A later failed check, a fork, or a new user turn invalidates earlier success: files or verification settings may have changed outside the session. Evidence lands in the `evidence/` directory. Unverified wrap-ups get bounced (up to 2 times); if evidence never arrives, the session ends as `unverified` with a **non-zero exit code** that CI can branch on directly. This proves the configured commands passed, not that every requirement is satisfied.

### 3. Policy first, audit everything

Every tool call passes a declarative policy engine before execution, and the decision itself is logged as an event:

- `denyPaths` — path blocklist (defaults: `.env`, private keys), enforced on **reads and writes**
- `bashDeny` / `bashApprove` — reject outright / require human approval
- `readOnly` — read-only sessions
- `protectPaths` / `writePaths` / `approvePaths` — readable-but-not-writable files (default: `.keel.json`, so the agent cannot rewrite its own policy), a write allowlist, and paths whose edits need a human
- Budget fuse — the session halts automatically when spend exceeds the cap

### 4. Confine, gate, undo

Control does not stop at the prompt or at pattern matching:

- **OS sandbox for bash/verify** (`sandbox.mode: "workspace-write"`): macOS seatbelt or Linux bubblewrap. Commands can write only the workspace (or `writePaths`) and temp dirs, cannot read `denyPaths` secrets, cannot touch `protectPaths` or `.git`, cannot read or edit the Keel event store, and have no outbound network unless `sandbox.network` is on. If a sandbox is requested but unavailable, bash is refused rather than run unconfined. Every `tool.call` records which sandbox it ran under.
- **Pre-tool hooks** (`hooks.preTool`): your own script sees each tool call as JSON before it runs and can deny it or escalate it to human approval. Hooks only tighten built-in policy; crashes, timeouts and malformed output deny. Each hook verdict is stored in the `policy.decision` event.
- **Checkpoints**: every write/edit stores content-addressed before/after snapshots (`file.changed`). `keel diff` shows the session's patch; `keel rewind` restores files to any event (default: undo the last turn) and refuses to overwrite content that changed outside the checkpoint unless `--force` is given. `keel fork --at <seq> --rewind` branches history *and* files. Bash side effects are not snapshotted; `keel diff` points them out.
- **Machine-readable runs**: `keel run --json` streams every event as JSONL on stdout for orchestrators.

## Scope

| Concern | Keel provides | Deployment responsibility |
|---|---|---|
| Completion | verification events and exit codes | trusted acceptance tests |
| Recovery | local session lock, resumable history, explicit unknown tool outcomes | independent workspace per task; reconcile interrupted side effects |
| Isolation | tool policy checks; opt-in OS sandbox for bash/verify | container/VM for untrusted repos, resource limits |
| Resources | request/tool timeouts and response-boundary budgets | job deadline, hard resource and provider spending limits |

Keel aims to make these contracts easy to inspect and integrate with zero npm runtime dependencies. Current evidence supports controlled trials; see [validation results and limitations](./VALIDATION.md).

## Quick start

```bash
git clone https://github.com/dangzitou/keel-agent.git
cd keel-agent && npm install && npm run build
export ZHIPU_API_KEY=sk-...   # or STEPFUN_API_KEY / DEEPSEEK_API_KEY / ...
node dist/index.js            # interactive REPL — the model is auto-matched to your key
```

No config file needed: keel picks a sensible model from whichever provider key it finds. `node dist/index.js run "task"` for one-shot mode, `continue` to resume the latest session, `-m <provider/model>` to switch models per run.

No API key? The full pipeline runs on a deterministic mock model:

```bash
KEEL_MOCK=1 node dist/index.js run "write a hello world"
```

## CLI

| Command | What it does |
|---|---|
| `keel` | interactive REPL (`--session <id>` to continue) |
| `keel continue` | resume the most recent session |
| `keel run "<task>"` | single task; exit code 3 if `unverified`, 1 on failure (`--session <id>` resumes, `-m <ref>` switches model, `--yes` auto-approves, `--json` streams events as JSONL) |
| `keel sessions` | list sessions (turns, spend, ⚠ unverified-change marker) |
| `keel replay <id>` | read-only replay of the event stream |
| `keel fork <id> [--at <seq>] [--rewind]` | branch a new session from event `seq`; `--rewind` also restores checkpointed files to that point |
| `keel diff [id] [--at <seq>]` | unified diff of write/edit changes since event `seq` (default: session start) |
| `keel rewind [id] [--at <seq>] [--force]` | restore checkpointed files to event `seq` (default: undo the last turn) |
| `keel cost <id>` | cost report |
| `keel doctor` | environment check: node, config, keys, pricing, verify commands, writable dirs |
| `keel init` | write a config template |

REPL slash commands: `/help /new /sessions /plan /replay /fork /cost /diff /rewind /policy /exit`.

**Exit codes** (for CI): `0` done · `1` failure / budget / max turns · `3` unverified file changes · `130` interrupted.

**Recovery**: one local writer per session; durable JSONL appends; atomic metadata writes; unfinished tool batches get explicit unknown-result messages on resume, without replaying side effects. Incomplete tail bytes are archived before recovery; corruption in a committed event fails closed. Forks copy history and plan state, **not workspace files**. Forks and new user turns invalidate old successful evidence, requiring fresh verification even for a read-only follow-up. Interrupted lock reclamation is recoverable too. File tools reject special files such as FIFOs; read/edit/search accept regular files up to 2 MB.

**Reliability**: exponential backoff on 429/5xx/network errors (`llm.retries`, honors `Retry-After`), configurable per-request timeout; every retry lands as an auditable `llm.retry` event. Ctrl+C propagates an AbortSignal end-to-end — in-flight fetches and the bash process group are terminated, `turn.completed(aborted)` is persisted, and `keel run` exits 130. Text typed mid-turn in the REPL is queued, not dropped. EOF drains queued work; noninteractive approval requests are rejected unless `--yes` is set. Both single-run and REPL modes handle SIGTERM through audited shutdown.

`bash`/`verify` run foreground tasks: shell exit cleans up background descendants in the same process group; persistent services are not retained. `grep` runs regex matching in a terminable worker with a five-second search limit and stops traversal at the result limit. Compaction summarizes the complete history in chunks, checks the budget between requests, and commits a replacement view only after all chunks succeed.

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
    "stepfun": { "baseURL": "https://api.stepfun.com/step_plan/v1", "apiKeyEnv": "STEPFUN_API_KEY", "api": "responses" }
  },
  "router": { "main": "stepfun/step-5-preview", "fast": "deepseek/deepseek-chat" },
  "budget": { "maxUsdPerSession": 2, "maxTokensPerSession": 1000000 },
  "llm": { "retries": 3, "timeoutMs": 600000, "stream": true },
  "verify": { "commands": ["npm test"] },
  "policy": {
    "denyPaths": ["**/.env", "**/*.pem"],
    "bashDeny": ["sudo *"],
    "bashApprove": ["git push*"],
    "readOnly": false,
    "constrainToWorkspace": true,
    "protectPaths": [".keel.json", "test/**"],
    "writePaths": [],
    "approvePaths": ["package.json"]
  },
  "sandbox": { "mode": "workspace-write", "network": false, "writablePaths": [] },
  "hooks": { "preTool": [{ "command": "./scripts/keel-gate.sh", "tools": ["bash", "write", "edit"] }] },
  "context": { "compactThresholdTokens": 48000, "keepRecentMessages": 6 },
  "maxTurns": 40
}
```

**Hook protocol**: the command runs in the workspace (provider keys removed, not sandboxed — it is operator config) and receives `{"event":"preTool","session","cwd","tool","input","policy":{"decision","rule"}}` on stdin. Exit `0` allows; it may print `{"decision":"allow"|"approve"|"deny","reason":"..."}`. Exit `2` denies with stderr as the reason. Anything else denies. Hooks run in order, stop at the first deny, and default to a 30 s timeout (`timeoutMs`).

**Sandbox notes**: `writePaths` also limits sandboxed bash, so include build outputs (e.g. `dist/**`) when you set it. Tool caches outside the workspace (`~/.npm`, `~/.cache`) are read-only unless listed in `sandbox.writablePaths`. On Linux, protected and denied paths are bind-mounted when the command starts, so only files that already exist are covered. `keel doctor` reports which sandbox is available.

`router.main` does the work; `router.fast` handles compaction and other cheap tasks — routing is a first-class concern, multi-model is scheduling, not a checkbox. API keys are read **only** from environment variables (`providers.<name>.apiKeyEnv` names the variable); they never touch a config file.

Unknown model prices are flagged in the event log and cost report; a dollar total can be incomplete. The default **1,000,000 session-token limit** still applies (set `budget.maxTokensPerSession` to change it; `0` disables it). Set `pricing` to an object of `"provider/model": { "input": USD_per_million, "output": USD_per_million }` for custom rates; explicit zero rates are supported for subscriptions. Budget checks run before requests, after compaction and after responses; one in-flight response can overshoot the cap. Built-in prices are estimates, not provider billing receipts.

## Architecture

```text
src/
├── events/types.ts     # 19 event types (versioned schema)
├── core/
│   ├── store.ts        # append-only JSONL store (~/.keel/sessions/<id>/)
│   ├── fold.ts         # state = fold(events): messages / spend / verification / plan / file changes
│   ├── checkpoint.ts   # file snapshots → state at any seq, diff, rewind
│   └── loop.ts         # agent loop: completion contract, budget fuse, compaction
├── llm/
│   ├── provider.ts     # OpenAI-compatible client + deterministic mock
│   ├── anthropic.ts    # Anthropic Messages protocol client
│   ├── responses.ts    # OpenAI Responses protocol client
│   ├── http.ts         # shared POST / SSE / abort semantics
│   ├── router.ts       # main/fast role routing
│   └── cost.ts         # pricing tables and billing
├── policy/policy.ts    # declarative policy engine (deny / approve / allow)
├── policy/hooks.ts     # external pre-tool gates (can only tighten)
├── tools/              # plan / read / write / edit / bash / glob / grep / verify
│   └── sandbox.ts      # seatbelt / bubblewrap confinement for bash and verify
├── ui/render.ts        # terminal rendering + event replay rendering
└── index.ts / repl.ts / commands.ts
```

Event envelope: `seq / id / ts / session / parent / forkedAtSeq / type / data`, with 19 types: `session.started`, `user.message`, `system.note`, `llm.request`, `llm.response`, `llm.retry`, `tool.call`, `tool.result`, `plan.updated`, `policy.decision`, `file.changed`, `workspace.rewound`, `verify.started`, `verify.result`, `verify.invalidated`, `context.compacted`, `turn.completed`, `budget.exceeded`, `error`.

Invariants:

- events are append-only; fork copies a prefix, it never rewrites history
- any state can be re-derived by replay, so a replay *is* a regression test
- harness invariants (completion contract, policy, budget) are enforced in the loop layer, not delegated to prompt discipline

## Security boundaries — read this

Keel is a policy and audit layer with an **opt-in** OS sandbox for shell commands:

- `constrainToWorkspace` (default on) constrains read/write/edit/glob/grep. **With `sandbox.mode: "off"` (the default) bash is not path-constrained**: `cat /etc/passwd` bypasses path policy and relies on `bashDeny`/`bashApprove` and human approval. Turn the sandbox on to confine bash/verify writes, secret reads and network
- The sandbox still allows reads outside the workspace (e.g. `/etc`, your home directory) other than `denyPaths` and the Keel store; it is not a VM and does not limit CPU/memory
- `verify` commands pass the same deny/approval/read-only checks as bash; glob/grep filter denied files and path checks resolve symlinks (including new-file targets).
- Harness provider credentials are removed from bash/verify child environments; session directories/files are created with owner-only permissions.
- `bashDeny`/`bashApprove` is naive pattern matching; it can be bypassed with quoting or variables. Treat it as a guardrail, not a boundary
- For untrusted repos, still run keel inside a container/VM (built-in worktree/container isolation is on the roadmap); hooks are trusted operator code and run unsandboxed
- The event stream records tool inputs, including full file contents written by `write` — mind access permissions and retention for sensitive repos
- Models can be prompt-injected by repo content: the completion contract and policy layer are backstops; keep approvals on for high-risk operations

Platforms: macOS / Linux (bash required).

## Testing & CI

```bash
npm test   # regression cases: glob / policy / fold / fork / retry / stream aggregation / plan / protocols (anthropic & responses)
           # + full mock pipeline (contract bounce-back, budget fuse, policy interception)
           # + local SSE server integration test (real streaming chunks through the agent loop)
           # + real SIGINT delivery test (keel run child exits 130, aborted event persisted)
           # + control plane: write scope, hooks (deny/escalate/fail-closed), checkpoints/rewind/fork --rewind,
           #   real seatbelt/bwrap confinement (skipped when the host has none), --json event stream
```

GitHub Actions runs build + tests + a mock-mode end-to-end smoke on Node 20/22/24.

Opt-in real-model evaluation (creates temporary projects, uses your provider quota):

```bash
export STEPFUN_API_KEY=...
npm run eval:stepfun  # 3 independent fixes, streaming/non-streaming, resume + fork, independent artifact assertions
npm run eval:repo     # repair two seeded regressions in an isolated copy of this repository; external acceptance
```

## Roadmap

- What-if forks: swap a tool result and re-run — the full realization of `fork`
- Worktree / container isolation: planner-worker execution with branch/PR output (the bash OS sandbox has shipped)
- Session regression sets: export past sessions as eval cases (`exportEvents` hook already reserved)
- Subagents, an MCP compatibility layer, Windows support

## Contributing

Keel is small on purpose and contributions should stay small too — see [CONTRIBUTING](./CONTRIBUTING.md) ([中文](./CONTRIBUTING.zh-CN.md)). The one rule that matters: every state must stay derivable from the event stream alone. Good first contributions: provider presets, replay rendering, runtime-level tests, and real usage stories.

## Status

Experimental (v0.3.0), with reliability hardening. See [validation results and operating limits](./VALIDATION.md). Developed in the open; the event schema, CLI and config are stable enough to try but may still change. Keel is a personal project exploring how far an agent harness can go on event sourcing alone — issues and discussions are welcome.

## License

[MIT](./LICENSE) © 2026 dangzitou
