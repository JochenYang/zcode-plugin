# zcode-plugin

<div align="center">

[![中文](https://img.shields.io/badge/中文-简体中文-blue.svg)](README.md) [![English](https://img.shields.io/badge/English-English-blue.svg)](README.en.md)

</div>

<p align="center">
  <img src="https://img.shields.io/github/license/JochenYang/zcode-plugin" alt="License">
  <img src="https://img.shields.io/github/repo-size/JochenYang/zcode-plugin" alt="Repo size">
  <img src="https://img.shields.io/badge/plugin-v0.1.1-orange" alt="Plugin version">
</p>

个人 ZCode 插件市场。每个插件独立目录，结构遵循官方约定（`.zcode-plugin/plugin.json` + 组件目录）。

## 插件列表

| 插件 | 版本 | 说明 |
|---|---|---|
| `plugins/git-workflow` | 0.1.1 | Git 工作流：`/gcommit` 规范提交、`/gpr` PR 描述、`/gchangelog` 变更日志；`PostToolUse` 钩子校验提交格式 |

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

- 图标文件放在 `assets/git-workflow/icon.png`（建议 128×128 PNG）
- `marketplace.json` 中通过 `icon` 字段引用（GitHub raw URL）
- 换图标后需重新 push 才在远端生效；本地市场面板刷新即可

## git-workflow 用法

- `/gcommit` — 分析暂存/未暂存变更，生成 `<type>(<scope>): <subject>` 格式提交消息，用户确认后提交
- `/gcommit [scope]` — 指定 scope（如 `auth`、`api`）
- `/gcommit --amend` — 修改上一次提交
- `/gcommit --no-add` — 不自动 `git add`，只提交已暂存内容
- `/gpr [--base <branch>]` — 基于当前分支与基础分支的差异，生成 PR 描述（摘要 / 分组变更 / 验证 / 风险）
- `/gchangelog [--from <ref> --to <ref> | --count <n>] [--file <path>]` — 按版本 tag 分组生成 changelog；带 `--file` 时合并写入并先预览确认

提交后钩子会自动校验消息格式；不合规时在会话中给出提醒（不拦截提交）。

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
