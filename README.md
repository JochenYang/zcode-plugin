<h1 align="center">zcode-plugin</h1>

<div align="center">

[中文](README.md) | [English](README.en.md)

</div>

<p align="center">
  <a href="https://github.com/JochenYang/zcode-plugin"><img src="https://img.shields.io/badge/ZCode-插件-4A90D9?style=for-the-badge" alt="ZCode 插件"></a>
  <a href="https://github.com/JochenYang/zcode-plugin/releases"><img src="https://img.shields.io/github/v/release/JochenYang/zcode-plugin?style=for-the-badge" alt="版本"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/JochenYang/zcode-plugin?style=for-the-badge" alt="许可证"></a>
  <a href="https://github.com/JochenYang/zcode-plugin/stargazers"><img src="https://img.shields.io/github/stars/JochenYang/zcode-plugin?style=for-the-badge" alt="Star"></a>
</p>

个人 ZCode 插件市场。每个插件独立目录，结构遵循官方约定（`.zcode-plugin/plugin.json` + 组件目录）。

## 插件列表

| 插件 | 版本 | 说明 |
|---|---|---|
| `plugins/git-workflow` | 0.1.1 | Git 工作流：`/gcommit` 规范提交、`/gpr` PR 描述、`/gchangelog` 变更日志；`PostToolUse` 钩子校验提交格式 |
| `plugins/dev-workflow` | 0.1.0 | 日常开发工作流 7 个 skill：规划、调试、测试、审查、提交检查、发布检查、文档生成 |

## 安装

**方式一：GitHub 市场（推荐，任意机器）**

1. 打开 ZCode **设置 → 插件**，右上角「创建/添加」→ **添加插件市场**，选 **GitHub 源**
2. 填仓库：`JochenYang/zcode-plugin`（公开仓库，无需额外配置）
3. 在列表中找到 `git-workflow` 并**启用**

**方式二：本地开发目录**

1. 打开 ZCode **设置 → 插件**，右上角「创建/添加」→ **添加插件市场**
2. 填入本目录路径：`D:\codes\zcode-plugin`
3. 在「个人」分段找到 `git-workflow` 并**启用**
4. 修改插件代码后，回到「市场源」面板刷新即可生效

## 插件图标

- 插件图标由 `marketplace.json` 的 `icon` 字段引用：`https://static.geluman.cn/icon/icon.png`
- 更换图标：替换 CDN 上的文件即可（本地市场面板刷新即可生效）

## git-workflow 用法

- `/gcommit` — 分析暂存/未暂存变更，生成 `<type>(<scope>): <subject>` 格式提交消息，用户确认后提交
- `/gcommit [scope]` — 指定 scope（如 `auth`、`api`）
- `/gcommit --amend` — 修改上一次提交
- `/gcommit --no-add` — 不自动 `git add`，只提交已暂存内容
- `/gpr [--base <branch>]` — 基于当前分支与基础分支的差异，生成 PR 描述（摘要 / 分组变更 / 验证 / 风险）
- `/gchangelog [--from <ref> --to <ref> | --count <n>] [--file <path>]` — 按版本 tag 分组生成 changelog；带 `--file` 时合并写入并先预览确认

提交后钩子会自动校验消息格式；不合规时在会话中给出提醒（不拦截提交）。

## dev-workflow 用法

7 个 flow skill，覆盖日常开发生命周期，合适时机会自动触发，也可输入 `/` 从「技能」分组手动选用：

| Skill | 时机 | 产出 |
|---|---|---|
| `change-plan` | 新功能/重构/复杂修复前 | 可执行计划 + Handoff contract（后续 skill 对照的验收契约） |
| `debug` | bug/测试失败/构建失败 | 复现→隔离→假设→验证→最小修复，支持 diagnose/fix/verify 意图 |
| `test-changed` | 当前改动要验证 | 最小有效测试范围 + 证据记录 + Anti-rationalization 检查（AR-1~10 SSOT） |
| `review` | 要审查改动 | P0–P3 分级发现，带 `path:line` 与证据等级 |
| `commit-review` | 提交前 | READY/NOT READY 结论 + 分支名与提交消息提案（不实际提交） |
| `release-check` | 发版/打 tag 前 | GO/NO-GO/CONDITIONAL GO + 阻塞项与解除路径（不实际发布） |
| `doc-gen` | 写/更新文档 | API 文档/CHANGELOG/README/用户文档/迁移指南，声明可回指代码 |

核心机制：`change-plan` 产出 Handoff contract（会话内验收契约，不落盘）；`test-changed` 是 Anti-rationalization（AR-1~10）与 Contract resolution（explicit-handoff → user-pinned → rebuilt-from-context → unavailable）的 SSOT，其余 skill 引用；结论硬性连动：AR `FAIL` → commit-review 不得 READY、release-check 不得 GO。

推荐生命周期：`change-plan → 实现 → test-changed → review → commit-review → release-check → doc-gen`

## Subagents 备份

`agents/` 目录是本机 ZCode 子智能体定义（`~/.zcode/agents`）的备份，16 个，随本机修改手动同步（`cp ~/.zcode/agents/*.md agents/`）。

## 开发新插件

```text
plugins/<plugin-name>/
├── .zcode-plugin/plugin.json   # 必需：插件清单
├── commands/*.md               # 斜杠命令（frontmatter + $ARGUMENTS）
├── skills/*/SKILL.md           # 技能
├── agents/*.md                 # 子智能体
├── hooks/hooks.json            # 钩子（7 种事件）
└── .mcp.json                   # MCP 服务
```

然后在此 `marketplace.json` 的 `plugins` 数组追加条目。

## 参考

- 官方插件文档：<https://zcode.z.ai/cn/docs/plugin>
- 钩子机制与调试：本机 `zcode-guide` 插件中的 `diagnosing-hooks` 技能
