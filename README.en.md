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
| `plugins/git-workflow` | 0.1.5 | Git workflow: `/gcommit` conventional commits, `/gpr` PR descriptions, `/gchangelog` changelogs; a `PostToolUse` hook checks the message after each commit |
| `plugins/dev-workflow` | 0.5.0 | Development flow: 7 skills + `.devflow` / `docs/plans` plan files + `/handoff` session contract + a `SessionStart` repo snapshot + 22 specialist subagents auto-installed into `~/.zcode/agents` |
| `plugins/guardrails` | 0.2.0 | Deterministic safety hooks: `PreToolUse` gates that block irreversible commands and hardcoded credentials, and route deploys to a prompt; the prompt tier steps aside in full access mode, the blocks never do |
| `plugins/websearch` | 0.1.6 | Standalone web search: a zero-dependency MCP server chaining AnySearch, Exa, Parallel, Bing and SearXNG with automatic fallback, plus a static page reader. Keyless by default, per-engine keys optional |
| `plugins/model-speed` | 0.1.0 | Show current model output speed (tok/s) in the composer, per session, zero-dependency extension |

The four plugins are independent and can be enabled separately. `guardrails` blocks operations, so it is its own plugin and can be switched off on its own.

## Installation

**Option 1: GitHub marketplace (recommended, any machine)**

1. Open ZCode **Settings → Plugins**, click **Add marketplace** (top-right), choose the **GitHub** source
2. Enter the repo: `JochenYang/zcode-plugin` (public, no extra config needed)
3. Enable whichever of `git-workflow` / `dev-workflow` / `guardrails` you want
4. After enabling `dev-workflow`, the 22 subagents are automatically installed into `~/.zcode/agents` on the next session start

**Option 2: Local development directory**

1. **Settings → Plugins** → **Add marketplace**, enter this directory: `D:\codes\zcode-plugin`
2. Enable what you need from the personal section
3. After editing plugin code, refresh the marketplace panel. Note that the install cache is keyed by `<plugin>/<version>`, so **any change must also bump `version` in `plugin.json`** or the refresh keeps serving the old copy

## git-workflow

- `/gcommit` — runs the readiness check first (single responsibility / sensitive content / verification evidence / contract alignment), stages only after it passes, then generates a `<type>(<scope>): <subject>` message and commits after confirmation
- `/gcommit [scope]` — specify a scope (e.g. `auth`, `api`)
- `/gcommit --amend` — amend the last commit
- `/gcommit --no-add` — commit only what is already staged
- `/gpr [--base <branch>]` — PR description from the diff against the base branch (summary / grouped changes / verification / risks)
- `/gchangelog [--from <ref> --to <ref> | --count <n>] [--file <path>]` — changelog grouped by version tag; with `--file` it previews before merging into the file

The message is written with `git commit -F -` plus a heredoc so the blank line and bullet layout survive intact — repeated `-m` flags collapse each section into one unwrapped paragraph.

The `PostToolUse` hook only runs when the Bash call really was a `git commit` and HEAD is less than 120 seconds old. It checks the type/scope format, the 50-character limit and a trailing period, then reports in-session. It never blocks the commit.

## dev-workflow

7 flow skills covering the development lifecycle. They fire automatically when appropriate, or can be picked manually from the Skills group by typing `/`:

| Skill | When | Output |
|---|---|---|
| `change-plan` | before a feature/refactor/complex fix | executable plan + `.devflow/<slug>.md` (task-level acceptance basis); with a regression surface also `docs/plans/<slug>.md` (Work items / Phases gates / Test plan / Phase log) |
| `debug` | bug/test failure/build failure | iron rule: no fix before the root cause is established; reproduce → gather evidence → falsifiable hypotheses → root cause → minimal fix → regression check, with `git bisect`, boundary logging and a three-strikes stop; details in `references/` |
| `test-changed` | changes need verification | minimal valid test scope + evidence log + phase-gate verdict, writing Test plan results and Phase log back into the persistent plan |
| `review` | changes need review | P0–P3 findings with `path:line`, `introduced`/`pre-existing` and evidence level, a four-way verdict, stops after three unconverged rounds |
| `commit-review` | before committing | READY/NOT READY + proposed branch and message + Testing / Risk / How to revert (no actual commit) |
| `release-check` | before release/tag | GO/NO-GO/CONDITIONAL GO + blockers and unblock path (no actual release) |
| `doc-gen` | writing/updating docs | API docs / CHANGELOG / README / user docs / migration guides / feature map, every claim traceable to code |

Commands and hooks:

- `/handoff [save|show|clear]` — persists the **session-level** contract to `.zcode/handoff.md` so the goal and acceptance criteria survive compaction and new sessions; the **task-level** acceptance basis is written into the project by `change-plan` under `.devflow/`, and the task plan wins when both exist
- The `SessionStart` hook (`startup` / `clear` / `compact`) injects the branch, uncommitted file count, last 3 commits, the active plans under `.devflow/` and a `.zcode/handoff.md` summary, replacing the usual round of git calls at the start of a session
- On `startup`, a second hook auto-syncs the 22 specialist subagents into `~/.zcode/agents` (ZCode never loads agents from inside a plugin, so they must be copied out; it installs missing files, refreshes files it previously wrote, deletes files it previously wrote that the plugin no longer bundles, and skips anything the user has edited by hand). A subagent's `tools:` is a literal allow-list — a misspelled tool name means no such capability — and an agent that lists `WebFetch` also gets the host's read-only `mcp__web_reader__webReader`. A subagent's `description` is what the main model matches against when deciding whether to dispatch it — the listing carries only that plus its name and tools, and the separate trigger field Kimi reads does not exist in ZCode — so write it as role + trigger wording + hand-off to neighbouring agents + capability limits; the built-in `Explore` and `general-purpose` are not duplicated, code recon uses the built-in `Explore`
- `/agents-sync [diff|export|install]` — installation is automatic, so this is only for: `diff` comparing local vs bundled agents, `export` pushing hand-edited local agents back into the repo, `install` forcing an overwrite

Core mechanics: `change-plan` writes the plan and acceptance criteria to `.devflow/<slug>.md` (plus `docs/plans/<slug>.md` when the change has a regression surface), and all five downstream skills plus every subagent check against it; persistent plans track progress through Work item state transitions and phase gates, and a Gate row may only be written by `test-changed` after the verification ran. Each of the five downstream skills (`test-changed` / `review` / `commit-review` / `release-check` / `doc-gen`) closes with the same self-check: green commands are not satisfied acceptance, plausible is not evidence, and "I tested it" is hearsay — if any of the three fails, `commit-review` cannot be READY and `release-check` cannot be GO.

Recommended lifecycle: `change-plan → implement → test-changed → review → gcommit → release-check → doc-gen`

Pre-commit checks now live in `/gcommit`; `commit-review` is kept for the case where one batch of changes needs to become several commits.

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

`rm -rf node_modules`, `del /s /q .\dist`, `Remove-Item -Recurse .\build` and `rm -rf /d/codes/<this-project>/build` all pass without a prompt; `rm -rf ../another-project` and `Remove-Item -Recurse D:\codes\other` ask once. `git rm` only touches tracked files inside the repository, so it is left to git and never judged here.

Design notes:

- Only newly written text is scanned (`content` / `new_string`), **never `old_string`** — otherwise replacing a hardcoded secret with an env lookup would be blocked by the very secret it removes
- Escape hatch: `.zcode/guardrails-allow` in the project root, one ERE per line, a match passes the command through (`#` starts a comment). For a project that genuinely runs `terraform apply`, add `^terraform apply`
- A check takes about 8ms; both hooks run inline and block

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

- Engine chain `anysearch → exa → parallel → bing → searxng`, moving on when an engine fails or returns nothing; one deadline covers the whole call (20s default) and engines left unrun are reported in `skipped`
- **Usable without any key**: empty key means the engine's free tier; when a quota runs out `attempts[].hint` says so. The current ZCode build has **no configuration form** on the plugin detail page, so keys and engine order live in `$ZCODE_PLUGIN_DATA/websearch.json` (i.e. `~/.zcode/cli/plugins/data/websearch@zcode-plugin/websearch.json`); the ambient `ANYSEARCH_API_KEY` / `EXA_API_KEY` / `PARALLEL_API_KEY` variables work too (the file wins)
- Settings: engine order, disabled list, fallback/rotate, default limit, total timeout, Bing market, SearXNG instances and the three optional keys; the manifest also declares `userConfig`, so once ZCode grows a configuration form this plugin picks it up with no changes
- The tool descriptions carry the routing rule: search first for anything current (weather, news, prices), and only call `fetch_page` for a URL you already have
- The safety boundary lives in this plugin's own code: http/https only, loopback/private/link-local (including cloud metadata)/CGNAT/ULA refused, every redirect hop re-checked, 2 MB response ceiling, request timeouts — an MCP server is an ordinary local process with no host gatekeeper
- Manual entry point: `/websearch <query> [--engine bing]`, the quickest way to check one engine
- It neither conflicts with nor replaces the built-in `WebSearch`: that one relies on the model provider's server-side search and only exists for specific provider endpoints, while this plugin works under any provider

Engine table, settings detail, safety boundary and known limits: `plugins/websearch/README.md`.

## Checks

Two dependency-free checks ship with the repo (Python 3.8+ and bash). Run them after changing a plugin:

```bash
python scripts/check-consistency.py             # versions, agent count, frontmatter, agent descriptions, references, line endings, shell syntax
python plugins/guardrails/tests/test-hooks.py   # verdict matrices for both hooks, 116 cases including the permission-mode dimension
python plugins/websearch/tests/test-server.py   # the websearch MCP server (add --live to hit the real network)
python plugins/dev-workflow/tests/test-sync-agents.py  # the subagent sync hook: refresh, protect local edits, clean up dropped agents, read legacy state
```

`check-consistency.py` catches the drift a human review keeps missing: a version bumped in one place only, an agent count that no longer matches the prose, a frontmatter key ZCode does not read, a reference to a missing file, a leftover mention of a removed mechanism, an agent description that hands off to an agent that does not exist or collides with a built-in type. `test-hooks.py` pins every verdict of both hooks — it drives the real hook process, not a mock — so a rule change that alters an unrelated verdict fails immediately. Nothing is wired to CI yet.

## References

- Official plugin docs: <https://zcode.z.ai/cn/docs/plugin>
- Hook mechanics and debugging: the `diagnosing-hooks` skill from the local `zcode-guide` plugin



