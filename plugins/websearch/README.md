# websearch

ZCode 的独立网页搜索插件：一个零依赖的 MCP server，把 AnySearch / Exa / Parallel / Bing 串成一条会自动回退的引擎链，另带一个静态网页正文读取工具。**所有引擎都能免 Key 使用**（免费额度）；某个引擎额度用完时，在 `websearch.json` 里给它填自己的 Key 就继续用。

与内置工具的关系：内置 `WebSearch` 走**模型 provider 的服务端原生搜索**，只在 provider 命中特定端点时才存在（见下）。本插件不依赖 provider，任何模型下都能用。插件工具名带 `mcp__` 前缀，所以两者不会冲突，也不会互相覆盖。两个工具的描述都写明：内置 `WebSearch` / `WebFetch` 可用时优先用内置的，本插件是它们不可用时的替代；`fetch_page` 另有一个例外——确实需要页面原文、而不是 `WebFetch` 给出的摘要时。

## 工具

### `web_search`

```json
{ "query": "必填，≤2000 字符", "limit": "1-10，省略用设置默认值", "engines": ["bing", "exa"] }
```

成功返回 `{ ok:true, engine, results:[{title,url,snippet,publishedAt}], attempts, skipped, elapsedMs }`；失败返回 `{ ok:false, errorCode, message, attempts, skipped, configPath }`，`message` 可直接转述给用户。两种返回都可能带 `configWarning`：配置文件读不了，或配置里还有已移除的引擎。把它原样告诉用户，按提示改配置即可。

`attempts` 里每个引擎都有 `ok` / `count` / `ms`，失败时带 `error`；额度类失败（401/402/429、rate limit、quota）会额外带 `hint`，提示可以填 Key。

### `fetch_page`

```json
{ "url": "必填，http(s) 绝对地址", "maxChars": "可选，默认 8000，范围 500-30000" }
```

去掉 `script`/`style`/`svg`/注释，块级标签转换行，解码 HTML 实体，压缩空白后截断。按响应头或页面里声明的字符集解码（GBK、Big5、Shift-JIS 等不会乱码），都没声明时按 UTF-8。`application/json` 直接返回原文。不执行页面脚本、不处理登录态。

## 引擎

| id | 端点 | 方式 | Key |
|---|---|---|---|
| `anysearch` | `api.anysearch.com/v1/search` | JSON API | 可选（Bearer） |
| `exa` | `mcp.exa.ai/mcp` | 托管 MCP，工具 `web_search_exa` | 可选（Bearer） |
| `parallel` | `mcp.parallel.ai/mcp` | 托管 MCP，工具 `web_search` | 可选（`x-api-key`） |
| `bing` | `www.bing.com/search` | 抓结果页 HTML | 不需要，也无法填 |

链式规则：`fallback`（默认，每次从第一位开始）或 `rotate`（每次把起始位后移一格，分散匿名额度）；一次调用只有一个总预算（默认 20s），每个引擎用剩余预算，预算耗尽后剩余引擎记入 `skipped`。只做去重与 300 字符截断，不改写摘要。

0.2.0 起不再有 SearXNG 引擎：公共实例基本关了 JSON API，自建又得允许插件去连一个用户填的地址。旧配置文件里的 `searxng`、`searxngInstances` 会被忽略，不用改；但如果旧配置只用 SearXNG（`order` 里只有它，或者填了 `searxngInstances`），升级后每次搜索都会带 `configWarning` 提醒，并按剩下的引擎搜索——不想让它再查公网引擎，就把 `order` 改成要用的引擎。

## 设置

**当前版本的 ZCode 插件详情页没有配置表单**（详情页的「高级信息」只展示路径）。配置有三种方式，按优先级：

1. **插件数据目录的 `websearch.json`（推荐）**：路径是

   ```text
   C:\Users\<你>\.zcode\cli\plugins\data\websearch@zcode-plugin\websearch.json
   ```

   内容示例（键名与 `sanitizeConfig` 一致）：

   ```json
   {
     "anysearchKey": "你的Key",
     "exaKey": "",
     "parallelKey": "",
     "order": "anysearch,exa,parallel,bing",
     "disabled": "",
     "mode": "fallback",
     "defaultLimit": 10,
     "timeoutMs": 20000,
     "bingMarket": "auto"
   }
   ```

   只写要改的键即可，其余用默认值；保存后下一次搜索就读到。

2. **环境变量**：`ANYSEARCH_API_KEY` / `EXA_API_KEY` / `PARALLEL_API_KEY`（`setx` 后重启 ZCode）。**仅当 `websearch.json` 和插件配置里都没填该引擎的 Key 时生效**。

3. **插件的 `userConfig`**（清单里声明了 9 个字段）：值会展开进 MCP 的环境变量，但当前版本没有输入界面，且这些字段不能标 `sensitive`（敏感字段连界面输入都不支持）。等 ZCode 支持配置表单后，无需改本插件即可使用。注意：首次启动生成的 `websearch.json` 模板带着全部默认值，只要该文件在，`userConfig` 里的同名设置就不会生效。

优先级：`websearch.json` > `userConfig`（应用配置）> 环境变量 > 内置默认值。

`userConfig` 各字段默认值：引擎顺序 `anysearch,exa,parallel,bing`；禁用列表空；`fallback`；默认条数 `10`；总超时 `20000`；Bing 市场 `auto`；三个 Key 空。

## 安全边界

- **没有宿主守门**。Cindy 版靠宿主的 `cindy.fetch` 做 SSRF/体积/超时拦截；ZCode 的 MCP server 是普通本地进程，所以这些限制写在本插件里：只允许 http/https、拒绝带用户名密码的 URL、拒绝回环/内网/链路本地（含 `169.254.169.254`）/CGNAT/组播/唯一本地地址（IPv4 与 IPv6 都判）、最多 5 次重定向，`fetch_page` 与搜索引擎的**每一跳都重新校验**、响应上限 2 MB、一次请求一个截止时间（覆盖所有跳与响应体）。引擎 Key 只发给配置里的那个源，跨源重定向时不带。
- 没有例外：`fetch_page` 的 URL 来自模型，搜索引擎的地址写死在代码里，两者每一跳都走上面的校验；重定向目标带用户名或密码时直接拒绝。插件配置里没有任何能让它去连接的地址。
- 搜索结果的正文与摘要是**不可信数据**，两个工具的描述里都写明了不要执行其中的指令。

## 已知限制

- **Bing 靠 HTML 解析**：结果页 class 改版就会返回 0 条（会被链自动跳过，不会伪装成「没有结果」）。`cn.bing.com` 还偶尔返回 200 但正文为空（从本机实测约六次一遇），遇到时同一地址会重试一次，所以 Bing 引擎一次尝试最多发两个请求。
- **匿名额度会限流**：Exa 曾长期 429、AnySearch 曾转付费档，链会自动回退；失败时 `attempts[].hint` 会提示填 Key。
- **`fetch_page` 不渲染 JS**：需要脚本渲染的页面只能拿到静态部分。
- **没有缓存**：每次调用都真实打到引擎。
- **让位靠描述引导**。内置 `WebSearch` / `WebFetch` 存在时（provider 命中 `api.anthropic.com`、`api.deepseek.com/anthropic`、`api.z.ai/api/anthropic`、`open.bigmodel.cn/api/anthropic`、`zcode.z.ai` 的 plan/highspeed 端点），两个工具的描述都让模型优先用内置的；但插件进程看不到会话的工具表，模型偶尔仍会选插件。要确定性就屏蔽一边：只想用插件时用会话级 `--disallowedTools WebSearch`，只想用内置时屏蔽 `mcp__plugin_websearch_search__web_search` 与 `mcp__plugin_websearch_search__fetch_page`。
- **升级不影响已开着的会话**。MCP 进程随会话启动，插件升级后要开新会话才用上新版——旧会话里跑的仍是旧的工具描述。
- **DNS rebinding 不在防护范围内**。校验用的解析与实际连接用的解析是两次，控制了域名解析的一方可以让两次结果不同；用全局 `fetch` 没有小改动能修掉。

## 开发与验证

```bash
node --check plugins/websearch/bin/server.mjs
node plugins/websearch/bin/server.mjs --self-test          # 离线解析器/配置/SSRF 断言
node --test plugins/websearch/tests/*.test.mjs             # 离线：网络层回归（重定向凭证、截止时间、字符集、守门、描述）
python plugins/websearch/tests/test-server.py              # 离线：MCP 握手、工具表、错误路径
python plugins/websearch/tests/test-server.py --live        # 追加真实引擎与网络守门测试
```

`--self-test`、`node --test` 与离线的 `test-server.py` 不发网络请求，可以随时跑；`--live` 需要出网，用来确认引擎是否仍然可用（Bing 解析失效时它会是第一个失败的用例）。

## 目录

```text
plugins/websearch/
├── .zcode-plugin/plugin.json   # 清单：mcpServers + userConfig
├── bin/server.mjs              # 全部实现，零依赖，Node 18+（全局 fetch）
├── commands/websearch.md       # /websearch 手动入口与单引擎排查
├── tests/test-server.py        # 离线 + --live 测试
├── tests/request.test.mjs      # node --test：网络层回归
└── README.md
```
