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
| `plugins/git-workflow` | 0.1.3 | Git 工作流：`/gcommit` 规范提交、`/gpr` PR 描述、`/gchangelog` 变更日志；`PostToolUse` 钩子在提交后校验消息 |
| `plugins/dev-workflow` | 0.3.0 | 日常开发流程：7 个 skill + `/handoff` 契约落盘 + `SessionStart` 仓库快照 + 16 个专项子智能体自动安装到 `~/.zcode/agents` |
| `plugins/guardrails` | 0.1.0 | 确定性安全护栏：`PreToolUse` 硬拦不可逆命令与硬编码密钥，发布/部署/迁移转为确认弹窗 |

四个插件互不依赖，可单独启用。`guardrails` 会阻断操作，独立成插件便于单独关闭。

## 安装

**方式一：GitHub 市场（推荐，任意机器）**

1. 打开 ZCode **设置 → 插件**，右上角「创建/添加」→ **添加插件市场**，选 **GitHub 源**
2. 填仓库：`JochenYang/zcode-plugin`（公开仓库，无需额外配置）
3. 在列表中按需**启用** `git-workflow` / `dev-workflow` / `guardrails`
4. `dev-workflow` 启用后，下次会话启动时 16 个子智能体会自动安装到 `~/.zcode/agents`

**方式二：本地开发目录**

1. **设置 → 插件** → 「创建/添加」→ **添加插件市场**，填入本目录路径：`D:\codes\zcode-plugin`
2. 在「个人」分段按需启用
3. 改完插件代码后回「市场源」面板刷新。注意：安装缓存以 `<插件名>/<version>` 为键，**改了插件必须同时提升 `plugin.json` 的 `version`**，否则刷新后仍是旧版本

## git-workflow

- `/gcommit` — 先做就绪检查（单一职责 / 敏感信息 / 验证证据 / 契约对照），检查通过后才 `git add`，再生成 `<type>(<scope>): <subject>` 消息，用户确认后提交
- `/gcommit [scope]` — 指定 scope（如 `auth`、`api`）
- `/gcommit --amend` — 修改上一次提交
- `/gcommit --no-add` — 不自动 `git add`，只提交已暂存内容
- `/gpr [--base <branch>]` — 基于当前分支与基础分支的差异生成 PR 描述（摘要 / 分组变更 / 验证 / 风险）
- `/gchangelog [--from <ref> --to <ref> | --count <n>] [--file <path>]` — 按版本 tag 分组生成 changelog；带 `--file` 时先预览再合并写入

提交消息用 `git commit -F -` + heredoc 写入，以保证空行与 bullet 布局不被破坏（多个 `-m` 会把每段压成单行）。

`PostToolUse` 钩子只在这次 Bash 调用确实是 `git commit`、且 HEAD 提交在 120 秒内产生时才校验，校验 type/scope 格式、50 字符上限和结尾句号；不合规时在会话中提醒，**不拦截提交**。

## dev-workflow

7 个 flow skill 覆盖开发生命周期，合适时机自动触发，也可输入 `/` 从「技能」分组手动选用：

| Skill | 时机 | 产出 |
|---|---|---|
| `change-plan` | 新功能/重构/复杂修复前 | 可执行计划 + Handoff contract（后续 skill 对照的验收契约） |
| `debug` | bug/测试失败/构建失败 | 复现→隔离→假设→验证→最小修复，支持 diagnose/fix/verify 意图 |
| `test-changed` | 当前改动要验证 | 最小有效测试范围 + 证据记录 + Anti-rationalization 检查（AR-1~10 SSOT） |
| `review` | 要审查改动 | P0–P3 分级发现，带 `path:line` 与证据等级 |
| `commit-review` | 跨职责需拆分提交时 | READY/NOT READY + 分支名与提交消息提案（不实际提交） |
| `release-check` | 发版/打 tag 前 | GO/NO-GO/CONDITIONAL GO + 阻塞项与解除路径（不实际发布） |
| `doc-gen` | 写/更新文档 | API 文档/CHANGELOG/README/用户文档/迁移指南，声明可回指代码 |

命令与钩子：

- `/handoff [save|show|clear]` — 把会话内的 Handoff contract 落盘到 `.zcode/handoff.md`，跨压缩与跨会话保留目标和验收标准
- `SessionStart` 钩子（`startup` / `clear` / `compact`）自动注入分支、未提交文件数、最近 3 条提交和 `.zcode/handoff.md` 摘要，省掉每次会话开头的多次 git 调用
- `startup` 时另一条钩子自动同步 16 个专项子智能体到 `~/.zcode/agents`（ZCode 不加载插件目录内的 agent，必须复制出来；只装缺失、刷新它自己写过的文件，用户手改过的跳过）
- `/agents-sync [diff|export|install]` — 安装已是自动的，这里只用于：`diff` 对比本地与插件资产、`export` 把本地手改的 agent 推回仓库、`install` 强制覆盖重装

核心机制：`change-plan` 产出 Handoff contract，`/handoff save` 负责落盘；`test-changed` 是 Anti-rationalization（AR-1~10）与 Contract resolution（explicit-handoff → user-pinned → rebuilt-from-context → unavailable）的 SSOT；结论硬性连动：AR `FAIL` → commit-review 不得 READY、release-check 不得 GO。

推荐生命周期：`change-plan → 实现 → test-changed → review → gcommit → release-check → doc-gen`

提交前检查已并入 `/gcommit`；`commit-review` 保留给「一批改动需要拆成多个提交」的场景。

## guardrails

两个 `PreToolUse` 钩子，是这套插件里唯一不依赖模型自觉的确定性约束。

**`deny`（硬阻断，模型收到明确原因）** — 不可逆且无回退路径：

- `rm` 指向根级目标（`/`、`~`、`.`、`..`、`*`）、系统目录或 `~/.ssh` `~/.aws` 等凭据目录
- `git push --force`（放行 `--force-with-lease`）、`reset --hard`、`clean -fd`、`filter-branch`/`filter-repo`、删除远程分支
- `DROP TABLE/DATABASE/SCHEMA`、`TRUNCATE`
- `mkfs*`/`fdisk`/`parted`、`dd of=/dev/*`、重定向到裸块设备、`chmod 777 /`
- 写入内容含真密钥格式：AWS `AKIA…`、私钥块、GitHub `ghp_`/`github_pat_`、GitLab `glpat-`、Slack `xox*`、Stripe `sk_live_`、Google `AIza…`、OpenAI `sk-…`

**`ask`（转为确认弹窗）** — 可逆但代价高：

- `rm` 越出项目目录：绝对路径不在项目下、`../` 越界、`~/` 下的路径、未展开的变量（`/tmp`、`/var/tmp` 放行）
- `git checkout .`/`restore .`（一次丢弃全部本地修改）、`commit --amend`、`rebase`（放行 `--continue`/`--abort`/`--skip`）、push 到 `main`/`master`/`prod`、`git tag`
- `sudo`、`curl … | sh`
- 无 WHERE 风险的 `UPDATE`/`DELETE FROM`、各语言的 migrate 命令
- `npm/cargo/gem/twine publish`、`docker push`、`terraform apply|destroy`、`kubectl`、`helm`、`vercel --prod`、云 CLI 的 delete/terminate
- 写入 `.env*`（放行 `.env.example`/`.template`/`.sample`）、`id_rsa`、`*.pem`、`.npmrc`、`credentials`、`secrets.*`
- 疑似密钥赋值（20 字符以上字面量赋给 `password`/`secret`/`api_key` 等）、JWT

删除判定按**位置**而非命令形态，所以项目内清理完全不打扰：

| 目标 | 判定 |
|---|---|
| 项目内（相对路径、或绝对路径落在项目目录下） | 静默放行 |
| `/tmp`、`/var/tmp` | 静默放行 |
| 项目外（绝对路径越界、`../` 越界、`~/…`、未展开变量） | `ask` |
| 根级、系统目录、凭据目录 | `deny` |

`rm -rf node_modules`、`rm -rf build dist`、`rm -rf src/generated`、`rm -rf /d/codes/<本项目>/build` 都不弹窗；`rm -rf ../another-project` 会问一次。

设计要点：

- 只扫描新写入的内容（`content` / `new_string`），**不扫 `old_string`** —— 否则「把硬编码密钥改成读环境变量」这个修复动作本身会被它拦住
- 逃生阀：项目根 `.zcode/guardrails-allow`，每行一个 ERE，命中即放行（`#` 开头为注释）。例：某项目确实需要跑 `terraform apply`，写入 `^terraform apply` 即可
- 单次检查约 8ms，两个钩子都是阻塞执行

## 开发新插件

```text
plugins/<plugin-name>/
├── .zcode-plugin/plugin.json   # 必需：插件清单，name 须匹配 ^[a-z0-9][a-z0-9._-]{0,127}$
├── commands/*.md               # 斜杠命令，命令名取自文件名，子目录用 : 连接
├── skills/<name>/SKILL.md      # 技能，文件名大小写必须精确
├── hooks/hooks.json            # 钩子，无需在清单声明，按约定自动加载
└── .mcp.json                   # MCP 服务
```

然后在 `marketplace.json` 的 `plugins` 数组追加条目（`name` + `source` 必填，建议补 `version`/`category`/`tags`/`icon`）。

踩过的坑，写下来省得再查：

- **只有 `commands`/`skills`/`hooks`/`mcpServers` 会被执行**。`agents`/`outputStyles`/`settings`/`lspServers` 声明即警告、不生效
- `marketplace.json` 只能放在仓库根或 `.claude-plugin/`，**没有** `.zcode-plugin/marketplace.json` 这个位置
- SKILL.md frontmatter 只识别 `name`/`description`/`when_to_use`/`license`/`metadata` 五个键；`description` 上限 1024 字符，但呈现给模型时约 250 字符就截断，触发语要前置
- 命令 frontmatter 只识别 `description`/`argument-hint`/`allowed-tools`/`model`/`skills`/`disable-noninteractive`；列表必须写成单行逗号形式，`disable-model-invocation` 在 ZCode 不存在
- hook 事件恰好 7 个：`SessionStart`/`UserPromptSubmit`/`PreToolUse`/`PermissionRequest`/`PostToolUse`/`PostToolUseFailure`/`Stop`
- hook 输出是严格 schema，**多一个键整体丢弃**；`async` 无效，钩子始终阻塞执行；跨平台优先 `type: "process"` + `args[]`，路径用 `${ZCODE_PLUGIN_ROOT}`
- shell 脚本必须保持 LF（本仓库靠 `.gitattributes` 约束），CRLF 在非 MSYS bash 下会失败

## 参考

- 官方插件文档：<https://zcode.z.ai/cn/docs/plugin>
- 钩子机制与调试：本机 `zcode-guide` 插件中的 `diagnosing-hooks` 技能



