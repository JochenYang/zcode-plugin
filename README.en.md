<h1 align="center">zcode-plugin</h1>

<div align="center">

[![中文](https://img.shields.io/badge/中文-简体中文-blue.svg)](README.md) [![English](https://img.shields.io/badge/English-English-blue.svg)](README.en.md)

</div>

<p align="center">
  <img src="https://img.shields.io/github/license/JochenYang/zcode-plugin" alt="License">
  <img src="https://img.shields.io/github/repo-size/JochenYang/zcode-plugin" alt="Repo size">
  <img src="https://img.shields.io/badge/plugin-v0.1.1-orange" alt="Plugin version">
</p>

Personal ZCode plugin marketplace. Each plugin lives in its own directory following the official convention (`.zcode-plugin/plugin.json` + component directories).

## Plugins

| Plugin | Version | Description |
|---|---|---|
| `plugins/git-workflow` | 0.1.1 | Git workflow: `/gcommit` conventional commits, `/gpr` PR descriptions, `/gchangelog` changelogs; a `PostToolUse` hook validates commit format |

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

- Icon file lives at `assets/git-workflow/icon.png` (128×128 PNG recommended)
- Referenced by the `icon` field in `marketplace.json` (GitHub raw URL)
- After replacing the icon you must push again for remote changes; the local marketplace just needs a panel refresh

## git-workflow usage

- `/gcommit` — analyzes staged/unstaged changes, generates a `<type>(<scope>): <subject>` message, commits after user confirmation
- `/gcommit [scope]` — specify a scope (e.g. `auth`, `api`)
- `/gcommit --amend` — amend the last commit
- `/gcommit --no-add` — commit only what is already staged
- `/gpr [--base <branch>]` — generates a PR description from the diff between the current and base branches (summary / grouped changes / verification / risks)
- `/gchangelog [--from <ref> --to <ref> | --count <n>] [--file <path>]` — generates a changelog grouped by version tag; with `--file` it merges into the file after a preview confirmation

A hook validates the message format after each commit; non-compliant messages trigger a reminder in the session (never blocks the commit).

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
