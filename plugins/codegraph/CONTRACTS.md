# codegraph 内部契约（所有并行 lane 的共同依据）

本文件是实现的依据，随改动一起更新：改了接口或输出格式，就在同一批里改这里与对应的测试（输出格式以 §11 的快照测试为准）。

## 0. 运行时与约定

- Node ≥ 22.13（`node:sqlite`）。ESM，文件一律 `.mjs`；零 npm 依赖；不联网、不执行项目代码。
- **V8 wasm 分层**：默认允许 TurboFan 升级（比 `--liftoff-only` 快约 1.6×）。曾有一个随包语法（`tree-sitter-wasms` 版 swift）在升级编译时让整个进程崩溃，已换成 `codegraph` 仓库的构建；`CODEGRAPH_LIFTOFF_ONLY=1` 是保险开关，`src/bootstrap.mjs` 会带 `--liftoff-only` 重启一次。不要在别处再写重启逻辑。
- 测试用内置 `node --test`；只跑自己 lane：`node --test plugins/codegraph/tests/<lane>/*.test.mjs`。
- 注释写设计意图与约束，英文；标识符英文；错误信息英文、可行动。
- 失败就地抛错并带上下文；用户可见错误稳定、不泄露路径之外的敏感信息。
- 开发工具：`node plugins/codegraph/bin/ast.mjs <lang> <file> [--depth N]` 打印带字段名的 AST；`node plugins/codegraph/bin/extract.mjs <file>… [--spec <lang>] [--refs]` 打印抽取结果。

## 1. 目录与所有权

| 路径 | 所有者 |
|---|---|
| `src/paths.mjs`、`src/store/schema.sql`、`src/extract/*`、`languages/registry.mjs`、`tests/contract.test.mjs`、`grammars/loader.mjs` | 阶段 0（冻结） |
| `languages/<lang>.mjs`、`tests/languages/<lang>.test.mjs`、`tests/fixtures/langs/<lang>/*` | L1–L5（按语言分组） |
| `src/index/*`、`tests/index/*` | A |
| `src/resolve/*`、`src/graph/*`、`tests/resolve/*`、`tests/graph/*` | B |
| `src/mcp/*`、`src/render/*`、`src/config.mjs`、`tests/mcp/*`、`tests/render/*` | C |
| `hooks/*`、`bin/hook.mjs`、`commands/*`、`README.md`、`.zcode-plugin/plugin.json`、`THIRD-PARTY-NOTICES.md` 之外的打包文件 | D |
| `grammars/**`（wasm、runtime、manifest、LICENSES、queries、tools） | G（阶段 0） |

## 2. 路径（`src/paths.mjs`，已实现）

- `PLUGIN_ROOT`、`GRAMMARS_DIR`、`LANGUAGES_DIR`
- `dataDir()`：`ZCODE_PLUGIN_DATA`，缺省 `~/.zcode/cli/plugins/data/codegraph@zcode-plugin`
- `resolveProjectRoot(start?)` → `{ root, reason: 'git'|'cwd', unsafe }`：向上找最近的 `.git`；`unsafe` 表示家目录或盘根（索引器必须拒绝自动索引）
- `projectKey(root)`、`indexDir(root)`、`dbPath(root)`、`statusPath(root)`、`dirtyLogPath(root)`、`dirtyOffsetPath(root)`、`lockPath(root)`、`configPath()`
- `announcedPath(root, sessionId)`：`<indexDir>/announced/<sessionId>`，空文件，标记「这个会话已经被告知索引就绪」（`UserPromptSubmit` 钩子写与读）
- `projectConfigPath(root)`（`src/config.mjs`）：`<项目根>/.zcode/codegraph.json`，项目自己的设置，见 §12
- `indexesDir()`（`src/index/storage.mjs`）：`<dataDir>/indexes`，全部项目索引的根，见 §3.4
- `displayPath(root, abs)`：相对路径，`/` 分隔
- `isInside(root, abs)`：`abs`（已 resolve）是否就是 `root` 或在它之下。`root` 先经过 `path.resolve`，所以它的写法（Windows 下的正斜杠、尾部分隔符）不决定结果；文件系统不分大小写的平台上比较也不分大小写。读索引给出的路径之前都要过它（`readBody`、§8 属性读取的扫描）；只比前缀而不带分隔符的写法会把 `project-other/` 当成 `project/` 之下。`tests/store/paths.test.mjs`

## 3. 磁盘格式

### 3.1 `status.json`（索引器写，钩子读；tmp + rename 原子写）

```json
{ "schema": 1, "pluginVersion": "0.1.0", "root": "D:/x", "state": "empty|building|ready|error",
  "indexedAt": 1732000000000, "filesTotal": 0, "filesDone": 0, "symbols": 0,
  "languages": { "typescript": 12 }, "stale": 0, "error": null,
  "reason": null }
```

`reason`（additive）：`empty`/`error` 态的机器可读原因——`auto-index-disabled` / `unsafe-root` / `below-min-files` / `too-many-files` / `no-supported-files` / `build-failed`；`ready`/`building` 为 null。只读进程（拿不到锁）不写 status.json，`lock-held-read-only` 只出现在 `Indexer.status()` 的内存返回里。

### 3.2 `dirty.log`（钩子追加，索引器消费）

UTF-8 追加行：`<mtimeMs>\t<相对路径，/ 分隔>\n`。索引器记录已读字节偏移到 `dirty.offset`。索引目录不存在时钩子**不创建**（还没索引就没有可标脏的东西）。

### 3.3 `lock`（pid 判活）

内容为 pid；存在且该 pid 存活即视为有人持有写锁，等待最多 5 s。pid 不存在则视为陈旧锁可删除。

零字节锁文件（`O_EXCL` 已创建、pid 尚未写入的瞬间，或写入前进程已死）：mtime 与当前时间相差 < 2 s 视为正在加锁，等待而不删除；相差 ≥ 2 s（含明显来自未来的时间戳）视为陈旧，可删除。非 pid 的垃圾内容同样视为陈旧。

### 3.4 索引存储（`<data>/indexes/<项目键>/`，`src/index/storage.mjs`）

每个项目的索引是 `indexes/` 下一个以项目键（16 位十六进制）命名的目录，里面是 3.1–3.3 的文件、`graph.db`（及 `-wal` / `-shm`）和 `announced/`。另有一个文件属于存储整理：

- `used.at`：内容是毫秒时间戳，表示这个索引最近一次服务会话的时刻。服务在会话开始时和工具调用时写（至多每小时一次，且只在索引目录已存在时写，绝不为此创建目录）。
- 「最近使用」取以下各项的最大值：`used.at` 的内容、`status.json` 的 `indexedAt`、`status.json` / `dirty.log` / `lock` / `used.at` / `announced/*` 的 mtime。一个开着但很久没动的会话，只要钩子写过编辑日志或会话标记，就算最近用过。

清理策略（`planSweep`，纯函数；`sweepIndexes` / `removeListed` 负责执行）：

| 原因 | 条件 |
|---|---|
| `idle` | `maxIdleDays > 0` 且最近使用早于 `maxIdleDays` 天 |
| `orphan` | 同上，并且清单知道项目目录已不存在（只是 `idle` 的另一种说法，不是独立的规则） |
| `over-quota` | `maxTotalMB > 0`，按最近使用从旧到新删，直到总量不超过上限 |
| `requested` | 显式请求 `clean: "all"` |

项目目录找不到（没插的移动硬盘、没挂载的网络盘）本身不是删除理由：它和别的索引一样只看闲置了多久，所以正在用的项目不会因为盘暂时不可达而丢索引。探测目录是否存在（`listIndexes({ probe: true })`，默认开）是对每个项目一次文件系统调用，路径在网络盘上可能等到超时，所以**自动清理不探测**（`sweepIndexes` 默认 `probe: false`，原因只会是 `idle`）；手动 `clean` 与 `storage: true` 才探测，为的是清单里标出 `project folder missing`。读不出来的 `status.json` 不影响列出这个索引（按项目键显示，`root` 为 null）。

永不删除：调用方要求保留的项目键（当前会话的项目），以及 `lock` 正被存活进程持有的索引（`lockHeld`）。删除前再读一次锁。删除顺序是先删数据库三个文件、再删目录：数据库被别的进程占用时整个索引原样保留（Windows 会拒绝删除打开的文件；类 Unix 上会删掉，持有一方继续用已解除链接的文件，下一次会话重建）。`removeIndex` 只接受 `indexes/` 的直接子目录且名字是项目键，别的路径直接抛错；其它文件系统错误一律返回 false，由调用方记为「到期但没删掉」并继续处理下一个（`sweepIndexes` 与 `clean` 都逐项隔离）。

## 4. 语法包（G 产出）

- 运行时：`grammars/runtime/web-tree-sitter.mjs`（导出 `Parser`、`Language`，0.25.10）、`grammars/runtime/tree-sitter.wasm`。
- 语言：`grammars/wasm/tree-sitter-<grammar>.wasm`；清单 `grammars/manifest.json`：`[{ "grammar", "file", "bytes", "sha256", "source", "version", "license", "languages": ["typescript", "tsx"] }]`。
- 参考查询：`grammars/queries/<grammar>/{tags,locals}.scm`（有则放）。
- 装载：`grammars/loader.mjs` 导出 `initTreeSitter()`、`loadLanguage(grammarId)`、`parserFor(grammarId)`。

## 5. LanguageSpec（`languages/<lang>.mjs` 默认导出）

```js
export default {
  id: 'python',                       // = 文件名，唯一
  label: 'Python',
  extensions: ['.py', '.pyi'],        // 不得与其它包冲突
  grammar: 'python',                  // wasm 的 grammar id（见 grammars/manifest.json）
  extends: null,                      // 继承另一包（见下方合并语义）
  support: 'full',                    // full = 解析语法; script = 只有 embeddings、无自身 grammar; file-level = 只进 files 表与 map
  scope: null,                        // 'locals' = 用 locals.scm 做作用域级引用解析（仅 js/ts/ruby）
  commentTypes: ['comment'],          // 文档注释取「前一个命名兄弟节点」且类型在此列表
  transparentAncestors: ['export_statement'], // 取文档注释、判断 isTopLevel 时跳过的包裹节点
  maxParseBytes: 4194304,
  definitions: {                      // 节点类型 -> 规则（每个节点类型一条规则）
    function_definition: { kind: 'function', name: 'name', signature: ['parameters', 'return_type'],
                            doc: { from: 'bodyFirstString' } },
    class_definition:  { kind: 'class', name: 'name' },
  },
  calls: [ { node: 'call', fn: 'function' } ],
  imports: [
    { node: 'import_statement', kind: 'import', spec: (n, ctx) => '...', names: (n, ctx) => [{ imported, alias }] | null },
  ],
  references: [{ node: 'identifier' }],              // 兜底引用（未被打定义/调用/导入/skip 消费的节点）
  skipPatterns: ['required_parameter pattern: (identifier) @skip'], // 查询模式：命中的节点不作为引用，也不会被 locals 合并重新加回；捕获写在要排除的节点上
  recovery: [{ kind: 'function', regex: '^(?:export\\s+)?function\\s+([A-Za-z_$][\\w$]*)' }], // 语法不认的写法让后续语句折进 ERROR 节点时，按行首正则把顶层定义捞回来（只有 startLine、无 refs、`recovered: true`）
  isExported: null,                   // (node, symbol, ctx) => boolean | null
  embeddings: [],                     // [{ lang: 'typescript', extract: (source, ctx) => [{ text, startLine, endLine }] }]
  hooks: {},                          // { onNode(node, ctx, out), postProcess(out, ctx) }
};
```

规则语义（与引擎实现一一对应，审查后已对齐）：

- `kind`：字符串或 `(node, ctx) => string`；取值 `function | method | class | struct | interface | trait | enum | type | variable | constant | field | property | namespace | module | component | macro | test | other`。在 class/struct/interface/trait/enum/object/record/namespace/module/component 内的 `function`/`method` 由引擎自动记为 `method`。
- `name`：字段路径字符串（如 `'name'`、`'declarator.id'`）、函数 `(node, ctx) => node | string`，或省略（用节点自身）。任何**命名节点**（`isNamed`）的文本都可作为名字，不限节点类型（Ruby 的 `constant`、Kotlin 的 `simple_identifier`、Erlang 的 `atom` 都可以）。没有字段名的语法（如 kotlin wasm 的 `fieldCount=0`）必须用函数按子节点位置取名。
- `signature`：字段名、字段数组、或 `(node, ctx) => string`；引擎拼接、压空白、截 120 字符。**签名里的类型引用仍会成为 `refs`**（引擎不消费签名字段）；不想要的标识符用 `skipPatterns` 排除，不要在读 `parent` 的 `when` 里排除（大文件上每个标识符读 `parent` 约 3.5 µs，曾是最大开销）。
- `doc`：`{ from: 'prevSiblingComment' }`（默认；取 `transparentAncestors` 包裹外的前一个注释兄弟节点，间隔 ≤ 2 行）、`{ from: 'bodyFirstString' }`（沿 `body` 向下穿过语句包裹找第一个字符串节点，须在 body 首两行内）、`{ from: (node, ctx) => string }`、`{ from: 'none' }`。截 240 字符。
- `when(node, ctx)`：定义/调用/导入规则的守卫。**引用规则上的 `when` 每个标识符都会执行**，只能做廉价判断；排除类需求用 `skipPatterns`。
- `calls[].fn`：字段路径、函数 `(node, ctx) => node | string`（callee 文本，可含 receiver）、或返回 `{ name, receiver, node? }`。`node` 是 callee 名字节点，引擎会把它消费掉，避免同一调用点再产出一条同名 `ref`（Ruby/PHP 曾因此 callers 翻倍）；不给 `node` 时引擎消费 `method`/`function` 字段。`a.b.c()` 会拆成 receiver `a.b` + name `c`；`?`、`::`、`->` 分隔请自行在函数里处理。
- `imports[].spec` 返回字符串（模块说明）；`names` 返回 `[{ imported, alias }]` 或 null。`kind` 自由（`import`/`from`/`require`/`include`/`dynamic`…）。
- `embeddings`：`extract(source, ctx)` 返回脚本块，`startLine`/`endLine` 为**文件内绝对行号（1 基）**；引擎用目标包递归解析，符号/引用/导入按块偏移，`blocks` 记录顶层块（递归内的子块不记录）。自身或祖先包不得再嵌入自己（引擎会抛错）。外层包若同时有 `grammar`，外层也会解析并合并 `parseOk`/`errorNodes`。
- `extends` 合并语义：`definitions`、`hooks` 按键浅合并（派生包覆盖同名键；改一条规则要整条重写）；`calls`、`imports`、`references`、`skipPatterns`、`embeddings`、`commentTypes` 追加；`extensions`、`grammar`、`scope`、`support`、`isExported`、`transparentAncestors` 等标量整体替换。
- `hooks.onNode(node, ctx, out)`：存在时引擎退回「全节点命名遍历」，每个未被规则命中的节点都会调用；`hooks.postProcess(out, ctx)` 在包含关系计算前调用，可增删 `out.symbols/refs/imports`。
- `ctx`：`{ spec, source, tree, lines, text(node), field(node, path), isConsumed(node), consume(node), isTopLevel(node), addSymbol(sym), addRef(ref), addImport(imp) }`。`add*` 的行号为**块内相对行**，引擎会加偏移并填 `block`。

## 6. 抽取引擎（`src/extract/engine.mjs`，阶段 0 实现并冻结）

```js
await initEngine();                         // 加载运行时 + 全部语言包（每进程一次，worker 里也要调）
await loadLanguage(grammarId);              // 缓存 Language（loader 导出，引擎转发）
await loadSpecs();  listSpecs()             // 同一个函数的两个名字
specForPath(relativePath, specs?)           // 按扩展名取 spec 或 null（最长扩展名优先，大小写不敏感）
await extractFile({ path, source, spec, startLine = 1, block = null })   // → ExtractedFile
```

`ExtractedFile`：

```js
{ path, lang, hash, size, parseOk, errorNodes,
  symbols: [{ kind, name, qual, startLine, startCol, endLine, endCol, signature, doc, exported, parent /* 下标或 null */, block }],
  refs:    [{ name, receiver, kind, startLine, startCol, endLine, symbol /* 所属符号下标或 null */, scope, localDef /* 下标或 null */ }],
  imports: [{ spec, names, kind, startLine, block }],
  blocks:  [{ lang, startLine, endLine }] }
```

- 行号 1 基、列 0 基（tree-sitter 的列，按 UTF-16 代码单元计），范围闭区间。
- `refs[].kind`：`call | ref | type | inherit | implement | decorator`（后四种由包在 `calls[].kind` 或 `references[].kind` 里声明）。
- `symbol`（所属符号）由引擎按范围包含计算，单行定义按 `endCol` 判定；`parent` 为包含它的定义。
- 发现方式：引擎把包里的节点类型编译成一条 tree-sitter `Query`，`captures()` 在 wasm 内匹配，JS 只处理命中的节点；节点类型在该语法版本里不存在时自动剔除并打一行 stderr 警告。有 `hooks.onNode` 的包走全节点遍历。
- `scope === 'locals'` 的包：引擎在 worker 内调用 `src/resolve/locals.mjs` 的 `resolveLocals(tree, queryText, symbols)`，把结果并入 `refs`（`scope: 'local'`，`localDef` 指向同文件定义下标；被局部变量遮蔽的引用 `localDef` 为 null）。**局部变量/参数的使用本身不入库**：`scope === 'local'` 且 `localDef` 为空的**非调用**引用会被引擎丢弃（它们的目标永远不是索引里的符号）；调用引用保留，解析层把这类遮蔽的 callee 标 `?`，不会误连到同名全局定义。
- 导入语句整个节点被消费：其中的标识符（含 `library(stats)` 这种裸参数）不会成为 `refs`；定义只消费名字节点与 `skipPatterns` 命中的节点（`skipPatterns` 里要自己写 `@skip` 捕获，让被排除的是内部标识符而不是整个结构）。
- 解析树在返回前 `tree.delete()`；每进程每个语法只创建一个 `Parser`。解析树有 ERROR 节点照常抽取，`parseOk=false`；源码为空或超过 `maxParseBytes` 返回空结果不抛错。

## 7. 存储（`src/store/db.mjs`、`src/store/repo.mjs`，S 实现）

```js
openDatabase(file)                                  // 建目录、应用 schema、WAL、foreign_keys；返回 Database
close(db)
// files
upsertFile(db, { path, lang, hash, mtimeMs, size, parseOk, errorNodes, indexedAt })   // → id（已存在则更新并清掉旧 symbols/refs/imports）
getFileByPath(db, path)      listFiles(db)      countFiles(db)      deleteFile(db, path)
// per-file atomic replace（事务：删旧 → 写 symbols → 写 refs → 写 imports → 维护 symbols_fts）
replaceAllForFile(db, fileId, { symbols, refs, imports })   // → { symbolIds: number[] }（与输入下标对应）
replaceFile(db, fileMeta, extracted)                         // → { fileId, symbolIds }：upsertFile + replaceAllForFile 同一事务，索引器一律用这个
setRefResolution(db, [{ refId, targetId, resolution }])      // resolution ∈ '=' | '~' | '?'；targetId 可 null
// lookups
findSymbolsByName(db, name, { exact = true } = {})
searchSymbolsDetailed(db, query, { limit = 20, kind = null } = {})   // → { rows, matched, dropped }，按相关度排序（见下）
searchSymbols(db, query, options)                                   // 上者的 rows
usageCounts(db, symbolIds)        // → Map<id, { refs, files, inSource, byName }>；引用数超过 `USAGE_MAX_REFS` 的符号只给 { refs, capped: true }
isSecondaryPath(path)            // → boolean；测试 / 脚本 / 第三方目录与文件，清单 `SECONDARY_PATH_PARTS`（search 排序与 inSource 共用）
searchRefs(db, query, { limit = 20 } = {})                        // → { rows, uses, files, fileIds, names, capped }：只被使用、这里没有定义的名字（见下）；§8 的 search 在没有可用的符号行时才调它
symbolById(db, id)           symbolsInFile(db, path)
refsTo(db, symbolId)         refsByName(db, name)        refsInFile(db, fileId)     unresolvedRefs(db, { fileId } = {})
importsOfFile(db, path)      importersOfPath(db, path)
// dirty + meta（dirty 表是「至少一次」语义：takeDirty 取出即删，崩溃丢失的标脏由下一次 mtime 扫描补上）
markDirty(db, paths)         takeDirty(db, limit = 500)      dirtyCount(db)
metaGet(db, key)             metaSet(db, key, value)
```

- `db` 对象对 graph 层可见，B 可以直接写 SQL；列名即 schema。
- `searchSymbolsDetailed` 的匹配与排序（模型第一步检索常是描述或猜的名字，这一段决定它信不信结果）：
  - 匹配层：精确名 → 连写前缀（`parseconfig` → `parseConfig`）→ FTS5（bm25）→ LIKE 兜底。兜底每个词一条谓词，所以词序无关（`config parse`、`gift card redeem` 都能命中 `redeemGiftCard`），也够得到分词器够不到的名字（`parse2config`）。谓词与下面的词边界规则是同一条（`poolPredicate`）：长词是 `LIKE '%词%'`；≤ 2 字符的 ASCII 词只能是整词，所以只匹配名字开头或词边界之后（分隔符之后、字母 / 数字后接首字母大写的 `userId`、小写后接全大写的 `macOS`、`isIP`，用 GLOB 实现）。池在 SQL 里就被筛过，噪声不进池，池的大小不再决定会不会漏掉 `sessionId` 这样的整词命中。兜底候选按「词边界贴合度」过滤排序：长词可以是词前缀（`sign` → `signed`）或最弱的任意子串，≤ 2 字符的 ASCII 词必须是整词（`signIn` 的 `in` 不命中 `SigningIdentity`）；中日韩文的两字词是词本身，仍按前缀 / 子串匹配（`配置` 命中 `读取配置`）。被过滤掉的 FTS 行不占 `limit`，兜底是否执行看过滤后的行数。
  - 排序键：完全同名 → 源码先于测试 / 脚本 / 第三方目录（路径含 `__tests__`、`tests`、`_test.go`、`test_`、`scripts`、`node_modules` 等，清单在 `repo.mjs` 的 `SECONDARY_PATH_PARTS`；清单是路径的子串，目录项带首尾斜杠并在匹配前给路径补一个前导斜杠，所以仓库根目录下的 `tests/`、`scripts/` 也算，`latest_x` 不算）→ 以查询开头的前缀先于更松的匹配 → bm25 / 贴合度。完全同名不会被任何匹配挤出 `limit`，前缀匹配不会被更松的匹配挤出 `limit`。
  - 截断顺序：每层 FTS 按 `limit × 4`（40–2000 行）读取、LIKE 兜底最多读 2000 行（都按名字从短到长），**先过词边界过滤，再截到 `limit`**——被过滤掉的行不占名额，也不会让好行只能在兜底里以更低层级回来。短词查询的代价：每行最多 1 条 LIKE + 3 条 GLOB，cindy（17.8 万符号）上 `io` / `os` / `up` 实测 180–290 ms。
  - 放宽：没有任何名字含全部词时，退回到部分匹配。取查询里最长的两个词作锚（并列取靠前的），各查一次「含该词的名字」；候选池在 SQL 里按「同时含其它查询词的个数」降序截取（截断发生在 SQL 里，所以截断本身要偏向多词命中），再用词边界规则逐词核对。两个锚的结果合并后依次按：命中的查询词数 → 命中词的具体程度（词长平方和）→ 源码先于测试 / 脚本 → 名字短者优先。成本与词数无关：完整查询（一条 FTS，至多一条 LIKE）加每个锚一条查询，共 3–4 条语句；`reasoning efforts discovery merge` 第一次回退就命中 `reasoning + efforts`（按子集重试的旧做法要试 6 次，5 个词的查询连两词组合都轮不到）。`matched` 是排在最前的名字命中的词（按查询原序），`dropped` 是其余的词；全无命中时三者皆为空数组。
  - SQL 参数按其在 SQL 文本中的位置绑定（CTE 的 select 列表先于 `WHERE`）；带 `kind` 过滤时 FTS 层同样生效。
- `searchRefs`（§8 的 `search` 在没有可用的符号行时才调）：查的是 `refs` 表，也就是抽取器记下来的引用。TypeScript 上实测（2026-11-25，当前引擎；`tests/resolve/locals.test.mjs` 钉住）：调用一定记，带接收者（`call console.log`、`call client.takePendingDeepLink`）；类型名一定记；方法调用的对象不是本文件的局部名字时也记（`console.log(x)` 另有 `ref console`）；**本文件里绑定了的名字的读取不记**——参数、局部变量、解构出来的字段，连同 `row.membershipKind` 这种点号读取的属性、方括号访问、对象字面量的键都不在表里（`src/extract/engine.mjs` 丢掉「没有局部定义的局部读取」，理由是它们不连边；要让它们可搜得改那里并重建索引）。Python 记录属性读取（`row.membershipKind` → `ref membershipKind`）；Go 的字段选择子不记录；其它语言没有逐一核对。扩充抽取器时要连同提示语与 README 一起改。开发期早期版本抽取器留下的行不算数：本仓库索引里 `storage.mjs` 的 `maxIdleDays` 有 2 条，是 11-24 的旧行，文件没再变过所以没有被重新抽取。每个「名字 × 接收者 × 文件 × 所在符号」一行（`req.get` 与 `res.get` 在同一个函数里是两行；模块级引用每个文件一行），带出现次数；同一行里的引用不全是同一种（既被调用又被读取）时 `kind` 是 `use`；行形状 `{ name, kind, receiver, count, start_line, file_id, path, owner, owner_qual, owner_kind }`。
  - 两种查法。名字原样存在时走 `refs.name` 索引（`name = ?`），答案就只有它，不带含这些词的更长的名字；否则扫描全表，词的匹配规则与符号搜索是同一条（`poolPredicate`：任意词序、长词可子串、≤ 2 字符的 ASCII 词必须整词，再过 `wordDistance`），排序时与查询同名（不分大小写）者在前，其后源码先于测试与脚本，再按位置。带分隔符的写法（`max-idle-days`）不算原名，走扫描。多个词时长词的谓词排在前面：AND 与顺序无关，SQLite 从左到右求值，短词的四种模式只留给过了长词的行（`e props` 因此从 1.3 s 降到 0.2 s）。
  - 字符串里的词不在 `refs` 表里，查不到：那是 Grep 的事。解析器对没法归约的调用会把整段调用文本记成名字（如 `(childProps[name] as ((e: unknown) => void) | undefined)`），它只在扫描时按子串命中，渲染层截断显示。
  - 代价与截断（2026-11-25，合成索引，220 万条引用）：原名命中 24–150 ms；扫描 ≥ 3 字母的词（1 条 LIKE）约 180 ms；一两个字母的词要 1 条 LIKE + 3 条 GLOB，约 1.3 s。扫描到的引用先截到 `REF_ROWS_MAX`（20000）行——不截的话，`meth` 这种几十万行共有的片段光分组就 18 s；再按 `REF_GROUPS_MAX`（5000，约 100 ms）截组，`uses` / `files` / `names` 是留下的这些组的合计。是否越过截断在词过滤之前判断：被过滤掉的行也算读过（`id` 会读到 `identity`）。越过任一截断 `capped: true`，合计是下界。引用按它们在表里的顺序读，所以越过第一道截断时留下的是先索引的文件，其后的「源码先于测试」只在幸存者里生效。`fileIds` 是留下的这些组所在的文件 id（一个文件一个，含被 `limit` 截掉的行所在的文件），给合并两个来源的调用方数文件用。`node:sqlite` 对没绑定的参数报的是 `datatype mismatch`，不是参数个数错误：SQL 里的 `?` 与 `all()` 的实参要逐个对上。
- 符号被删除时，`refs.target_id`、`refs.local_def_id` 由 schema 的 `ON DELETE SET NULL` 置 NULL，`resolution` 由 repo 显式置 NULL；B 的解析管线把「`resolution IS NULL`」当作待解析。
- **符号 id 保留**：`replaceAllForFile` 重写一个文件时，按 `kind|qual|name` 配对旧、新定义——两边都恰好 1 个的视为同一符号，保留旧 id 就地 UPDATE（行号/签名/doc/exported/parent 变化不换 id）并同步 FTS；其它旧符号删除、新符号取新 id；键在任一边重复（重载）则整组删旧插新。其它文件里指向**保留** id 的 refs 不动；只有被删符号的 refs 置空并进入待解析。`symbolIds` 仍按输入下标返回。
- 写组与 bulk load（阶段 2 性能）：
  - `beginWriteGroup(db)` → `endGroup()`：同一事务里连续提交多个文件（每文件仍是自己的 savepoint，单文件原子性不变）；必须成对、事务外调用。
  - `beginBulkLoad(db)` / `endBulkLoad(db)`：仅 `Indexer.buildAll` 在「空库或 force 全量」时使用。begin 清空四表与 FTS、删除 refs/symbols 的 9 个二级索引、`PRAGMA foreign_keys=OFF`（必须在事务外；失败时自行恢复索引与 FK）；end 重建索引、FK=ON、`PRAGMA foreign_key_check` 非空即抛、`ANALYZE`。每条路径 end 恰好一次；bulk 期间 `openDatabase`（它会执行 schema 的 `CREATE INDEX IF NOT EXISTS`）只是降速，不是错误。
  - `takePurgedSymbols(db)` / `clearPurgedSymbols(db)`、`pendingFiles(db)` / `clearPendingFiles(db)`：解析器用的两个 TEMP 表日志（每次入口无条件 `CREATE TEMP TABLE IF NOT EXISTS`，因为回滚会连 TEMP 表一起撤销）。`logPendingFiles` 用 `INDEXED BY refs_target`，`refs_target` 因此属于冻结索引名。
  - `setRefResolution`：≥ 50 行按 `(target, resolution)` 分组、每 500 个 id 一批 `UPDATE … WHERE id IN (…)`，`changes` 总数不等于行数即抛。
- **不要绕过 `repo` 直接 `DELETE FROM symbols/refs/imports`**：FTS 行与跨文件链接只由 `repo.replaceAllForFile`/`deleteFile` 维护。schema 已含 `symbols_parent`、`refs_local_def` 索引（FK 级联不再全表扫描）。
- 约定：`mtimeMs` 必须是整数（A 侧 `Math.trunc`）；`imports.names` 以 JSON 数组存储，读出后自行 `JSON.parse`；`importersOfPath` 依赖 B 填 `imports.resolved_file_id`。

## 8. 解析与查询（B 实现；阶段 0 放签名一致的桩，返回空结果）

```js
// src/resolve/pipeline.mjs
resolveFile(db, fileId)        // → { resolved, ambiguous, unresolved }：解析该文件 refs；并重解析「目标曾在本文件」的其它文件 refs
resolveAll(db)                 // 全库
// src/resolve/locals.mjs
resolveLocals(tree, queryText, symbols)   // → [{ name, startLine, startCol, endLine, symbol, localDef }]
// src/graph/queries.mjs
search(db, { query, kind, limit }, info = null)   // → [{ kind, name, qual, path, startLine, endLine, signature, usage? }]；给了 info 则回填 matched / dropped。前 `SEARCH_USAGE_ROWS`（3）行带 `usage: { refs, files, inSource, byName }`——其它文件里指向它的引用数（不含定义所在文件）、所在文件数、其中源码文件数、其中按唯一名字连上的引用数（`byName`，其余是 import 解析确定的；未连边的 `?` 不计）（`usageCounts`）；引用数超过 `USAGE_MAX_REFS`（2000）的符号改为 `usage: { refs, capped: true }`，只给全部引用数（含定义所在文件）；没有被外部引用的行没有这个字段
symbol(db, { name, path, qual })              // → { symbol, callers, callees, imports } | null
searchIsPartial(db, { query, kind, limit })   // → boolean：`search` 会不会改列使用位置（没有符号叫这个名字，或符号只沾了部分词）。只做符号搜索，所以调用方可以先问它、为真时去扫描源码、再做唯一的一次 `search`（§8 属性读取）
callers(db, { name, path, limit })            // → [{ name, path, startLine, resolution, count }]
callees(db, { name, path, limit })
impact(db, { name, path, depth })             // → { nodes, files, truncated }
outline(db, { path })                         // → [{ kind, name, startLine, endLine, signature }]
// src/graph/map.mjs
repoMap(db, { path, budgetTokens })           // → { text, shown, total, truncated }
```

`search` 有两种行。默认是上面的符号行。**没有符号叫这个名字、或符号只是沾了它的部分词**（`searchSymbolsDetailed` 走了放宽分支）时改查使用位置：`searchRefs`（§7）与——调用方给了 `extra.propertyReads` 时——源码扫描（下一段），两份结果由 `mergePlaces()` 合成一份；不超过 `REF_LEAD_MAX`（200）处时，行是使用位置 `{ kind, name, receiver, count, path, startLine, owner, ownerQual, ownerKind }`——不是符号行：没有 `id` / `endLine` / `signature`，也不带 `usage`——并回填 `info.refs = { uses, files, names, capped, fromIndex, fromScan, skipped, symbols, symbolCount }`（`symbols` 是前 3 个沾词符号的名字，`symbolCount` 是这次搜索找到的个数——符号是按 `limit` 找的，所以它至多是 `limit`，不是沾词符号的总数；`fromIndex` / `fromScan` 是两个来源各自的行数；`skipped` 是扫描没有行时的原因，有行时为 `null`，调用方没传扫描时是 `not-asked`，见下一段），此时不回填 `matched` / `dropped`。合并的顺序与任一来源单独时相同（源码先于测试与脚本，再按路径、行），同一位置索引行在前；`uses` 相加、文件数取两个来源 `fileIds` 的并集，任一来源被截断则 `capped`；两份都没有行时不给使用位置（`capped` 的空结果也不给），沾词的符号行照旧，此时没有领先的结果而 `skipped === 'hub'` 的话回填 `info.hub = true`（输出层只在结果为空时读它）。四条边界：符号含全部词时符号行照旧（`theme` → `ThemeProvider`，描述式查询 `gift card redeem` → `redeemGiftCard`，猜的名字 `fetchUserData` → `fetchUserDataAsync`）；名字用在超过 200 处时不排到前面——哪里都在用的名字说明不了方向，沾词的符号更有用（`expect`、`deepEqual`）；完全没有符号行时无论多少处都给使用位置；带 `kind` 只查符号、不扫描。在 coding-usage 与本仓库各约 60 个常见名字上实测，这条规则只改变了「符号只沾一个词」的查询（`useEffect` 原来给 `useT`、`useTick`，现在给 90 处使用），常见单个词（`props`、`data`、`config`）与描述式查询的结果不变。

**属性读取**（`src/graph/propertyReads.mjs`，2026-11-25）。`row.membershipKind` 这种点号读取不在 `refs` 表里（§7）。方向是用户交给我定的，量过两条路：进索引（成组存也要多 20% ~ 38% 的行，已有索引还得整体重建一次，而索引器没有这个机制）或查询时扫描；选了扫描——被读最多的属性是 `.length`、`.type`、`.id`，信息密度低，只有长尾有用，平时不该为它付代价。
- 进程模型：读文件、预筛、解析都在一个专用的常驻 worker 里（`src/graph/propertyReadsWorker.mjs`；§9 的约束是主线程不解析），主线程只等答案，超过 `SCAN_TIMEOUT_MS`（10 秒）就放弃。`warmPropertyReads()` 启动 worker 并等它加载完 `typescript` / `tsx` / `javascript` 三个语法的解析器与捕获查询 `(member_expression property: (property_identifier))`，每个进程一次；`silentIndexStart`（`server.mjs`）在确认 `autoIndex` 开着之后调用它，放在索引刷新派发与存储清理之后——这个模块加载失败也不会跳过前面两件事；worker 还没起来时扫描自己等它。启动出错、或 30 秒（`START_TIMEOUT_MS`）内没就绪，都算启动失败：写一行 stderr，这个进程里不再试（解析器坏了，重试结果一样；机器一时卡住的情形由下一个会话、也就是新的服务进程重来）。worker 崩溃或超时后被换掉：正在等它的扫描立刻得到 `not-ready`，下一次扫描起新的；被换掉的那个晚到的 `exit` 事件不处理（按 worker 实例核对），否则会清掉刚顶上的新 worker。空闲时 worker 不保持进程存活（Node 26 里挂了 `message` 监听的 worker 会被重新引用，所以只在等待应答期间引用）。测试用 `setScanWorkerFactory()` 换掉 worker 的创建，`tests/graph/propertyReads.worker.test.mjs` 用一个由测试掌握事件的假 worker 钉住「晚到的退出」与「扫描中途崩溃」这两条。
- `scanPropertyReads({ root, db, query, maxFileBytes, timeoutMs, limits })`（async）：这是唯一读源码文件的查询，什么都不存，所以不会陈旧、不需要重建。`maxFileBytes` 由调用方传索引器自己的上限；`timeoutMs` 与 `limits` 是给测试改的。只接受 ASCII 标识符（`^[A-Za-z_$][\w$]*$`），其它写法直接答 `skipped: 'not-identifier'`。返回形状同 `searchRefs`（`kind` 为 `property`），多一个 `skipped`。工具层的用法（`src/mcp/tools.mjs`）：先问 `searchIsPartial()`，为真才扫描，再带着扫描结果做**唯一的一次** `search()`——早先的做法是先 `search()` 一遍只为判断要不要扫描，那样 `searchRefs` 的慢路径（一两个字母的词，220 万条引用上 1.3 秒）要跑两遍。
  - 读与预筛：对索引里 `lang ∈ {typescript, tsx, javascript}` 的文件按路径顺序逐个读入。**索引不保证它给的路径可信**：绝对路径由 `path.resolve(root, file.path)` 得到并过 `isInside()`（与 `readBody` 同一个函数，`src/paths.mjs`），`lstat` 不是普通文件的（目录、符号链接）不读，链接不跟随。不含这个名字的文件到此为止（`includes`）。用 `propertyReadNeedle`（`src/graph/prefilter.mjs`）预筛——`.name` 或 `?.name`，点号与名字之间允许一段空白、至多八个注释（每个注释后可以再跟一段空白）；一段空白至多 40 个字符，一个块注释至多 200 个字符，一个行注释至多 1000 个字符且必须以换行结束（更长的会把这次读取漏掉；只有 `\r` 的行尾不算换行）。**每一段重复都有界，且每个空白字符只有一个可能的归属**，这决定代价是线性的：点号与名字之间的间隔若能一直延伸到文件末尾，`a. /* x */ b; ` 这种文本重复 400 KB 要 5 秒，`//` 之后没有换行的单行文件 800 KB 要 38 秒；空白若是可重复的「段」，`a.` 后接一串空格是指数级。读入那一步的上限按读入量计，看不到这种事。这些界在 dsh-app（916 个 JS/TS 文件）与本仓库（152 个）上一处都没咬到（逐文件逐名字对比新旧写法，新的没有丢任何旧的能找到的读取）。排除展开运算 `...name` 与方法调用 `.name(`（那是调用，已在索引里）。超过 `maxFileBytes`（默认 4 MB）的文件跳过，不算截断；累计读入超过 `maxReadBytes`（64 MB）停下（`stopped: 'bytes'`）；有命中的文件**超过** `maxFiles`（60）即热点，不再读（`'files'`；恰好 60 个不算，后面还有没命中的文件也不算）；预筛命中数超过 `maxHits`（400）不再解析（`'uses'`）。这三种都发生在解析之前，所以没有行可给。
  - 读不到的文件分两类：不存在（`ENOENT` / `ENOTDIR`——下一次同步会把它移出索引）不算数；其它（在项目之外、不是普通文件、没有权限、`root` 不对）计入 worker 应答里的 `unreadable`，见下。
  - 解析：候选文件按大小从小到大解析，下一个文件会让累计解析量超过 `maxParseBytes`（2 MB）就停在它前面（`'bytes'`），已解析的照给。小文件先解析，被舍弃的只是最大的几个文件。后三个上限按字符数计（读入的字符串长度），不是字节数。
  - 越过任一上限，或有文件被落下（`unreadable > 0`）：带着已得的行返回并 `capped: true`，合并后的合计是下界（首行写 `12+ uses in 5+ files`，页脚解释 `+`）；一行都没有时 `skipped` 说明原因。上限是 `SCAN_LIMITS`，每个对应一步；`stopped` 由 worker 报告，说明停在哪一步。
- tree-sitter 确认：只算 `member_expression` 的 `property`，且文本等于查询的名字。文本预筛是 `src/graph/prefilter.mjs` 的 `propertyReadNeedle`，由单元测试钉住（它写在模板字符串里、反斜杠是转义过的）。**不算读取**：被调用的函数（`obj.name()`、`obj.name?.()`、标签模板）、`new obj.name()`、装饰器 `@obj.name`、普通赋值的目标（`obj.name = 1`，只写不读值）——解构（`[obj.name] = list`、`({ key: obj.name } = list)`，带默认值、剩余元素的也一样）与 `for…of` 的头部同样是赋值目标，沿 `array_pattern` / `object_pattern` / `pair_pattern` / `assignment_pattern` / `rest_pattern` / 括号向上找到 `assignment_expression` 或 `for_in_statement` 的 `left` 即是（节点名以 `bin/ast.mjs typescript` 的输出为准）。**算读取**：复合赋值（`+=`）、自增自减、`delete obj.name`、`typeof obj.name`、解构默认值里的读取（`const [a = obj.name] = list` 与赋值形式的 `[a = obj.name] = list`：向上走时遇到 `assignment_pattern` 的 `right` 即停）。接收者取对象部分的原文，空白压成单个空格（与索引记调用的接收者一致），截 80 列：`this.fallback`、`getList()`；位置取属性名所在的行列；所在符号取索引里包含该位置的最内层定义——同一行有多个定义时取起点在该位置之前、离它最近的那个（为此 `SYMBOLS_SQL` 带上了 `start_col`；`symbols` 表没有 `end_col`，所以同一行上排在某个单行定义之后的读取会归到那个定义）；模块级为空。按「接收者 × 所在符号」成组，行形状同 `searchRefs`；文件顺序源码先于测试与脚本，再按路径；文件内按行，同一行按接收者，不依赖 tree-sitter 的捕获顺序。模板字符串里的 `${row.name}` 是捕获得到的节点，算读取；字符串与注释里的 `.name` 过不了 tree-sitter，不算。**搜不到**（要 Grep）：解构出来的字段（`const { name } = row`）、方括号访问、对象字面量的键。
- `skipped`（扫描没有行时说明原因；有行时恒为 `null`）：`hub`（有命中的文件超过 60 个）、`limit`（命中数或读入量越界）、`unreadable`（有索引里记着却读不到的文件，见上）、`not-ready`（worker 起不来，或这次扫描超过 10 秒——这时 worker 被终止并换新）、`not-identifier`；扫描完整而确实没有读取时为 `null`。`search()` 在调用方没传 `extra.propertyReads` 时自己填 `not-asked`。输出层据此选页脚（§11），所以「源码里找过、没有」只在扫描真的找完时才说。
- 代价（2026-11-25 实测，worker 版）：worker 启动 56 ~ 64 ms。本仓库（152 个 JS/TS 文件、1.5 MB）与 coding-usage（291 个文件、2.7 MB）上，读完并预筛 4 ~ 14 ms；带解析的名字 50 ~ 190 ms——本仓库 `config` 43 处 / 5 个文件 53 ~ 63 ms、`row` 111 处 / 23 个文件 93 ~ 103 ms、`path` 189 处 / 31 个文件 159 ~ 174 ms、`id` 224 处 / 43 个文件 176 ~ 187 ms，coding-usage `type` 15 处 / 9 个文件 42 ~ 44 ms、`config` 63 ~ 106 ms；热点或命中过多的名字 4 ~ 14 ms 即停——本仓库 `type`（407 处预筛命中）与 `length` 是 `limit`，coding-usage 的 `id`、`length` 是 `hub`。本仓库 `maxIdleDays` 17 处 / 8 个文件、54 ms。每一次「没有同名符号」的搜索都会读一遍全部 JS/TS 文件，所以它随 JS/TS 源码的体量线性增长。预筛本身在对抗性的形状下也是线性的（`.tmp/w30-needle-time.mjs`：点号后接闭合 / 未闭合的块注释、行注释、没有换行结束的行注释、一串空格，200 KB 1 ~ 71 ms，2 MB 7 ~ 655 ms）。
- 解析速度决定 `maxParseBytes`：手写代码约 4 MB/s，「一行里几万个对象字面量」（压缩过的打包产物的形状）约 1 MB/s——单文件 0.5 MB 扫描 0.45 s、1 MB 0.9 s、2 MB 2.1 s、3.5 MB 4.1 s。预算原定 8 MB，最坏一次搜索要 9 秒多，所以降到 2 MB 并让小文件先解析。终止一个卡在 2 秒解析中间的 worker，`terminate()` 后 4 ms 它就退出。
- 用例：`tests/graph/propertyReads.test.mjs`（预筛、扫描、什么算读取、路径与读不到的文件、五种上限、超时、合并与 `search` 的决策，19 条），`tests/graph/propertyReads.worker.test.mjs`（worker 的生命周期：被换掉的晚到的退出、扫描中途崩溃），`tests/store/search.test.mjs`（`fileIds`）与 `tests/store/paths.test.mjs`（`isInside`），`tests/render/text.test.mjs`（页脚按来源与原因选，合计带 `+` 并解释），`tests/mcp/tools.test.mjs`（工具 → `searchIsPartial` → 扫描 → 唯一的一次 `search`），`tests/e2e/property-reads.test.mjs`（真实 server）。变异 `.tmp/w30-mutate.mjs`。**没被测试钉住的三处**：worker 启动失败后的 `not-ready`（测试里没法让真的 worker 起不来；2026-11-25 用「让 worker 少一个 import」手工走过一遍：`warm → false` 16 ms、扫描答 `not-ready`、进程 56 ms 退出，脚本 `.tmp/w30-start-failure.mjs`）；会话开始时的预热（去掉它只是第一次搜索多等启动时间）；`lstat` 不是普通文件就不读（目录的情形与「读不到」殊途同归，符号链接要本机测试不假设的权限）。

`repoMap` 的符号按输出顺序逐文件惰性读取，预算满即停；`total` / `filesTotal` 的口径与是否截断无关：整个 scope 内每文件前 6 个符号之和、有符号的文件数（截断时由一次聚合查询给出）。

解析顺序固定：import 解析（`=`）→ 同文件唯一（裸名）→ 全局唯一名（`~`，歧义上限 500）→ 不连边（`?`）。成员调用 `x.m()`（接收者未知）只在属性名全局唯一时连边。动态特性（`getattr`、动态 import、反射）不连边。

两种情形**不回落**，直接 `?`：

1. 导入绑定存在、但其模块不在索引里（外部包、被 exclude、尚未索引）。import 已把名字钉在该模块上，按名回落会把 `import { omit } from 'lodash'` 连到项目里同名的 `omit`。目标文件入库后，`recheckImportersOf` / `recheckByName` 会把这些 ref 重新置为待解析并改为 `=`。
2. 接收者已解析为类（本文件类、导入类或命名空间）而该类没有这个成员：`Shape.nope()` 不是全局函数 `nope`。例外：`this.m()` 未在本类声明时可能来自继承，仍走全局唯一名；`super.m()` 恒为 `?`。

标记语义（渲染层据此显示）：`=` 确定（import 解析成功，或 `locals.scm` 作用域解析到同文件定义）；`~` 按名唯一（同文件唯一或全局唯一，可能是同名误连）；`?` 未解析、歧义或动态；NULL 尚未处理。`scope === 'local'` 且 `localDef === null` 的引用表示**被局部变量遮蔽**（局部定义不是索引里的符号），必须标 `?`，不得回落到全局唯一名。

运行时 API（实测 web-tree-sitter 0.25.10）：`tree.language` 可取到 `Language`；用 `new Query(language, source)`（`Language.query` 已弃用），`query.captures(rootNode)` 按文档顺序返回 `{ name, node }`，适合做作用域栈追踪。

## 9. 索引器（A 实现）

```js
// src/index/indexer.mjs
export class Indexer {
  constructor({ root, config, workers = 4 })
  status()                                   // 读 status.json 对应字段 + 即时 dirty 数
  ensureFresh({ maxWaitMs = 3000, force = false } = {})
                                             // 消费 dirty.log、stat 比对、与文件枚举对账、增量同步；首次且允许自动索引时后台全量构建，最多等 maxWaitMs
  buildAll({ force = false })                // 前台全量（进度回调）
  onProgress(cb)                             // cb({ filesTotal, filesDone, state })
}
```

- 文件枚举：git 仓 `git ls-files -z -c -o --exclude-standard`；非 git 仓自走目录并按 `exclude` 配置与内置忽略（`node_modules`、`.git`、`dist`、`build`、`out`、`target`、`vendor`、`.codegraph`）过滤。
- 变更检测：size + mtime_ms 预筛 → sha256 复核；变了才重新解析。
- **新鲜度以 server 自己为准**：`ensureFresh()` 每次调用先消费 `dirty.log`，再对已索引文件做 mtime+size 扫描（10k 文件量级约 100 ms，按 5 s 节流；超过 2 万文件时跳过扫描只信 `dirty.log`），有变化就增量重解析。钩子只是加速器：ZCode 的钩子进程没有 `node` 回退（只认 PATH），没装 Node 的机器上钩子静默失效，索引仍必须正确。
- **周期枚举对账**：钩子只看得到编辑，分支切换 / pull / 生成器 / rm 这类没有钩子行的增删靠重新枚举发现。索引非空时，`ensureFresh` 在本进程首次、之后每 60 s（`meta.lastWalkAt`）、以及 `force: true` 时跑一次 `listFiles`：不在 `files` 表的路径 `markDirty`（交给 `sync()`），在表但不在枚举结果里的行 `deleteFile`（已删除、被 exclude、超过 maxFileBytes、超出 maxFiles，连带其 dirty 条目）。只删不增的路径若有 `resolution IS NULL` 的 refs，立即 `resolveAll`。
- **脏条目的准入**（2026-11-25 修复）：`sync()` 处理的脏路径来自钩子与文件监听，走不到枚举里的 `.gitignore`。批里所有受支持、过了 `exclude` 的路径由 `gitIgnoredPaths()` 问一次 git（`git check-ignore -z --stdin`，每次 `sync` 至多一个 git 进程，约 25–40 ms；只编辑已索引文件且没有新路径时不问）。被报为忽略的：新文件不进索引，已索引的行当场 `deleteFile`（连带其符号），不等下一次枚举对账。已跟踪的文件 git 从不报，与枚举的 `ls-files -c` 一致。git 不可用、失败或超时（退出码不是 0 或 1）、或目录不是工作树时回答是 `null`（不知道），照旧准入，与枚举的纯目录回退一致；失败即开放。输入须已是索引里的拼写（都经过 `normalizeDirtyPath` 或 `toRel`），因为 git 按它的拼写回答、调用方按原拼写查。git 在读完输入前退出时，对 stdin 的写入以 EOF / EPIPE 失败，`stdin.on('error')` 那一行是防止进程崩溃的唯一屏障。修复前：碰一下 `.gitignore` 目录里的文件它就进索引，直到下一次枚举对账才被清掉（真实会话里 `.devflow/` 下的草稿脚本排在结果第一行）。`tests/index/walker.test.mjs` 测 `gitIgnoredPaths`（含大负载撞已关闭的管道、`core.ignorecase` 两种取值），`tests/index/indexer.test.mjs` 测整条路。
- **死进程遗留的构建**：持有锁却读到磁盘 `state === 'building'`，而本进程没有构建在跑，只可能是上一个进程构建中被杀。索引非空且允许自动索引时按 listing 续建（非 force，mtime/size 未变的文件跳过）；索引为空则走自动索引判定；`autoIndex: false` / `unsafe` 时不续建，只把状态写回 `ready`。`buildAll` 与续建末尾：有提交，**或**存在 `resolution IS NULL` 的 refs，就 `resolveAll`（被杀在「文件已写、refs 未解析」之间的那次由此补齐）。
- **大批量不阻塞**：脏文件 ≥ 200 时不走前台 `sync()`，改为后台非 force 构建（同样只重解析 mtime/size 变化的文件，status 为 `building`，查询结果 partial），`ensureFresh` 最多等 `maxWaitMs`。构建进行中再调用 `ensureFresh` 同样最多等 `maxWaitMs`，不启动第二个构建。
- dirty 条目是外部输入：`normalizeDirtyPath` 先归一化 `.`/`..` 段再拒绝任何越界或绝对路径；`sync()` 用 `lstat` 校验，不跟随符号链接（与 walker 一致）。
- 解析在 `worker_threads`（每 worker `initEngine()` 一次；单任务 60 s 超时则终止该 worker 并把该文件记为解析失败），主线程按文件事务写库；增量 `sync()` 对每个重写过的文件调用 `resolveFile`，全量 `buildAll()` 在末尾调用一次 `resolveAll`（实测比逐文件快 3×，结果更一致）。查询时读源码的只有属性读取的扫描（§8），它有自己单独的常驻 worker（`src/graph/propertyReadsWorker.mjs`），不在这个池里；主线程在那条路上同样不解析，只等答案。
- 全量构建走 bulk load（见 §7）：清表、删索引、FK 关到结束，每 100 个文件一次 WAL 提交；构建期间 `wal_autocheckpoint=0`，结束做一次 `wal_checkpoint(TRUNCATE)` 并恢复自动检查点。bulk 构建的 `resolveAll` 必须在 `endBulkLoad` **之后**（解析器需要索引）；增量 sync 的 `resolveFile` 在每个文件的写组 savepoint 内执行。`buildAll` 与后台构建失败都写 `status.json` 的 `error` 态与 `reasonDetail`。
- 自动索引条件：`config.autoIndex` 且 `!unsafe` 且支持语言的文件数 ≥ `config.minFilesToAutoIndex` 且总数 ≤ `config.maxFiles`；否则 `state: 'empty'`，`status.json` 的 `reason` 给机器可读原因（`auto-index-disabled` / `unsafe-root` / `below-min-files` / `too-many-files` / `no-supported-files` / `build-failed`）；只读进程（拿不到锁）不写 status.json，只在 `status()` 返回里给出 `lock-held-read-only`。`total` 指枚举到的全部文件数（任意语言，已应用 ignore/exclude），`supportedCount` 为语言包命中的文件数，`maxFiles` 截断只作用于后者。
- 语言包装载是容错的：任一包语法/引用错误时打一行 stderr 并跳过（`registry.loadErrors` 记录），索引照常；契约测试用 `initEngine({ strict: true })` 让坏包直接失败。
- 多进程写：`lockPath` 的 pid 锁；拿不到锁走只读（查询照常，不同步）。
- **会话开始即刷新**（`src/mcp/server.mjs` 的 `silentIndexStart`）：每会话一个服务进程，`initialize` 请求一到就在后台调 `ensureFresh({ maxWaitMs: 1 })`，不等它完成、失败只写 stderr。于是新项目在会话打开时就开始建第一次索引（而不是等模型第一次调用工具——`SessionStart` 钩子让未索引项目的模型「就绪前用 Grep/Read」，照做的模型永远不会触发构建），已索引项目则在会话打开时做一次增量检查。钩子进程短命，进程内的构建会随它退出，所以构建只能由服务进程发起。2026-11-24 实测：握手后不发任何工具调用，99 个文件的项目 1.6 s 就绪、2 个文件的项目 0.5 s 就绪；低于自动索引门槛的项目只写 `state: 'empty'` 的记录，不索引。
- **会话开始即整理存储**（同一个函数，刷新派出之后）：给当前项目的索引盖 `used.at`，再按 §3.4 的策略清理；删了什么、什么因为在用而保留，各写一行 stderr。`autoIndex` 关闭（用户的设置或项目的 `.zcode/codegraph.json`）、或项目根不安全时，这一步整个不做。
- **自动索引关闭时工具不同步**：`autoIndex` 为 false（无论来自用户还是项目）时，工具调用不再先调 `ensureFresh`，只有带 `refresh: true` 的 `codegraph_status` 才动索引；其余调用按库里现有的内容回答，首行注明 `not synced: auto-indexing is off, refresh=true syncs`。
- **`status.json` 丢失不影响已有索引**：库里有文件而状态文件缺失或损坏时，`status()` 直接从库里的计数给出 `ready` 状态（`indexedAt` 取 `graph.db` 的 mtime）；持有锁的进程在下一次刷新开头把状态文件按库里的内容写回。只读进程照样能回答，但不写文件。

## 10. MCP 与工具（C 实现协议层与渲染；工具名与 schema 冻结）

传输：stdio，按行分隔的 JSON-RPC 2.0（与 `plugins/websearch/bin/server.mjs` 相同写法）。方法：`initialize`（回显 `protocolVersion`，`capabilities.tools = {}`，`instructions` 见下）、`notifications/initialized`、`tools/list`、`tools/call`、`ping`。未知方法回 `-32601`；非法 JSON 回 `-32700` 且进程不退出。

ZCode 宿主事实（2026-11-23 读 `zcode.cjs` 实证，详见 `.devflow/codegraph-plugin/zcode-facts.md`）：
- `hooks/hooks.json` 由宿主**自动发现并加载**；清单里再声明 `hooks` 键会报 `Duplicate plugin hooks file ignored`，所以 `plugin.json` 不写 `hooks`。
- MCP server 的 cwd = 会话工作区；env 注入 `ZCODE_PLUGIN_DATA`/`ZCODE_PLUGIN_ROOT`/`ZCODE_PROJECT_DIR`；`command/args/env` 里的 `${…}` 会展开；第三方插件每会话一个进程（写入必须走文件锁）。
- 工具结果模型可见上限 **50 000 字节**，超出静默截尾（不落盘）。单次输出预算 ≤ 45 KB。
- `initialize.instructions` **不会被注入**系统提示；指引只能放在工具 description 与 `SessionStart.additionalContext`。
- 工具名：`mcp__plugin_codegraph_codegraph__<tool>`。
- `"command": "node"` 在 MCP 侧有内置回退（Electron 的 Node 22.22.1），钩子侧没有。
- 钩子 stdin 带通用字段 `session_id`、`cwd`、`hook_event_name`，env 带 `ZCODE_SESSION_ID`、`ZCODE_PROJECT_DIR`；`UserPromptSubmit` 的输出 `{ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext } }` 生效，钩子配置里不写 `matcher` 即全匹配。三个钩子：
  - `session-start`：读 `status.json` 注入状态与指引（≤ 120 token）。索引已就绪时顺带写 `announced/<sessionId>`，因为它已经告诉过模型。没有索引或索引为空、而项目的 `.zcode/codegraph.json` 把 `autoIndex` 关掉时，改说 `Not indexed: auto-indexing is off for this project (.zcode/codegraph.json); use Grep/Read here.`——否则它会承诺一个不会开始的后台构建。钩子只读文件（`loadProjectConfig` 静音告警），不加载语法运行时。
  - `user-prompt`：状态为 `ready` 且本会话没有 `announced/<sessionId>` 时，注入同样的就绪状态与指引并写标记；否则静默退出。它负责「索引在会话开始后才建完」的通知，每个会话一次；没有 session id 时保持静默（分不清「说过」与「没说过」）；标记超过一天的被清掉。单次约 60 ms。
  - `post-tool`：见 §3.2。

| 工具 | 参数 | 说明 |
|---|---|---|
| `codegraph_status` | `refresh?: boolean`，`storage?: boolean`，`clean?: 'stale'\|'all'\|'current'\|'project'`，`project?: string`，`confirm?: boolean` | 索引状态；`refresh` 强制同步一次；`storage` 附带本机全部索引的清单（§3.4）；`clean` 删除索引——`stale` 按 §3.4 的策略，`all` 除当前项目外全部，`current` 当前项目（先关掉本会话的句柄，下一次调用重建），`project` 由 `project` 指定的那个；不带 `confirm: true` 时只列出会删什么 |
| `codegraph_lookup` | `operation: 'search'|'symbol'|'callers'|'callees'|'impact'|'outline'`，`query?: string`，`name?: string`，`file?: string`，`depth?: int(1–6, 默认 2)`，`limit?: int(1–200, 默认 20)`，`body?: boolean` | `search` 用 `query`（符号名、前缀或任意词序的描述；没有符号叫这个名字时给使用它的位置，见 §8）；其余用 `name`（`outline` 用 `file`）。`body=true` 且函数体 ≤ 30 行时内联源码，否则给 Read 行段 |
| `codegraph_map` | `path?: string`，`budget?: int(200–4000 tokens, 默认 1200)` | 仓库地图 |

工具描述（固定文案，命令式）：

- `codegraph_lookup`：`Locate symbols and relationships in the code graph. Use this INSTEAD of Grep to find where a function/class/variable is defined, who calls or uses it, what it calls, or what a change impacts. One line per symbol with exact file:line ranges; read only those ranges afterwards. operation=search needs query; symbol/callers/callees/impact need name (add file to disambiguate); outline needs file. symbol with body=true returns the definition source in the same call. Relations are marked: = import-resolved, ~ unique-name, ? unresolved/dynamic — verify ? with Grep if it matters. Index may lag a few seconds after external edits; codegraph_status reports staleness.`
- `query` 参数：`search only: symbol name, prefix, or words in any order ("parse config", "gift card redeem"). When no name holds every word, the longest ones anchor a partial-match search, best match first. When no symbol carries the name, search lists where it is used: calls and type names from the index, and for JS/TS the property reads (obj.field) of that name, found by scanning the source. Variables and parameters, object keys in literals and words in strings are not in the graph. Required for search.`；`operation` 参数以 `search: symbols by name, or the places that use a name no symbol carries;` 开头。
- `codegraph_map`：`Repository map: directories -> files -> key symbols, ranked by reference count and cut to a token budget. Use this INSTEAD of Glob plus reading file heads when you need to see what a project or directory contains. Symbols only, no source.`
- `codegraph_status`：`Code graph index status: ready/building/empty, file and symbol counts, covered languages, stale files. Call it first when unsure whether the graph is usable; refresh=true forces an incremental sync. storage=true lists every project's index on this machine; clean removes indexes (only with confirm=true). When the project is not indexed, fall back to Read/Grep.`
- `storage` / `clean` / `project` / `confirm` 参数描述见 `src/mcp/tools.mjs` 的 `PARAMETER`（`tools.test.mjs` 钉住了 `clean` 的枚举与参数顺序）。

`codegraph_status` 的 `clean` 请求不调 `ensureFresh`，只读一次 `status()`：`clean: "current"` 要看本会话是否正在构建（`status().building`，是就拒绝并说明进度——关闭索引器会等整个构建结束）。进程自己的上下文上执行 `clean: "current"` 后会 `resetContext()`，下一次调用重新建索引器；注入的上下文（测试）不会被重置。

`initialize.instructions`（约 700 字符）：说明三个工具、何时用 Grep（文本、配置、字符串、未支持语言）、未索引时用内置工具。

## 11. 输出格式（`src/render/text.mjs`，C 实现；快照测试以此为准）

```
# <operation> <args> · <summary> · <freshness>
<rows>
<footer>
```

- `symbol`：首行 `# symbol parseConfig · src/config/parse.ts:42-71 (30 lines) · callers 3/5 resolved`；随后 `sig` 行、`doc:` 行、`calls(n): a= b~ c?`、`called by(n): name path:line=`、`imports: a, b`、图例行（仅含 `~` 或 `?` 时出现）、`body:` 行（`30 lines → Read src/config/parse.ts offset 42 limit 30` 或内联代码块）。`function` / `method` / `component` / `macro` 的入边写作 `callers` / `called by`，其它 kind（类型、类、常量、字段……）写作 `uses` / `used by`——入边是全部引用，不只是调用。
- `callers`/`callees`/`impact`/`outline`：每行 `<kind> <name> <signature> <path>:<start>-<end>`（`kind` 右对齐 9 列省略号，`signature` 截 80 列），按 path 再按行排序。`search` 的前 3 行在行尾追加 ` · 12 uses in 4 files (3 in source)`（`usage.refs` 为 0 或没有 `usage` 时不追加）：定向的那一次调用就带上「谁依赖它」，不必等模型之后再回来问 `callers`——T20 的 13 个会话里它在第一次编辑后一次也没回来过。其中有按唯一名字连上的引用时（`usage.byName > 0`）行尾再加 `~` 并带出图例行；被大量引用的符号（`capped`）只写 ` · 15361 references (not broken down by file)`（全部引用，含定义所在文件）。
- `search`：行格式同上，但**保持相关度顺序**（完全同名优先；其余先看名字是否以查询开头，同一层内源码先于测试与脚本，再 bm25，最后 LIKE 兜底），不按 path 重排——小预算截断时留下的是最相关的行。首行在部分匹配时写 `# search "sign-in cookie" · 18 partial matches (no name has all words; best match: sign + cookie) · indexed 0s ago`（`matched` 是排在最前的那个名字含的词，多个词用 ` + ` 连接；靠后的行未必含这些词，所以首行只说「最佳匹配含什么」，不说整个结果集都含）；无命中写 `no matches` 并给 `hint: search matches symbol names and names that are used here without a definition (calls, type names, and property reads such as obj.field in JS/TS); text, object keys in literals, variables and parameters, and string literals belong to Grep; a word of one or two letters must be a whole word.`。
- `search` 的「名字只被使用」结果（§8；行是使用位置时）：首行 `# search useEffect · no symbol carries this name; 90 uses in 48 files (useEffect) · also in symbol names: useT, useTick (+18 more found) · indexed 2m ago`。`uses` / `files` 是全部使用位置的总数，越过截断写 `5001+ uses in 501+ files`；括号里是命中的名字，至多 3 个（`listOrClamp`）；`also in symbol names` 只在沾词的符号存在时出现，至多 3 个名字，其余计 `(+N more found)`——N 是这次搜索找到的个数减 3（见 §8 的 `symbolCount`），不是沾词符号的总数，所以写 `found`。行是 `<kind> [<receiver>.]<name> ×<count> in <owner> <path>:<line>`，`kind` 在同一行的引用不全是同一种时是 `use`，扫描出来的属性读取是 `property`，模块级引用写 `at`、没有 `in <owner>`。名字截 60 列、接收者 24 列、首行里的名字 40 列，带空格的名字加引号。页脚按来源选（没有图例行，也没有 `next:`；`matched` / `dropped` 与 `refs` 同时到达时以使用位置为准）。只有索引行时计数词是 `uses`，页脚以 `hint: no symbol carries this name; the rows are places that use it: calls and type names from the index.` 开头，后半句说扫描怎么了（`refs.skipped`）：扫描完整而没有读取是 `JS/TS property reads (obj.field) were looked for in the source: there were none.`；热点（`hub`）是 `It is also read as a property (obj.field) in more JS/TS files than a search lists: too common to point anywhere.`；扫描停在上限（`limit`）是 `Its JS/TS property reads (obj.field) are not listed: more of them than a search parses at once, or more source than one scan reads. Grep for them.`；这次没有扫描（`not-ready`、`not-identifier`，以及没有专门页脚的原因 `unreadable`、`not-asked`）是 `JS/TS property reads (obj.field) were not looked for in the source this time: the scanner was not ready or its scan timed out, some files could not be read, or the query is not a single name.`；四种都以 `Variables and parameters, object keys in literals and words in strings are not in the graph: grep for those.` 结尾。只有扫描行时计数词是 `property reads`（`1 property read in 1 file`），页脚 `hint: no symbol carries this name; the rows are property reads (obj.name), found by scanning the JavaScript and TypeScript source just now; the index had no call or type of that name. Variables and parameters, object keys in literals and words in strings are not in the graph: grep for those.`；两份都有时计数词是 `uses`，页脚 `hint: no symbol carries this name; the rows are places that use it: calls and type names from the index, and property reads (obj.name) found by scanning the JS/TS source just now. Variables and parameters, object keys in literals and words in strings are not in the graph: grep for those.`。只要 `refs.capped` 为真（任一来源被截断，或有文件没读到），页脚末尾追加一句 ` Totals with a + are lower bounds: more places exist than were read.`：首行的合计带 `+`，这句话是输出里唯一解释它的地方。结果为空而 `info.hub` 为真时，页脚换成 `hint: no symbol, call or type has this name, and it is read as a property (obj.field) in more JS/TS files than a search lists. Too common to point anywhere: Grep for it. Object keys in literals and words in strings are not in the graph either.`
- 页脚提示（`hint:` / `next:`）排在图例行之后。`search` 有结果时固定给一行 `next: symbol <name> returns the definition with its callers and imports (body=true reads it in one call); impact <name> shows what a change breaks.`。**行优先于提示**：预算装不下「首行 + 页脚 + 几行结果」时先丢页脚提示（从最后一个起，页脚剩给行的空间少于 48 token 即丢），再丢截断提示；行与首行始终保留。
- `map`：按目录分组，`dir/` 行后缩进 `<file>  <kind> <name>:<line> ...`，每文件最多 6 个符号。
- `status` 的存储清单（`storage: true` 时接在其它行之后）：`indexes: 4 projects · 1.2 GB in all`、`under <数据目录>/indexes`、每个索引一行 ` <项目根> · <N files | building | empty> · <大小> · used <多久前>[ · in use]`（项目目录不存在的写 `project folder missing`），最后一行 `policy: <闲置策略>; <总量策略>; an index whose project folder is gone goes by the same age rule`。大小写作 `7.6 MB` / `471 MB` / `1.2 GB`（不足 1 MB 写 KB）。
- `status` 的 `clean` 输出：首行 `# status clean=<目标> · <N of M indexes would be removed · 大小>`（未带 `confirm`）或 `# status clean=<目标> · removed N of M indexes · 大小 freed`；随后每个索引一行，行尾是原因（`orphan` / `idle` / `over-quota` / `requested`），因在用而保留的写 `kept: in use`；页脚未执行时是 `hint: nothing was removed. Call again with confirm=true, and only when the user asked for it.`，执行后是重建与查看剩余的提示。`clean: "project"` 找不到、或指向当前项目时，各返回一行说明（后者提示改用 `clean="current"`）。
- `status` 在自动索引关闭且已有索引时多一行 `note: auto-indexing is off <(codegraph.json) | for this project (.zcode/codegraph.json)>; the index is only refreshed by codegraph_status (refresh=true)`；`empty` 且是项目文件关掉的，提示改为 `hint: auto-indexing is off in .zcode/codegraph.json of this project; delete "autoIndex": false there to index it. Until then use Read/Grep.`。
- 截断：末行 `(N of M shown)`；陈旧：首行末尾 ` · stale: N files changed since index`；构建中：` · indexing 43% (results partial)`。
- token 估算：`Math.ceil(Buffer.byteLength(text) / 4)`，超出预算先截行数再补截断行。
- 所有文本纯文本，不输出 JSON；`tool_result` 的 `content[0].text` 即全文。

## 12. 配置（`src/config.mjs`，C 实现）

文件 `configPath()`（JSON），字段缺省：

```json
{ "autoIndex": true, "minFilesToAutoIndex": 30, "maxFiles": 30000, "maxFileBytes": 4194304, "exclude": [],
  "languages": null, "defaultBudgetTokens": { "lookup": 1500, "map": 1200 }, "frontload": false, "liftoffOnly": false,
  "maxIdleDays": 90, "maxTotalMB": 0 }
```

环境变量覆盖（字段为空才回落）：`CODEGRAPH_AUTO_INDEX`、`CODEGRAPH_MAX_FILES`、`CODEGRAPH_MIN_FILES`、`CODEGRAPH_EXCLUDE`（逗号分隔）、`CODEGRAPH_LIFTOFF_ONLY`、`CODEGRAPH_MAX_IDLE_DAYS`、`CODEGRAPH_MAX_TOTAL_MB`。宿主把 userConfig 的布尔渲染成 `"true"/"false"`（不是 `"1"/"0"`），空串表示未设，所以布尔解析接受 `true/1/yes/on` 与 `false/0/no/off/""`。`Indexer.ensureFresh({ force })` 的 `force`（`codegraph_status{refresh:true}` 用）绕过 stat 扫描的 5 s 节流，并无条件执行一次 §9 的文件枚举对账；它不强制重新解析未变化的文件（那是 `buildAll({ force: true })`）。

**项目自己的设置**：`<项目根>/.zcode/codegraph.json`（`loadProjectConfig(root)`，`projectConfigPath(root)`）。读取顺序是 用户的 `codegraph.json` → 环境变量 → 默认值，再由 `applyProjectConfig(config, project)` 叠加项目文件；`loadConfig({ project })` 一步完成。项目文件认 `autoIndex`、`exclude`、`minFilesToAutoIndex`、`maxFiles`、`languages` 五个键，其它键告警并忽略；缺文件是常态、不告警，文件损坏则当作没有（告警一行）。**项目只能收紧**：

| 键 | 叠加规则 |
|---|---|
| `autoIndex` | 项目为 `false` 且用户为 `true` 时关闭，并在配置里标 `autoIndexOffBy: 'project'`；用户已关闭时项目写 `true` 无效，也不改原因 |
| `exclude` | 并集（用户的在前） |
| `minFilesToAutoIndex` | 取较大者 |
| `maxFiles` | 取较小者 |
| `languages` | 交集；只有一方设置时取设置了的一方 |

`defaultBudgetTokens`、`frontload`、`maxIdleDays`、`maxTotalMB` 不是项目设置。`autoIndexOffBy` 不在 §12 的文件 schema 里，只在项目关闭时出现在结果对象上；`Indexer` 在 `applyDefaults` 之前读它，用来说明是谁关的（`reasonDetail`）。

## 13. 测试约定

- `tests/contract.test.mjs`：对 `languages/*.mjs` 每个包跑同一套断言：`sample.<ext>` 的符号/import/调用点与 `expected.json` 一致、`broken.<ext>` 不抛错且有 ERROR 节点、扩展名无冲突、`id` 等于文件名。`CODEGRAPH_CONTRACT_LANGS=python,ruby` 只跑指定包（并行开发用）。
- `expected.json`：`{ "symbols": [{ "kind", "name", "line", "endLine", "qual"?, "doc"?, "exported"? }], "imports": [{ "spec", "line" }], "calls": [{ "name", "line" }], "refs": [{ "kind"?, "name", "line", "symbol" }] }`。`symbols`/`imports`/`calls` 是**精确多重集**（多一个少一个都失败）；`qual`/`doc`/`exported` 写了才比对；`refs` 是**必须存在的子集**（`symbol` 为所属符号名或 null），用来锁住单行定义的归属。
- 多文件解析用例放 `tests/fixtures/projects/<name>/`，测试里用临时目录建库。

## 14. 桌面端扩展（`bin/extension.mjs`、`src/extension/describe.mjs`、`ui/index.html`）

只在 ZCode 桌面端加载（清单的 `extension` 与 `slots`）。接口没有公开文档，以下按 4.0.10870 的打包代码核对；宿主对不认识的清单字段与越界的调用报 `not-declared` / `invalid-input`，不会崩溃。`tests/extension/extension.test.mjs` 把清单里的 id 和代码里注册的 id 钉在一起。

**运行环境**：所有插件的扩展代码跑在同一个进程里，所以扩展里**不做**插件数据目录以外路径的同步文件调用。要碰项目路径，先用 `probe(path, timeout)` 问一次（异步 `stat`，默认 1500 ms）：答 `'there'` / `'missing'` 才继续走同步的 `resolveProjectRoot` / `projectKey` / `loadProjectConfig`——与 server 是同一套函数，项目键才一致；答 `'unknown'` 的这一轮跳过（`stat` 同步抛错也算 `unknown`）。拿不到应答的后果只有两个：那个会话这一轮没有状态位，那个项目的索引这一轮不受「打开会话」保护（删了下次重建）。插件自己的数据目录（索引清单、`status.json`、`codegraph.json`、删除）在本地盘，同步读写；清理时每删一个让出一次事件循环。刷新循环里的异常一律接住并记日志，这个进程里不能有未处理的拒绝。`activate` 返回 `{ dispose }`，停掉刷新循环（刷新正在等宿主时调用也成立）。

两条已知的残余：探测只说明那一刻路径应答了，探测通过后路径被拔掉，随后的同步调用仍可能等到系统超时（本机无法复现）；读取代次只丢弃「比之后开始的读取更旧」的应答，宿主若对晚于某次变更事件发起的读取仍给出不含该事件的旧快照，那个会话会被当作已关闭，直到下一次读取（空闲时 60 s），期间它的索引同样不受保护。

**状态位**：槽位 `composer.status`，条目 `codegraph.status`，点击执行命令 `codegraph.storage`。每个打开的会话一项，`ctx.slots.update(id, { text, tooltip, visible }, { sessionId })`，宿主要求 `text ≤ 40`、`tooltip ≤ 200` 字符。

| 索引状态 | `text` | 悬停的第三行 |
|---|---|---|
| `ready` | `compact(filesTotal)` 个文件（`291 个文件`、`1.8k 个文件`） | `291 个文件 · 2748 个符号 · 7.6 MB · 2 分钟前`，有改过未同步的文件再加 ` · 3 个文件在索引之后改过` |
| `building` | 百分比（已建 / 总数，封顶 100） | `正在索引 100 / 700 个文件，建完之前结果是部分的` |
| `error` | `出错` | `索引出错：<error 或 reason，压成一行>` |
| 没有索引或 `empty`，且项目文件关了 `autoIndex` | `未开启` | `这个项目关闭了索引（.zcode/codegraph.json）` |
| 其它（没有索引、`empty`、家目录或盘根） | 不显示 | — |

悬停共四行：标题、项目根（`/` 分隔）、状态行、「点击管理本机上的索引」；超出 200 字符时截断并以 `…` 结尾。语言随宿主的 `locale`（`zh*` 为中文）。刷新间隔：有会话的索引在构建时 5 s，否则 60 s。

会话列表有两条顺序规则。读取代次（`reads`）：一次读取的应答如果在更新的读取开始之后才到，直接丢弃——宿主的应答可能比中途到来的变更事件旧。绘制串行（`paintOnce`），并且写状态位前复核该会话仍在列表里：否则一次还在等路径应答的绘制，会把刚关闭的会话的状态位重新画出来。

**面板**：视图 `codegraph.storage`，入口 `ui/index.html`，`scope: "app"`。页面在沙箱 iframe 里，用 `window.zcode.callTool(<名字>, <参数>)` 调下面五个工具。`run` 返回的对象被宿主 JSON 序列化后成为页面的 `structuredContent`，**返回值里不能有函数**（`viewData` 把依赖数字的文案都先算成字符串）；`run` 抛错时页面收到 `isError`。工具永不抛错。

| 工具 | 参数 | 返回 |
|---|---|---|
| `list` | — | `{ ok: true, data }` |
| `remove` | `{ key }`（索引目录名，16 位十六进制） | 成功 `{ ok: true, message, data }`；被拒 `{ ok: false, message }`：没给 `key`、本机没有这个索引、是打开着的会话的项目、正在被写入 |
| `clean` | — | 同上；到期的逐个删，删不掉的在 `message` 里说明。到期的一个都没删掉时 `ok: false` |
| `policy` | `{ maxIdleDays?, maxTotalMB? }`（≥ 0 的整数） | 写进插件设置（`ctx.settings.update`，键即 `userConfig` 的同名项），返回新的快照；非法值 `{ ok: false, message }` |
| `open` | — | `{ ok: true, message }`；文件管理器起不来时 `{ ok: false, message }`。不带 `data`，页面也不重读 |

`open`：宿主没有对外打开目录的能力，所以扩展自己起系统的文件管理器（`OPENERS`：Windows `explorer`、macOS `open`，其余 `xdg-open`），`detached: true`、`stdio: 'ignore'`，起来后 `unref`，不让它拴住这个共用进程。路径固定是 `indexesDir(data)`（不存在就建），**不接受页面传路径**，参数走数组、不经 shell。`explorer` 打开目录成功时退出码也是 1，所以只认「起没起来」：`spawn` 事件算成功，`error` 事件才算失败。

改动成功但快照恰好读不到时，应答是 `{ ok: true, message }`、不带 `data`；页面据此再读一次 `list`，读不到才报错。

`data` 来自 `viewData(entries, policy, { current, locale, now, storeDir, due })`：`{ locale, storeDir, totals: { projects, files, size, due, dueSize }, policy: { maxIdleDays, maxTotalMB, fixedByFile: { maxIdleDays, maxTotalMB } }, rows: [{ key, path, state, stateLabel, files, filesText, size, used, notes, removable, due, transient, blocked }], text }`。`files` 是各索引文件数之和；`transient` 标出 ZCode 给还没指定目录的会话建的工作区（根路径匹配 `/.zcode/workspace/draft-<id>`），它带「临时会话」备注并排在最后，其余顺序不变。`removable` 是扩展允许不允许：打开着的会话的项目与在用的索引为 `false`，`blocked` 为 `current` 或 `in-use`；`due` 只说明「清理到期索引」会带走它。策略的来源同 §12：`codegraph.json` 里写了的项 `fixedByFile` 为 `true`，页面把那一项置灰。`text` 是页面用到的全部文案，值都是字符串（`cleanLabel` 已按到期数量算好；工具自己的消息不进去）。

**页面**（`ui/index.html`）有三个 `<style>`。`#zcode-contract` 是 ZCode 沙箱样式表（`out/plugin-sandbox/visualize.css`）的逐条原文：不改，应用升级后整块重抄。`#codegraph-layout` 只有版式属性和档位内的间距。`#codegraph-decorations` 是面板自有的装饰——图标底下的色块、分区标题前的竖条、路径的底色、按状态着色的标签、说明文字的次要文字色（`--muted-foreground` 与 `--foreground` 按 80 / 20 混合：官方的次要文字色在应用的浅色主题下只有 4.26:1，混合后 4.99:1；改比例前用 `.tmp/w27-muted.mjs` 的做法重量）——**颜色只能是契约令牌或它的混合（`var(--…)`、`color-mix(…)`、`currentColor`、`transparent`），字号字重只能取契约的 `--font-*`，间距只能在档位上，选择器只能落在自己的 `storage-*` 上**。状态色先与前景色混合再用：契约的状态色偏亮，在应用的浅色主题下直接当文字不到 WCAG AA，混合比例（绿 50%、蓝 45%、红 65%、强调色 50%）是用 ZCode 4.0.10870 量出来的上限，改动前要重新量（`.tmp/w27-contrast.mjs` 的做法）。页面用到的类名只能是契约里的工具类，或自己的 `storage-*`；动态文本一律 `textContent`，拼进选择器的 `key` 先过 `CSS.escape`。路径是 `<span class="storage-path-code">`：在分隔符处放 `<wbr>`，至多两行（`-webkit-line-clamp: 2`），完整路径在 `title` 里。主题：宿主只通过 `zcode.hostContext.styles.variables` 交出变量，页面自己写到根元素上，并监听 `zcode:globals` 跟随明暗切换。交出来的只有 `--color-*`、`--font-*`、圆角这类变量（宿主的 schema 会剥掉 `--gen-ui-*`），所以契约里的卡片色、主按钮色、悬停色、输入框边框色用的是契约内置的回退值——ZCode 自带的可视化也是这样。

**图标**：沙箱不给扩展视图图标库（`data-lucide` 不会生效），所以把 Lucide 的官方文件（npm `lucide-static` 0.468.0，ISC；原件在 `ui/icons/`）内联成 `<symbol>`，用到的地方 `<svg class="storage-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><use href="#codegraph-icon-<名字>"></use></svg>`，尺寸取契约的 `--icon-size`，颜色跟随文字。`icons.test.mjs` 拿 `ui/icons/` 的原件逐字对照页面里的 `<symbol>`，换版本时两处一起换。

**复制路径**：`navigator.clipboard.writeText`；沙箱拒绝时（没有用户手势或没有权限）改为选中路径并提示按 Ctrl+C（macOS 上是 ⌘C，由 `viewData` 的 `platform` 决定发哪一句）；连选中都做不到时显示错误。

删除与清理都是两步（先问，再确认），`Escape` 撤回，焦点跟着走。别名运行时的 `zcode.connecting` 在首次访问后恒为 `true`，不能拿它等连接。

**检查**（`tests/extension/`）：`page.test.mjs` 用无头 Chrome 或 Edge 打开页面（没有浏览器就跳过），应答由真实的 `viewData` 生成；检查三个样式块的性质、类名、图标、标签不换行、路径至多两行、320 px 与桌面宽度下不横向溢出、对比度（文字 4.5:1、图标 3:1）、每个控件有名称、加载中、空存储、出错后重试、两步确认与焦点、打开目录与复制路径、明暗切换。`CODEGRAPH_PAGE=<另一份页面>` 用来确认这些检查在页面被改坏时会失败。
