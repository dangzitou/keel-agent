# Keel（龙骨）

**可回放、可验证、可审计的编码智能体 CLI。** 运行时零依赖，OpenAI 兼容接口通吃 DeepSeek / GLM / Kimi / Qwen / OpenAI。支持流式输出、瞬态错误自动重试、Ctrl+C 安全中断。

```
keel run "修复登录超时的 bug，并确保测试通过"
```

## 它和 Claude Code / DSH / Cline 的区别在哪

到 2026 年，agent CLI 的功能清单已经同质化：工具循环、MCP、hooks、插件、子代理家家都有。Keel 不在清单上竞争，而是改 harness 的三个核心行为：

### 1. 会话即事件流（event-sourced session）

传统 agent 把对话存成消息数组，"恢复会话"只是续上数组。Keel 的会话是一条 **append-only 事件流**（`~/.keel/sessions/<id>/events.jsonl`），LLM 请求/响应、策略判定、工具调用、验证证据、上下文压缩全部是带序号的事件；对话历史、花费、验证状态全部是对事件的 **fold（纯推导）**。

由此获得别家没有的能力：

- **`keel fork <id> --at <seq>`**：从任意事件分叉出新会话——"如果它当时没删那个文件会怎样"是可操作的
- **`keel replay <id>`**：只读回放完整执行轨迹（含每步策略判定与成本）
- **`keel cost <id>`**：按模型/回合的费用审计，精确到每次 LLM 调用
- **上下文压缩只是视图替换**：事件流里永远有全量历史，fork 回压缩点即可还原——不像传统 compact，压完细节就永久丢失了

### 2. 证据驱动的完成契约（evidence-driven done）

别的 agent 说"完成"是模型自述。Keel 由 **harness 强制**：只要发生过文件修改（write/edit），模型声明完成前必须调用 `verify` 工具跑通验证（测试/构建/脚本），证据落盘 `evidence/` 目录；没验证就想收工会被打回（最多 2 次），最终仍无证据则以 `unverified` 结束并给出非零退出码——CI 里可以直接依赖这个信号。

### 3. 策略先行、全程审计

所有工具调用先过声明式策略引擎再执行，判定本身也作为事件落盘：

- `denyPaths`：路径黑名单（默认 `.env`、私钥），**读和写都拦**
- `bashDeny` / `bashApprove`：命令直接拒绝 / 需人工确认
- `readOnly`：只读模式
- 预算熔断：会话花费超上限自动停

## 快速开始

```bash
npm install && npm run build
node dist/index.js init          # 生成 ~/.keel/config.json
export DEEPSEEK_API_KEY=sk-...   # 或 ZHIPU_API_KEY / OPENAI_API_KEY 等
node dist/index.js               # 交互式 REPL
```

没有 API key 也能体验完整链路（确定性 mock 模型）：

```bash
KEEL_MOCK=1 node dist/index.js run "写个 hello"
```

项目级配置 `.keel.json`（放在仓库根目录，覆盖全局配置）：

```json
{
  "verify": { "commands": ["npm test"] },
  "router": { "main": "deepseek/deepseek-chat", "fast": "deepseek/deepseek-chat" },
  "budget": { "maxUsdPerSession": 2 }
}
```

`router.main` 干活，`router.fast` 做上下文压缩等便宜活——路由是一等公民，多模型是调度而非"支持"。

## CLI

| 命令 | 作用 |
|---|---|
| `keel` | 交互式 REPL（`--session <id>` 继续会话） |
| `keel run "<任务>"` | 单任务模式；`unverified` 时退出码 3，失败退出码 1 |
| `keel sessions` | 列出会话（回合数、花费、⚠未验证修改标记） |
| `keel replay <id>` | 只读回放事件流 |
| `keel fork <id> [--at <seq>]` | 从第 seq 个事件分叉新会话 |
| `keel cost <id>` | 成本报告 |
| `keel doctor` | 环境体检：node 版本、配置、密钥、价目、验证命令、目录可写性 |
| `keel init` | 生成配置模板 |

REPL 内命令：`/help /new /sessions /replay /fork /cost /policy /exit`。

**可靠性设计**：LLM 调用对 429/5xx/网络错误做指数退避重试（`llm.retries`，尊重 `Retry-After`），单请求超时可配（`llm.timeoutMs`）；每次重试落 `llm.retry` 事件可审计。Ctrl+C 触发 AbortSignal 全程传导——进行中的 fetch 与 bash 进程组被终止，`turn.completed(aborted)` 完整落盘，`keel run` 以退出码 130 结束。回合进行中在 REPL 输入的文本会排队，不丢弃。

## 架构

```
src/
├── events/types.ts     # 14 种事件类型（版本化 schema）
├── core/
│   ├── store.ts        # append-only JSONL 存储（~/.keel/sessions/<id>/）
│   ├── fold.ts         # 状态 = fold(事件)：消息/花费/验证状态/文件改动
│   └── loop.ts         # agent 循环：完成契约、预算熔断、上下文压缩
├── llm/
│   ├── provider.ts     # OpenAI 兼容客户端 + 确定性 mock
│   ├── router.ts       # main/fast 角色路由
│   └── cost.ts         # 价目表与计费
├── policy/policy.ts    # 声明式策略引擎（deny/approve/allow）
├── tools/              # read/write/edit/bash/glob/grep/verify
├── ui/render.ts        # 终端渲染 + 事件回放渲染
└── index.ts / repl.ts / commands.ts
```

**事件 schema**（信封 `seq / id / ts / session / parent / forkedAtSeq / type / data`，15 种 type：`session.started`、`user.message`、`system.note`、`llm.request`、`llm.response`、`llm.retry`、`tool.call`、`tool.result`、`policy.decision`、`verify.started`、`verify.result`、`context.compacted`、`turn.completed`、`budget.exceeded`、`error`）。

关键设计约束：

- 事件只追加、不改写；fork 是复制前缀，不是改历史
- 任何状态都可从事件重放推导，所以重放本身就是回归测试
- harness 的不变量（完成契约、策略、预算）在 loop 层强制，不依赖提示词自觉

## 配置参考

全局 `~/.keel/config.json` 与项目 `.keel.json` 合并（项目优先）：

```jsonc
{
  "router": { "main": "deepseek/deepseek-chat", "fast": "deepseek/deepseek-chat" },
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

API key 只从环境变量读取（`providers.<name>.apiKeyEnv` 指定变量名），不落配置文件。

## 安全边界（务必阅读）

Keel 是策略层 + 审计层，**不是操作系统级沙箱**：

- `constrainToWorkspace`（默认开）只约束 read/write/edit/glob/grep；**bash 不受路径约束**——`cat /etc/passwd` 这类命令绕过路径策略，依赖 `bashDeny`/`bashApprove` 与人工审批
- `bashDeny`/`bashApprove` 是朴素模式匹配，可被引号/变量绕过，是最低保障而非安全边界
- 需要强隔离时，请把 keel 放进容器/VM 运行（roadmap：内置 worktree/容器隔离）
- 事件流会记录工具输入（含 write 的完整文件内容），敏感仓库注意会话目录的访问权限与留存策略
- 模型可能被仓库内容注入指令：完成契约与策略层是兜底，高危操作请保持审批开启

**平台**：macOS / Linux（bash 依赖）。`keel run` 退出码约定：`0` done、`1` 失败/预算/超轮次、`3` 存在未验证修改、`130` 被中断——CI 可直接按退出码分派。

## 测试与 CI

```bash
npm test    # 23 个用例：glob/策略(含目录约束)/fold/fork/重试/流式聚合 + mock 全链路（契约打回、预算熔断、策略拦截）
```

GitHub Actions（`.github/workflows/ci.yml`）在 Node 20/22 上跑 build + test + mock 模式端到端 smoke。

## Roadmap

- what-if 分叉：替换某个工具结果后重跑（fork 的完全体）
- worktree/容器隔离：planner-worker 多任务隔离执行，产出分支/PR；bash 的强沙箱
- 会话回归集：把历史会话导出为评测用例（`exportEvents` 已留口）
- 子代理、MCP 兼容层、Windows 支持
