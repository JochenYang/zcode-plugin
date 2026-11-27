---
description: Show the codegraph index status for this workspace. "storage" also lists every project's index on this machine with its size and last use; "clean" removes indexes (stale ones, all but this project, this project's, or a named project's); "refresh" forces an incremental sync.
argument-hint: "[refresh | storage | clean [all | current | <project>]]"
---

Report and manage the codegraph index by calling the plugin's MCP status tool. The model-visible
name is `mcp__plugin_codegraph_codegraph__codegraph_status`; if that exact name is not in the
tool list, use the tool whose name ends in `__codegraph_status`.

## Steps

1. Read `$ARGUMENTS` and call `codegraph_status` once with the matching arguments:

   | the user typed | arguments |
   |---|---|
   | nothing | `{}` |
   | `refresh` | `{ "refresh": true }` |
   | `storage` | `{ "storage": true }` |
   | `clean` | `{ "clean": "stale" }`, then step 4 |
   | `clean all` | `{ "clean": "all" }`, then step 4 |
   | `clean current` | `{ "clean": "current" }`, then step 4 |
   | `clean <project path>` | `{ "clean": "project", "project": "<path>" }`, then step 4 |

   Words may be combined (`storage refresh` → both arguments). A word you cannot map to one of
   these rows is not an error to guess at: say what you understood and ask.

2. Report what the tool returns, in this order: state (`ready` / `building` / `empty`),
   covered languages, file count, symbol count, stale file count. Quote the text rather than
   paraphrase counts. With `storage`, also show the `indexes:` block as it is: one line per
   project, with its size and when it last served a session, and the policy line.

3. When the project is not indexed, explain the reason the tool gives and the matching fix:
   - the workspace is a home or drive root: never auto-indexed; open a project folder;
   - `not a project folder`: the workspace is one ZCode made for a session that was never
     given a folder (under a `.zcode/workspace` directory); nothing is indexed or stored there;
     open a project folder;
   - too few supported files (default 30): lower `minFilesToAutoIndex`;
   - too many files (default 30000): raise `maxFiles`;
   - `autoIndex` is off in the user's configuration: set it to `true`;
   - `autoIndex` is off in `.zcode/codegraph.json` of this project: that file is the project's
     own setting and can only switch indexing off, so delete `"autoIndex": false` there;
   - then call `codegraph_status` again with `{ "refresh": true }` to start the build, unless
     indexing is switched off.

4. A clean request goes in two calls. The first one, without `confirm`, only lists what would be
   removed: show that list to the user. Then make the second call with the same arguments plus
   `{ "confirm": true }` and report what was removed and what was kept because a session holds
   it. The command itself is the user's request, so do both calls in the same answer; do not ask
   again. Never clean on your own initiative — not after an edit, not to free disk space: only
   when the user typed `/codegraph clean` or asked for it in plain words. `clean current`
   deletes the index of this project; the next codegraph call rebuilds it, which is the way to
   start over from an index that looks wrong.

5. Configuration lives in `$ZCODE_PLUGIN_DATA/codegraph.json`, i.e.
   `~/.zcode/cli/plugins/data/codegraph@zcode-plugin/codegraph.json` (JSON; write only
   the keys to change, the file may be created if missing). Keys: `autoIndex`,
   `minFilesToAutoIndex`, `maxFiles`, `exclude` (array), `languages`, and for the store
   `maxIdleDays` (an index that last served a session longer ago is deleted when a session
   opens; default 90, `0` keeps every index) and `maxTotalMB` (above this the least recently
   used indexes go; default `0`, no limit). A project may add its own file,
   `.zcode/codegraph.json` in its root, with `autoIndex`, `exclude`, `minFilesToAutoIndex`,
   `maxFiles` or `languages`; it can only tighten the user's settings, never loosen them.
   Environment variables `CODEGRAPH_AUTO_INDEX` / `CODEGRAPH_MIN_FILES` / `CODEGRAPH_MAX_FILES` /
   `CODEGRAPH_EXCLUDE` apply when the file leaves the field empty. Tell the user the
   exact path and the key to change; edit a file only when asked.

6. While the state is `building`, results are partial; never describe the index as
   ready unless the tool said `ready`.

Tool names carry the plugin namespace (`mcp__plugin_codegraph_codegraph__`); see the
plugin README for the other two tools, `codegraph_lookup` and `codegraph_map`.
