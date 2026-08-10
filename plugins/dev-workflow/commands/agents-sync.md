---
description: Compare or export the bundled subagent definitions against ~/.zcode/agents. Installation itself is automatic, so this is only for inspecting differences or pushing local edits back into the repo.
argument-hint: "[diff|export|install] [agent-name …]"
---

Inspect or export the bundled subagent definitions.

**Installation is already automatic.** A `SessionStart` hook (`hooks/sync-agents.sh`) copies `${ZCODE_PLUGIN_ROOT}/assets/agents/*.md` into `~/.zcode/agents/` on every session start — it installs missing files, refreshes files it previously wrote, and skips any file the user has edited by hand. This command exists for the cases the hook deliberately does not handle.

Why the copy is needed at all: ZCode only discovers subagents under `~/.zcode/agents` and `<workspace>/.agents/agents`. A plugin directory is never a discovery root, and declaring `agents` in `plugin.json` only produces a `plugin_unsupported_component` warning.

Mode comes from `$1`; default to `diff` when it is absent. Extra arguments name specific agents (without `.md`) and restrict the operation to those.

## diff

1. List `${ZCODE_PLUGIN_ROOT}/assets/agents/*.md` and `~/.zcode/agents/*.md`.
2. Classify each bundled file as `identical`, `differs`, or `missing in target`, and list target files that have no bundled counterpart (the user's own agents).
3. Show the actual diff for every `differs` file. Write nothing.

## export

For an agent that was edited in `~/.zcode/agents` and should come back into the repo — this is the direction the hook will never take on its own.

1. Diff `~/.zcode/agents/*.md` against the bundled assets and show what would change.
2. After explicit confirmation, copy the changed files into the **repo checkout**, not the plugin cache. The cache under `~/.zcode/cli/plugins/cache/…` is overwritten on every reinstall, so edits there are lost; the source of truth is `plugins/dev-workflow/assets/agents/` in the git working tree. Ask the user for the checkout path if it is not the current working directory.
3. Remind the user to bump `version` in `plugin.json` — the install cache is keyed by version, and without a bump the change never reaches any machine.
4. Only touch files that already exist as bundled assets unless the user explicitly asks to add a new one.

## install

Force what the hook does, for when it was skipped: same classification as `diff`, then overwrite after per-file confirmation — including files the hook left alone because they were edited locally. Always show the diff of a locally-edited file before overwriting it.

## Frontmatter rules

ZCode reads only these keys: `name`, `description`, `model`, `thoughtLevel`, `color`, `permissionMode`, `maxTurns`, `memory`, `tools`, `disallowedTools`, `skills`, `background`, `injectAgentsMd`, `mcpServers`. `name` and `description` are required and the body becomes the system prompt. `whenToUse` is **not** recognised — trigger wording belongs in `description`, which is what the model matches against. Report any file that violates this rather than copying it silently.