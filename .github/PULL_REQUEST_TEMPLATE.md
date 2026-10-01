## 改动 / What changed

<!-- 一两句话；关联 issue 用 Fixes #N -->

## 运行时层面如何测试 / How it's tested at runtime level

<!-- 约定：运行时代码路径必须有运行时级测试（mock 跑绿不算覆盖真实路径）。说明你加了什么测试、跑了什么命令。 -->

```
npm run build && npm test   # 结果：
```

## 契约检查 / Contract checklist

- [ ] 新状态可从事件流 fold 推导（新 event type 已进 `src/events/types.ts`）
- [ ] 工具改动过策略引擎；策略相关改动已同步 README「安全边界」
- [ ] diff 保持最小，无无关重排
- [ ] 提交标题符合 `type: 摘要` 规范
