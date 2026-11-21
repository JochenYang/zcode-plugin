# model-speed

在 ZCode 输入框工具栏（上下文用量圆环左边）显示**当前会话模型**的输出速度 `N tok/s`。数据来自 ZCode 内置生成指标，不需要 API Key、不发网络请求、无遥测。

> 这是 **extension 插件**（不是 MCP 插件）：ZCode 会启动一个独立扩展进程运行 `bin/extension.mjs`，首次启用时需要确认授权。

## 原理

- 订阅 `ctx.models.onDidGenerate`，**只取 `phase: "final"`**——宿主在请求结束时用服务商报告的 output tokens 和真实生成时长算出精确 TPS。流式阶段的估算值（每 500ms 一次）**不显示**，按官方设计决策，插槽保留该会话上一次的准确值。
- `ctx.slots.update("tps", ...)` 按 `{ sessionId }` 作用域更新——同一时间两个会话各看各的速度，不串台。
- 悬停说明：模型 id（只显示 modelId，如 `auto/hy4flash-free`）、输出 token 数、首 token 用时（TTFT），跟随界面语言（中/英）。
- 点击插槽触发 `model-speed.show` 命令，返回该会话最近一次速度（不弹窗、不打断）。

### 异常值过滤

宿主报告的 TPS 偶尔会出现假值——比如输出 74 token 却在极短生成窗口（31ms）里算出 7,483 tok/s。这类计时伪影会被过滤：

- 输出 token < 20 → 忽略
- 计算 TPS > 500 → 忽略
- 反推生成时长 < 300ms → 忽略

遇到异常样本时保留该会话上一次的有效值，不闪烁、不乱跳。

## 清单要点

```json
{
  "extension": {
    "engines": { "zcode": "^1.4.0" },
    "main": "./bin/extension.mjs",
    "activationEvents": ["onAvailable"]
  },
  "slots": {
    "composer.status": [{ "id": "tps", "icon": "gauge", "target": { "command": "model-speed.show" } }]
  }
}
```

`^1.3.0` 兼容宿主插件 API 1.3.x 与 1.4.x（判断规则：主版本相同且宿主版本不低于下限）。运行时零依赖：宿主通过 `activate(ctx)` 注入所有能力，源码只有纯 JS，不需要 `@zcode-dev/plugin-api` 类型包（npm 上也没发布），不需要构建步骤。

## 验证

```bash
node --check bin/extension.mjs
node tests/extension.test.mjs
```

测试用 mock ctx 覆盖：final 更新 / streaming 忽略 / 异常值过滤 / 会话隔离 / 中英文切换 / 命令返回，共 5 组。

## 局限

- 只显示**主轮请求**的速度（宿主 `models.onDidGenerate` 本身就只推主轮）。
- 没有视图、没有历史面板——想看逐轮明细请用内置的「开发者工具 → Token 调试」。
- **速度口径**：宿主用服务商报告的 output tokens（**含隐藏的 reasoning/思考 token**）÷ 首 token 到结束的时长。所以 196 tok/s 里可能有一半是思考 token，屏幕可见文字的速度会更低。宿主事件不提供 reasoningTokens，插件无法区分，只能照实显示。
- 如果某会话还没完成过生成，插槽不显示（官方 `composer.status` 行为：没有 text 就不渲染）。
- 并发多会话下，每个会话保留各自最近一次值；切换到旧会话时显示的是该会话上次的速度，不是「正在生成」的实时值（按设计）。

## 许可

MIT — 见 [LICENSE](./LICENSE)。
