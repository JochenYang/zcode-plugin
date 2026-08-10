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
| `plugins/git-workflow` | 0.1.3 | Git workflow: `/gcommit` conventional commits, `/gpr` PR descriptions, `/gchangelog` changelogs; a `PostToolUse` hook checks the message after each commit |
| `plugins/dev-workflow` | 0.3.0 | Development flow: 7 skills (plan/debug/test/review/commit/release/docs) + `/handoff` contract persistence + a `SessionStart` repo snapshot + 16 specialist subagents auto-installed into `~/.zcode/agents` |
| `plugins/guardrails` | 0.1.0 | Deterministic safety hooks: `PreToolUse` gates that block irreversible commands and hardcoded credentials, and route deploys to a prompt |

The four plugins are independent and can be enabled separately. `guardrails` blocks operations, so it is its own plugin and can be switched off on its own.

## Installation

**Option 1: GitHub marketplace (recommended, any machine)**

1. Open ZCode **Settings → Plugins**, click **Add marketplace** (top-right), choose the **GitHub** source
2. Enter the repo: `JochenYang/zcode-plugin` (public, no extra config needed)
3. Enable whichever of `git-workflow` / `dev-workflow` / `guardrails` you want
4. After enabling `dev-workflow`, the 16 subagents are automatically installed into `~/.zcode/agents` on the next session start

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
| `change-plan` | before a feature/refactor/complex fix | executable plan + Handoff contract (the acceptance contract later skills check against) |
| `debug` | bug/test failure/build failure | reproduce → isolate → hypothesize → verify → minimal fix; supports diagnose/fix/verify intent |
| `test-changed` | changes need verification | minimal valid test scope + evidence log + Anti-rationalization check (AR-1~10 SSOT) |
| `review` | changes need review | P0–P3 findings with `path:line` and evidence level |
| `commit-review` | a batch needs splitting into several commits | READY/NOT READY + proposed branch and message (no actual commit) |
| `release-check` | before release/tag | GO/NO-GO/CONDITIONAL GO + blockers and unblock path (no actual release) |
| `doc-gen` | writing/updating docs | API docs / CHANGELOG / README / user docs / migration guides, every claim traceable to code |

Commands and hooks:

- `/handoff [save|show|clear]` — persists the session Handoff contract to `.zcode/handoff.md` so the goal and acceptance criteria survive compaction and new sessions
- The `SessionStart` hook (`startup` / `clear` / `compact`) injects the branch, uncommitted file count, last 3 commits and a `.zcode/handoff.md` summary, replacing the usual round of git calls at the start of a session
- On `startup`, a second hook auto-syncs the 16 specialist subagents into `~/.zcode/agents` (ZCode never loads agents from inside a plugin, so they must be copied out; it installs missing files, refreshes files it previously wrote, and skips anything the user has edited by hand)
- `/agents-sync [diff|export|install]` — installation is automatic, so this is only for: `diff` comparing local vs bundled agents, `export` pushing hand-edited local agents back into the repo, `install` forcing an overwrite

Core mechanics: `change-plan` produces the Handoff contract and `/handoff save` persists it; `test-changed` is the SSOT for Anti-rationalization (AR-1~10) and Contract resolution (explicit-handoff → user-pinned → rebuilt-from-context → unavailable); conclusions are hard-gated: AR `FAIL` → commit-review cannot be READY, release-check cannot be GO.

Recommended lifecycle: `change-plan → implement → test-changed → review → gcommit → release-check → doc-gen`

Pre-commit checks now live in `/gcommit`; `commit-review` is kept for the case where one batch of changes needs to become several commits.

## guardrails

Two `PreToolUse` hooks — the only constraint in this collection that does not depend on the model policing itself.

**`deny` (hard block, the model receives the reason)** — irreversible with no undo path:

- `rm` aimed at a root-ish target (`/`, `~`, `.`, `..`, `*`), a system directory, or a credential directory such as `~/.ssh` or `~/.aws`
- `git push --force` (`--force-with-lease` passes), `reset --hard`, `clean -fd`, `filter-branch`/`filter-repo`, remote branch deletion
- `DROP TABLE/DATABASE/SCHEMA`, `TRUNCATE`
- `mkfs*`/`fdisk`/`parted`, `dd of=/dev/*`, redirecting into a raw block device, `chmod 777 /`
- Written text containing a real credential shape: AWS `AKIA…`, private key blocks, GitHub `ghp_`/`github_pat_`, GitLab `glpat-`, Slack `xox*`, Stripe `sk_live_`, Google `AIza…`, OpenAI `sk-…`

**`ask` (turned into a confirmation prompt)** — reversible but costly:

- `rm` reaching outside the project: an absolute path not under the project, a `../` escape, anything under `~/`, or an unexpanded variable (`/tmp` and `/var/tmp` pass)
- `git checkout .`/`restore .` (discards every local modification at once), `commit --amend`, `rebase` (`--continue`/`--abort`/`--skip` pass), pushes to `main`/`master`/`prod`, `git tag`
- `sudo`, `curl … | sh`
- `UPDATE`/`DELETE FROM` that may lack a WHERE clause, migration commands across ecosystems
- `npm/cargo/gem/twine publish`, `docker push`, `terraform apply|destroy`, `kubectl`, `helm`, `vercel --prod`, cloud CLI delete/terminate
- Writes to `.env*` (`.env.example`/`.template`/`.sample` pass), `id_rsa`, `*.pem`, `.npmrc`, `credentials`, `secrets.*`
- Secret-looking assignments (a 20+ character literal assigned to `password`/`secret`/`api_key`), JWTs

Deletes are judged by **location**, not by command shape, so cleaning up inside the project never interrupts:

| Target | Verdict |
|---|---|
| Inside the project (relative path, or an absolute path under the project directory) | passes silently |
| `/tmp`, `/var/tmp` | passes silently |
| Outside the project (absolute path elsewhere, `../` escape, `~/…`, unexpanded variable) | `ask` |
| Root-ish, system, or credential directories | `deny` |

`rm -rf node_modules`, `rm -rf build dist`, `rm -rf src/generated` and `rm -rf /d/codes/<this-project>/build` all pass without a prompt; `rm -rf ../another-project` asks once.

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

## References

- Official plugin docs: <https://zcode.z.ai/cn/docs/plugin>
- Hook mechanics and debugging: the `diagnosing-hooks` skill from the local `zcode-guide` plugin



