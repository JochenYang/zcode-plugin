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
| `plugins/git-workflow` | 0.1.1 | Git workflow: `/gcommit` conventional commits, `/gpr` PR descriptions, `/gchangelog` changelogs; a `PostToolUse` hook validates commit format |
| `plugins/dev-workflow` | 0.1.0 | 7 daily development workflow skills: planning, debugging, testing, review, commit review, release check, doc generation |

## Installation

**Option 1: GitHub marketplace (recommended, any machine)**

1. Open ZCode **Settings → Plugins**, click **Add marketplace** (top-right)
2. Choose the **GitHub** source and enter: `JochenYang/zcode-plugin` (public repo, no extra config needed)
3. Find `git-workflow` in the list and **enable** it

**Option 2: Local development directory**

1. Open ZCode **Settings → Plugins**, click **Add marketplace** (top-right)
2. Enter this directory: `D:\codes\zcode-plugin`
3. Find `git-workflow` and **enable** it
4. After modifying plugin code, refresh the marketplace panel to apply changes

## Plugin icon

- The plugin icon is referenced by the `icon` field in `marketplace.json`: `https://static.geluman.cn/icon/icon.png`
- To change it, replace the file on the CDN (a local marketplace just needs a panel refresh)

## git-workflow usage

- `/gcommit` — analyzes staged/unstaged changes, generates a `<type>(<scope>): <subject>` message, commits after user confirmation
- `/gcommit [scope]` — specify a scope (e.g. `auth`, `api`)
- `/gcommit --amend` — amend the last commit
- `/gcommit --no-add` — commit only what is already staged
- `/gpr [--base <branch>]` — generates a PR description from the diff between the current and base branches (summary / grouped changes / verification / risks)
- `/gchangelog [--from <ref> --to <ref> | --count <n>] [--file <path>]` — generates a changelog grouped by version tag; with `--file` it merges into the file after a preview confirmation

A hook validates the message format after each commit; non-compliant messages trigger a reminder in the session (never blocks the commit).

## dev-workflow usage

7 flow skills covering the daily development lifecycle. They fire automatically when appropriate, or can be picked manually from the 技能 group by typing `/`:

| Skill | When | Output |
|---|---|---|
| `change-plan` | before a feature/refactor/complex fix | executable plan + Handoff contract (the acceptance contract later skills check against) |
| `debug` | bug/test failure/build failure | reproduce → isolate → hypothesize → verify → minimal fix; supports diagnose/fix/verify intent |
| `test-changed` | changes need verification | minimal valid test scope + evidence log + Anti-rationalization check (AR-1~10 SSOT) |
| `review` | changes need review | P0–P3 findings with `path:line` and evidence level |
| `commit-review` | before committing | READY/NOT READY + proposed branch name and commit message (no actual commit) |
| `release-check` | before release/tag | GO/NO-GO/CONDITIONAL GO + blockers and unblock path (no actual release) |
| `doc-gen` | writing/updating docs | API docs / CHANGELOG / README / user docs / migration guides, every claim traceable to code |

Core mechanics: `change-plan` produces a Handoff contract (in-session acceptance contract, not persisted); `test-changed` is the SSOT for Anti-rationalization (AR-1~10) and Contract resolution (explicit-handoff → user-pinned → rebuilt-from-context → unavailable), referenced by the other skills; conclusions are hard-gated: AR `FAIL` → commit-review cannot be READY, release-check cannot be GO.

Recommended lifecycle: `change-plan → implement → test-changed → review → commit-review → release-check → doc-gen`

## Developing a new plugin

```text
plugins/<plugin-name>/
├── .zcode-plugin/plugin.json   # required: plugin manifest
├── commands/*.md               # slash commands (frontmatter + $ARGUMENTS)
├── skills/*/SKILL.md           # skills
├── agents/*.md                 # subagents
├── hooks/hooks.json            # hooks (7 event types)
└── .mcp.json                   # MCP services
```

Then append an entry to the `plugins` array in `marketplace.json`.

## References

- Official plugin docs: <https://zcode.z.ai/cn/docs/plugin>
- Hook mechanics and debugging: the `diagnosing-hooks` skill from the local `zcode-guide` plugin
