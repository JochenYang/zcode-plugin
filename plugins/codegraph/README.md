# codegraph

ZCode 的本地代码图谱插件：一个零 npm 依赖的 MCP server，用随包的 tree-sitter wasm 把工作区里 35 行语言索引成「符号 / 引用 / 调用 / 导入」图，存进插件数据目录下的 SQLite；模型通过三个工具直接拿到精确的 `file:line` 行段，替代「Grep 一轮、整文件 Read 一轮」的反复试探。**不联网、不遥测、不执行项目代码。**

模型看到的工具名带插件命名空间：`mcp__plugin_codegraph_codegraph__<tool>`。

## 工具

| 工具 | 参数 | 做什么 |
|---|---|---|
| `codegraph_status` | `refresh?: boolean`，`storage?: boolean`，`clean?: stale \| all \| current \| project`，`project?: string`，`confirm?: boolean` | 索引状态：`ready` / `building` / `empty`、文件数、符号数、覆盖语言、陈旧文件数；`refresh: true` 强制增量同步（符合自动索引条件的项目会借此启动后台构建）；`storage: true` 列出本机所有项目的索引与清理策略；`clean` 删除索引，不带 `confirm: true` 时只列出会删什么 |
| `codegraph_lookup` | `operation: search \| symbol \| callers \| callees \| impact \| outline`，`query?`、`name?`、`file?`、`depth?`（1–6，默认 2）、`limit?`（1–200，默认 20）、`body?: boolean` | 定位符号、调用者、被调用者、改动影响面、文件大纲；每行一个符号，带精确行段，`body=true` 且函数体 ≤ 30 行时内联源码，否则给出要 Read 的行段 |
| `codegraph_map` | `path?`、`budget?`（200–4000 tokens，默认 1200） | 仓库地图：目录 → 文件 → 关键符号，按引用数排序，按 token 预算截断 |

`search` 用 `query`；`symbol` / `callers` / `callees` / `impact` 用 `name`（加 `file` 消歧）；`outline` 用 `file`。

`search` 的 `query` 可以是符号名、前缀，也可以是一句描述（`gift card redeem`、`sign in auth cookie browser`），词序不限：没有名字同时含所有词时，以其中最长的两个词为锚找部分匹配，同时含更多查询词的排前面，并在首行标明（`18 partial matches (no name has all words; best match: gift + card + redeem)`）。结果按相关度排序——完全同名优先，其次以查询开头的名字，同一层里源码符号排在测试和脚本前面——所以截断时留下的是最相关的行。`symbol` 的入边是全部引用：函数写作 `called by`，类型、常量、字段写作 `used by`；`body=true` 在同一次调用里带回定义源码。前 3 行的行尾带「谁在用它」：` · 12 uses in 4 files (3 in source)`（其它文件里的引用数、所在文件数、其中源码文件数），其中有按唯一名字连上的引用时数字带 `~`；被大量引用的符号只给 ` · 15361 references (not broken down by file)`。

没有符号叫这个名字时——库的函数（`useEffect`、`readFileSync`）、方法调用（`client.takePendingDeepLink()`）、类型名，以及 JS/TS 里点号读取的属性（`row.membershipKind`，查询时扫描源码现找）——`search` 改列**使用它的位置**：首行 `# search useEffect · no symbol carries this name; 90 uses in 48 files (useEffect) · also in symbol names: useT, useTick (+18 more found)`，每行 ` call useEffect ×4 in ThemeProvider src/components/ThemeProvider.tsx:63`，属性读取的行是 ` property config.maxIdleDays ×2 in storageOf plugins/codegraph/src/mcp/tools.mjs:317`（模块级引用写 `at`）。只沾了同一个词的符号不出现在行里，首行列出找到的前几个的名字。两种情况仍是符号优先：符号含全部词（`gift card redeem` → `redeemGiftCard`），以及这个名字用在超过 200 处（哪里都在用的名字说明不了方向）。对象字面量的键、字符串里的词、变量与参数不是引用，仍要 Grep。

关系带置信标记：`=` import 解析确定；`~` 同名唯一（可能是同名误连）；`?` 未解析、歧义或动态调用——`?` 对结论重要时用 Grep 复核。截断时末行标 `(N of M shown)`；构建中首行标 `indexing N% (results partial)`；有陈旧文件时标 `stale: N files changed since index`。

## 索引什么时候建、什么时候更新

- **会话一打开就开始，不等模型调用工具。** 每个会话有自己的 codegraph 服务进程，握手完成时它在后台做一次刷新：项目还没索引且符合自动索引条件就建第一次索引，已索引就检查文件变化并增量同步。模型什么都不用做。
- **模型随时能看到状态。** 会话开头由钩子注入一行状态和指引（见下）；如果索引是在会话中途才建完的，下一条用户消息处会再注入一次就绪通知，每个会话只通知一次。
- 首次构建的耗时取决于项目大小：几百个文件几秒，一千多个文件十几秒，上万文件一两分钟。构建期间的查询带着 `indexing N% (results partial)` 标记照常返回已有的部分。
- 低于自动索引门槛（默认 30 个受支持文件）、关闭了 `autoIndex`、或项目自己的 `.zcode/codegraph.json` 里写了 `"autoIndex": false` 的项目不会自动建；家目录和盘根从不自动索引。
- **`.gitignore` 里的文件不进索引**：完整扫描按 `git ls-files --exclude-standard` 列文件；两次扫描之间由文件监听或钩子报来的文件，同步时也会问一次 git，被忽略的新文件不进、已被 `.gitignore` 收进去的旧条目当场删。git 不可用、调用失败或超时的环境只按内置忽略目录与 `exclude` 过滤，不认 `.gitignore`。
- **代价**：这是一项默认开启的行为，适用于每个打开过的项目，不管模型有没有用到 codegraph。首次构建占 CPU（4 个工作线程，构建期间与自己的构建 / 测试争抢），索引留在插件数据目录里，实测约 26 KB 每个文件（1.8 万文件的项目约 471 MB）。不想要就在设置里关掉 `autoIndex`，或在项目根放一个 `.zcode/codegraph.json`（见「配置」）。关闭之后只有手动 `refresh` 会动索引：查询首行注明没有同步，`codegraph_status` 多一行说明。

## 磁盘占用与清理

索引都在 `~/.zcode/cli/plugins/data/codegraph@zcode-plugin/indexes/<项目键>/`，项目目录里不写任何文件。每个会话打开时服务会顺带整理一次这个目录：

| 情况 | 处理 |
|---|---|
| 超过 `maxIdleDays`（默认 90 天）没有服务过任何会话 | 删除，下次打开该项目时自动重建；`0` 表示一直保留 |
| 全部索引加起来超过 `maxTotalMB`（默认 `0`，不限制） | 从最久没用的删起，直到低于上限 |
| 项目的目录已经不存在 | 按同一条闲置规则处理，只是清单里会标出来；不会因为目录暂时找不到（没插的移动硬盘、没挂载的网络盘）就提前删 |
| 某个会话正在写这个索引 | 不删 |

「最近使用」取索引目录里最新的一次写入（会话开始时的 `used.at`、状态文件、钩子写的编辑日志和会话标记）。被删的只是派生数据，重建即可。

要看和手动清理，用斜杠命令：

- `/codegraph`：当前项目的索引状态。`/codegraph storage`：再加上本机所有项目的索引（路径、状态、大小、上次使用）和当前策略。
- `/codegraph clean`：按上面的策略清理；`clean all`：除当前项目外全部删除；`clean current`：删掉当前项目的索引，下一次调用时重建（索引看起来不对时用它从头来过）；`clean <项目路径>`：删指定项目的。清理分两步：先列出会删什么，再由模型带着确认执行，所以命令一发出去就会完成，模型不会自作主张地清理。
- `codegraph_status` 工具对应 `storage: true` 与 `clean` / `project` / `confirm` 参数。

## 桌面端界面

在 ZCode 桌面端（命令行会话里没有），插件另外带一个扩展，把上面这些事情做成能点的界面。**首次激活时 ZCode 会弹窗请你确认。**

- **输入框状态位**（每个会话一项）：输入框工具栏里显示当前项目索引的状态——就绪时是文件数（`291 个文件`），构建中是百分比，出错时是 `出错`，项目自己的 `.zcode/codegraph.json` 关闭了索引时是 `未开启`；项目还没有索引时什么都不显示。悬停能看到符号数、大小、多久前建的、有没有改过但还没同步的文件。点它打开索引管理面板。有索引在构建时每 5 秒刷新一次，否则每 60 秒。
- **侧边栏入口**：侧边栏的插件入口里有一项「代码图谱索引」，打开同一个面板。
- **索引管理面板**，从上到下：
  - 标题、一行说明和「刷新」；三张统计卡：项目数量、索引总大小、索引文件数。
  - **索引存储位置**：目录路径。「打开目录」在系统的文件管理器里打开它；「复制路径」把路径放到剪贴板，沙箱不让写剪贴板时改为选中路径并提示按 Ctrl+C。
  - **项目索引**：每个索引一行——路径、状态、大小与文件数、上次使用，以及备注（临时会话、项目目录不存在、使用中、当前会话、已到期）。状态用带圆点的彩色标签表示（就绪绿色、构建中蓝色、出错红色）。ZCode 给还没指定目录的会话建的临时工作区也在这里，标成「临时会话」并排在最后。底部是「清理到期索引」，按钮上写着有几个。
  - **自动清理策略**：闲置多少天后删除、总量上限（MB），`0` 表示不限。保存在插件设置里（`maxIdleDays` / `maxTotalMB`），下次会话打开时生效；`codegraph.json` 里写了的那一项在这里改不了，面板会说明去哪里改。
  - **删除**分两步：先点「删除」，再点「确认删除」。打开着的会话的项目、正在被别的会话写入的索引不能在这里删（按钮置灰）；前者要去那个会话里用 `/codegraph clean current`。「清理到期索引」同样分两步。
- 面板跟着应用的主题（明 / 暗）和语言走。卡片、按钮、输入框、表格用的是 ZCode 自己给沙箱界面定的那一套，没有改动；图标是 ZCode 用的同一套 Lucide，内联在页面里。面板自己只加了五样装饰：图标底下的色块、分区标题前的竖条、路径的底色、按状态着色的标签，以及说明文字用的颜色（ZCode 的次要文字色在浅色主题下只有 4.26:1，面板把它和正文色混合后用到 4.99:1）。它们的颜色全部取自 ZCode 的主题值，明暗自动跟随；状态色先和文字色混合再用，浅色主题下文字对比度不低于 4.5:1。宿主交给沙箱页面的变量里不含应用的组件色，所以卡片、主按钮、输入框用的是那套样式内置的颜色——ZCode 自带的可视化也是如此。

状态位和面板只读本机的索引目录，不联网。项目的路径在一段时间内不应答（断开的网络盘、没插的移动硬盘）时，这一轮不显示它的状态位；面板里它的索引也不受「打开会话」的保护——被删了只是下次重建。

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
| `maxIdleDays` | `90` | 一个项目的索引超过这么多天没服务过会话，就在会话打开时删除；`0` 一直保留 |
| `maxTotalMB` | `0` | 全部索引的总大小上限，超过后删最久没用的；`0` 不限制 |

自动索引条件：`autoIndex` 开、项目根不是家目录或盘根、支持语言的文件数 ≥ `minFilesToAutoIndex`、总文件数 ≤ `maxFiles`。四条都满足才建，否则 `codegraph_status` 说明原因。

环境变量（配置文件里对应字段为空时生效）：`CODEGRAPH_AUTO_INDEX`、`CODEGRAPH_MIN_FILES`、`CODEGRAPH_MAX_FILES`、`CODEGRAPH_EXCLUDE`（逗号分隔）、`CODEGRAPH_LIFTOFF_ONLY`（`1` 打开 V8 的 `--liftoff-only` 保险开关，索引慢约 1.6 倍）、`CODEGRAPH_MAX_IDLE_DAYS`、`CODEGRAPH_MAX_TOTAL_MB`。

清单里的 `userConfig`（`autoIndex` / `minFiles` / `maxFiles` / `exclude` / `liftoffOnly` / `maxIdleDays` / `maxTotalMB`）通过 `${user_config.*}` 展开成上面这些变量，对应 ZCode 插件详情页里的一组配置项。

**项目自己的设置**：项目根目录下的 `.zcode/codegraph.json`，可以提交进仓库，让一个项目对索引提出要求：

```json
{ "autoIndex": false, "exclude": ["vendor/", "*.generated.ts"] }
```

可写的键是 `autoIndex`、`exclude`、`minFilesToAutoIndex`、`maxFiles`、`languages`。项目文件**只能收紧，不能放宽**：可以关掉索引、追加排除、提高自动索引的文件门槛、降低文件上限、收窄语言；不能在用户关掉索引的情况下打开它，也不能突破用户设的上限。输出预算和磁盘策略只能在用户的配置文件里改。

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
- **search 的使用位置：索引里的引用，加上 JS/TS 的属性读取**：索引里稳定覆盖的是调用（带接收者，如 `fs.readFileSync`）、类型名，以及方法调用的对象（`console.log(x)` 里的 `console`，它不是本文件的局部名字时）。JS/TS 里点号读取的属性（`row.membershipKind`）不在索引里，`search` 在没有同名符号时扫描源码现找——读文件和解析在后台线程里，服务进程照常应答：先读一遍全部 JS/TS 文件做文本预筛（两个真实仓库各 1.5 MB 与 2.7 MB，4 ~ 14 毫秒），只解析命中的文件（常见名字 50 ~ 190 毫秒）。有五种上限，越过时合计带 `+`（页脚会说明 `+` 是下界）并说明原因：同一个名字出现在超过 60 个文件里当热点不列；预筛命中超过 400 处、读入超过 64 MB、解析超过 2 MB 时停下（最小的文件先解析，被舍弃的是最大的几个文件——压缩过的打包产物解析速度只有手写代码的四分之一左右）；单次扫描超过 10 秒放弃。点号与名字之间隔得很远的读取会漏掉（超过 40 个空白字符，或中间夹着超过 200 个字符的块注释、超过 1000 个字符的行注释）。只读项目内的普通文件（索引给的路径也要过这道核对），不跟随符号链接；有文件读不到时不把结果说成完整的。搜不到的（要 Grep）：参数、局部变量、解构出来的字段、方括号访问、对象字面量的键、字符串里的词；只写不读值的也不算（`obj.name = 1`、解构与 `for…of` 的赋值目标、方法调用、`new`、装饰器）。没有同名引用、又是一两个字母的词时还要在索引的全表上扫描，大仓库上约 1 秒多（220 万条引用实测 1.3 秒，其余查询 0.2 秒内）。解析器对没法归约的调用会把整段调用文本记成名字，这种行里的名字很长，输出里截断显示。
- **首次构建在后台**：大仓库第一次查询拿到的可能是 partial 结果，`codegraph_status` 看进度；构建完成后自动就绪。
- **索引可能滞后几秒**：外部编辑（非 ZCode 工具）靠下一次查询前的 mtime 扫描补上；工具输出首行会标 `stale: N`。
- **钩子依赖 PATH 里的 node**：见「安装要求」。
- **每个会话一个 server 进程**：多个会话各自打开同一个 SQLite，写入走 pid 文件锁；拿不到锁的会话只读（查询照常，不同步）。
- **界面入口用的是 ZCode 没有公开文档的扩展接口**：只在桌面端生效，接口按 4.0.10870 的打包代码核对过；清单里声明的 `engines.zcode ^1.3.0` 与已安装的 model-speed 同值，宿主是否满足没有直接证据。按宿主处理清单的方式，应用升级后扩展部分若不再合法会被标成无效并忽略，索引、工具、钩子是分开加载的（这是读打包代码得出的，没有实测过升级后的情形）。
- **浅色主题下官方的错误色不到 WCAG AA 的对比度**：用 ZCode 4.0.10870 的主题实测是 2.81:1（正文 9.93:1），面板用它显示出错的状态和失败的消息，没有改动。官方的次要文字色在那里是 4.26:1，面板没有直接用它：说明、备注这些用的是和正文色混合后的颜色，4.99:1。面板自己的状态标签 5.07:1、图标 3.99:1。

## 开发与验证

```bash
node --check plugins/codegraph/bin/hook.mjs plugins/codegraph/bin/server.mjs plugins/codegraph/bin/extension.mjs
node --test plugins/codegraph/tests/                  # 全套：契约、存储、图谱、渲染、工具、索引、钩子、端到端
node --test plugins/codegraph/tests/hooks/*.test.mjs     # 钩子：真实 spawn，含 Windows 管道路径
node --test plugins/codegraph/tests/extension/           # 扩展逻辑，以及页面在无头浏览器里的检查（要 Chrome 或 Edge，没有则跳过后者）
python scripts/check-consistency.py                      # 版本四处一致、行尾、市场 source
```

面板的检查把页面放进 320 像素、侧边栏宽度和桌面宽度的窗口里各走一遍（中英文、明暗两套主题）：三个样式块的性质（官方原文不改、布局只有版式、装饰只取官方令牌）、类名、图标与 Lucide 原文一致、标签不换行、路径至多两行、对比度、删除与清理的两步确认、焦点、加载中、空存储、出错后重试、打开目录与复制路径。把 `CODEGRAPH_PAGE` 指向另一份页面可以确认这些检查在页面被改坏时会失败。

## 目录

```text
plugins/codegraph/
├── .zcode-plugin/plugin.json   # 清单：mcpServers（含 CODEGRAPH_* env 映射）+ commands + userConfig + 桌面端的 extension / slots
├── bin/server.mjs              # MCP server 入口（Node ≥ 22.13 检查、--liftoff-only 保险）
├── bin/hook.mjs                # 钩子入口：session-start / post-tool
├── bin/extension.mjs           # 桌面端扩展：输入框状态位、索引管理面板和它的五个工具
├── hooks/hooks.json            # SessionStart + UserPromptSubmit + PostToolUse，type: process
├── commands/codegraph.md       # /codegraph [refresh]
├── src/                        # 路径、引擎、索引器、解析、存储、MCP、渲染；src/extension/ 是状态位与面板数据的纯逻辑
├── languages/*.mjs             # 语言包（每包一个文件，无中央清单）
├── grammars/                   # wasm、运行时、参考查询、许可文本
├── ui/index.html               # 索引管理面板，全部内联；三个 <style>：ZCode 沙箱样式表的逐条原文、只放版式的布局、只取官方令牌的装饰
├── ui/icons/*.svg              # 面板内联的 Lucide 图标的原文件（页面里内联它们，测试拿它们对照）
├── ui/design-system-zcode.md   # 面板对照的设计系统（ZCode 的主题契约与工具类、面板自有的装饰、图标）
└── tests/                      # node --test，按 lane 分目录
```

---

## English summary

codegraph is a local code-graph plugin for ZCode: a zero-dependency MCP server that indexes 35 language rows (33 symbol-extracting packs plus COBOL and Liquid at file level) with bundled tree-sitter wasm into SQLite under the plugin data folder, and exposes three tools — `codegraph_status`, `codegraph_lookup` (search / symbol / callers / callees / impact / outline) and `codegraph_map` — returning exact `file:line` ranges so the model reads only what it needs; the leading rows of a search also say who uses them (` · 12 uses in 4 files (3 in source)`, `~` when some of those links are by unique name); a name no symbol carries (a library function, a method, a type, or a property read such as `row.field` in JS/TS, which a scan of the source finds) lists the places that use it instead (`no symbol carries this name; 90 uses in 48 files`), unless the name is used in more than 200 places. The index is built or refreshed silently when a session opens, so a new project is indexed without the model asking. Indexes live under the plugin data folder, one per project; when a session opens the store is tidied (indexes unused for `maxIdleDays` are deleted, as are the least recently used ones while the store is over `maxTotalMB`; each is rebuilt when its project is opened again), `/codegraph storage` lists them with size and last use, `/codegraph clean` removes them, and a project can switch indexing off or exclude paths with its own `.zcode/codegraph.json`. Three hooks (`SessionStart` for the status and guidance, `UserPromptSubmit` to announce an index that became ready mid-session, `PostToolUse` to append edited files to `dirty.log`) are accelerators only; the server's mtime scan keeps the index correct without them. Requirements: Node ≥ 22.13; the MCP side has ZCode's built-in Node fallback, the hooks resolve `node` from PATH only. No network, no telemetry, no project code execution. Configuration: `~/.zcode/cli/plugins/data/codegraph@zcode-plugin/codegraph.json` (`autoIndex`, `minFilesToAutoIndex`, `maxFiles`, `exclude`, `languages`, `maxIdleDays`, `maxTotalMB`) with `CODEGRAPH_*` environment variables that only apply when the file leaves the field unset. Known limits: COBOL and Liquid are file-level, dynamic language features stay unresolved (`?`), variables and parameters, object keys in literals and words in strings are not in the graph (Grep finds those), the first build runs in the background. In the ZCode desktop app an extension adds a status item in the composer toolbar (file count when the index is ready, the percentage while it builds, `error`, or `off` when the project switched indexing off) that opens an index management view: every index with state, size and last use; delete and clean-what-is-due each ask for a second press; the two policy limits can be changed there, and it follows the app's theme and language, drawn with ZCode's own sandbox stylesheet. It uses an interface ZCode has not documented (checked against 4.0.10870) and asks for confirmation the first time it is activated.
