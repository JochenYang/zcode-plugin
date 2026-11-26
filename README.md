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
| `plugins/git-conventions` | 0.1.0 | 提交信息规范钩子：`PreToolUse` 在 git 运行前校验 `git commit` 写下的提交信息（标题格式与 50 字符上限、正文 `-` 列表与末尾 `Verified:` 行），不合规直接拒绝 |
| `plugins/dev-workflow` | 0.9.1 | 日常开发流程：7 个 skill + `.devflow` / `docs/plans` 计划落盘 + 多轮审查收敛协议 + `/handoff` 会话契约 + `SessionStart` 仓库快照 + 23 个专项子智能体自动安装到 `~/.zcode/agents`（它们用 codegraph 定位代码，需要同时启用 `codegraph`） |
| `plugins/guardrails` | 0.2.1 | 确定性安全护栏：`PreToolUse` 硬拦不可逆命令与硬编码密钥，发布/部署/迁移转为确认弹窗（完全访问下不弹，硬拦不变） |
| `plugins/websearch` | 0.2.0 | 独立网页搜索：零依赖 MCP server，AnySearch / Exa / Parallel / Bing 自动回退，每个引擎可免 Key 用免费额度、也可填自己的 Key；另带静态网页正文读取 |
| `plugins/model-speed` | 0.1.0 | 在输入框显示当前模型输出速度（tokens/s），按会话区分，零依赖 extension |
| `plugins/codegraph` | 0.2.0 | 本地代码图谱：零依赖 MCP server，35 行语言的 tree-sitter 索引存进插件数据目录的 SQLite，`codegraph_status` / `codegraph_lookup` / `codegraph_map` 三个工具直接给出精确 `file:line`，`lookup` 还能列 import 环与受改动影响的测试文件；索引在会话打开时自动建立或刷新，`SessionStart` / `UserPromptSubmit` / `PostToolUse` 三个钩子告诉模型图谱何时就绪、何时该用它；桌面端另有输入框状态位与索引管理面板；零遥测、零外联、不执行项目代码 |

各插件互不依赖，可单独启用。`guardrails` 会阻断操作，独立成插件便于单独关闭。

## 安装

**方式一：GitHub 市场（推荐，任意机器）**

1. 打开 ZCode **设置 → 插件**，右上角「创建/添加」→ **添加插件市场**，选 **GitHub 源**
2. 填仓库：`JochenYang/zcode-plugin`（公开仓库，无需额外配置）
3. 在列表中按需**启用** `git-conventions` / `dev-workflow` / `guardrails`
4. `dev-workflow` 启用后，下次会话启动时 23 个专项子智能体会自动安装到 `~/.zcode/agents`；它们依赖 `codegraph` 插件，要一起启用

**方式二：本地开发目录**

1. **设置 → 插件** → 「创建/添加」→ **添加插件市场**，填入本目录路径：`D:\codes\zcode-plugin`
2. 在「个人」分段按需启用
3. 改完插件代码后回「市场源」面板刷新。注意：安装缓存以 `<插件名>/<version>` 为键，**改了插件必须同时提升 `plugin.json` 的 `version`**，否则刷新后仍是旧版本

## git-conventions

在提交落库之前拦住不合规的提交信息。一个 `PreToolUse` 钩子挂在 Bash 上：命令里有带新写信息的 `git commit` 时，先取出提交信息按规范校验，不合规就直接拒绝并说明原因，git 根本不会运行。相比「提交之后再提醒」，它不依赖模型自觉去改。

| 部分 | 要求 |
|---|---|
| 标题 | `<type>(<scope>): <subject>`；type 取 `feat` `fix` `docs` `style` `refactor` `perf` `test` `chore` `build` `ci` `revert`，scope 可省略，冒号前可带 `!` 表示破坏性变更；英文、首字母小写、不以句号结尾、不超过 50 字符 |
| 正文（可省略） | 每行一条 `- ` 开头的改动点，缩进的续行除外；末尾一行 `Verified: <验证结论>`，结论折行也算。`Co-authored-by:` 这类 trailer 不算列表项，会被拒 |

- 认得的写法：`-m "…"`（可多个）、`-F <文件>`、`-F -` 配 heredoc 或 here-string；`cd … &&`、`git -C <目录>`、`-am` 这类合并短选项；`if`、`for`、`sudo`、`eval`、子 shell 里的提交；同一行里先赋值的变量（`MSG="…"; git commit -m "$MSG"`）与 `"$(cat <<'MSG' … MSG)"`。路径按 shell 的规则解析：相对路径以 `cd` 或 `git -C` 之后的目录为准，Git Bash 风格的 `/d/…` 和 `~` 也能认。
- 不校验的情况：没有新写信息的提交（不带信息的 `git commit`——它从不从标准输入读消息、`--amend --no-edit`、`-C`、`--fixup`）；消息原文里还留着解析不了的变量或命令替换；读不到的 `-F` 文件；喂给 `bash`/`sh` 的脚本正文和 `xargs` 里的提交。规范钩子永远不该成为提交失败的原因，这些一律放行。
- 合并、revert 产生的提交不经过 `git commit`，不校验。`--no-verify` 绕不过它，那是 git 自己的钩子开关。
- 只在 ZCode 的 Bash 工具里生效；终端或 IDE 里提交不经过它。完全访问模式下同样拦截。
- 需要 PATH 里有 Node 14 及以上，钩子没有内置回退，没有时它静默不运行。
- 「英文祈使」无法机械判定，只检查首字母小写。

## dev-workflow

7 个 flow skill 覆盖开发生命周期，合适时机自动触发，也可输入 `/` 从「技能」分组手动选用：

| Skill | 时机 | 产出 |
|---|---|---|
| `change-plan` | 新功能/重构/复杂修复前 | 可执行计划 + `.devflow/<slug>.md`（任务级验收依据），有回归面时同时写 `docs/plans/<slug>.md`（Work items / Phases Gate / Test plan / Phase log） |
| `debug` | bug/测试失败/构建失败 | 铁律：根因未明不提出修复；复现→取证→可证伪假设→根因→最小修复→回归验证，含 `git bisect`、跨层边界日志、连续 3 次失败即停；细则见 `references/` |
| `test-changed` | 当前改动要验证 | 最小有效测试范围 + 证据记录 + 阶段 Gate 判定，并把 Test plan 结果与 Phase log 回写到持久计划 |
| `review` | 要审查改动 | P0–P3 分级发现，带 `path:line`、`introduced`/`pre-existing` 与证据等级，四档 verdict，三轮未收敛即停；第二轮起或高风险走多轮收敛协议（`review-gate.mjs`） |
| `commit-review` | 提交前 | READY/NOT READY + 分支名与提交消息提案 + Testing / Risk / How to revert 三行（不实际提交） |
| `release-check` | 发版/打 tag 前 | GO/NO-GO/CONDITIONAL GO + 阻塞项与解除路径（不实际发布） |
| `doc-gen` | 写/更新文档 | API 文档/CHANGELOG/README/用户文档/迁移指南/feature map，声明可回指代码 |

命令与钩子：

- `/handoff [save|show|clear]` — 把**会话级**契约落盘到 `.zcode/handoff.md`，跨压缩与跨会话保留目标和验收标准；任务级验收依据由 `change-plan` 写在项目内 `.devflow/`，两者并存时以任务级计划为准
- `SessionStart` 钩子（`startup` / `clear` / `compact`）自动注入分支、未提交文件数、最近 3 条提交、`.devflow/` 下活跃计划与 `.zcode/handoff.md` 摘要，省掉每次会话开头的多次 git 调用
- `startup` 时另一条钩子自动同步 23 个专项子智能体到 `~/.zcode/agents`（ZCode 不加载插件目录内的 agent，必须复制出来；只装缺失、刷新它自己写过的文件、删掉它写过而插件已不再提供的文件，用户手改过的跳过）。子智能体的 `tools:` 是字面白名单——写错工具名等于没有这项能力；列了 `WebFetch` 的 agent 会连带获得宿主附带的只读 `mcp__web_reader__webReader`；列了 `Bash` 的 agent 反而拿不到 `Grep` / `Glob`（宿主只在 Bash 不可用时才注册这两个工具，搜索走 Bash 内置的 `grep` / `find`），所以正文按「有这两个工具就用，没有就走 `Bash`」写。子智能体的 `description` 是主模型判断何时派它的依据——列表里除了它只有名字和工具，Kimi 那套单独的触发字段在 ZCode 不生效——按「角色 + 触发语 + 与相近 agent 的分流 + 能力边界」写；内置的 `Explore` 与 `general-purpose` 不重复提供，代码侦察直接用内置 `Explore`
- 派发子智能体时，一条 `PreToolUse` 钩子（匹配 `Agent` 工具）在主模型上下文里补一句回收提醒：返回后先抽查，实现类复跑并把条目标成已改未审，审查类把发现写进裁决文件，分析类先复现它结论依赖的那一步；缺上下文或跑偏用 `SendMessage` 续用而不是重开。它不拦截、无状态。子智能体在后台运行，`Agent` 工具在派发那一刻就返回，所以提醒只能放在派发时
- 23 个专项子智能体都带 codegraph 的两个工具（`codegraph_lookup`、`codegraph_map`）来定位代码与调用关系，正文里也写了先 codegraph 再 `grep`。**`tools:` 里出现 MCP 工具名就是硬性要求**：codegraph 没装、被禁用或它的服务没连上时，这 23 个子智能体都派不出去（宿主报 `Required MCP tool is not available in the parent MCP snapshot`），所以 0.8.0 起 dev-workflow 依赖 codegraph。要卸载 codegraph，先把 dev-workflow 回到 0.7.0，或删掉 23 个文件里 `tools:` 下的那两行
- `/agents-sync [diff|export|install]` — 安装已是自动的，这里只用于：`diff` 对比本地与插件资产、`export` 把本地手改的 agent 推回仓库、`install` 强制覆盖重装

核心机制：`change-plan` 把计划与验收标准落盘为 `.devflow/<slug>.md`（有回归面时加 `docs/plans/<slug>.md`），下游 5 个 skill 与全部子智能体都按它对照；持久计划用 Work items 状态流转与 Phases Gate 管进度，Gate 行只能由 `test-changed` 在跑完验证后写入。ZCode 没有按匹配度派发的机制，派谁全靠主模型读子智能体清单来决定，所以 `debug`、`test-changed`、`change-plan`、`release-check` 在该交接的步骤点名角色：排查与取证派 `detective`，验证派 `tester`，审查派 `reviewer`（安全面加 `guard`，跨层加 `integrator`），重大决策前派 `oracle`，发布配置派 `ops`，新页面与改版先派 `ux-designer` 出规格，实现按层派专才、没有归属的派 `builder`。`change-plan` 的「派发」一节定了什么时候派（读写量大、可并行、要独立，三者至少一项）、什么时候自己做（点、线的改动与难而小的推理）、交接单写什么，以及派发批次如何对应 Work items（返回后是 `[~]`，Gate 与审查通过才是 `[x]`）。5 个下游 skill（`test-changed` / `review` / `commit-review` / `release-check` / `doc-gen`）结案前各做一次自查：命令绿了不等于验收满足、看起来合理不算证据、用户说测过了只是口述——任一条不满足，`commit-review` 不得 READY、`release-check` 不得 GO。

多轮审查收敛：审查进入第二轮，或改动为高风险时，`reviewer` 只产出 findings 与证据，主会话逐条核实并把裁决写进 `.devflow/<slug>/review-<round>.json`，`scripts/review-gate.mjs` 按八道闸门判出 `converged` / `needs_user_confirmation` / `stop_max_rounds` / `continue`。存在状态文件时，`commit-review` 只在最新一轮 `converged` 后放行。

推荐生命周期：`change-plan → 实现 → test-changed → review → 提交 → release-check → doc-gen`

提交前的改动范围检查用 `commit-review` skill；提交信息由 `git-conventions` 插件的钩子在提交前校验。

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

确认级只在「本来就要确认」的模式下生效。ZCode 会把会话当前的权限模式传给钩子：处于**完全访问**（`yolo`）时，上面整段 `ask` 直接放行——否则即使开了完全访问，推送主分支、打 tag、发布这些照样弹窗，因为 ZCode 对钩子的确认是叠加在权限模式之上的；`deny` 在任何模式下都拦，而且**硬拦优先于确认**：一条命令或一次写入里同时有硬拦和确认级内容时直接拦，不会先弹确认再放行整条命令。自主模式（`guarded`）、默认模式，以及不传这个字段的旧版本，照旧询问。

删除判定按**位置**而非命令形态，所以项目内清理完全不打扰。`rm`、cmd 的 `del`/`rd`/`rmdir` 与 PowerShell 的 `Remove-Item` 走同一套位置检查：

| 目标 | 判定 |
|---|---|
| 项目内（相对路径、或绝对路径落在项目目录下） | 静默放行 |
| `/tmp`、`/var/tmp` | 静默放行 |
| 项目外（绝对路径越界、`../` 越界、`~/…`、`$env:…`、未展开变量） | `ask` |
| 根级、盘根（`C:\`、`C:/*`）、系统目录、凭据目录 | `deny` |

`rm -rf node_modules`、`del /s /q .\dist`、`Remove-Item -Recurse .\build`、`rm -rf /d/codes/<本项目>/build` 都不弹窗；`rm -rf ../another-project`、`Remove-Item -Recurse D:\codes\other` 会问一次。`git rm` 只作用于仓库内已跟踪文件，交给 git 自己把关，不触发判定。命令里的 `;`、`&&` 和换行不论前后有没有空格都按命令分隔处理，制表符按空格处理：前面的删除到分隔处结束，后面的命令按它自己的规则判定（`cd …` 换行后跟 `git push --force` 一样被拦）。`find` 以 `-delete`、`-exec rm …` 结尾或接 `| xargs rm …` 时按它的起点判定位置：删除动作之前有过滤条件的，起点只按危险位置拦（`find . -name "*.log" -delete` 不弹窗，`find /etc -type f -delete` 被拦）；没有过滤条件的，起点就是删除目标（`find . -delete` 等同 `rm -rf .`，被拦）。`git clean` 逐个读选项：带强制又有目录或忽略文件标志的拦，试运行和交互模式不拦。被反斜杠转义的分隔符（`find … -exec … \;`、`grep "a\|b"`）不算命令分隔。here-document 的正文也逐行照常检查，引号也不被解析（`echo 'rm -rf /'` 会被拦）——这两处是有意的保守取舍：正文常常就是随后要执行的脚本或提交信息。只想写入一段提到危险命令的文本时，用 Write 工具（不受这条规则影响）或逃生阀。

设计要点：

- 只扫描新写入的内容（`content` / `new_string`），**不扫 `old_string`** —— 否则「把硬编码密钥改成读环境变量」这个修复动作本身会被它拦住
- 逃生阀：项目根 `.zcode/guardrails-allow`，每行一个 ERE，命中即放行（`#` 开头为注释）。例：某项目确实需要跑 `terraform apply`，写入 `^terraform apply` 即可
- 两个钩子都阻塞执行。能交给 bash 做的就不另起进程：每档规则没有命中时只跑一次 `grep`，取字段、去引号、盘符归一化都由 bash 完成。Windows 上实测每次 Bash 调用约 150ms、每次写入约 240ms，优化前分别约 1300ms 和 730ms（规则命中需要确认时约 300ms）

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

- 引擎链 `anysearch → exa → parallel → bing`，失败或空结果自动换下一个；一次调用共用一个总预算（默认 20s），预算耗尽的引擎记入 `skipped`
- **免 Key 可用**：不填 Key 走各引擎的免费额度；额度用完时 `attempts[].hint` 会提示。当前版本 ZCode 的插件详情页**没有配置表单**，Key 与引擎顺序等写在 `$ZCODE_PLUGIN_DATA/websearch.json`（即 `~/.zcode/cli/plugins/data/websearch@zcode-plugin/websearch.json`），也可用环境变量 `ANYSEARCH_API_KEY` / `EXA_API_KEY` / `PARALLEL_API_KEY`（文件优先）
- 设置项：引擎顺序、禁用列表、fallback/rotate、默认条数、总超时、Bing 市场、三个可选 Key；清单里也声明了 `userConfig`，等 ZCode 支持配置表单后无需改本插件即可用
- 工具描述里写明了路由：内置 `WebSearch` / `WebFetch` 可用时优先用内置的，本插件是它们不可用时的替代（`fetch_page` 另在确实需要页面原文时可用）；需要先找 URL 时先搜索，已知确切 URL 才读正文
- 安全边界写在自己代码里：只允许 http/https、拒绝回环/内网/链路本地（含云元数据地址）/CGNAT/唯一本地地址、每跳重定向重新校验、引擎 Key 不跟跨源重定向走、响应上限 2 MB、一次请求一个截止时间——MCP server 是普通本地进程，没有宿主守门
- 手动入口：`/websearch <query> [--engine bing]`，单引擎排查最快
- 与内置 `WebSearch` 不冲突也不互相替代：内置那个走模型 provider 的服务端原生搜索，只在特定 provider 端点下存在；插件在任何 provider 下都可用

引擎表、设置项细节、安全边界与已知限制见 `plugins/websearch/README.md`。

## codegraph

本地代码图谱插件，自带一个零 npm 依赖的 MCP server（`bin/server.mjs`，`node:sqlite` + 随包 tree-sitter wasm，无 node_modules）。模型看到的工具是 `mcp__plugin_codegraph_codegraph__codegraph_status` / `__codegraph_lookup` / `__codegraph_map`。

- **35 行语言**（33 个有符号抽取的语言包 + COBOL、Liquid 文件级），覆盖 TypeScript/JavaScript、Python、Go、Rust、C/C++、Java/Kotlin/Scala、C#/VB.NET、PHP/Ruby、Vue/Svelte/Astro、Terraform、Solidity 等；语法 wasm 全部随包，来源与许可见 `plugins/codegraph/THIRD-PARTY-NOTICES.md`
- `codegraph_lookup`（search / symbol / callers / callees / impact / outline）每行一个符号、带精确行段，替代「Grep 一轮 + 整文件 Read 一轮」；没有符号叫这个名字时（库的函数、方法调用、类型名，以及 JS/TS 里点号读取的属性、对象的键、JSX 属性名与类型的成员）`search` 列出使用它的位置；`codegraph_map` 替代 Glob + 逐个读文件头；关系带置信标记 `=` import 解析、`~` 同名唯一、`?` 未解析或动态
- 索引存 `~/.zcode/cli/plugins/data/codegraph@zcode-plugin/indexes/<项目键>/`，项目目录内不写文件；符合条件（`autoIndex` 开、支持语言文件 ≥ 30、总数 ≤ 30000、非家目录/盘根）的项目在**会话打开时**就开始在后台建索引（MCP 握手完成即启动，不等模型调用工具），已索引的项目同时检查文件变化并增量同步；`codegraph_status` 报告进度与陈旧文件数
- 之后的代码变更是**静默、惰性**更新的：文件监听（2 秒去抖）、`PostToolUse` 钩子、每次调用前的 mtime 扫描只把改过的文件标脏，真正重新解析发生在**下一次 codegraph 工具调用之前**（不到 200 个文件前台同步，更多则转后台构建）；没有工具调用就不会重新解析，也不会提醒模型
- 三个钩子都是加速器：`SessionStart`（startup/resume/clear/compact/fork）注入 ≤ 120 token 的索引状态与「何时用图、何时用 Grep」指引；`UserPromptSubmit` 在索引于会话中途才建好时通知一次（每个会话一次）；`PostToolUse`（Edit/Write，含 ApplyPatch 别名）只在索引目录已存在时向 `dirty.log` 追加一行，绝不创建目录。没有钩子时 server 靠 mtime 扫描照样正确
- 索引存储会自己整理：每次会话打开时删除超过 `maxIdleDays`（默认 90 天）没再用过的索引，并可在总量超过 `maxTotalMB` 时从最久没用的删起；项目目录暂时找不到不是删除理由，正在被别的会话写入的也不动。`/codegraph storage` 列出本机所有项目的索引（路径、状态、大小、上次使用），`/codegraph clean [all | current | <项目>]` 手动清理
- 桌面端另有界面入口（ZCode 未公开文档的扩展接口，首次激活要确认）：输入框工具栏的状态位显示当前项目索引的状态（文件数 / 构建百分比 / 出错 / 未开启），点开是索引管理面板——列出本机所有索引，删除与清理到期索引都分两步，清理策略在这里改；跟随应用的主题与语言，样式用 ZCode 自己的沙箱样式表（Apache-2.0，来源与许可见 `plugins/codegraph/THIRD-PARTY-NOTICES.md` §7）
- **Node ≥ 22.13**。MCP 侧 ZCode 有内置 Node 回退（Electron 的 Node 22.22.1），**钩子只认 PATH**——PATH 里没有 `node` 时钩子静默失效，索引仍正确
- 配置文件 `~/.zcode/cli/plugins/data/codegraph@zcode-plugin/codegraph.json`（`autoIndex` / `minFilesToAutoIndex` / `maxFiles` / `exclude` / `languages` / `maxIdleDays` / `maxTotalMB`），环境变量 `CODEGRAPH_*` 仅在配置文件未设置该项时生效；项目根的 `.zcode/codegraph.json` 可以只针对这个项目关闭索引或追加排除（只能收紧，不能放宽用户设置）；手动入口 `/codegraph [refresh | storage | clean …]`
- 已知限制：COBOL 与 Liquid 只有文件级；`getattr`、动态 import、反射不连边；首次构建在后台、期间结果标 partial；浅色主题下状态徽章等几处官方样式的对比度不到 WCAG AA

工具参数、配置键、语言表、隐私与限制见 `plugins/codegraph/README.md`。

## 校验

仓库自带两个零依赖检查（需要 Python 3.8+ 与 bash），改动插件后手动跑：

```bash
python scripts/check-consistency.py             # 版本、agent 数量、frontmatter、agent 描述、引用、行尾、shell 语法；个人规则备份落后时提示
python plugins/guardrails/tests/test-hooks.py   # 两个钩子的判定矩阵，198 个用例（含权限模式维度）
python plugins/websearch/tests/test-server.py   # websearch MCP server（加 --live 才发真实网络请求）
node --test plugins/websearch/tests/*.test.mjs  # websearch 网络层：跨源重定向不带引擎 Key、截止时间覆盖响应体、GBK 解码、描述里的让位句
node --test plugins/git-conventions/tests/*.test.mjs  # 提交信息钩子：认得的命令写法、规范各条规则、读不出消息时放行
python plugins/dev-workflow/tests/test-sync-agents.py  # 子智能体同步钩子：刷新、保护手改、清理插件已下架的、兼容旧 state
python plugins/dev-workflow/tests/test-review-gate.py  # 多轮审查闸门脚本：八道闸门、字段交叉校验与不合法状态的退出码（需要 node）
python plugins/dev-workflow/tests/test-on-dispatch.py  # 派发提醒钩子：三种角色各一句、始终退出 0、输出是 PreToolUse 的 additionalContext、提示词里提到 subagent_type 不改判
node --test plugins/codegraph/tests/hooks/*.test.mjs  # codegraph 钩子：真实 spawn，SessionStart 文案/schema、dirty.log 协议、hooks.json 字段
node --test plugins/codegraph/tests/extension/       # codegraph 桌面端扩展：状态位、面板的工具，以及面板在无头浏览器里的检查（要 Chrome 或 Edge）
```

`check-consistency.py` 拦的是人工评审反复漏掉的那类漂移：版本只在一处改了、agent 数量与文案不符、frontmatter 写了 ZCode 不认的键、引用了不存在的文件、残留已删除机制的提法、agent 描述把任务交给一个不存在的 agent 或与内置类型撞名。`test-hooks.py` 把两个钩子的每条判定钉住，改规则时误伤别的判定会立刻失败——它用真实钩子进程跑，不是模拟。目前没有 CI 绑定。

派发是否用对，拿本机会话库量：`node scripts/dispatch-stats.mjs 2026-11-01` 读出各类型的派发数、`general-purpose` 占比、小派发占比（不超过 3 次工具调用）、`SendMessage` 续用次数，以及每次派发的 token 与耗时。它只读，不打印提示词、命令和路径；需要 Node 22.13+。

## 个人规则备份

`zcode-personal-rules/AGENTS.md` 是 `~/.zcode/AGENTS.md`（ZCode 全局规则）的备份。它不是插件资产，不随插件安装；源头仍是 `~/.zcode/AGENTS.md`，改了之后把备份跟上：

```bash
cp ~/.zcode/AGENTS.md zcode-personal-rules/AGENTS.md   # 备份
cp zcode-personal-rules/AGENTS.md ~/.zcode/AGENTS.md   # 恢复
```

`check-consistency.py` 会比对两份内容，不一致时提示备份没跟上（只提示，不算失败）；机器上没有 `~/.zcode/AGENTS.md` 时跳过。Kimi 与 DSH 共用的那份在 kimicode-configure 的 `kimi-personal-rules/`，两边是有意分开的。

## 参考

- 官方插件文档：<https://zcode.z.ai/cn/docs/plugin>
- 钩子机制与调试：本机 `zcode-guide` 插件中的 `diagnosing-hooks` 技能



