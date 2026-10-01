# 参与 Keel Agent 开发

感谢你想让 Keel 变得更好。Keel 刻意保持小体积——大多数贡献也应该保持小体积。

[English](./CONTRIBUTING.md) · **中文**

## 先要理解的一件事

Keel 是一条 append-only 事件流加一个 fold。改动行为前先问自己：*我的改动是否仍然保证一切状态都能只从日志推导出来？* 如果某个功能需要活在 `events.jsonl` 之外的状态，那它不属于这里。

## 开发环境

```bash
git clone https://github.com/dangzitou/keel-agent.git
cd keel-agent
npm install && npm run build
npm test                      # 全量测试，必须全绿
KEEL_MOCK=1 node dist/index.js run "写个 hello"   # 无需 API key
```

要求 Node ≥ 18.17。没有其它工具链——运行时零依赖、开发期近零依赖是刻意设计，请抵制添加依赖的诱惑。

## 代码地图

```text
src/events/types.ts   事件 schema——一切的契约
src/core/store.ts     append-only JSONL 存储
src/core/fold.ts      状态 = fold(事件)；新状态加这里
src/core/loop.ts      agent 循环：完成契约、预算、压缩
src/llm/              协议适配（openai/anthropic/responses）、路由、重试、计费
src/tools/            plan/read/write/edit/bash/glob/grep/verify
src/policy/           声明式策略引擎
src/ui/render.ts      终端渲染 + 确定性回放渲染
```

## 什么样的贡献是好的

- **新 provider 预设或协议修复**——小而可测，用本地 SSE mock 验证（见 `test/helpers/sse-server.ts`）。
- **新工具**——必须过策略引擎（`checkPolicy`）、改变状态时要落自己的事件、在 `test/` 里有测试。
- **回放渲染改进**——`renderEventLine` 是纯函数，验证成本低。
- **文档与实例**——尤其是真实使用故事：fork 工作流、CI 接法、预算熔断救场记录。

## 基本规则

1. **运行时代码路径要有运行时级测试。** 对 mock 路径跑绿的用例不覆盖真实路径（SSE/SIGINT 的教训都在测试套件里）。动了流式，就写本地服务器集成测试。
2. **新状态必须 fold 可推导。** 新事件类型加进 `src/events/types.ts`（带 data 接口），`fold()` 必须能重建。
3. **保持 diff 最小。** 贴合周围风格，不重排未触碰的代码。
4. **提交规范：** `type: 摘要`（中文），type ∈ `feat | fix | docs | test | chore`；破坏性变更在正文注明 `BREAKING`。发版用 `vX.Y.Z: ...`。
5. **安全相关改动**（策略引擎、沙箱、bash 处理）必须在同一个 PR 里更新 README 的"安全边界"章节。

## Pull Request

1. Fork、开分支、提交（规则见上），跑 `npm run build && npm test`。
2. 按 PR 模板填写——尤其"运行时层面如何测试"一节。
3. feature 级改动先开 issue / Discussion 对齐设计再动手。

## Issue 指引

- Bug：keel 版本、Node 版本、provider + 协议、涉及会话的话附 `keel replay <id>` 片段——事件流通常能说明全部真相。
- 功能：描述你想要的*工作流*而不只是机制。Keel 只选契合事件流模型的机制。
