<h1 align="center">zcode-plugin</h1>

<div align="center">

[中文](README.md) | [English](README.en.md)

</div>

<p align="center">
  <a href="https://github.com/JochenYang/zcode-plugin"><img src="https://img.shields.io/badge/ZCode-Plugin-4A90D9?style=for-the-badge" alt="ZCode Plugin"></a>
  <a href="https://github.com/JochenYang/zcode-plugin/releases"><img src="https://img.shields.io/github/v/release/JochenYang/zcode-plugin?style=for-the-badge" alt="Version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/JochenYang/zcode-plugin?style=for-the-badge" alt="License"></a>
  <a href="https://github.com/JochenYang/zcode-plugin/stargazers"><img src="https://img.shields.io/github/stars/JochenYang/zcode-plugin?style=for-the-badge" alt="Stars"></a>
</p>

Personal ZCode plugin marketplace. Each plugin lives in its own directory following the official convention (`.zcode-plugin/plugin.json` + component directories).

## Plugins

| Plugin | Version | Description |
|---|---|---|
| `plugins/git-conventions` | 0.1.0 | Commit message guard: a `PreToolUse` hook validates the message a `git commit` writes before git runs (subject format and the 50-character limit, body as `-` bullets ending with a `Verified:` line) and denies a non-compliant one |
| `plugins/dev-workflow` | 0.7.0 | Development flow: 7 skills + `.devflow` / `docs/plans` plan files + a gated multi-round review protocol + `/handoff` session contract + a `SessionStart` repo snapshot + 22 specialist subagents auto-installed into `~/.zcode/agents` |
| `plugins/guardrails` | 0.2.1 | Deterministic safety hooks: `PreToolUse` gates that block irreversible commands and hardcoded credentials, and route deploys to a prompt; the prompt tier steps aside in full access mode, the blocks never do |
| `plugins/websearch` | 0.2.0 | Standalone web search: a zero-dependency MCP server chaining AnySearch, Exa, Parallel and Bing with automatic fallback, plus a static page reader. Keyless by default, per-engine keys optional |
| `plugins/model-speed` | 0.1.0 | Show current model output speed (tok/s) in the composer, per session, zero-dependency extension |
| `plugins/codegraph` | 0.1.0 | Local code graph: a zero-dependency MCP server keeping a tree-sitter index of 35 language rows in SQLite under the plugin data folder; `codegraph_status` / `codegraph_lookup` / `codegraph_map` return exact `file:line` ranges; the index is built or refreshed silently when a session opens, and `SessionStart` / `UserPromptSubmit` / `PostToolUse` hooks tell the model when the graph is ready and when to use it; no telemetry, no network, no project code execution |

The plugins are independent and can be enabled separately. `guardrails` blocks operations, so it is its own plugin and can be switched off on its own.

## Installation

**Option 1: GitHub marketplace (recommended, any machine)**

1. Open ZCode **Settings → Plugins**, click **Add marketplace** (top-right), choose the **GitHub** source
2. Enter the repo: `JochenYang/zcode-plugin` (public, no extra config needed)
3. Enable whichever of `git-conventions` / `dev-workflow` / `guardrails` you want
4. After enabling `dev-workflow`, the 22 subagents are automatically installed into `~/.zcode/agents` on the next session start

**Option 2: Local development directory**

1. **Settings → Plugins** → **Add marketplace**, enter this directory: `D:\codes\zcode-plugin`
2. Enable what you need from the personal section
3. After editing plugin code, refresh the marketplace panel. Note that the install cache is keyed by `<plugin>/<version>`, so **any change must also bump `version` in `plugin.json`** or the refresh keeps serving the old copy

## git-conventions

Stops a non-compliant commit message before git records it. A `PreToolUse` hook on Bash: when a command carries a `git commit` that writes a new message, the hook extracts the message, checks it against the convention and denies the call with the reason, so git never runs. Unlike a reminder after the fact, it does not depend on the model going back to fix anything.

| Part | Requirement |
|---|---|
| Subject | `<type>(<scope>): <subject>` with type one of `feat` `fix` `docs` `style` `refactor` `perf` `test` `chore` `build` `ci` `revert`, an optional scope and an optional `!` before the colon for a breaking change; English, lowercase first letter, no trailing period, at most 50 characters |
| Body (optional) | one `- ` bullet per change, indented continuation lines aside; ends with a `Verified: <what was run>` line, which may wrap. A trailer such as `Co-authored-by:` is not a bullet and is denied |

- Recognised forms: `-m "…"` (one or more), `-F <file>`, `-F -` fed by a heredoc or a here-string; `cd … &&`, `git -C <dir>`, clusters such as `-am`; a commit inside `if`, `for`, `sudo`, `eval` or a subshell; a variable assigned earlier on the same line (`MSG="…"; git commit -m "$MSG"`) and `"$(cat <<'MSG' … MSG)"`. Paths resolve the way the shell would: relative ones against the directory after `cd` or `git -C`, and Git Bash's `/d/…` and `~` are understood.
- Not judged: a commit that writes no new message (a bare `git commit`, which never takes its message from stdin, `--amend --no-edit`, `-C`, `--fixup`); a message that still holds a variable or command substitution this hook cannot resolve; an `-F` file that cannot be read; a script fed to `bash`/`sh` and anything behind `xargs`. A convention guard must never be the reason a commit fails, so these all pass.
- Merge and revert commits never go through `git commit` and are not judged. `--no-verify` does not bypass it: that switch belongs to git's own hooks.
- It only applies to commits made through ZCode's Bash tool; a terminal or IDE commit does not pass through it. Full access mode does not turn it off either.
- It needs Node 14 or later on PATH. Hooks get no built-in fallback, so without it the hook silently does not run.
- "English imperative" cannot be checked mechanically; only the lowercase first letter is.

## dev-workflow

7 flow skills covering the development lifecycle. They fire automatically when appropriate, or can be picked manually from the Skills group by typing `/`:

| Skill | When | Output |
|---|---|---|
| `change-plan` | before a feature/refactor/complex fix | executable plan + `.devflow/<slug>.md` (task-level acceptance basis); with a regression surface also `docs/plans/<slug>.md` (Work items / Phases gates / Test plan / Phase log) |
| `debug` | bug/test failure/build failure | iron rule: no fix before the root cause is established; reproduce → gather evidence → falsifiable hypotheses → root cause → minimal fix → regression check, with `git bisect`, boundary logging and a three-strikes stop; details in `references/` |
| `test-changed` | changes need verification | minimal valid test scope + evidence log + phase-gate verdict, writing Test plan results and Phase log back into the persistent plan |
| `review` | changes need review | P0–P3 findings with `path:line`, `introduced`/`pre-existing` and evidence level, a four-way verdict, stops after three unconverged rounds; from the second round on, or for high-risk changes, the gated convergence protocol (`review-gate.mjs`) applies |
| `commit-review` | before committing | READY/NOT READY + proposed branch and message + Testing / Risk / How to revert (no actual commit) |
| `release-check` | before release/tag | GO/NO-GO/CONDITIONAL GO + blockers and unblock path (no actual release) |
| `doc-gen` | writing/updating docs | API docs / CHANGELOG / README / user docs / migration guides / feature map, every claim traceable to code |

Commands and hooks:

- `/handoff [save|show|clear]` — persists the **session-level** contract to `.zcode/handoff.md` so the goal and acceptance criteria survive compaction and new sessions; the **task-level** acceptance basis is written into the project by `change-plan` under `.devflow/`, and the task plan wins when both exist
- The `SessionStart` hook (`startup` / `clear` / `compact`) injects the branch, uncommitted file count, last 3 commits, the active plans under `.devflow/` and a `.zcode/handoff.md` summary, replacing the usual round of git calls at the start of a session
- On `startup`, a second hook auto-syncs the 22 specialist subagents into `~/.zcode/agents` (ZCode never loads agents from inside a plugin, so they must be copied out; it installs missing files, refreshes files it previously wrote, deletes files it previously wrote that the plugin no longer bundles, and skips anything the user has edited by hand). A subagent's `tools:` is a literal allow-list — a misspelled tool name means no such capability — and an agent that lists `WebFetch` also gets the host's read-only `mcp__web_reader__webReader`. A subagent's `description` is what the main model matches against when deciding whether to dispatch it — the listing carries only that plus its name and tools, and the separate trigger field Kimi reads does not exist in ZCode — so write it as role + trigger wording + hand-off to neighbouring agents + capability limits; the built-in `Explore` and `general-purpose` are not duplicated, code recon uses the built-in `Explore`
- `/agents-sync [diff|export|install]` — installation is automatic, so this is only for: `diff` comparing local vs bundled agents, `export` pushing hand-edited local agents back into the repo, `install` forcing an overwrite

Core mechanics: `change-plan` writes the plan and acceptance criteria to `.devflow/<slug>.md` (plus `docs/plans/<slug>.md` when the change has a regression surface), and all five downstream skills plus every subagent check against it; persistent plans track progress through Work item state transitions and phase gates, and a Gate row may only be written by `test-changed` after the verification ran. Each of the five downstream skills (`test-changed` / `review` / `commit-review` / `release-check` / `doc-gen`) closes with the same self-check: green commands are not satisfied acceptance, plausible is not evidence, and "I tested it" is hearsay — if any of the three fails, `commit-review` cannot be READY and `release-check` cannot be GO.

Multi-round review convergence: once a review reaches its second round, or the change is high risk, `reviewer` only produces findings and evidence, the main session verifies each one and writes its decision to `.devflow/<slug>/review-<round>.json`, and `scripts/review-gate.mjs` decides `converged` / `needs_user_confirmation` / `stop_max_rounds` / `continue` through eight gates. When a state file exists, `commit-review` only passes once the latest round is `converged`.

Recommended lifecycle: `change-plan → implement → test-changed → review → commit → release-check → doc-gen`

The pre-commit change check is the `commit-review` skill; the commit message itself is validated by the `git-conventions` plugin's hook before git runs.

## guardrails

Two `PreToolUse` hooks — the only constraint in this collection that does not depend on the model policing itself.

**`deny` (hard block, the model receives the reason)** — irreversible with no undo path:

- `rm` aimed at a root-ish target (`/`, `~`, `.`, `..`, `*`), a system directory, or a credential directory such as `~/.ssh` or `~/.aws`
- `git push --force` (`--force-with-lease` passes), `reset --hard`, `clean -fd`, `filter-branch`/`filter-repo`, remote branch deletion
- `DROP TABLE/DATABASE/SCHEMA`, `TRUNCATE`
- `mkfs*`/`fdisk`/`parted`, `dd of=/dev/*`, redirecting into a raw block device, `chmod 777 /`
- Disk-level Windows commands: `format C:`, `Format-Volume`, `diskpart`, `Clear-Disk`, `Initialize-Disk`
- Written text containing a real credential shape: AWS `AKIA…`, private key blocks, GitHub `ghp_`/`github_pat_`, GitLab `glpat-`, Slack `xox*`, Stripe `sk_live_`, Google `AIza…`, OpenAI `sk-…`

**`ask` (turned into a confirmation prompt)** — reversible but costly:

- A delete verb reaching outside the project: an absolute path not under the project, a `../` escape, anything under `~/`, or an unexpanded variable (`/tmp` and `/var/tmp` pass)
- `git checkout .`/`restore .` (discards every local modification at once), `commit --amend`, `rebase` (`--continue`/`--abort`/`--skip` pass), pushes to `main`/`master`/`prod`, `git tag`
- `sudo`, `curl … | sh`
- `UPDATE`/`DELETE FROM` that may lack a WHERE clause, migration commands across ecosystems, `reg delete`
- `npm/cargo/gem/twine publish`, `docker push`, `terraform apply|destroy`, `kubectl`, `helm`, `vercel --prod`, cloud CLI delete/terminate
- Writes to `.env*` (`.env.example`/`.template`/`.sample` pass), `id_rsa`, `*.pem`, `.npmrc`, `credentials`, `secrets.*`
- Secret-looking assignments (a 20+ character literal assigned to `password`/`secret`/`api_key`), JWTs

The `ask` tier only exists in modes that confirm at all. ZCode passes the session's permission mode to the hook: in **full access** (`yolo`) every `ask` above passes silently — otherwise pushes to the main branch, tags and publishing would keep prompting even with full access on, because ZCode applies a hook's confirmation on top of the permission mode — while `deny` holds in every mode, and **deny beats ask**: a command or a write that contains both is denied outright instead of asking first and then running the whole line. Autonomous mode (`guarded`), the default modes and older builds that do not send the field still ask.

Deletes are judged by **location**, not by command shape, so cleaning up inside the project never interrupts. `rm`, cmd's `del`/`rd`/`rmdir` and PowerShell's `Remove-Item` all run through the same position check:

| Target | Verdict |
|---|---|
| Inside the project (relative path, or an absolute path under the project directory) | passes silently |
| `/tmp`, `/var/tmp` | passes silently |
| Outside the project (absolute path elsewhere, `../` escape, `~/…`, `$env:…`, unexpanded variable) | `ask` |
| Root-ish, a drive root (`C:\`, `C:/*`), system, or credential directories | `deny` |

`rm -rf node_modules`, `del /s /q .\dist`, `Remove-Item -Recurse .\build` and `rm -rf /d/codes/<this-project>/build` all pass without a prompt; `rm -rf ../another-project` and `Remove-Item -Recurse D:\codes\other` ask once. `git rm` only touches tracked files inside the repository, so it is left to git and never judged here. A `;`, `&&` or line break is a command separator whether or not it is surrounded by spaces, and a tab counts as a space: the delete before it ends there, and what follows is judged by its own rules (a `git push --force` on the line after a `cd` is denied as well). A find that ends in `-delete` or `-exec rm …`, or feeds `| xargs rm …`, is judged by its starting points. With a filter ahead of the deleting action only a dangerous position counts (`find . -name "*.log" -delete` passes, `find /etc -type f -delete` is denied); without one the starting point is the target (`find . -delete` is `rm -rf .` and is denied). git clean is read flag by flag: force together with the directory or ignored-files flag is denied, a dry run or an interactive run is not. A separator made a literal by a backslash (`find … -exec … \;`, `grep "a\|b"`) is not a command separator. The body of a here-document is checked line by line and quotes are not parsed (`echo 'rm -rf /'` is denied) — both are deliberate, because the body is often the script or the commit message that runs next. To write a text that merely mentions such a command, use the Write tool (not subject to this rule) or the escape hatch.

Design notes:

- Only newly written text is scanned (`content` / `new_string`), **never `old_string`** — otherwise replacing a hardcoded secret with an env lookup would be blocked by the very secret it removes
- Escape hatch: `.zcode/guardrails-allow` in the project root, one ERE per line, a match passes the command through (`#` starts a comment). For a project that genuinely runs `terraform apply`, add `^terraform apply`
- Both hooks run inline and block. Nothing starts a process where bash alone can do the job: a tier with no hit costs one `grep`, and the payload fields, quote stripping and drive letters are handled by bash. Measured on Windows: about 150ms per Bash call and 240ms per write, from about 1300ms and 730ms (about 300ms when a rule asks for confirmation)

## Developing a new plugin

```text
plugins/<plugin-name>/
├── .zcode-plugin/plugin.json   # required manifest; name must match ^[a-z0-9][a-z0-9._-]{0,127}$
├── commands/*.md               # slash commands; the name comes from the filename, subdirs join with :
├── skills/<name>/SKILL.md      # skills; the filename casing must be exact
├── hooks/hooks.json            # hooks; loaded by convention, no manifest entry needed
└── .mcp.json                   # MCP servers
```

Then append an entry to the `plugins` array in `marketplace.json` (`name` + `source` required; `version`/`category`/`tags`/`icon` recommended).

Pitfalls worth writing down instead of rediscovering:

- **Only `commands`/`skills`/`hooks`/`mcpServers` are executed.** Declaring `agents`/`outputStyles`/`settings`/`lspServers` produces a warning and does nothing
- `marketplace.json` belongs in the repo root or `.claude-plugin/`. There is **no** `.zcode-plugin/marketplace.json` location
- SKILL.md frontmatter reads only `name`/`description`/`when_to_use`/`license`/`metadata`. `description` allows 1024 characters but is truncated to roughly 250 when shown to the model, so put the trigger wording first
- Command frontmatter reads only `description`/`argument-hint`/`allowed-tools`/`model`/`skills`/`disable-noninteractive`. Lists must be single-line comma form, and `disable-model-invocation` does not exist in ZCode
- There are exactly 7 hook events: `SessionStart`/`UserPromptSubmit`/`PreToolUse`/`PermissionRequest`/`PostToolUse`/`PostToolUseFailure`/`Stop`
- Hook output uses a strict schema — **one extra key discards the whole payload**. `async` has no effect, hooks always block. For cross-platform safety prefer `type: "process"` with `args[]` and `${ZCODE_PLUGIN_ROOT}` paths
- Shell scripts must stay LF (enforced here by `.gitattributes`); CRLF fails under any non-MSYS bash

## websearch

A standalone search plugin with its own zero-dependency MCP server (`bin/server.mjs`, Node 18+ global fetch, no node_modules). It exposes `web_search` and `fetch_page`; the model sees them as `mcp__plugin_websearch_search__web_search` / `mcp__plugin_websearch_search__fetch_page`.

- Engine chain `anysearch → exa → parallel → bing`, moving on when an engine fails or returns nothing; one deadline covers the whole call (20s default) and engines left unrun are reported in `skipped`
- **Usable without any key**: empty key means the engine's free tier; when a quota runs out `attempts[].hint` says so. The current ZCode build has **no configuration form** on the plugin detail page, so keys and engine order live in `$ZCODE_PLUGIN_DATA/websearch.json` (i.e. `~/.zcode/cli/plugins/data/websearch@zcode-plugin/websearch.json`); the ambient `ANYSEARCH_API_KEY` / `EXA_API_KEY` / `PARALLEL_API_KEY` variables work too (the file wins)
- Settings: engine order, disabled list, fallback/rotate, default limit, total timeout, Bing market and the three optional keys; the manifest also declares `userConfig`, so once ZCode grows a configuration form this plugin picks it up with no changes
- The tool descriptions carry the routing rule: the built-in `WebSearch` / `WebFetch` go first when they exist and this plugin is the fallback (`fetch_page` also when you need the page text itself rather than the `WebFetch` summary); search before fetching when the URL is not known yet
- The safety boundary lives in this plugin's own code: http/https only, loopback/private/link-local (including cloud metadata)/CGNAT/ULA refused, every redirect hop re-checked, engine keys never follow a cross-origin redirect, 2 MB response ceiling, one deadline per request covering every hop and the body — an MCP server is an ordinary local process with no host gatekeeper
- Manual entry point: `/websearch <query> [--engine bing]`, the quickest way to check one engine
- It neither conflicts with nor replaces the built-in `WebSearch`: that one relies on the model provider's server-side search and only exists for specific provider endpoints, while this plugin works under any provider

Engine table, settings detail, safety boundary and known limits: `plugins/websearch/README.md`.

## codegraph

A local code-graph plugin with its own zero-npm-dependency MCP server (`bin/server.mjs`, `node:sqlite` plus bundled tree-sitter wasm, no node_modules). The model sees the tools as `mcp__plugin_codegraph_codegraph__codegraph_status` / `__codegraph_lookup` / `__codegraph_map`.

- **35 language rows** (33 symbol-extracting packs plus COBOL and Liquid at file level) covering TypeScript/JavaScript, Python, Go, Rust, C/C++, Java/Kotlin/Scala, C#/VB.NET, PHP/Ruby, Vue/Svelte/Astro, Terraform, Solidity and more; every grammar wasm ships in the box, provenance and licences in `plugins/codegraph/THIRD-PARTY-NOTICES.md`
- `codegraph_lookup` (search / symbol / callers / callees / impact / outline) returns one symbol per line with exact line ranges, replacing the "grep once, read the whole file once" loop; `codegraph_map` replaces Glob plus reading file heads; relations carry confidence marks — `=` import-resolved, `~` unique-name, `?` unresolved or dynamic
- The index lives in `~/.zcode/cli/plugins/data/codegraph@zcode-plugin/indexes/<project key>/` and nothing is written inside the project; qualifying projects (`autoIndex` on, ≥ 30 supported files, ≤ 30000 files, not a home or drive root) start building in the background **when the session opens** (the work begins with the MCP handshake, before the model calls anything), and an indexed project is checked for changes and synced at the same time; `codegraph_status` reports progress and stale files
- Later changes are picked up **silently and lazily**: the file watcher (2 s debounce), the `PostToolUse` hook and an mtime scan before each call only mark the changed files dirty; they are parsed again **right before the next codegraph tool call** (under 200 files sync in the foreground, more go to a background build). Without a tool call nothing is re-parsed and the model is not told
- All three hooks are accelerators only: `SessionStart` (startup/resume/clear/compact/fork) injects ≤ 120 tokens of index status plus "when to use the graph, when to use Grep"; `UserPromptSubmit` announces an index that became ready mid-session, once per session; `PostToolUse` (Edit/Write, ApplyPatch via the host alias) appends one line to `dirty.log` only when the index directory already exists and never creates it. Without the hooks the server's mtime scan keeps the index correct
- **Node ≥ 22.13**. The MCP side has ZCode's built-in Node fallback (Electron's Node 22.22.1); **the hooks resolve `node` from PATH only** — without it they fail silently and the index stays correct
- Config file `~/.zcode/cli/plugins/data/codegraph@zcode-plugin/codegraph.json` (`autoIndex` / `minFilesToAutoIndex` / `maxFiles` / `exclude` / `languages`), with `CODEGRAPH_AUTO_INDEX` / `CODEGRAPH_MIN_FILES` / `CODEGRAPH_MAX_FILES` / `CODEGRAPH_EXCLUDE` applying only when the file leaves the field unset; manual entry point `/codegraph [refresh]`
- Known limits: COBOL and Liquid are file-level only; `getattr`, dynamic imports and reflection produce no edges; the first build runs in the background and results are partial meanwhile

Tool parameters, config keys, the language table, privacy and limits: `plugins/codegraph/README.md`.

## Checks

Two dependency-free checks ship with the repo (Python 3.8+ and bash). Run them after changing a plugin:

```bash
python scripts/check-consistency.py             # versions, agent count, frontmatter, agent descriptions, references, line endings, shell syntax
python plugins/guardrails/tests/test-hooks.py   # verdict matrices for both hooks, 198 cases including the permission-mode dimension
python plugins/websearch/tests/test-server.py   # the websearch MCP server (add --live to hit the real network)
node --test plugins/websearch/tests/*.test.mjs  # the websearch network layer: engine keys never follow a cross-origin redirect, the deadline covers the body, GBK decoding, the descriptions defer to the built-ins
node --test plugins/git-conventions/tests/*.test.mjs  # the commit message hook: recognised command forms, every rule, and passing on what cannot be read
python plugins/dev-workflow/tests/test-sync-agents.py  # the subagent sync hook: refresh, protect local edits, clean up dropped agents, read legacy state
python plugins/dev-workflow/tests/test-review-gate.py  # the multi-round review gate: eight gates, cross-checks between fields, and the exit codes of an invalid state (needs node)
node --test plugins/codegraph/tests/hooks/*.test.mjs  # the codegraph hooks: real spawn, SessionStart text/schema, dirty.log protocol, hooks.json fields
```

`check-consistency.py` catches the drift a human review keeps missing: a version bumped in one place only, an agent count that no longer matches the prose, a frontmatter key ZCode does not read, a reference to a missing file, a leftover mention of a removed mechanism, an agent description that hands off to an agent that does not exist or collides with a built-in type. `test-hooks.py` pins every verdict of both hooks — it drives the real hook process, not a mock — so a rule change that alters an unrelated verdict fails immediately. Nothing is wired to CI yet.

## References

- Official plugin docs: <https://zcode.z.ai/cn/docs/plugin>
- Hook mechanics and debugging: the `diagnosing-hooks` skill from the local `zcode-guide` plugin



