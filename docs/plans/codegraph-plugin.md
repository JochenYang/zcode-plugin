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
| 把触发条件放宽成「没有同名符号就查引用」（W28，用户 11-25 把工程判断交给我） | 实测会改变约一半的常见单个词查询：`props`、`data`、`theme` 这些词多半没有同名符号，结果会从「相关符号」（`ThemeProvider`、`useTheme`）整体变成「参数的使用位置」。所以只在符号行不含全部词时才让引用排在前面 |
| 会话途中提醒模型「索引变了」（同上，交给我判断） | 新鲜度在调用时保证（每次调用前同步改过的文件），首行已有 `stale: N` / `indexing N% (results partial)`，模型不需要据此做任何决定，每条提示都占上下文。会话开头那行指引已顶在 120 token 的上限上；新行为写在工具描述里，模型调用时看的是那里 |
| 把测试 / 脚本文件的判定固化到 `files` 表（省掉排序里每行 24 次 LIKE） | 2026-11-25 实测，两个真实索引（各约 2,800 个符号）上 `search` 的中位耗时 1.8 ms、p95 8.5 ms、最大 12 ms（12 个常见词各跑 20 次）：那串 LIKE 不是瓶颈，不值得为它改表结构。大仓库上真正慢的是短词的 GLOB 扫描（W23 记的 180–290 ms），与此无关 |

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
| W25 | P1 | 索引存储管理与按项目关闭（用户 11-24 晚：「都知道缺陷，为什么不去调研环境和同类做法再优化好；索引清理功能显示在哪里、ZCode 有没有扩展接口」）。同类做法：JetBrains 自动清 180 天没更新的目录、Cursor / Roo 都有「列出索引 + 删除」入口；ZCode 有未公开文档的扩展接口（输入框状态位、侧边栏入口、HTML 面板、通知、插件设置）。本轮做与界面无关的核心：`src/index/storage.mjs`（清单、最近使用、清理：孤儿 / 闲置 `maxIdleDays` / 总量 `maxTotalMB`，永不删当前项目与在用的索引）；会话开始时自动整理；`codegraph_status` 的 `storage` / `clean` / `project` / `confirm` 与 `/codegraph storage|clean`；项目根 `.zcode/codegraph.json` 只能收紧；状态文件丢失自愈；`autoIndex` 关闭时工具不再自动同步。审查 `review-7-store-management.md`（无阻塞；4 条 P2：孤儿不绕过闲置期、自动清理不探测远端路径、逐项隔离删除错误、补 `clean=current` 重建的端到端）。界面入口（状态位 + 面板）另开 | 主 agent | [x] |
| W26 | P1 | 索引管理的界面入口（用户 11-24 晚：「把界面入口做好，一定要按照 Z Code 的官方主题、主题组件和 UI 风格设计，不能随意」）。`bin/extension.mjs`（输入框状态位 `composer.status`、侧边栏入口、命令、视图与四个工具）、`src/extension/describe.mjs`、`ui/index.html`（`#zcode-contract` = 应用沙箱样式表逐条原文，`#codegraph-layout` 只有版式）、清单的 `extension` / `slots`。共用进程里对项目路径先探测再同步调用；删除与清理两步确认；迟到的会话快照丢弃、绘制串行。审查 `review-8-ui-entry.md`（两轮，均无阻塞） | 主 agent | [x] |
| W27 | P2 | 索引管理面板的视觉整理（用户 11-25 看过真实效果：「徽章还行，面板不好看」，明天再做）。截图里的问题：路径被画成整列宽的灰条（`.storage-path` 是纵向 flex，`<code>` 被拉伸）；列太挤导致词内断行（徽章「未索 / 引」、「291 个文 / 件」、「4 小时 / 前」、表头「上次使 / 用」）；长路径中间硬断；标题、统计、目录、表格、按钮、卡片全是小字、没有层级；ZCode 内部的草稿工作区（`zcode-cache/.zcode/workspace/draft-*`）作为「未索引」条目混在列表里。方案已定（用户 11-25 夜）：版式照用户给的原型图——标题与说明、三张统计卡、存储位置卡、带标题的两个分区卡片、策略卡；补两样官方样式表里没有的装饰（按状态着色的标签、标题左侧的竖条），颜色全部取官方令牌；图标用内联的 Lucide SVG（npm `lucide-static`，ISC 许可；沙箱没有图标运行时，`data-lucide` 不生效），`stroke="currentColor"` 随主题走。用户 11-25 另选定：索引目录那一行加「打开目录」按钮——宿主没有对外打开目录的能力，由扩展用 `child_process` 启动系统文件管理器（`explorer` / `open` / `xdg-open`），路径固定为插件数据目录。逐项清单在 `.devflow/codegraph-plugin/t20-progress.md` 顶部。实现时另加：说明文字的次要文字色（官方的次要文字色在浅色主题下只有 4.26:1，与正文色混合后 4.99:1）；「复制路径」；路径只在分隔符处断、至多两行；状态色按实测比例与前景色混合。审查 `review-9-view-restyle.md`（一轮，无阻塞） | 主 agent | [x] |
| W28 | P1 | search 列出「只被使用」的名字（用户 11-25 选定）。T20 里模型转去 grep 的 `membershipKind`、`requirePersonalAccount`、`takePendingDeepLink` 是 `refs` 表里的引用名而非符号。`searchRefs`（`repo.mjs`）：名字原样存在时走 `refs_name` 索引，答案只有它；否则按词扫描全表再过词边界过滤，带上含这些词的更长的名字；原始引用先截到 2 万行（不截的话 `meth` 这类片段在 220 万条引用上光分组就 18 秒），再截到 5000 组，越过截断合计是下界。触发规则（`queries.mjs`）：没有符号行、或符号行只是放宽匹配（不含全部词）时才查引用；使用位置不超过 200 处时排在前面，首行列出沾词的符号；符号含全部词、或名字用在 200 处以上时符号照旧。输出（`text.mjs`）：`# search useEffect · no symbol carries this name; 90 uses in 48 files (useEffect) · also in symbol names: useT, useTick (+18 more found)`，行 ` call useEffect ×4 in ThemeProvider src/components/ThemeProvider.tsx:63`。实测这条规则只改变「符号只沾一个词」的查询（`useEffect` 原来给 `useT`、`useTick`），常见单个词与描述式查询不变。审查 `review-10-reference-fallback.md`（一轮，无阻塞；P2-1「截断与词过滤同时发生时 `capped` 漏报」与五条 P3 都已处理）。审查后经真实协议发现并更正：JS/TS 里点号读取的属性、变量与参数的读取、解构出来的字段都不在图谱里（抽取层 `engine.mjs` 的既有边界），文档与提示语原先写的「对象的字段」言过其实，已按实测改写并由 `tests/resolve/locals.test.mjs` 钉住；要让它们可搜是另一项工作 | 主 agent | [x] |
| W29 | P1 | 修复：增量同步不认 `.gitignore`。2026-11-25 在一次真实会话里发现：`.devflow/` 下的草稿脚本排在 search 结果的第一行。文件枚举用 `git ls-files --exclude-standard`，但文件监听与 `PostToolUse` 钩子报来的脏路径走 `Indexer#sync()`，那里的准入只查内置忽略目录与 `exclude`，于是被忽略的文件一被碰到就进索引，直到下一次枚举对账才被清掉。修法：`src/index/walker.mjs` 加 `gitIgnoredPaths()`（`git check-ignore -z --stdin`；不是工作树或 git 答不上来返回 `null`），`#sync()` 只对索引里还没有的脏路径问一次 git，被忽略的丢弃且不重试。没有 git 时维持目录遍历的回退（不认 `.gitignore`），与枚举一致 | 主 agent | [x] |
| W30 | P1 | search 找得到只被当作属性读取的名字（`row.membershipKind`）。用户 11-25 把方向交给我定。量过两条路：进索引（成组存也要多 20% ~ 38% 的行，已有索引要整体重建，而索引器没有这个机制）或查询时扫描；选了扫描——被读最多的属性是 `.length`、`.type`、`.id`，信息密度低，只有长尾有用，平时不该为它付代价。做法：`src/graph/propertyReadsWorker.mjs` 是专用常驻 worker，读文件、预筛（`src/graph/prefilter.mjs`）、解析都在它里面，主线程只等答案（`src/graph/propertyReads.mjs`，CONTRACTS §9 的约束）；会话开始时后台预热。五种上限：有命中的文件 60（热点）、单文件大小、读入 64 MB、预筛命中 400、解析 2 MB（小文件先解析）；单次扫描 10 秒超时后换 worker。解构与 `for…of` 的赋值目标不算读取。方括号访问仍然搜不到；对象字面量的键与解构出来的字段见 W33。审查 `review-12-property-reads.md`（三轮，均批准；意见全部处理，两条不改、写进契约） | 主 agent | [x] |
| W31 | P1 | 链接一律不进索引。此前登记的准入缺口：枚举用的 `statMany` 是跟随链接的 `stat`，`git ls-files` 列出的已跟踪链接被当成普通文件收进索引；实验还发现 git 在 Windows 上会钻进目录联接、把联接后面的文件（可能在项目之外）当成未跟踪文件列出来，而自走目录是跳过链接的。修法：`statMany` 改 `lstat`；`underLink()` 判断路径上是否有一级目录是链接（`listFiles` 整批目录只 `lstat` 一次，`sync()` 的脏路径准入每批缓存一次）；过期扫描与 `#reconcileDirty` 随之是 `lstat`。用户 11-25：「把没做的按照最佳方向做」。审查 `review-12-property-reads.md` 第四、五轮（批准；第四轮指出只查直接父目录时嵌套的联接会漏，已改成查全部祖先目录） | 主 agent | [x] |
| W32 | P1 | 属性读取的扫描在大仓库上不工作。回放 T20 的名字时发现：cindy 的 JS/TS 有 17,451 个文件、193 MB，读入预算 64 MB 只覆盖三分之一，读到位就停，于是所有名字都是 0 行、`skipped: 'limit'`。修法：worker 记住每个文件里「点号后面、且没有被紧接着调用」的名字（`dottedName`，与预筛共用点号与间隔的定义），按索引里的 `size` + `mtime_ms` 判断文件是否变了；只记「读到了什么」和「文件没了」。读入预算按一次请求计（512 MB），没读到的留给下一次请求；会话开始时 prime。代价从「每次搜索读整个项目」变成「第一次约 2 秒（cindy），之后只读含该名字的文件」。新语义：扫描与索引一样新鲜。审查第四、五轮（批准；第四轮指出预算只按字节时慢盘上会超时换 worker，改成按时间收手、从发出时刻算） | 主 agent | [x] |
| W33 | P1 | 对象字面量的键与类型的成员进搜索。用户 11-25 问「对象字面量的键、变量读取进搜索这个是能做吗」，看过可行性后说「值得做就做」。不另起机制：同一次扫描多找三类位置——对象的键（`{ name: 1 }`、`{ name }`、`const { name } = row`、`{ name: alias }`、带默认值、参数位置的模式）、JSX 元素的属性名（`<Input name={…} />`，只在 tsx 语法上问；我按「属性名就是键」延伸的——造三十来种形状核对查询时发现它既不在索引也不在扫描里，dsh-app 的 72 个 TSX 文件里有 29 个这样传 `onChange`）与接口 / 类型字面量的成员。worker 为每个文件多记一样「单独出现的名字」（`bareName`）；读取与键两种查找各有热点、各截各的（处处作为变量出现的 `onChange` 不连累少数把它当属性读的文件）；行多了 `key` / `field` 两种，`info.refs.kinds` 让输出层只在全是读取时才说 `property reads`。类字段与对象字面量里的方法是索引里的符号，不收；变量读取不做（用户：Grep 是正确做法）。实现中发现并修掉一处：键的热点成立时，只作为键出现的文件原先仍被解析、照常出行。代价：第一次读一遍多出最贵的一步（每个标识符过一遍，cindy 193 MB 约 2.5 秒），cindy 首次请求从 2.3 秒变成 5.36 秒，紧贴 5 秒的读入时限；量过更省的写法最多省 18%（已用），「只留后面跟着 `:` `,` `=` `}` `?` 的标识符」反而更慢。审查 `review-12-property-reads.md` 第六轮（批准，1 条 P2 + 5 条 P3，全部处理）：接口与类型字面量的方法签名补进 `field`；JSX 属性名在 javascript 语法上也问（只有 typescript 语法没有这个节点）；一侧被热点截掉而另一侧有行时，回 `cut`、合计带 `+`、页脚说缺的是哪一侧；键侧的热点上限单独设为 `maxKeyFiles`（200，按「单独出现」计是个很松的超集：截在 60 时 dsh-app 有 17% 的名字丢键行，200 时 4%）；候选文件的重读也看读入的截止时间；Apache-2.0 §4(d) 的 `NOTICE.md`。另加：prime 分轮读到完——加键之后 cindy 冷盘第一次读一遍要两轮多的时限，不分轮时第一次搜索空手回来。第七轮只看这些修法（批准，无阻塞；两条 nit：候选重读每次从第一个开始、prime 最坏约 22 秒后台占用，都记进契约、不改） | 主 agent | [x] |
| W34 | P1 | 关系列表与检索的文件档位：生成文件单独一档（源码 → 测试/脚本 → 生成），`callers` / `callees` / `impact` / `symbol` 的关系列表在截断前按档位排。借鉴 CodeGraph-Rust 的文件权重（用户 11-26：「按照你列出来的值得借鉴的内容方向来做」） | builder（甲） | [x] |
| W35 | P1 | `codegraph_lookup` 新增 `cycles`（文件间 import 环，Tarjan SCC）与 `affected`（给定文件，沿 import 与已解析引用反向找依赖它的测试文件）两个纯图查询；工具 schema、CONTRACTS §8 / §10 / §11、README 同步。主 Agent 复核后把 `affected` 的引用边收紧为 `resolution = '='`（`~` 边在本仓库把 8 个真实依赖放大成 68 个） | builder（甲） | [x] |
| W36 | P2 | 逐文件过期横幅：结果引用了仍在 `dirty` 表里的文件时，在首行之后点名（至多 3 个），提示直接 Read 取当前内容 | builder（甲） | [x] |
| W37 | P1 | 增量等价测试：小仓库上随机编辑（可复现种子），每步断言增量索引的规范化图等于全量重建 | builder（乙） | [x] |
| W38 | P1 | 「永不索引的目录」不进插件：ZCode 给没指定目录的会话建的工作区（`<数据目录>/.zcode/workspace/draft-*`、`default`）与家目录 / 盘根——不建索引目录、不写存储、面板无行；钩子对前者静默；工具一行作答（`storage` / `clean` 照常）；清理规则 `not-a-project` 删掉旧版本留下的空条目。用户 11-27：「这种非真实项目的不要弄进来啊」 | 主 Agent（调试后自己修） | [x] |

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
| 3 收尾 | W21、W22、W23、W24、W25、W26、W27、W28、W29、W30、W31、W32、W33（W20 视 W19 数据：未开启） | T21–T34 PASS；安装进 ZCode 跑通 |

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
| 26 (W25) | 索引存储管理与按项目关闭 | 单元测试（存储策略纯函数、真实目录、被占用索引）；真实服务进程端到端（握手后清理、预演与确认、删当前项目后重建、按项目关闭的三种情形）；变异验证 | 孤儿与闲置索引被删、当前项目与在用的索引永不删；`clean` 不带 `confirm` 只列不删；项目文件只能收紧；状态文件丢失后工具照常回答 | `node --test plugins/codegraph/tests/index/storage.test.mjs plugins/codegraph/tests/e2e/warm-start.test.mjs plugins/codegraph/tests/mcp/`；`node .tmp/e2e/storage-probe.mjs`；`node .tmp/e2e/project-off-probe.mjs` | PASS（2026-11-24 深夜：526 项 520 过 0 失败 6 跳过；三轮共 11 处变异都被抓住；已安装副本经真实协议验证清单、预演、确认清理、`clean=current` 后重建、按项目关闭的三种情形；审查 `review-7-store-management.md` 无阻塞。本机真实存储只读预演：两个索引 15 MB，下次会话开始不删任何东西。未做：界面入口；macOS / Linux 没有环境；真实会话里 `/codegraph storage` 的那次调用在等用户点授权弹窗） |
| 27 (W26) | 界面入口 | 单元测试（状态位四种状态与长度上限、`viewData` 能过 JSON、视图工具的拒绝与成功、清单与注册项一致、不应答的路径、迟到的会话快照、刷新循环不产生未处理拒绝）；页面在无头 Chrome 里的检查（320 px 与 1280、中英文、明暗）；对页面 16 处、对扩展入口 6 处变异；官方样式块与应用样式表逐条比对 | 状态位按状态显示且不超宿主上限；面板里删除与清理都要第二次点击；打开会话的项目与在用的索引不能从面板删；页面只用官方工具类、自己的样式只有版式；改坏页面时检查失败 | `node --test plugins/codegraph/tests/extension/`；`node .tmp/page-mutate.mjs`；`node .tmp/zcode-ui/verbatim.mjs .tmp/zcode-ui/visualize.css` | PASS（2026-11-25：`node --test plugins/codegraph/tests/extension/` → 29 项全过，其中 4 项在无头 Chrome 里打开页面；全套 557 项 551 过 0 失败 6 跳过；`check-consistency.py` ALL CHECKS PASSED；selftest 15 断言、32 个语法、193 项许可检查；22 处变异全部被抓住；官方样式块 56 条规则与应用样式表逐条一致；用 ZCode 4.0.10870 的真实令牌实测对比度——浅色主题下官方的状态徽章 2.04:1、错误色 2.81:1、次要文字 4.26:1 不到 WCAG AA，深色主题全部 ≥ 5.76，没有改这些工具类。审查 `review-8-ui-entry.md` 第一轮无阻塞。已安装，缓存与市场副本与工作树一致。**未做：真实应用里的验证**——扩展要完全退出应用再打开才会加载，首次激活要用户点确认，这两步我做不了） |
| 28 (W27) | 面板重排 | 单元测试（数据层的新字段与文案、`open` 工具、图标与 Lucide 原件逐字对照）；页面在无头浏览器里的检查（1280 / 760 / 320 像素，中英文，明暗）；变异 14 处；ZCode 真实主题下的对比度；设计技能的 `audit.mjs`；Playwright 真实鼠标与键盘 | 版式照原型；装饰只取官方令牌；标签不换行、路径至多两行；文字 ≥ 4.5:1、图标 ≥ 3:1；打开目录与复制路径可用 | `node --test plugins/codegraph/tests/extension/`；`node .tmp/w27-shots.mjs`；`node .tmp/w27-real-input.mjs` | PASS（2026-11-25：`tests/extension/` 36 项全过；全套 564 项 558 过 0 失败 6 跳过；真实主题下面板自己的文字全部达标——状态标签 5.07:1、说明 4.99:1、图标 3.99:1；`audit.mjs` 必须修 0；官方 lint 在自己的样式块 0 条；审查 `review-9-view-restyle.md` 无阻塞。已安装。**未做：面板在真实应用里的样子**——截图留给用户看；用户要完全退出应用再打开） |
| 29 (W28) | search 列出只被使用的名字 | 单元测试（存储层 `searchRefs` 10 条：分组、两种查法、词序、短词整词、两级截断各插入上限的两倍、截断在词过滤之前判断、接收者与种类、参数校验；查询层触发规则 5 条，含上限 200 的边界；输出层 5 条；工具层走真实模块 1 条；抽取层「什么算引用」3 条）；变异 27 处；两个真实索引上的只读对比（各约 60 个常见名字与库 API）；合成 220 万条引用上的耗时；工作树与**已安装副本**各通过真实 MCP 协议端到端 | 没有符号叫这个名字、或符号只沾部分词时给出使用位置，沾词的符号在首行；符号含全部词、或名字用在 200 处以上时结果不变；常见单个词与描述式查询不变；最坏查询有界 | `node --test plugins/codegraph/tests/store/search.test.mjs plugins/codegraph/tests/graph/ plugins/codegraph/tests/render/ plugins/codegraph/tests/mcp/ plugins/codegraph/tests/resolve/locals.test.mjs`；`node .tmp/w28-mutate.mjs`；`node .tmp/w28-trigger.mjs`（输出留在 `.tmp/w28-trigger.txt`）；`node .tmp/e2e/mcp-search.mjs "<query>"…`；`node .tmp/e2e/installed-refs-probe.mjs` | PASS（2026-11-25：全套 588 项 582 过 0 失败 6 跳过；`check-consistency.py` ALL CHECKS PASSED；selftest 三项通过；27 处变异全部被对应用例抓住；合成索引 220 万条引用上原名命中 24–150 ms、扫描约 180 ms、子串热点 114 ms、一两个字母且无同名引用约 1.3 s；审查 `review-10-reference-fallback.md` 一轮无阻塞，P2-1 与五条 P3 都已处理。已安装副本经真实协议：`membershipKind`（库调用）、`requirePersonalAccount`、`client.takePendingDeepLink()` 给出使用位置，属性读取 `row.pendingLinkQuota` 返回无匹配并说明原因。**未做：真实会话里模型是否真的少用 grep**；JS/TS 的属性读取、变量与参数的读取不在图谱里，是抽取层的边界） |
| 30 (W29) | 被忽略的文件不进索引 | 单元测试（`gitIgnoredPaths`：问与不问的路径、是否存在、已跟踪的不受 `.gitignore` 影响、`core.ignorecase` 两种取值、空输入、非工作树、git 坏掉、一次问 10 万条撞上已关闭的管道）；索引器端到端（钩子 / 文件监听式脏条目：被忽略的不进、没被忽略的照常进、已入索引后被 `.gitignore` 收进去的当场删、已跟踪的留着、无 git 时照旧）；变异 8 处；真实 MCP server 上的泄漏探针（临时项目）三条路径各一遍 | `.gitignore` 里的文件既不进完整构建，也不经文件监听、钩子上报进入；没被忽略的新文件照常进；git 不可用时行为与枚举的回退一致 | `node --test plugins/codegraph/tests/index/walker.test.mjs plugins/codegraph/tests/index/indexer.test.mjs`；`node .tmp/w29-gitignore-leak.mjs`；`node .tmp/w29-mutate.mjs` | PASS（2026-11-25：修复前探针在文件监听与钩子两条路径都泄漏，修复后工作区与已安装副本上都不泄漏；全套 592 项 586 过 0 失败 6 跳过；变异 8 处全部被抓住；已安装副本上三组探针与 selftest 三项通过。审查 `review-11-gitignore-admission.md`（一轮，批准含评论，无阻塞；审查者实测了退出码、错误形态、耗时与六类混合批次，P2 与四条 P3 已处理）。**未做**：macOS / Linux 实机；符号链接场景只读了代码） |
| 31 (W30) | search 找得到只被当作属性读取的名字 | 单元测试（预筛 4 条：匹配、字面量、间隔的界、代价线性；扫描 12 条：成组与排序、不算读取的写法、算读取的写法、接收者、空白与注释、同一行多个定义的归属、热点、项目外的路径、消失与读不出的文件、五种上限、超时；worker 的生命周期 2 条；合并与 `search` 的决策 5 条、`searchIsPartial` 1 条；存储层 `fileIds` 1 条、`isInside` 2 条；输出层页脚按原因选、`+` 的解释；工具层走真实模块 2 条；真实 server 的端到端 1 条）；变异 72 处；两个真实索引上的只读计时；已安装副本经真实协议的探针 | 没有同名符号时 JS/TS 的属性读取出现在使用位置里，与索引的行合成一份；热点与越界的名字不列并说明原因，「找过、没有」只在扫描真的找完时说；主线程不解析；最坏一次搜索有界 | `node --test plugins/codegraph/tests/graph/propertyReads.test.mjs plugins/codegraph/tests/store/search.test.mjs plugins/codegraph/tests/render/ plugins/codegraph/tests/mcp/ plugins/codegraph/tests/e2e/property-reads.test.mjs`；`node .tmp/w30-mutate.mjs`；`node .tmp/w30-scan-real.mjs <仓库根> <名字>…`；`node .tmp/e2e/property-reads-probe.mjs`（`CODEGRAPH_SERVER` 指向已安装副本再跑一遍） | PASS（2026-11-25：全套 626 项 620 过 0 失败 6 跳过；`check-consistency.py` ALL CHECKS PASSED；selftest 三项通过；变异 72 处全部被抓住（基线 165 项）；两个真实索引上只读计时——读完并预筛 4 ~ 14 ms，带解析的名字 41 ~ 199 ms，worker 启动 54 ~ 64 ms；预筛在对抗性的形状（点号后接闭合 / 未闭合的块注释、没有换行结束的行注释、一串空格）下线性；已安装副本经真实协议：合并、仅扫描、仅索引、无结果四种输出都对，另五组探针与 selftest 通过；审查 `review-12-property-reads.md` 三轮均批准。**未做**：真实会话里模型是否用得上；macOS / Linux 实机；worker 启动失败路径只有手工探针，「不是普通文件就不读」没有可区分的用例） |
| 32 (W31) | 链接一律不进索引 | 单元测试（`statMany` 是 `lstat`、`underLink` 的边界；`listFiles` 在 git 仓库里不列指向文件的链接、不钻目录联接，自走目录也不钻；`sync()` 的脏路径准入不收目录联接后面的文件）；变异 5 处；已安装副本上的探针 | 已跟踪的链接、目录联接后面的文件既不进完整构建，也不经脏条目进索引；项目自己的文件照常进；没有链接的项目行为不变 | `node --test plugins/codegraph/tests/index/fsstat.test.mjs plugins/codegraph/tests/index/walker.test.mjs plugins/codegraph/tests/index/indexer.test.mjs`；`node .tmp/w31-mutate.mjs`；结果落盘 `.tmp/w31-mutate.txt` | PASS（2026-11-25：全套 639 项 633 过 0 失败 6 跳过；变异 6 处全部被抓住；已安装副本上探针通过；审查第四、五轮批准。**未做**：指向文件的链接那一半在本机没有权限建（用例里标了），macOS / Linux 实机） |
| 33 (W32) | 属性读取的扫描在大仓库上工作 | 单元测试（记住的文件与索引一样新鲜；读不到的下次再试；预算跨请求续读；只被调用的名字不算候选；prime 有应答；worker 起不来）；变异（`.tmp/w30-mutate.mjs` 共 81 处）；四个真实索引上的只读计时（本仓库、coding-usage、dsh-app、cindy） | 第一次请求读完所有 JS/TS 文件，之后的搜索只读含该名字的文件；预算没覆盖到的文件如实报出来，下一次接着读；扫描看到的就是索引看到的 | `node --test plugins/codegraph/tests/graph/propertyReads.test.mjs plugins/codegraph/tests/graph/propertyReads.worker.test.mjs plugins/codegraph/tests/e2e/property-reads.test.mjs`；`node .tmp/w30-real-scan.mjs <仓库根> <索引目录> <名字>…` | PASS（2026-11-25：全套 639 项 633 过 0 失败 6 跳过；变异 86 处全部被抓住；四个真实索引上只读计时——cindy 首次 2.3 ~ 2.4 秒（冷盘 5.5 秒应答、下一次 0.8 秒读完）、之后 35 ~ 420 ms，本仓库 47 ~ 204 ms，dsh-app 约 250 ms；已安装副本上探针通过；审查第四、五轮批准。**未做**：真实慢盘上只有一次实测；真实会话里模型是否用得上） |
| 34 (W33) | 对象字面量的键与类型的成员进搜索 | 单元测试（键的各形状：字面量、简写、重命名解构、带默认值、赋值形式的解构、参数模式、嵌套；不算键的：类字段、对象字面量的方法、计算键、字符串键；三种行在同一行上的顺序；读取与键两侧热点各截各的，含只有键、没有读取的热点；`bareName` 预筛与它的代价）；输出层（`key` / `field` 行、只有读取时才说 `property reads`、全部页脚文案）；工具层与真实 server 的端到端（夹具加了对象键）；变异 `.tmp/w30-mutate.mjs` 共 122 处；四个真实索引上的只读计时；已安装副本经真实协议的探针 | 对象的键、解构、类型的成员出现在使用位置里，与读取、索引的行合成一份；一个名字处处作为变量出现时不连累把它当属性读的文件，反过来也一样；「找过、没有」只在两侧都真的找完时说 | `node --test plugins/codegraph/tests/graph/propertyReads.test.mjs plugins/codegraph/tests/graph/queries.test.mjs plugins/codegraph/tests/render/ plugins/codegraph/tests/mcp/ plugins/codegraph/tests/e2e/property-reads.test.mjs`；`node .tmp/w30-mutate.mjs`；`node .tmp/w33-replay.mjs index <仓库根> <索引目录> <名字>…`；`node .tmp/e2e/property-reads-probe.mjs`（`CODEGRAPH_SERVER` 指向已安装副本） | PASS（2026-11-25：全套 647 项 641 过 0 失败 6 跳过；`check-consistency.py` ALL CHECKS PASSED；selftest 三项通过；变异 145 处全部被抓住（全量一次跑 143 处，两处锚点过时没应用上，改锚点后重跑被抓住；基线 180 项）；四个真实索引上只读计时（机器空闲）——cindy 分轮 prime 6.0 秒后 `membershipKind` 568 ~ 696 ms（218 处 / 95 个文件），本仓库 34 ~ 262 ms，coding-usage 37 ~ 166 ms，dsh-app 138 ~ 416 ms；键侧上限取 200 的依据（`.tmp/w33-keycap.mjs`：dsh-app 截在 60 时 17% 的名字丢键行、200 时 4%，另两个仓库降到 0）；已安装副本经真实协议：键行、计数词、四种页脚都对，另四组探针与 selftest 通过；审查 `review-12-property-reads.md` 第六轮批准（1 条 P2、5 条 P3、若干 nit，全部处理），第七轮只看修法与「prime 分轮读到完」（批准，无阻塞）。**未做**：真实会话里模型是否用得上键的行；macOS / Linux 实机；真实慢盘上只有冷盘一次实测） |
| 35 (发布后) | 真实会话对照：codegraph 与 grep 配合、代价 | 两个只读任务各跑一对会话（用户开的完全访问会话，或我建、用户在界面里批准的会话），`SendToSession` 发任务，一臂提示词禁用 codegraph；第一组的答案键 = `git grep -n -w` 的 120 行 / 26 个文件，`.tmp/t35/score.mjs` 逐行核对，第二组对源码逐条核对；`.tmp/t35/sequence.mjs` 看工具顺序，`measure-sessions.mjs` 读调用与 token | 两臂答案同样完整时，有 codegraph 的一臂不多花调用与 token | `.tmp/t35/score.mjs`、`.tmp/t35/sequence.mjs`、`node .devflow/codegraph-plugin/measure-sessions.mjs <会话 id…>` | PASS（2026-11-25，每臂每任务一次。**第一组**，给 `reasoningEfforts` 做改名清单：两臂都是 120 / 120 处、26 / 26 个文件；有 codegraph 的一臂 43 次调用对 60 次、整文件读取 25 对 42、输入 token 1.40 M 对 1.61 M（少的几乎全是缓存命中）、输出 token 相同；它用 grep 拿全量清单、用 codegraph 的 `outline` 看源码结构，没有用 `search`。**第二组**，排查 sign-in 鉴权 Cookie 在多端口下会不会互相干扰（答案在 `browser-auth.ts`，两臂的关键结论都对过源码）：第一步就是 `search` 且首查命中，`callers` 5 次；36 次调用对 38 次，其中 bash 检索 5 对 17；第 4 次调用读到答案文件，对第 7 次；合计 token 0.86 M 对 1.28 M（−33%），模型请求 11 对 15。模型分别是 `auto-deepseek-v4-1-flash` 与 `GLM-5.4`，两组之间不能互比。记录在 `.devflow/codegraph-plugin/bench.md`。**未做**：实现类任务、每臂多次运行、卸载插件的干净对照（两臂都是提示词禁用）） |
| 36 (W34) | 文件档位 | 单元测试（生成文件的识别清单逐项配路径；关系列表与 search 在源码、测试、生成文件并存时的顺序；limit 下留给源码行；渲染层排序一致） | 源码行排在测试、脚本与生成文件前面；截断先丢生成文件与测试 | `node --test plugins/codegraph/tests/store/ plugins/codegraph/tests/graph/queries.test.mjs plugins/codegraph/tests/render/` | PASS（2026-11-26：166 项 166 过，退出码 0） |
| 37 (W35) | cycles / affected | 单元测试（环、无环、自环不计、多环排序与截断；affected 的反向闭包、只列测试、未知路径、截断）；工具层（affected 必须给 files）；渲染快照 | 环与依赖它的测试文件列得对；超限如实说截断 | `node --test plugins/codegraph/tests/graph/ plugins/codegraph/tests/mcp/ plugins/codegraph/tests/render/ plugins/codegraph/tests/contract.test.mjs` | PASS（2026-11-26：304 项 303 过 1 跳过 0 失败，退出码 0；真实协议下 51 个路径被拒、50 个通过） |
| 38 (W36) | 过期横幅 | 工具层测试（结果引用脏文件时点名；没有交集时只有计数；就绪且无脏文件时没有横幅） | 模型能知道哪几个文件可能过期 | `node --test plugins/codegraph/tests/mcp/ plugins/codegraph/tests/render/` | PASS（2026-11-26：157 项 156 过 1 跳过 0 失败，退出码 0；SQL 守卫钉住「只按点名路径查 `dirty`」） |
| 39 (W37) | 增量 == 全量 | 端到端：2 个种子 × 10 步随机编辑（注释、追加函数、改名、加 import、新建与删除文件），每步比较增量索引与全量重建的规范化图；`CODEGRAPH_PARITY_STEPS` 放大 | 每一步都相等 | `node --test plugins/codegraph/tests/e2e/incremental-parity.test.mjs` | PASS（2026-11-26：默认 3/3，`CODEGRAPH_PARITY_STEPS=30` 3/3，退出码都是 0，两种规模下每一步都相等；比较器在改一行 / 少一行 / 多一行 / `symbols_fts` 多一项四种人为差异下都报出） |
| 40 (W38) | 永不索引的目录 | 端到端（真实 server + 真实钩子 + 临时数据目录：草稿工作区里存储零条目、三个工具各两行、`storage` 照常列出、钩子无输出；`default` 与子目录同样）；单元（路径判定含目录联接、纯字符串判定不碰文件系统、`resolveProjectRoot`、上下文不开库、存储标记与清理规则、建出过文件的条目不删、面板不保护草稿会话、`storage` / `clean` 照常且存储清单走同一道 45 KB 上限）；变异 18 处 | 这类目录不留下任何东西；旧的空条目被清掉；真实项目与存储管理不受影响 | `node --test plugins/codegraph/tests/e2e/host-workspace.test.mjs plugins/codegraph/tests/paths.test.mjs plugins/codegraph/tests/mcp/ plugins/codegraph/tests/hooks/ plugins/codegraph/tests/index/storage.test.mjs plugins/codegraph/tests/extension/ plugins/codegraph/tests/render/` | PASS（2026-11-27：257 项 256 过 1 跳过 0 失败，退出码 0；修复前新用例 13 条失败） |

## Verification commands

- `node --check plugins/codegraph/bin/server.mjs plugins/codegraph/bin/hook.mjs plugins/codegraph/bin/selftest.mjs plugins/codegraph/bin/extension.mjs`
- `node --test plugins/codegraph/tests/*.test.mjs plugins/codegraph/tests/*/*.test.mjs`（`tests/extension/page.test.mjs` 要 Chrome 或 Edge，没有则跳过）
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
| Bash 检索时由钩子提醒改用 codegraph | 多一个每条 Bash 都会起的 node 进程。2026-11-25 的一次真实会话观察（只读任务「找出 `plugins/codegraph` 里直接调用 `readFileSync` 的位置」，`build` 模式）：模型第一步**同时**发出 `git grep` 与 `codegraph_lookup search readFileSync`，并不是「先用 codegraph」——它把两边都下注；那次会话卡在权限确认上，没看到最终答案 | 做一轮 T21 类的真实会话对照、确认「先 grep」仍然普遍时 |
| 变量与参数的读取进搜索 | **不做**（用户 2026-11-25：搜不到的继续用 Grep 是正确做法）。属性读取已由 W30 / W32 用查询时扫描覆盖；对象字面量的键、解构出来的字段、类型的成员原也列在这里，用户同日说「值得做就做」，已由 W33 用同一次扫描覆盖。剩下的变量与参数信息密度低、形态多，交给 Grep。2026-11-25 量过把它们记进索引的代价：属性读取按「名字 × 接收者 × 文件 × 所在符号」逐条记，zcode-plugin 多 9,048 条（现有 32,228 条的 +28%），coding-usage 多 17,441 条（+54%）；已有索引要整体重建一次 | — |
| 文件变化后在后台立即增量同步（上游 codegraph 的做法：监听 + 2 秒去抖后直接重解析） | 现在是标脏后等下一次工具调用；T20 的 13 个会话里模型在第一次编辑后 0 次 codegraph 调用，单文件增量 35–57 ms，主动同步做的是没人消费的工作 | 用户反馈首次调用变慢时 |
| `affected` 的反向索引（按目标文件找引用）、`imports.resolved_file_id` 的索引、增量同步后的 `PRAGMA optimize` | 反向走一步要把 `refs` 与 `imports` 各扫一遍，线性于表的大小：本机最大的索引（8384 个文件、160 万条 `refs`）单次 190 ms，深度 6 走完 0.4–0.6 秒，在 30 秒的工具超时之内；改存储结构是另一轮的事。按「符号 → 引用」钉死连接顺序已实测否决：前沿 2 个文件 4.5 秒、32 个 40 秒（2026-11-26，`.tmp/t39/pinned-curve.mjs`） | 用户在更大的仓库上反馈 `affected` 慢时 |
| Python 同级模块 `from util import add` 不解析 | 解析器既有的召回缺口，不是 W35 引入；`cycles` 与 `affected` 只看已解析的边，页脚提示已说明「未解析的 specifier 不在图里」 | 做 Python 相对导入解析时一并处理 |
| `TEST_PATH_PARTS` 的 `tests.cs` 会把 `Contests.cs` 一类源码当成测试 | 清单是既有的（`usageCounts` 的 `inSource` 也用它），W35 只是多了一个消费方 `affected` | 改清单时连同 `usageCounts` 的口径一起核对 |
| `limit = 200` 时 `limit + 1` 探针被上限夹掉，没有 `(200 of 201+ shown)` | 既有的探针写法，`affected` / `callers` / `callees` 一致 | 需要精确回答「还有没有」时改成单独的计数查询 |
| ZCode 自建工作区的识别只靠路径（`.zcode/workspace`） | 宿主只在扩展拿到的会话列表里给 `isDraft`，钩子与 MCP 进程没有任何显式标记；2026-11-27 实测 `draft-<uuid>`、`default`、`<时间戳>-<uuid>` 三种都在这个目录下，按路径拼写的纯字符串版供索引存储用。只开草稿会话时不会触发自动清理，旧条目要等某个真实项目的会话启动或在面板里点清理 | ZCode 改了这个目录名（症状：草稿工作区重新出现在面板里），或宿主给钩子 / MCP 传入显式标记时 |

## Rollback

插件是独立目录：删除 `plugins/codegraph/`、市场条目、根 README 两行即可完全回退。索引与 `dirty.log` 在插件数据目录，可整目录删除。既有文件只动了 `scripts/check-consistency.py`（新增一个扩展名排除）、`marketplace.json`、两份 README（新增条目），均为加法。已知坑：Windows 下 `node:sqlite` 连接不关闭会让文件无法删除；`.wasm` 含合法 `\r\n`，一致性脚本必须跳过。

## Phase log

| 阶段 | 日期 | 证据 | 结论 |
|------|------|------|------|
| 4 续（W38） | 2026-11-27 | 用户：「如果是 zcode运行的workspace它也会被带进来显示未索引，这种非真实项目的不要弄进来啊」。复现（临时数据目录）：草稿工作区里钩子注入「Not indexed: no index for this project yet…」、`codegraph_status` 报 `below-min-files`、存储多一条 210 KB 的 `empty` 记录、面板一行「未索引 · 临时会话」。新用例先红（13 条）；修复后计划第 40 条命令 257 项 256 过 0 失败 1 跳过、全套 715 项 709 过 0 失败 6 跳过、一致性脚本通过、变异 18 处全部被抓住（`.tmp/t40/mutate.mjs`）。独立审查第一轮 `APPROVE_WITH_COMMENTS`：两条 P2（`storage` / `clean` 被一并拒掉；索引存储对每个条目做同步 `realpath`）与两条 P3（建出过文件的索引也被删；数据目录经目录联接访问时漏判）都已修，第二轮逐条执行复核成立；第二轮增量只剩一条 P3（拒绝路径里的存储清单绕过 45 KB 上限）与一处用例缺口（`clean=current`、`refresh + storage`），已修并跑了自动检查，没有再过第三轮。check-level: test | W38 [x]，T40 PASS，0.2.1；提交 / 推送 / 安装等授权 |
| 4 借鉴 CodeGraph-Rust（W34–W37） | 2026-11-26 | 全套 693 项 687 过 0 失败 6 跳过；一致性脚本通过；计划 36–39 四条命令退出码都是 0；17 个变异全部被对应测试抓住（`.tmp/t39/mutate-round2.mjs`，文件逐字节恢复）；本机 9 个索引只读实测：`cycles` 最大 27 ms（8384 个文件、70 个环），`affected` 深度 6 最大 401 ms；两轮独立审查都是 `APPROVE_WITH_COMMENTS`、无 P0–P2 | W34–W37 已发布：`9175145`（W37 的测试）与 `3c08fd1`（其余功能 + 0.2.0）快进推到 `origin/main`，已安装，新会话起生效；已安装副本上协议探针、四个探针、`.gitignore` 的三个泄漏场景与 selftest 都通过。第一轮之后：`affected` 的引用边收紧为仅 `=`（`~` 边把 8 个真实依赖放大成 68 个），超过 60 个文件的环只按路径列出；第二轮的三条 P3（`affected` 首行只列 5 个输入路径、未知路径截 100 字符、两条渲染测试改成相对断言）已修并跑了自动检查，没有再过第三轮审查 |
| 3 收尾（续二） | 2026-11-25 | 用户：「对象字面量的键、变量读取进搜索这个是能做吗」→「值得做就做」；「样式表可以分发因为开源的啊」。**W33（对象键、解构、JSX 属性名、类型的属性与方法进搜索）**：worker 为每个文件多记「单独出现的名字」（`bareName`），读取与键两种查找各截各的热点（键侧上限 200，因为按「单独出现」计是个很松的超集），行多了 `key` / `field`，一侧被截时回 `cut`、合计带 `+`、页脚说缺的是哪一侧。实现中自己发现并修掉：键热点成立时只作为键的文件仍被解析；加键后第一次读一遍变贵（列出单独出现的名字，cindy 193 MB 要 2.5 秒），冷盘上超过三轮的时限 → prime 改成分轮读到完。审查 `review-12-property-reads.md` 第六轮（1 条 P2 + 5 条 P3：方法签名、JSX 在 javascript 语法上、被截的一半说出口、键侧上限、候选重读的时限、`NOTICE.md` §4(d)）与第七轮（批准，无阻塞）。**样式表声明**：核实公开仓库 `zai-org/ZCode` 是 Apache-2.0、已安装应用里的文件与仓库里的逐字节相同，补了 `ui/licenses/LICENSE.zcode.txt` 与 THIRD-PARTY-NOTICES §7。`node --test plugins/codegraph/tests/` → 647 项 641 过 0 失败 6 跳过；`check-consistency.py` ALL CHECKS PASSED；selftest 三项通过；变异 145 处全部被抓住；四个真实索引上只读计时；已安装副本经真实协议的探针全过。check-level: test | W33 [x]，T34 PASS；已安装；**未提交、未推送**（W31 / W32 / W33 与声明一起，等授权）。遗留：真实会话里模型是否用得上、macOS / Linux 实机 |
| 3 收尾（续） | 2026-11-25 | W29（增量同步不认 `.gitignore`，真实会话里发现的）与 W30（属性读取改为查询时扫描：专用 worker、五种上限、与索引的使用位置合成一份）。W30 第一版是主线程同步扫描，按审查意见重做；三轮审查里又改掉：热点差一、解析预算过大（打包产物形状的文件解析约 1 MB/s）、被截断时页脚说「找过、没有」、worker 在扫描中途崩溃时主线程再抛一次、读索引给的路径没有越界核对、`isInside` 对根的写法敏感、预筛在几种形状下二次方 / 指数级。`node --test plugins/codegraph/tests/` → 626 项 620 过 0 失败 6 跳过；`check-consistency.py` ALL CHECKS PASSED；selftest 三项通过；变异 72 处全部被抓住；两个真实索引上只读计时；已安装副本经真实协议的探针。check-level: test | W29 [x]，提交 `04b7a7d`（用户授权）；W30 [x]，提交 `48a0418`（用户授权），T30–T31 PASS；已安装。之后用户说「把没做的按照最佳方向做」「搜不到的仍使用 Grep 是正确做法」：做了 W31（链接一律不进索引）与 W32（属性读取的扫描在大仓库上工作——回放 T20 的名字时发现首版在 cindy 上整体不工作），T32–T33 PASS，审查 `review-12` 第四、五轮批准，已安装，**未提交**（等授权）；「对象字面量的键、变量读取进搜索」不做。codegraph 的提交都未推送（等用户确认样式表能否分发）。遗留：真实会话里模型是否用得上、macOS / Linux 实机 |
| 3 收尾 | 2026-11-24 | T20 13 个会话全部跑完（`bench.md`），定向指标：有 codegraph 时到达真值文件中位 6 次调用、没有则 12 次，首次编辑后再调用 0 次。按用户在结果之后定的方向加了 W21（会话开始即建 / 刷新索引 + 就绪通知）与 W24（search 前 3 行带「谁依赖它」），各自经真实会话或真实索引验证；W23 补修根目录测试 / 脚本目录不被识别。`node --test plugins/codegraph/tests` → 491 用例 485 过 0 失败 6 跳过；`check-consistency.py` ALL CHECKS PASSED；`selftest` 15 断言；七条真实首查回放 7/7。独立审查：`review-5-silent-start.md`（一轮）、`review-6-usage-summary.md`（三轮收敛）。check-level: test | W21–W24 [x]，T20–T25 PASS；已安装，两处副本与工作树一致；**未提交、未推送**（待用户授权）。遗留：T7 基线臂与关臂读过参考答案、没有重跑；两项改动都没有再用真实会话验证模型行为；`files` 表固化测试文件判定、逐项目关闭索引的开关、索引淘汰机制未做 |
| 2 集成与验证（续） | 2026-11-24 | W19 基线开臂：T1、T2、T6 完成，T3、T7 运行中；T2 关臂完成。**口径更正**：模型不用 `Grep` 工具，检索走 Bash 里的 `grep`，早先「Grep 0 次」不成立（T1 开臂实际 55 次、T6 49 次），`measure-sessions.mjs` 已按管道段判定。基线发现：首步采用 5/5，但查询是描述或猜的名字，旧版 search 空结果或噪声、渲染按 path 重排，随后退回 grep → 开启 W23。W23 `searchSymbolsDetailed`：`node --test plugins/codegraph/tests/` → 463 用例 457 过 0 失败 6 跳过；`check-consistency.py` ALL CHECKS PASSED；`selftest` 15 断言；真实 stdio server 端到端（`"hook guide"` → `1 match for guide (no name has all words)`）。独立审查 `.devflow/codegraph-plugin/review-3-search.md`（三轮，均 APPROVE_WITH_COMMENTS，无 P0 / P1；审查方无 Bash，结论为读出来的；测试、真实索引对比、变异验证由主 agent 执行）。check-level: test | W23 [x]，仍未安装、未提交；W19 继续跑关臂与 W23 开臂 |
| 2 集成与验证 | 2026-11-23 | W15–W18 [x]，W19 [!]（T20 待用户在安装后执行）。全套 447 用例 441 过 0 失败 6 跳过；契约 75/75；selftest/check-consistency 通过；真实 stdio server 端到端 3 s 就绪；用户仓库 deepseek-harness（8,384 文件，38.8 s）与 cindy（17,830 文件，100.8 s）定义抽样 ≥ 99%。审查 `.devflow/codegraph-plugin/review-2.md`（2 P1 + 3 P2 处置，探针复验）。五问：主张复核=每个数字都是本机跑出来的且附命令；最小性=按 profile 只改热点（批量 INSERT、bulk load、分组 UPDATE、id 保留），原生运行时与 Rust 内核均被实测否定；新风险=bulk 期间 FK 关闭靠 end 的 foreign_key_check 兜底、并发 openDatabase 只降速；反例=被杀构建、回滚后 TEMP 表、并发打开、损坏库、离线均有用例；可检查性=e2e 门槛脚本 + 两个真实仓库基准脚本入 .devflow。check-level: test | Gate 通过（W15–W18）；W19/T20 待用户，按规则暂不进入阶段 3 |
| 1 并行开发 | 2026-11-23 | W6–W14 全 [x]；全套 `node --test plugins/codegraph/tests/*.test.mjs plugins/codegraph/tests/*/*.test.mjs` → 417 用例 416 过 0 失败 1 跳过（两遍一致，≈21 s）；契约 75/75；`selftest --self-test` 15 断言；`check-consistency.py` ALL CHECKS PASSED；真实 stdio server 端到端（本仓库 235 文件 3.0 s 就绪，`symbol createServer` callers 4/4 解析）。审查：`.devflow/codegraph-plugin/review-1-core.md`（2 P1 + 15 P2 全部处置，探针复验）与 `review-1-iface.md`（1 P1 + P2 全部处置）。五问：主张复核=每位审查者的探针在修复后重跑转绿；最小性=P1 修复各 ≤ 10 行复用既有 #build/#sync；新风险=周期枚举每 60 s 一次 listFiles（10k 文件约 100 ms）、死进程续建依赖锁判定；反例=被杀构建、切分支新增文件、Ruby/PHP callers 翻倍、零字节锁、静默 worker 均有负向用例；可检查性=新增 19 条索引/解析用例 + 契约测试 refs 断言。check-level: test | Gate 通过，可进入阶段 2 |
| 0 契约与骨架 | 2026-11-23 | W1–W5 全 [x]；`node --test plugins/codegraph/tests/*.test.mjs plugins/codegraph/tests/*/*.test.mjs` → 34/34 exit 0；`selftest --self-test` 15 断言 exit 0；`--grammars` 32/32 exit 0；`--licenses` 193 项 exit 0；审查 `.devflow/codegraph-plugin/review-0.md`（7 P1 全部处置，P1-7 实测不成立）。五问：主张复核=每条 P1 都有探针前后对照；最小性=删除 FK 绕行与 NAME_TYPES 白名单、无需原生依赖；新风险=TurboFan 依赖「swift 换构建」，留 CODEGRAPH_LIFTOFF_ONLY 保险；反例=单行定义归属、Ruby 类名、Python docstring、函数型 fn 均有负向用例；可检查性=契约测试新增 refs/qual/doc 断言。check-level: test | Gate 通过，可进入阶段 1 |
