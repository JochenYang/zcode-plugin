# codegraph 插件：40+ 语言代码图谱 MCP

- Status: active
- Plan date: 2026-11-23
- Risk: medium

> 状态列是唯一进度源：Gate 通过前必须逐行更新该阶段条目；禁止用「本轮完成度」之类的汇总段代替状态列。

## Goal / Why

给 ZCode 做一个零 npm 依赖的 `codegraph` 插件（MCP server + 钩子）：模型直接从本地代码图谱取「符号定义、调用者、被调用者、影响面、文件大纲、仓库地图」，替代多轮 Grep + Read 整文件。语言范围对标 `colbymchenry/codegraph` README「Supported Languages」表的全部 **35 行**，一次做完。成功标准：35 行全部覆盖（34 个语言包通过契约测试；COBOL 的语法 wasm 会让 Node 进程崩溃，暂按文件级）；真实仓库上查询位置正确、编辑后索引新鲜；首建在后台完成且不阻塞会话。

**定位（用户 2026-11-24 确认）**：codegraph 是**定向工具**——帮 LLM 快速理解和定位项目结构、相关逻辑与依赖文件。模型跟随任务自动选择调用，找到关键文件和关系图并计入上下文后不再调用；它不替代 grep，grep 的后续使用是正常的。所以收益衡量的是「开头是否采用」和「到达关键文件用了多少次调用」，不是调用次数或探索成本。

## Scope

- Must-have:
  - 35 行语言的语言包（见 Parallel lanes L1–L5），每个包通过同一套契约测试。
  - 3 个工具：`codegraph_status`、`codegraph_lookup`（search / symbol / callers / callees / impact / outline）、`codegraph_map`。
  - 持久化索引（`node:sqlite`，插件数据目录），钩子驱动的新鲜度：SessionStart 指引 + PostToolUse 标脏 + 查询前增量同步。
  - 输出为 token 设计：一行一符号、路径相对仓库根、截断必标 `(N of M shown)`、源码默认不回灌（≤ 30 行的函数体才内联，否则给精确 Read 行段）、关系带置信标记（`=` import 解析、`~` 同名唯一、`?` 未解析或动态）。
  - 零遥测、零外联（语法 wasm 全部随包）；不执行项目代码。
  - `scripts/check-consistency.py` 通过；四处版本号一致。
- Out of scope:
  - Rust 原生内核、LSP 桥、向量检索、SCIP 后端。
  - 修改既有插件的行为（`check-consistency.py` 只做加法：排除 `.wasm` 的 CRLF 检查）。
  - 仓库内共享索引（配置留字段，不实现）。

## Ruled out

| 方案 | 为什么排除 |
|---|---|
| 适配 `colbymchenry/codegraph` CLI 作为最终方案 | 平台包约 50 MB 且自带 Node；MCP 内不建索引要先 `init`；遥测默认开、启动即查更新；守护进程脱离插件生命周期；默认只暴露 `explore` 且单次回灌 13–24K 字符，驻留上下文 +80% |
| Serena / LSP 为主 | 应用层 GPL-3.0 不能随包；需 uv + 各语言工具链；语言服务器启动常超 30 s |
| SCIP 精度后端 | 需各语言编译器、全量重建、大项目 8 GB 堆；无现成的 `.scip` → 图谱库 |
| 向量 / 本地嵌入 | `transformers.js` 带原生 onnxruntime 307 MB；FTS5 先行性价比更高 |
| 搬 `codeidx` 代码 | GPL-3.0 |
| 引入 npm 运行时依赖（含 `tree-sitter-wasms` 包本身） | 插件从市场安装不跑 `npm install`；只取 wasm 产物与 `web-tree-sitter` 运行时文件随包 |
| `tree-sitter-wasms` 搭配 `web-tree-sitter` ≥ 0.26 | 不兼容（tree-sitter issue #5171）；固定 `web-tree-sitter@0.25.10` |
| Node 18/20 兼容 | `node:sqlite` 需 ≥ 22.13；改用 sql.js 会失去已验证的 FTS5 与落盘能力，不值得 |

## Work items

| # | 类目 | 内容 | 负责人 | 状态 |
|---|------|------|--------|------|
| W1 | P0 | 插件骨架：目录、`.zcode-plugin/plugin.json`（`mcpServers`/`hooks`/`userConfig`）、`bin/server.mjs`（MCP 握手，复用 `plugins/websearch/bin/server.mjs` 的 JSON-RPC 写法）、`bin/selftest.mjs` | 主 agent | [x] |
| W2 | P0 | `LanguageSpec` 契约（`src/languages/README.md` + JSDoc 类型）、通用抽取引擎 v0（`src/extract/engine.mjs`：definitions / calls / imports / references / 内嵌脚本块）、TypeScript 参考实现 `languages/typescript.mjs`、契约测试 `tests/contract.test.mjs` 与 fixture 格式 | 主 agent | [x] |
| W3 | P0 | 语法来源与装载器：35 行语言的 wasm 来源表（`tree-sitter-wasms@0.1.13` / `codegraph` 随包 / 官方包）、许可表、`grammars/loader.mjs`、随包 `web-tree-sitter@0.25.10` 运行时、`THIRD-PARTY-NOTICES.md`、`--grammars` 冒烟 | 主 agent | [x] |
| W4 | P0 | 存储层：`schema.sql`、`src/store/db.mjs`、`repo.mjs`（files / symbols / refs / imports / dirty 的 CRUD、按文件原子替换、FTS5） | 主 agent | [x] |
| W5 | P1 | ZCode 机制实测并记录：MCP server 的 `process.cwd()`、响应内联上限、SessionStart / PostToolUse 的输入输出 schema、Node 版本检测与报错文案 | 主 agent | [x] |
| W6 | P0 | Lane A 索引核心：walker（`git ls-files -co --exclude-standard` / 内置忽略 / 大小与数量上限）、内容哈希、`worker_threads` 解析池、indexer 编排、sync（`dirty.log` / mtime+size 比对 / `fs.watch`）、pid 判活锁、`status.json` | 子智能体 A | [x] |
| W7 | P0 | Lane B 解析与查询：import 策略（node / python / go / jvm / dotnet / none）、名字解析管线（import → 同文件唯一 → 全局唯一，歧义上限）、JS/TS/Ruby `locals.scm` 作用域解析、queries（search / symbol / callers / callees / impact / outline）、map（引用图 PageRank + token 预算） | 子智能体 B | [x] |
| W8 | P0 | Lane C MCP 与渲染：工具 schema、命令式工具描述、`render/text.mjs`、`render/budget.mjs`、`config.mjs`（数据目录 JSON + 环境变量兜底）、`paths.mjs`（项目根 / 索引目录 / 语法目录） | 子智能体 C | [x] |
| W9 | P0 | Lane D 钩子与打包：`hooks/hooks.json`、`bin/hook.mjs`（session-start / post-tool）、`dirty.log` 写入协议、`commands/codegraph.md`、插件 README（zh/en）、`check-consistency.py` 排除 `.wasm`、市场条目草稿与根 README 两行 | 子智能体 D | [x] |
| W10 | P0 | Lane L1 Web/TS 语言包：TypeScript（`.ts .tsx .mts .cts`）、JavaScript（`.js .jsx .mjs .cjs`）、ArkTS（`.ets`）、Svelte、Vue、Astro、ASP.NET Razor/Blazor（`.cshtml .razor`，脚本块抽取） | 子智能体 L1 | [x] |
| W11 | P0 | Lane L2 脚本语言包：Python（`.py .pyi`）、Ruby、PHP、Lua、Luau、R、Liquid（文件级 + include 边） | 子智能体 L2 | [x] |
| W12 | P0 | Lane L3 系统语言包：Go、Rust、C（`.c .h`）、C++（`.cpp .hpp .cc`）、Objective-C（`.m .mm`）、Metal（→ C++ 语法）、CUDA（→ C++ 语法） | 子智能体 L3 | [x] |
| W13 | P0 | Lane L4 JVM/.NET/移动语言包：Java、Kotlin（`.kt .kts`）、Scala（`.scala .sc`）、C#、VB.NET、Dart、Swift | 子智能体 L4 | [x] |
| W14 | P0 | Lane L5 领域/遗留语言包：Solidity、Terraform/OpenTofu（`.tf .tfvars .tofu`）、Nix、Pascal/Delphi（`.pas .dpr .dpk .lpr`）、CFML（`.cfc .cfm .cfs`）、Erlang（`.erl .hrl .escript .app.src .app`）。COBOL 不随包（见 Deferred），由 `languages/cobol.mjs` 以 `support: 'file-level'` 覆盖扩展名 | 子智能体 L5 | [x] |
| W15 | P0 | 集成：server ↔ indexer ↔ store ↔ resolver ↔ render 接线；自动索引规则（支持语言文件 < 30 不建、家目录/根目录拒建、文件数上限、后台构建与进度） | 主 agent | [x] |
| W16 | P0 | 真实仓库 e2e：本仓库、`codegraph` 克隆（1,945 个 TS 文件）、`psf/requests`、`gin-gonic/gin`；10 个手核对符号；编辑后新鲜度；多会话锁 | 主 agent | [x] |
| W17 | P1 | 性能门槛：首建 / 单文件增量 / 查询 P95（`selftest --perf`） | 主 agent | [x] |
| W18 | P1 | 失败安全：解析错误降级为文件级、损坏索引自动重建、Node 版本不足的明确报错、离线零网络 | 主 agent | [x] |
| W19 | P1 | 收益测量（由我 CreateSession 在 ZCode 内执行）：真实开发任务开关两臂，记录工具调用数与 token 到 `.devflow/codegraph-plugin/bench.md`。11-24 起收窄为 T1/T2/T3/T6/T7 五个任务、三方对照（基线 / 关插件 / W23）；16:25 起主指标改为定向指标（开头是否采用、到达关键文件的调用数）。最终 13 个会话。未做：T6 的 W23 臂（用户叫停）、T7 的干净三方对照（基线臂与关臂读过参考答案，未重跑） | 主 agent | [x] |
| W20 | OPT | `codegraph_explore`（词法排序 + 预算 + 小片段）；理由：是否做取决于 W19 数据 | 主 agent | [–] |
| W21 | P1 | 会话开始即索引（W19 之后按用户要求新增）：握手时服务在后台静默建 / 刷新索引，未索引项目不再依赖模型先调用工具；家目录 / 盘根与 `autoIndex: false` 时不碰磁盘；`UserPromptSubmit` 钩子把「索引在本会话中途建好」通知一次（每条用户消息约 60 ms，已实测）；顺带修掉就绪行超 120 token 被静默丢弃、`SessionStart` 缺 `fork` | 主 agent | [x] |
| W22 | P2 | 文档与市场：图标已定稿（`assets/codegraph.png`，SVG 源 `assets/codegraph.svg`），市场条目的 `icon` 已是用户上传的 CDN 地址；市场描述（zh-CN）、安装说明、Node ≥ 22.13 说明；11-24 把市场条目与根 README 的中英文描述同步到当前行为（会话打开即建 / 刷新索引、三个钩子） | 主 agent | [x] |
| W23 | P1 | search 质量 v2（来自 W19 基线发现）：兜底每词一条谓词（词序无关）、≤2 字符的 ASCII 词须整词且该规则下推到 SQL 候选池、完全同名优先且源码先于测试/脚本、结果保持相关度顺序（不再按 path 重排）、非可调用 kind 的入边写作 `used by`；空结果的处理在 v2.1 改为锚定最长的两个词做部分匹配（子集重试对 4–5 个词的查询轮不到两词组合）；SessionStart 指南按**任务类型**触发并带「需求 → 操作」映射（写成「查名字」时模型直接用 `rg`）；顺带修带 `kind` 时 SQL 参数绑定错位。11-24 晚补修：「源码先于测试 / 脚本」的目录规则此前在**仓库根目录**下不生效（索引里的路径没有前导斜杠），`tests/`、`scripts/`、`spec/`、`e2e/`、`benchmarks/` 都被当成源码；现匹配前补斜杠，清单补 Go / pytest / Django / C# / 快照目录，每一项都有用例 | 主 agent | [x] |
| W24 | P2 | search 结果的前 3 行带「谁依赖它」（` · 12 uses in 4 files (3 in source)`）；理由：定向的那一次调用就带上一片图谱，T20 的 13 个会话里模型在第一次编辑后从没回来查过 `callers` / `impact`。按唯一名字连上的引用让数字带 `~`；被引用超过 2000 处的符号只给总数（否则单词查询在 cindy 上多花 100–150 ms） | 主 agent | [x] |

类目：P0 不做就走不通 · P1 静默失败或数据风险 · P2 清理与一致性 · OPT 可选（不做要写明理由）。

状态流转（就地更新，不得跳级）：
- `[ ]` 待办 → `[~]` 已改未审 → `[x]` 审查通过
- `[?]` 审查不通过，已回退或待重做；`[–]` 本轮不做（写明理由）；`[!]` 待用户决定，阻塞当前阶段直到裁决后转 `[x]` / `[?]` / `[–]`

## Phases

| 阶段 | 包含条目 | Gate |
|------|----------|------|
| 0 契约与骨架 | W1–W5 | T1–T5 PASS；35 种语法全部可加载；子智能体审查无阻塞 |
| 1 并行开发 | W6–W14 | T6–T15 PASS；每条 lane 的文件边界未被越界；子智能体审查无阻塞 |
| 2 集成与验证 | W15–W19 | T16–T20 PASS（T20 由用户执行，未完成前不得标 done） |
| 3 收尾 | W21、W22、W23、W24（W20 视 W19 数据：未开启） | T21–T25 PASS；安装进 ZCode 跑通 |

## Parallel lanes（阶段 1）

各 lane 只能写自己名下的路径；共享契约由阶段 0 冻结，lane 不得改。语言包发现引擎缺口时，先在自己的包内用 `hooks`（语言包内的自定义函数）解决；确需改契约的，写进 `.devflow/codegraph-plugin/contract-requests.md`，由主 agent 串行处理。

| Lane | 独占可写路径 | 依赖的只读契约 |
|------|-------------|----------------|
| A 索引核心 | `src/index/*`、`tests/index/*` | W2 引擎接口、W4 repo 接口、W9 的 `dirty.log` 路径约定 |
| B 解析与查询 | `src/resolve/*`、`src/graph/*`、`tests/resolve/*`、`tests/graph/*` | W2 抽取输出格式、W4 schema |
| C MCP 与渲染 | `src/mcp/*`、`src/render/*`、`src/config.mjs`、`src/paths.mjs`、`tests/mcp/*`、`tests/render/*` | W7 查询接口（阶段 0 给出签名桩） |
| D 钩子与打包 | `hooks/*`、`bin/hook.mjs`、`commands/*`、插件 `README.md`、`.zcode-plugin/plugin.json`、`scripts/check-consistency.py`、根 `README.md` / `README.en.md` / `marketplace.json` 的新增行 | `src/paths.mjs` 的目录约定（阶段 0 定） |
| L1–L5 语言包 | `languages/<lang>.mjs`、`tests/languages/<lang>.test.mjs`、`tests/fixtures/langs/<lang>/*` | W2 契约 + `tests/contract.test.mjs`、W3 语法装载器 |

语言分组：L1 = TypeScript、JavaScript、ArkTS、Svelte、Vue、Astro、Razor/Blazor；L2 = Python、Ruby、PHP、Lua、Luau、R、Liquid；L3 = Go、Rust、C、C++、Objective-C、Metal、CUDA；L4 = Java、Kotlin、Scala、C#、VB.NET、Dart、Swift；L5 = Solidity、Terraform、Nix、Pascal/Delphi、CFML、Erlang，外加 COBOL 的 `file-level` 包。合计 35 行（34 个有符号抽取的语言包）。

## Affected behaviors

| 行为 | 类型 | 位置 |
|---|---|---|
| 新增 MCP server 与 3 个工具 | added | `plugins/codegraph/bin/server.mjs`、`src/mcp/tools.mjs` |
| 新增 SessionStart / PostToolUse 钩子 | added | `plugins/codegraph/hooks/hooks.json`、`bin/hook.mjs` |
| 新增本地索引（插件数据目录） | added | `src/index/*`、`src/store/*` |
| 新增 35 个语言包 | added | `plugins/codegraph/languages/<lang>.mjs` |
| 一致性脚本跳过 `.wasm` 的 CRLF 检查 | modified | `scripts/check-consistency.py` |
| 市场新增 `codegraph` 条目、根 README 两行 | modified | `marketplace.json`、`README.md`、`README.en.md` |

## Test plan

| # | 用例 | 输入/操作 | 预期 | 验证方式 | 结果 |
|---|------|-----------|------|----------|------|
| 1 (W2) | 契约测试在 TypeScript 参考包上通过 | 运行契约测试 | 符号的 kind/name/行范围、import、调用点与 `expected.json` 完全一致；`broken.ts` 不抛错 | `node --test plugins/codegraph/tests/contract.test.mjs` | PASS (`node --test plugins/codegraph/tests/contract.test.mjs` → 3/3, exit 0, 2026-11-23) |
| 2 (W3) | 32 个语法全部可加载 | `selftest --grammars` | 每种语言加载 wasm 并解析最小 fixture，0 个 ERROR 节点 | `node plugins/codegraph/bin/selftest.mjs --grammars` | PASS (`node plugins/codegraph/bin/selftest.mjs --grammars` → 32 loaded, 0 ERROR, exit 0, 2026-11-23) |
| 3 (W3) | 许可表完整 | 脚本比对 | 每个随包 wasm 在 `THIRD-PARTY-NOTICES.md` 有条目 | `node plugins/codegraph/bin/selftest.mjs --licenses` | PASS (`node plugins/codegraph/bin/selftest.mjs --licenses` → 193 checks incl. sha256, exit 0, 2026-11-23) |
| 4 (W4) | 存储层 | 单测 | 建库、CRUD、FTS5 命中、按文件原子替换后无残留 | `node --test plugins/codegraph/tests/store/*.test.mjs` | PASS (`node --test plugins/codegraph/tests/store/*.test.mjs` → 26/26, exit 0, 2026-11-23) |
| 5 (W5) | ZCode 机制实测 | 手工 | cwd / 内联上限 / 钩子 schema / Node 版本四项有记录 | `.devflow/codegraph-plugin/zcode-facts.md` | PASS (`.devflow/codegraph-plugin/zcode-facts.md`, 227 行代码级证据, 2026-11-23) |
| 6 (W6) | walker | 单测 | git 仓用 `git ls-files`；非 git 目录用内置忽略；超限文件跳过 | `node --test plugins/codegraph/tests/index/walker.test.mjs` | PASS (`node --test plugins/codegraph/tests/index/*.test.mjs` → index 套件 76/76 含 walker, exit 0, 2026-11-23) |
| 7 (W6) | 增量只重解析变更文件 | 改 1 个文件后 sync | 解析计数只增加 1；该文件旧行全部替换 | `node --test plugins/codegraph/tests/index/sync.test.mjs` | PASS (同上：增量只重解析变更文件用例, exit 0, 2026-11-23) |
| 8 (W6) | 标脏与锁 | 两进程同时写 | `dirty.log` 被消费且不重复；第二个进程等待或只读 | `node --test plugins/codegraph/tests/index/lock.test.mjs` | PASS (同上：dirty.log 消费、pid 锁（零字节锁/陈旧锁/等待）用例, exit 0, 2026-11-23) |
| 9 (W7) | import 解析 | TS / Python / Go 多文件 fixture | 跨文件引用标 `=`；相对导入、包入口解析正确 | `node --test plugins/codegraph/tests/resolve/imports.test.mjs` | PASS (`node --test plugins/codegraph/tests/resolve/*.test.mjs plugins/codegraph/tests/graph/*.test.mjs` → 49/49, exit 0, 2026-11-23) |
| 10 (W7) | 作用域反例 | 变量遮蔽同名函数 | 遮蔽后的引用不连到函数（无 `~` 误连） | `node --test plugins/codegraph/tests/resolve/locals.test.mjs` | PASS (同上：locals 遮蔽反例, exit 0, 2026-11-23) |
| 11 (W7) | 查询与地图 | 已知图的小型 fixture | callers / callees / impact / outline 结果正确；预算 100 时出现截断标记 | `node --test plugins/codegraph/tests/graph/*.test.mjs` | PASS (同上：queries/map 与预算截断反例, exit 0, 2026-11-23) |
| 12 (W1, W8) | MCP 协议 | stdio 握手与调用 | `initialize` / `tools/list` / `tools/call` 正常；非法 JSON 返回错误码且进程不退出 | `node --test plugins/codegraph/tests/mcp/*.test.mjs` | PASS (`node --test plugins/codegraph/tests/mcp/*.test.mjs …` → 115 用例 114 过 1 跳过（indexer 缺失分支）, exit 0, 2026-11-23) |
| 13 (W8) | 渲染 | 固定图快照 | 输出与快照一致；超预算时含 `(N of M shown)`；无源码回灌 | `node --test plugins/codegraph/tests/render/*.test.mjs` | PASS (同上：render 快照与 45 KB 上限, exit 0, 2026-11-23) |
| 14 (W9) | 钩子 | 喂样例输入 | SessionStart 输出合法 JSON 且含 `additionalContext`；PostToolUse 对 Edit/Write 追加一行；未知工具或坏输入时 exit 0 | `node --test plugins/codegraph/tests/hooks/*.test.mjs` | PASS (`node --test plugins/codegraph/tests/hooks/*.test.mjs` → 19/19, exit 0, 2026-11-23) |
| 15 (W10–W14) | 34 个语言包契约 | 对每个包跑契约测试 | 全部通过；扩展名无冲突 | `node --test plugins/codegraph/tests/languages/*.test.mjs plugins/codegraph/tests/contract.test.mjs` | PASS (`node --test plugins/codegraph/tests/contract.test.mjs` → 75/75（34 个语言包 + COBOL/Liquid 文件级）; lane 测试 76/76, exit 0, 2026-11-23) |
| 16 (W15) | 自动索引规则 | 29 个支持文件的家目录-like 工作区 | 不自动建索引，`status` 说明原因 | `node --test plugins/codegraph/tests/e2e/autoindex.test.mjs` | PASS (`node --test plugins/codegraph/tests/index/*.test.mjs` 自动索引规则用例; `tests/e2e/stale.test.mjs` 删除/新增文件对账, exit 0, 2026-11-23) |
| 17 (W16) | 真实仓库与新鲜度 | 4 个仓库；编辑一个文件后再查 | 10 个手核对符号位置全对；编辑后行号更新；两进程不损坏库 | `node --test plugins/codegraph/tests/e2e/*.test.mjs` | PASS (`CODEGRAPH_E2E_REPOS=… node --test plugins/codegraph/tests/e2e/*.test.mjs` → 11/11：4 个真实仓库定位、钩子路径新鲜度、双实例锁; 用户仓库 dsh 8,384 文件/cindy 17,830 文件定义抽样 299/300、298/300, exit 0, 2026-11-23) |
| 18 (W17) | 性能门槛 | `selftest --perf` | `codegraph` 克隆首建 ≤ 15 s（4 worker）；单文件增量 ≤ 200 ms；lookup P95 ≤ 50 ms | `node plugins/codegraph/bin/selftest.mjs --perf <path>` | PASS (`CODEGRAPH_E2E_PERF=1 …real-repos.test.mjs` 首建 8.5–12.9 s ≤ 15 s; 200 文件项目单文件增量 35–57 ms; 3,228 引用大文件 356–450 ms（引擎抽取占 ~200 ms）; lookup P95 < 1 ms, exit 0, 2026-11-23) |
| 19 (W18) | 失败安全 | 损坏库 / 旧 Node / 禁网 | 库损坏自动重建；旧 Node 报出所需版本；`offline` 下 `fetch` 调用次数为 0 | `node --test plugins/codegraph/tests/e2e/failures.test.mjs` | PASS (`node --test plugins/codegraph/tests/e2e/failures.test.mjs` → 3/3：旧 Node 报错、离线零网络、损坏索引重建, exit 0, 2026-11-23) |
| 20 (W19) | 收益测量 | 在 ZCode 内跑真实开发任务（五个任务，基线 / 关插件 / 新版 search 各臂） | 主指标（用户 11-24 定位：codegraph 是定向工具）：开头是否采用、到达关键文件用了多少次调用；辅助：探索阶段调用与 token、改动文件召回 | `.devflow/codegraph-plugin/bench.md`（汇总 + 各任务）、`time-to-truth.mjs`、`first-query-replay.mjs` | PASS（13 个会话：有 codegraph 时到达真值文件中位 6 次调用，没有则 12 次；首查命中 旧版 2/4、v2.0 0/2，v2.1 回放 7/7；首次编辑后再调用 0 次。约束：每臂一次运行，T6 / T7 的关臂与 T7 基线臂读过参考答案，T7 v2.0 臂修错了层） |
| 21 (W22) | 一致性脚本 | 运行 | 退出码 0；四处版本号一致 | `python scripts/check-consistency.py` | PASS（2026-11-24 多次，ALL CHECKS PASSED） |
| 22 (W22) | 安装验证 | 安装插件并开会话 | 工具出现在工具表；SessionStart 注入可见；一次真实查询正确 | 手工 | PASS（2026-11-24 重装后在新项目会话 `sess_adf11df9` 验证：开头注入 building 状态、模型零调用下索引自己建完、第二条消息处注入就绪状态、随后 `codegraph_status` 与 `codegraph_lookup` 调用成功） |
| 23 (W23) | search 质量 | 单元测试（含 8 条真实首查的表驱动用例、SQL 候选池与词过滤一致性用例约 1,700 种组合、变异验证）；两个真实索引上新旧对比；从工作树启动真实 MCP server 端到端 | 模型实际用过的查询得到相关结果；精确名查询结果不变；最坏查询 ≤ 400 ms | `node --test plugins/codegraph/tests/`；`node .devflow/codegraph-plugin/first-query-replay.mjs`；`node .tmp/e2e/mcp-search.mjs "<query>"…` | PASS（v2.1：首查回放 7/7 指向真值包；`"sign in auth cookie browser"` 0 → 60 行、`"reasoning efforts discovery merge"` 0 → 60 行；耗时 70–490 ms；审查 `.devflow/codegraph-plugin/review-3-search.md`、`review-4-search-relaxation.md`。11-24 晚修复根目录测试 / 脚本目录不被识别后：dsh 真实索引 `search "map"` 的第一行不再是 `scripts/…`，七条首查回放仍 7/7，见 `review-6-usage-summary.md`） |
| 24 (W21) | 会话开始即索引 | 真实进程只握手不发工具调用；真实 ZCode 会话 | 未索引项目的索引自己建好并能回答；建完后的第一条用户消息处注入就绪状态，且每个会话只注入一次；家目录与 `autoIndex: false` 不创建任何东西；握手后立刻发起的查询保持 3 s 上界 | `node --test plugins/codegraph/tests/e2e/warm-start.test.mjs plugins/codegraph/tests/hooks/`；`node .tmp/e2e/silent-start-guards.mjs` | PASS（2026-11-24：真实会话 `sess_adf11df9` 17:12:51 注入 building、17:15:49 就绪、17:16:07 注入 ready；1,661 文件项目握手后首查 3.16 s 返回；审查 `review-5-silent-start.md`） |
| 25 (W24) | search 带依赖摘要 | 单元测试；真实索引输出 | 前 3 行带 `uses in N files (M in source)`，其余行与其它操作不受影响 | `node --test plugins/codegraph/tests/store/usage.test.mjs plugins/codegraph/tests/graph/ plugins/codegraph/tests/render/` | PASS（2026-11-24：491 项 485 过 0 失败 6 跳过；真实索引上统计语句 0.05–0.16 ms，带 usage 的前三行里 61–86% 完全由 import 连上；已安装副本经真实协议输出 ` · 3 uses in 2 files (1 in source)`。审查 `review-6-usage-summary.md` 三轮收敛：第二轮抓到 1 条本轮引入的 P1（清单里 `/e2e/` 被打错）并顺带查出一个更早的缺陷——仓库根目录下的 `tests/`、`scripts/` 从未被识别为测试 / 脚本，都已修。未做：没有再用真实会话验证模型行为） |

## Verification commands

- `node --check plugins/codegraph/bin/server.mjs plugins/codegraph/bin/hook.mjs plugins/codegraph/bin/selftest.mjs`
- `node --test plugins/codegraph/tests/*.test.mjs plugins/codegraph/tests/*/*.test.mjs`
- `node plugins/codegraph/bin/selftest.mjs --self-test`
- `node plugins/codegraph/bin/selftest.mjs --grammars`
- `node plugins/codegraph/bin/selftest.mjs --licenses`
- `node plugins/codegraph/bin/selftest.mjs --perf .tmp/codegraph-research/codegraph`
- `python scripts/check-consistency.py`

## Deferred

| 项 | 为什么本轮不做 | 何时该回来 |
|---|---|---|
| COBOL 符号抽取 | `tree-sitter-cobol` 的 wasm 单个 16 MB（占全部语法的四分之一），且在没有 `--liftoff-only` 的进程里首次解析后即崩溃（其它语法只在 isolate 销毁时崩）；server 入口虽已自动带该标志，但 v1 收益低、体积代价高 | 用户需要 COBOL 项目时：随包 + 契约测试即可，技术路径已通 |
| Rust 原生解析内核 | WASM 在 worker 线程的耗时需先量；dsh 实测 337 文件约 1 s | T18 不达标时 |
| LSP 按需精化 | 依赖用户预装语言服务器；静态边已带置信标记 | 用户反馈 `~`/`?` 比例过高时 |
| 语法包按需下载（镜像） | 全量随包约 65 MB 换零外联与离线可用 | 仓库体积成为问题时 |
| 仓库内共享索引 | 团队共享需求未提出 | 有多人协作诉求时 |
| 向量检索、SCIP 后端、`explore`、前置注入 | 见 W20/W21 与 Ruled out | W19 数据出来后 |
| search 无符号命中时回退查 `refs` | W23 先解决空结果与排序；模型 grep 的 `membershipKind`、`requirePersonalAccount` 是 `refs` 表里的引用名而非符号，回退能直接答「谁引用了它」 | W23 装进 ZCode 的开臂数据出来后 |
| Bash 检索时由钩子提醒改用 codegraph | 多一个每条 Bash 都会起的 node 进程；先看 W23 的开臂是否已经把退回 grep 的比例降下来 | W23 开臂数据出来后 |

## Rollback

插件是独立目录：删除 `plugins/codegraph/`、市场条目、根 README 两行即可完全回退。索引与 `dirty.log` 在插件数据目录，可整目录删除。既有文件只动了 `scripts/check-consistency.py`（新增一个扩展名排除）、`marketplace.json`、两份 README（新增条目），均为加法。已知坑：Windows 下 `node:sqlite` 连接不关闭会让文件无法删除；`.wasm` 含合法 `\r\n`，一致性脚本必须跳过。

## Phase log

| 阶段 | 日期 | 证据 | 结论 |
|------|------|------|------|
| 3 收尾 | 2026-11-24 | T20 13 个会话全部跑完（`bench.md`），定向指标：有 codegraph 时到达真值文件中位 6 次调用、没有则 12 次，首次编辑后再调用 0 次。按用户在结果之后定的方向加了 W21（会话开始即建 / 刷新索引 + 就绪通知）与 W24（search 前 3 行带「谁依赖它」），各自经真实会话或真实索引验证；W23 补修根目录测试 / 脚本目录不被识别。`node --test plugins/codegraph/tests` → 491 用例 485 过 0 失败 6 跳过；`check-consistency.py` ALL CHECKS PASSED；`selftest` 15 断言；七条真实首查回放 7/7。独立审查：`review-5-silent-start.md`（一轮）、`review-6-usage-summary.md`（三轮收敛）。check-level: test | W21–W24 [x]，T20–T25 PASS；已安装，两处副本与工作树一致；**未提交、未推送**（待用户授权）。遗留：T7 基线臂与关臂读过参考答案、没有重跑；两项改动都没有再用真实会话验证模型行为；`files` 表固化测试文件判定、逐项目关闭索引的开关、索引淘汰机制未做 |
| 2 集成与验证（续） | 2026-11-24 | W19 基线开臂：T1、T2、T6 完成，T3、T7 运行中；T2 关臂完成。**口径更正**：模型不用 `Grep` 工具，检索走 Bash 里的 `grep`，早先「Grep 0 次」不成立（T1 开臂实际 55 次、T6 49 次），`measure-sessions.mjs` 已按管道段判定。基线发现：首步采用 5/5，但查询是描述或猜的名字，旧版 search 空结果或噪声、渲染按 path 重排，随后退回 grep → 开启 W23。W23 `searchSymbolsDetailed`：`node --test plugins/codegraph/tests/` → 463 用例 457 过 0 失败 6 跳过；`check-consistency.py` ALL CHECKS PASSED；`selftest` 15 断言；真实 stdio server 端到端（`"hook guide"` → `1 match for guide (no name has all words)`）。独立审查 `.devflow/codegraph-plugin/review-3-search.md`（三轮，均 APPROVE_WITH_COMMENTS，无 P0 / P1；审查方无 Bash，结论为读出来的；测试、真实索引对比、变异验证由主 agent 执行）。check-level: test | W23 [x]，仍未安装、未提交；W19 继续跑关臂与 W23 开臂 |
| 2 集成与验证 | 2026-11-23 | W15–W18 [x]，W19 [!]（T20 待用户在安装后执行）。全套 447 用例 441 过 0 失败 6 跳过；契约 75/75；selftest/check-consistency 通过；真实 stdio server 端到端 3 s 就绪；用户仓库 deepseek-harness（8,384 文件，38.8 s）与 cindy（17,830 文件，100.8 s）定义抽样 ≥ 99%。审查 `.devflow/codegraph-plugin/review-2.md`（2 P1 + 3 P2 处置，探针复验）。五问：主张复核=每个数字都是本机跑出来的且附命令；最小性=按 profile 只改热点（批量 INSERT、bulk load、分组 UPDATE、id 保留），原生运行时与 Rust 内核均被实测否定；新风险=bulk 期间 FK 关闭靠 end 的 foreign_key_check 兜底、并发 openDatabase 只降速；反例=被杀构建、回滚后 TEMP 表、并发打开、损坏库、离线均有用例；可检查性=e2e 门槛脚本 + 两个真实仓库基准脚本入 .devflow。check-level: test | Gate 通过（W15–W18）；W19/T20 待用户，按规则暂不进入阶段 3 |
| 1 并行开发 | 2026-11-23 | W6–W14 全 [x]；全套 `node --test plugins/codegraph/tests/*.test.mjs plugins/codegraph/tests/*/*.test.mjs` → 417 用例 416 过 0 失败 1 跳过（两遍一致，≈21 s）；契约 75/75；`selftest --self-test` 15 断言；`check-consistency.py` ALL CHECKS PASSED；真实 stdio server 端到端（本仓库 235 文件 3.0 s 就绪，`symbol createServer` callers 4/4 解析）。审查：`.devflow/codegraph-plugin/review-1-core.md`（2 P1 + 15 P2 全部处置，探针复验）与 `review-1-iface.md`（1 P1 + P2 全部处置）。五问：主张复核=每位审查者的探针在修复后重跑转绿；最小性=P1 修复各 ≤ 10 行复用既有 #build/#sync；新风险=周期枚举每 60 s 一次 listFiles（10k 文件约 100 ms）、死进程续建依赖锁判定；反例=被杀构建、切分支新增文件、Ruby/PHP callers 翻倍、零字节锁、静默 worker 均有负向用例；可检查性=新增 19 条索引/解析用例 + 契约测试 refs 断言。check-level: test | Gate 通过，可进入阶段 2 |
| 0 契约与骨架 | 2026-11-23 | W1–W5 全 [x]；`node --test plugins/codegraph/tests/*.test.mjs plugins/codegraph/tests/*/*.test.mjs` → 34/34 exit 0；`selftest --self-test` 15 断言 exit 0；`--grammars` 32/32 exit 0；`--licenses` 193 项 exit 0；审查 `.devflow/codegraph-plugin/review-0.md`（7 P1 全部处置，P1-7 实测不成立）。五问：主张复核=每条 P1 都有探针前后对照；最小性=删除 FK 绕行与 NAME_TYPES 白名单、无需原生依赖；新风险=TurboFan 依赖「swift 换构建」，留 CODEGRAPH_LIFTOFF_ONLY 保险；反例=单行定义归属、Ruby 类名、Python docstring、函数型 fn 均有负向用例；可检查性=契约测试新增 refs/qual/doc 断言。check-level: test | Gate 通过，可进入阶段 1 |
