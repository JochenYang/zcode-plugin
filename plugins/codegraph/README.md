# codegraph

ZCode 的本地代码图谱插件：一个零 npm 依赖的 MCP server，用随包的 tree-sitter wasm 把工作区里 35 行语言索引成「符号 / 引用 / 调用 / 导入」图，存进插件数据目录下的 SQLite；模型通过三个工具直接拿到精确的 `file:line` 行段，替代「Grep 一轮、整文件 Read 一轮」的反复试探。**不联网、不遥测、不执行项目代码。**

模型看到的工具名带插件命名空间：`mcp__plugin_codegraph_codegraph__<tool>`。

## 工具

| 工具 | 参数 | 做什么 |
|---|---|---|
| `codegraph_status` | `refresh?: boolean` | 索引状态：`ready` / `building` / `empty`、文件数、符号数、覆盖语言、陈旧文件数；`refresh: true` 强制增量同步（符合自动索引条件的项目会借此启动后台构建） |
| `codegraph_lookup` | `operation: search \| symbol \| callers \| callees \| impact \| outline`，`query?`、`name?`、`file?`、`depth?`（1–6，默认 2）、`limit?`（1–200，默认 20）、`body?: boolean` | 定位符号、调用者、被调用者、改动影响面、文件大纲；每行一个符号，带精确行段，`body=true` 且函数体 ≤ 30 行时内联源码，否则给出要 Read 的行段 |
| `codegraph_map` | `path?`、`budget?`（200–4000 tokens，默认 1200） | 仓库地图：目录 → 文件 → 关键符号，按引用数排序，按 token 预算截断 |

`search` 用 `query`；`symbol` / `callers` / `callees` / `impact` 用 `name`（加 `file` 消歧）；`outline` 用 `file`。

`search` 的 `query` 可以是符号名、前缀，也可以是一句描述（`gift card redeem`、`sign in auth cookie browser`），词序不限：没有名字同时含所有词时，以其中最长的两个词为锚找部分匹配，同时含更多查询词的排前面，并在首行标明（`18 partial matches (no name has all words; best match: gift + card + redeem)`）。结果按相关度排序——完全同名优先，其次以查询开头的名字，同一层里源码符号排在测试和脚本前面——所以截断时留下的是最相关的行。`symbol` 的入边是全部引用：函数写作 `called by`，类型、常量、字段写作 `used by`；`body=true` 在同一次调用里带回定义源码。前 3 行的行尾带「谁在用它」：` · 12 uses in 4 files (3 in source)`（其它文件里的引用数、所在文件数、其中源码文件数），其中有按唯一名字连上的引用时数字带 `~`；被大量引用的符号只给 ` · 15361 references (not broken down by file)`。

关系带置信标记：`=` import 解析确定；`~` 同名唯一（可能是同名误连）；`?` 未解析、歧义或动态调用——`?` 对结论重要时用 Grep 复核。截断时末行标 `(N of M shown)`；构建中首行标 `indexing N% (results partial)`；有陈旧文件时标 `stale: N files changed since index`。

## 索引什么时候建、什么时候更新

- **会话一打开就开始，不等模型调用工具。** 每个会话有自己的 codegraph 服务进程，握手完成时它在后台做一次刷新：项目还没索引且符合自动索引条件就建第一次索引，已索引就检查文件变化并增量同步。模型什么都不用做。
- **模型随时能看到状态。** 会话开头由钩子注入一行状态和指引（见下）；如果索引是在会话中途才建完的，下一条用户消息处会再注入一次就绪通知，每个会话只通知一次。
- 首次构建的耗时取决于项目大小：几百个文件几秒，一千多个文件十几秒，上万文件一两分钟。构建期间的查询带着 `indexing N% (results partial)` 标记照常返回已有的部分。
- 低于自动索引门槛（默认 30 个受支持文件）或关闭了 `autoIndex` 的项目不会自动建；家目录和盘根从不自动索引。
- **代价**：这是一项默认开启的行为，适用于每个打开过的项目，不管模型有没有用到 codegraph。首次构建占 CPU（4 个工作线程，构建期间与自己的构建 / 测试争抢），索引留在插件数据目录里，实测约 26 KB 每个文件（1.8 万文件的项目约 471 MB）。不想要就在设置里关掉 `autoIndex`；要回收磁盘就删除数据目录下 `indexes/<项目键>/`，下次会话需要时会重建。目前没有按项目单独关闭的开关。

## 钩子

三个 `type: "process"` 钩子（`hooks/hooks.json`，按约定自动加载，不需要在清单里声明）：

- **`SessionStart`**（`startup` / `resume` / `clear` / `compact`）：读索引的 `status.json`，向模型注入 ≤ 120 token 的上下文——索引就绪（N 文件 / M 符号 / 覆盖语言）、构建中（进度）、未索引（会话开始时自动建，下一条消息会报告就绪；条件不满足时说明原因）或出错，索引就绪时再加一句「什么时候用 `codegraph_lookup` / `codegraph_map`，什么时候用 Grep / Read」的指引。
- **`UserPromptSubmit`**：只在「索引在本次会话开始后才建完、且还没告诉过这个会话」时，注入一次与上面相同的就绪状态和指引；其余每条消息都静默退出（读一个状态文件、查一个标记，约 60 ms）。按会话记标记，所以同一个会话不会被重复通知。
- **`PostToolUse`**（`Edit` / `Write`，宿主把 `ApplyPatch` 当作它们的别名）：**只在索引目录已经存在时**向 `dirty.log` 追加一行 `<mtimeMs>\t<相对路径>`；索引器在下一次查询前消费它做增量同步。索引目录不存在就什么都不做，绝不创建目录。标脏只是加速器：没有钩子时索引器靠 mtime + size 扫描也能保持正确。

任何读不到、解析失败或文件系统错误都 exit 0 且不输出——钩子永远不会因为记账失败而拖垮会话。

## 安装要求

- **Node ≥ 22.13**（`node:sqlite` 与 `node:worker_threads`）。
- **MCP server**：清单写的是 `"command": "node"`。ZCode 在 MCP 侧有内置 Node 回退（Electron 自带的 Node 22.22.1，`~/.zcode/cli/node-fallback/v1`），所以系统没装 Node 也能跑。
- **钩子只认 PATH**：钩子进程没有这个回退。PATH 里没有 `node` 时三个钩子静默失效（宿主按超时或找不到命令跳过），索引仍由 server 在会话开始时静默建好、靠 mtime 扫描保持正确，只是少了会话开头的指引、索引建完后的就绪通知与编辑后的即时标脏。想三个钩子都生效，装一个 Node 22.13+ 并确保 `node` 在 PATH 上。
- **首次构建在后台**：符合条件的项目在会话打开时就开始建索引（见上），期间结果标 partial；`codegraph_status` 报告进度。

## 配置

配置文件在插件数据目录：

```text
Windows   C:\Users\<你>\.zcode\cli\plugins\data\codegraph@zcode-plugin\codegraph.json
macOS/Linux  ~/.zcode/cli/plugins/data/codegraph@zcode-plugin/codegraph.json
```

只写要改的键，其余用默认值；保存后开新会话生效。

| 键 | 默认 | 说明 |
|---|---|---|
| `autoIndex` | `true` | 符合条件的项目自动建索引；`false` 时只认手动 `refresh` |
| `minFilesToAutoIndex` | `30` | 支持语言的文件数低于此值不自动建（小目录不值得跑） |
| `maxFiles` | `30000` | 项目文件总数超过此值不自动建 |
| `exclude` | `[]` | 额外排除（字符串数组），叠加在内置忽略（`node_modules`、`.git`、`dist`、`build`、`out`、`target`、`vendor`、`.codegraph`）之后 |
| `languages` | `null` | 只启用列出的语言包 id；`null` = 全部 |
| `defaultBudgetTokens` | `{ "lookup": 1500, "map": 1200 }` | 单次输出的 token 预算 |
| `frontload` | `false` | 预留 |

自动索引条件：`autoIndex` 开、项目根不是家目录或盘根、支持语言的文件数 ≥ `minFilesToAutoIndex`、总文件数 ≤ `maxFiles`。四条都满足才建，否则 `codegraph_status` 说明原因。

环境变量（配置文件里对应字段为空时生效）：`CODEGRAPH_AUTO_INDEX`、`CODEGRAPH_MIN_FILES`、`CODEGRAPH_MAX_FILES`、`CODEGRAPH_EXCLUDE`（逗号分隔）、`CODEGRAPH_LIFTOFF_ONLY`（`1` 打开 V8 的 `--liftoff-only` 保险开关，索引慢约 1.6 倍）。

清单里的 `userConfig`（`autoIndex` / `minFiles` / `maxFiles` / `exclude` / `liftoffOnly`）通过 `${user_config.*}` 展开成上面这些变量。当前版本的 ZCode 插件详情页没有配置表单，这些值实际取默认；等 ZCode 支持表单后无需改插件。

## 语言

35 行 = 33 个有符号抽取的语言包 + COBOL、Liquid 文件级。扩展名与规则以 `languages/<id>.mjs` 为准；「语法来源」A = npm `tree-sitter-wasms@0.1.13` 的构建，B = `colbymchenry/codegraph` 仓库的构建（含补丁），许可与版权全文见 `THIRD-PARTY-NOTICES.md`。

| 分组 | 语言 | 扩展名 | 语法来源 |
|---|---|---|---|
| Web / TS | TypeScript（含 TSX） | `.ts .tsx .mts .cts` | A |
| | JavaScript | `.js .jsx .mjs .cjs` | A |
| | ArkTS | `.ets` | B |
| | Svelte | `.svelte` | embedded_template（A）+ JS/TS 嵌入 |
| | Vue | `.vue` | A + JS/TS 嵌入 |
| | Astro | `.astro` | embedded_template（A）+ JS/TS 嵌入 |
| | ASP.NET Razor / Blazor | `.cshtml .razor` | embedded_template（A）+ C# 嵌入 |
| 脚本 | Python | `.py .pyi` | A |
| | Ruby | `.rb` | A |
| | PHP | `.php` | A |
| | Lua | `.lua` | B |
| | Luau | `.luau` | B |
| | R | `.r .R` | B |
| | Liquid | `.liquid` | 无语法：文件级（只进文件表与 map，保留 include 边） |
| 系统 | Go | `.go` | A |
| | Rust | `.rs` | A |
| | C | `.c .h` | A |
| | C++ | `.cpp .hpp .cc` | A |
| | Objective-C | `.m .mm` | A |
| | Metal | `.metal` | 复用 C++ 语法（A） |
| | CUDA | `.cu` | 复用 C++ 语法（A） |
| JVM / .NET / 移动 | Java | `.java` | A |
| | Kotlin | `.kt .kts` | A |
| | Scala | `.scala .sc` | A |
| | C# | `.cs` | A |
| | VB.NET | `.vb` | B（含补丁） |
| | Dart | `.dart` | A |
| | Swift | `.swift` | B（原 A 构建在 TurboFan 升级时让进程崩溃，已替换） |
| 领域 / 遗留 | Solidity | `.sol` | A |
| | Terraform / OpenTofu | `.tf .tfvars .tofu` | B（Apache-2.0） |
| | Nix | `.nix` | B |
| | Pascal / Delphi | `.pas .dpr .dpk .lpr` | B |
| | CFML | `.cfc .cfm .cfs` | B（cfml / cfscript / cfquery 三个语法） |
| | Erlang | `.erl .hrl .escript .app.src .app` | B（Apache-2.0） |
| 文件级 | COBOL | `.cbl` 等 | 不随包：`tree-sitter-cobol` 的 wasm 让 Node 进程崩溃，只进文件表与 map |

## 隐私

- **零遥测、零外联**：没有 `fetch`，没有更新检查，语法 wasm 全部随包（约 65 MB），断网可用。
- **不执行项目代码**：只读源码做解析，不 import、不 build、不跑脚本。
- **索引位置**：`~/.zcode/cli/plugins/data/codegraph@zcode-plugin/indexes/<项目键>/`，内含 `graph.db`（SQLite）、`status.json`、`dirty.log`、`dirty.offset`、`lock`。项目键是项目根规范化后 sha256 的前 16 位，Windows 下大小写不敏感。项目目录内不写任何文件；删掉整个 `indexes/` 即可重置。
- 源码不离开本机；工具输出只含符号名、签名、路径与行号，`body=true` 时才内联 ≤ 30 行的函数体。

## 已知限制

- **COBOL 只有文件级**：不抽取符号，只出现在文件表与 map。
- **Liquid 没有可用语法**：文件级 + include 边，不抽取符号。
- **动态语言精度有限**：`getattr`、动态 import、反射、运行时生成的代码不连边（标 `?`）；成员调用只在属性名全局唯一时连边；`~` 表示按名唯一，同名不同物可能误连。
- **search 行尾的引用数不是调用图的全集**：只算已连边的跨文件引用（未解析的 `?` 不计），按唯一名字连上的会让数字带 `~`；`Error`、`stringify` 这类被大量引用（超过 2000 处）的符号只给总数。哪些文件算测试 / 脚本靠路径清单识别（`repo.mjs` 的 `SECONDARY_PATH_PARTS`），清单外的测试布局会被算作源码。
- **首次构建在后台**：大仓库第一次查询拿到的可能是 partial 结果，`codegraph_status` 看进度；构建完成后自动就绪。
- **索引可能滞后几秒**：外部编辑（非 ZCode 工具）靠下一次查询前的 mtime 扫描补上；工具输出首行会标 `stale: N`。
- **钩子依赖 PATH 里的 node**：见「安装要求」。
- **每个会话一个 server 进程**：多个会话各自打开同一个 SQLite，写入走 pid 文件锁；拿不到锁的会话只读（查询照常，不同步）。

## 开发与验证

```bash
node --check plugins/codegraph/bin/hook.mjs plugins/codegraph/bin/server.mjs
node --test plugins/codegraph/tests/hooks/*.test.mjs     # 钩子：真实 spawn，含 Windows 管道路径
python scripts/check-consistency.py                      # 版本四处一致、行尾、市场 source
```

## 目录

```text
plugins/codegraph/
├── .zcode-plugin/plugin.json   # 清单：mcpServers（含 CODEGRAPH_* env 映射）+ commands + userConfig
├── bin/server.mjs              # MCP server 入口（Node ≥ 22.13 检查、--liftoff-only 保险）
├── bin/hook.mjs                # 钩子入口：session-start / post-tool
├── hooks/hooks.json            # SessionStart + UserPromptSubmit + PostToolUse，type: process
├── commands/codegraph.md       # /codegraph [refresh]
├── src/                        # 路径、引擎、索引器、解析、存储、MCP、渲染
├── languages/*.mjs             # 语言包（每包一个文件，无中央清单）
├── grammars/                   # wasm、运行时、参考查询、许可文本
└── tests/                      # node --test，按 lane 分目录
```

---

## English summary

codegraph is a local code-graph plugin for ZCode: a zero-dependency MCP server that indexes 35 language rows (33 symbol-extracting packs plus COBOL and Liquid at file level) with bundled tree-sitter wasm into SQLite under the plugin data folder, and exposes three tools — `codegraph_status`, `codegraph_lookup` (search / symbol / callers / callees / impact / outline) and `codegraph_map` — returning exact `file:line` ranges so the model reads only what it needs; the leading rows of a search also say who uses them (` · 12 uses in 4 files (3 in source)`, `~` when some of those links are by unique name). The index is built or refreshed silently when a session opens, so a new project is indexed without the model asking. Three hooks (`SessionStart` for the status and guidance, `UserPromptSubmit` to announce an index that became ready mid-session, `PostToolUse` to append edited files to `dirty.log`) are accelerators only; the server's mtime scan keeps the index correct without them. Requirements: Node ≥ 22.13; the MCP side has ZCode's built-in Node fallback, the hooks resolve `node` from PATH only. No network, no telemetry, no project code execution. Configuration: `~/.zcode/cli/plugins/data/codegraph@zcode-plugin/codegraph.json` (`autoIndex`, `minFilesToAutoIndex`, `maxFiles`, `exclude`, `languages`) with `CODEGRAPH_*` environment variables that only apply when the file leaves the field unset. Known limits: COBOL and Liquid are file-level, dynamic language features stay unresolved (`?`), the first build runs in the background.
