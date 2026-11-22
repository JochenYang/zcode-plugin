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
| `plugins/git-workflow` | 0.1.5 | Git 工作流：`/gcommit` 规范提交、`/gpr` PR 描述、`/gchangelog` 变更日志；`PostToolUse` 钩子在提交后校验消息 |
| `plugins/dev-workflow` | 0.4.1 | 日常开发流程：7 个 skill + `.devflow` / `docs/plans` 计划落盘 + `/handoff` 会话契约 + `SessionStart` 仓库快照 + 23 个专项子智能体自动安装到 `~/.zcode/agents` |
| `plugins/guardrails` | 0.1.2 | 确定性安全护栏：`PreToolUse` 硬拦不可逆命令与硬编码密钥，发布/部署/迁移转为确认弹窗 |
| `plugins/websearch` | 0.1.6 | 独立网页搜索：零依赖 MCP server，AnySearch / Exa / Parallel / Bing / SearXNG 自动回退，每个引擎可免 Key 用免费额度、也可填自己的 Key；另带静态网页正文读取 |
| `plugins/model-speed` | 0.1.0 | 在输入框显示当前模型输出速度（tokens/s），按会话区分，零依赖 extension |

四个插件互不依赖，可单独启用。`guardrails` 会阻断操作，独立成插件便于单独关闭。

## 安装

**方式一：GitHub 市场（推荐，任意机器）**

1. 打开 ZCode **设置 → 插件**，右上角「创建/添加」→ **添加插件市场**，选 **GitHub 源**
2. 填仓库：`JochenYang/zcode-plugin`（公开仓库，无需额外配置）
3. 在列表中按需**启用** `git-workflow` / `dev-workflow` / `guardrails`
4. `dev-workflow` 启用后，下次会话启动时 23 个子智能体会自动安装到 `~/.zcode/agents`

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
| `change-plan` | 新功能/重构/复杂修复前 | 可执行计划 + `.devflow/<slug>.md`（任务级验收依据），有回归面时同时写 `docs/plans/<slug>.md`（Work items / Phases Gate / Test plan / Phase log） |
| `debug` | bug/测试失败/构建失败 | 铁律：根因未明不提出修复；复现→取证→可证伪假设→根因→最小修复→回归验证，含 `git bisect`、跨层边界日志、连续 3 次失败即停；细则见 `references/` |
| `test-changed` | 当前改动要验证 | 最小有效测试范围 + 证据记录 + 阶段 Gate 判定，并把 Test plan 结果与 Phase log 回写到持久计划 |
| `review` | 要审查改动 | P0–P3 分级发现，带 `path:line`、`introduced`/`pre-existing` 与证据等级，四档 verdict，三轮未收敛即停 |
| `commit-review` | 提交前 | READY/NOT READY + 分支名与提交消息提案 + Testing / Risk / How to revert 三行（不实际提交） |
| `release-check` | 发版/打 tag 前 | GO/NO-GO/CONDITIONAL GO + 阻塞项与解除路径（不实际发布） |
| `doc-gen` | 写/更新文档 | API 文档/CHANGELOG/README/用户文档/迁移指南/feature map，声明可回指代码 |

命令与钩子：

- `/handoff [save|show|clear]` — 把**会话级**契约落盘到 `.zcode/handoff.md`，跨压缩与跨会话保留目标和验收标准；任务级验收依据由 `change-plan` 写在项目内 `.devflow/`，两者并存时以任务级计划为准
- `SessionStart` 钩子（`startup` / `clear` / `compact`）自动注入分支、未提交文件数、最近 3 条提交、`.devflow/` 下活跃计划与 `.zcode/handoff.md` 摘要，省掉每次会话开头的多次 git 调用
- `startup` 时另一条钩子自动同步 23 个专项子智能体到 `~/.zcode/agents`（ZCode 不加载插件目录内的 agent，必须复制出来；只装缺失、刷新它自己写过的文件，用户手改过的跳过）。子智能体的 `tools:` 是字面白名单——写错工具名等于没有这项能力；列了 `WebFetch` 的 agent 会连带获得宿主附带的只读 `mcp__web_reader__webReader`
- `/agents-sync [diff|export|install]` — 安装已是自动的，这里只用于：`diff` 对比本地与插件资产、`export` 把本地手改的 agent 推回仓库、`install` 强制覆盖重装

核心机制：`change-plan` 把计划与验收标准落盘为 `.devflow/<slug>.md`（有回归面时加 `docs/plans/<slug>.md`），下游 5 个 skill 与全部子智能体都按它对照；持久计划用 Work items 状态流转与 Phases Gate 管进度，Gate 行只能由 `test-changed` 在跑完验证后写入。5 个下游 skill（`test-changed` / `review` / `commit-review` / `release-check` / `doc-gen`）结案前各做一次自查：命令绿了不等于验收满足、看起来合理不算证据、用户说测过了只是口述——任一条不满足，`commit-review` 不得 READY、`release-check` 不得 GO。

推荐生命周期：`change-plan → 实现 → test-changed → review → gcommit → release-check → doc-gen`

提交前检查已并入 `/gcommit`；`commit-review` 保留给「一批改动需要拆成多个提交」的场景。

## guardrails

两个 `PreToolUse` 钩子，是这套插件里唯一不依赖模型自觉的确定性约束。

**`deny`（硬阻断，模型收到明确原因）** — 不可逆且无回退路径：

- `rm` 指向根级目标（`/`、`~`、`.`、`..`、`*`）、系统目录或 `~/.ssh` `~/.aws` 等凭据目录
- `git push --force`（放行 `--force-with-lease`）、`reset --hard`、`clean -fd`、`filter-branch`/`filter-repo`、删除远程分支
- `DROP TABLE/DATABASE/SCHEMA`、`TRUNCATE`
- `mkfs*`/`fdisk`/`parted`、`dd of=/dev/*`、重定向到裸块设备、`chmod 777 /`
- 磁盘级 Windows 命令：`format C:`、`Format-Volume`、`diskpart`、`Clear-Disk`、`Initialize-Disk`
- 写入内容含真密钥格式：AWS `AKIA…`、私钥块、GitHub `ghp_`/`github_pat_`、GitLab `glpat-`、Slack `xox*`、Stripe `sk_live_`、Google `AIza…`、OpenAI `sk-…`

**`ask`（转为确认弹窗）** — 可逆但代价高：

- 删除类动词越出项目目录：绝对路径不在项目下、`../` 越界、`~/` 下的路径、未展开的变量（`/tmp`、`/var/tmp` 放行）
- `git checkout .`/`restore .`（一次丢弃全部本地修改）、`commit --amend`、`rebase`（放行 `--continue`/`--abort`/`--skip`）、push 到 `main`/`master`/`prod`、`git tag`
- `sudo`、`curl … | sh`
- 无 WHERE 风险的 `UPDATE`/`DELETE FROM`、各语言的 migrate 命令、`reg delete`
- `npm/cargo/gem/twine publish`、`docker push`、`terraform apply|destroy`、`kubectl`、`helm`、`vercel --prod`、云 CLI 的 delete/terminate
- 写入 `.env*`（放行 `.env.example`/`.template`/`.sample`）、`id_rsa`、`*.pem`、`.npmrc`、`credentials`、`secrets.*`
- 疑似密钥赋值（20 字符以上字面量赋给 `password`/`secret`/`api_key` 等）、JWT

删除判定按**位置**而非命令形态，所以项目内清理完全不打扰。`rm`、cmd 的 `del`/`rd`/`rmdir` 与 PowerShell 的 `Remove-Item` 走同一套位置检查：

| 目标 | 判定 |
|---|---|
| 项目内（相对路径、或绝对路径落在项目目录下） | 静默放行 |
| `/tmp`、`/var/tmp` | 静默放行 |
| 项目外（绝对路径越界、`../` 越界、`~/…`、`$env:…`、未展开变量） | `ask` |
| 根级、盘根（`C:\`、`C:/*`）、系统目录、凭据目录 | `deny` |

`rm -rf node_modules`、`del /s /q .\dist`、`Remove-Item -Recurse .\build`、`rm -rf /d/codes/<本项目>/build` 都不弹窗；`rm -rf ../another-project`、`Remove-Item -Recurse D:\codes\other` 会问一次。`git rm` 只作用于仓库内已跟踪文件，交给 git 自己把关，不触发判定。

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

## websearch

独立的网页搜索插件，自带一个零依赖 MCP server（`bin/server.mjs`，Node 18+ 的全局 fetch，无 node_modules）。工具是 `web_search` 与 `fetch_page`，模型看到的完整名字为 `mcp__plugin_websearch_search__web_search` / `mcp__plugin_websearch_search__fetch_page`。

- 引擎链 `anysearch → exa → parallel → bing → searxng`，失败或空结果自动换下一个；一次调用共用一个总预算（默认 20s），预算耗尽的引擎记入 `skipped`
- **免 Key 可用**：不填 Key 走各引擎的免费额度；额度用完时 `attempts[].hint` 会提示。当前版本 ZCode 的插件详情页**没有配置表单**，Key 与引擎顺序等写在 `$ZCODE_PLUGIN_DATA/websearch.json`（即 `~/.zcode/cli/plugins/data/websearch@zcode-plugin/websearch.json`），也可用环境变量 `ANYSEARCH_API_KEY` / `EXA_API_KEY` / `PARALLEL_API_KEY`（文件优先）
- 设置项：引擎顺序、禁用列表、fallback/rotate、默认条数、总超时、Bing 市场、SearXNG 实例、三个可选 Key；清单里也声明了 `userConfig`，等 ZCode 支持配置表单后无需改本插件即可用
- 工具描述里写明了路由：需要最新信息/天气/新闻时先用 `web_search`，只有已知确切 URL 才用 `fetch_page`
- 安全边界写在自己代码里：只允许 http/https、拒绝回环/内网/链路本地（含云元数据地址）/CGNAT/唯一本地地址、每跳重定向重新校验、响应上限 2 MB、请求超时——MCP server 是普通本地进程，没有宿主守门
- 手动入口：`/websearch <query> [--engine bing]`，单引擎排查最快
- 与内置 `WebSearch` 不冲突也不互相替代：内置那个走模型 provider 的服务端原生搜索，只在特定 provider 端点下存在；插件在任何 provider 下都可用

引擎表、设置项细节、安全边界与已知限制见 `plugins/websearch/README.md`。

## 校验

仓库自带两个零依赖检查（需要 Python 3.8+ 与 bash），改动插件后手动跑：

```bash
python scripts/check-consistency.py             # 版本、agent 数量、frontmatter、引用、行尾、shell 语法
python plugins/guardrails/tests/test-hooks.py   # 两个钩子的判定矩阵，90 个用例
python plugins/websearch/tests/test-server.py   # websearch MCP server（加 --live 才发真实网络请求）
```

`check-consistency.py` 拦的是人工评审反复漏掉的那类漂移：版本只在一处改了、agent 数量与文案不符、frontmatter 写了 ZCode 不认的键、引用了不存在的文件、残留已删除机制的提法。`test-hooks.py` 把两个钩子的每条判定钉住，改规则时误伤别的判定会立刻失败——它用真实钩子进程跑，不是模拟。目前没有 CI 绑定。

## 参考

- 官方插件文档：<https://zcode.z.ai/cn/docs/plugin>
- 钩子机制与调试：本机 `zcode-guide` 插件中的 `diagnosing-hooks` 技能



