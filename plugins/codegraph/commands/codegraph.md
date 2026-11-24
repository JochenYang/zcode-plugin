---
description: Report the codegraph index status for this workspace (state, covered languages, file and symbol counts, staleness) and explain how to enable the index when the project is not indexed.
argument-hint: "[refresh]"
---

Show the state of the codegraph index for the current workspace by calling the plugin's
MCP status tool. The model-visible name is
`mcp__plugin_codegraph_codegraph__codegraph_status`; if that exact name is not in the tool
list, use the tool whose name ends in `__codegraph_status`.

## Steps

1. Call `codegraph_status` with `{ "refresh": true }` when the arguments contain
   `refresh`, otherwise with `{}`. `refresh` forces an incremental sync; on a project
   that qualifies for auto-indexing it also starts the background build.
2. Report what the tool returns, in this order: state (`ready` / `building` / `empty`),
   covered languages, file count, symbol count, stale file count. Quote the text rather
   than paraphrasing counts.
3. When the project is not indexed, explain the reason the tool gives and the matching fix:
   - the workspace is a home or drive root: never auto-indexed; open a project folder;
   - too few supported files (default 30): lower `minFilesToAutoIndex`;
   - `autoIndex` is off: set it to `true`;
   - too many files (default 30000): raise `maxFiles`;
   - then call `codegraph_status` again with `refresh: true` to start the build.
4. Configuration lives in `$ZCODE_PLUGIN_DATA/codegraph.json`, i.e.
   `~/.zcode/cli/plugins/data/codegraph@zcode-plugin/codegraph.json` (JSON; write only
   the keys to change, the file may be created if missing). Keys: `autoIndex`,
   `minFilesToAutoIndex`, `maxFiles`, `exclude` (array), `languages`. Environment
   variables `CODEGRAPH_AUTO_INDEX` / `CODEGRAPH_MIN_FILES` / `CODEGRAPH_MAX_FILES` /
   `CODEGRAPH_EXCLUDE` apply when the file leaves the field empty. Tell the user the
   exact path and the key to change; edit the file only when asked.
5. While the state is `building`, results are partial; never describe the index as
   ready unless the tool said `ready`.

Tool names carry the plugin namespace (`mcp__plugin_codegraph_codegraph__`); see the
plugin README for the other two tools, `codegraph_lookup` and `codegraph_map`.
