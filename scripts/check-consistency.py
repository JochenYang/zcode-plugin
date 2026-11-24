#!/usr/bin/env python3
"""Consistency checks for this plugin marketplace.

Catches the drift that a human reviewer keeps missing: a version bumped in one
manifest but not the others, an agent count that no longer matches the prose,
a frontmatter key ZCode does not recognise, a reference to a file that is not
there, or a leftover mention of a mechanism that was removed.

    python scripts/check-consistency.py [repo-root]

Requires Python 3.8+. Exits non-zero when any check fails.
"""
import glob
import json
import os
import re
import shutil
import subprocess
import sys

ROOT = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FAILS = []

# Frontmatter keys ZCode actually reads. An unknown key is silently dropped, so
# the check is the only thing that notices.
SKILL_KEYS = {"name", "description", "when_to_use", "license", "metadata"}
AGENT_KEYS = {
    "name", "description", "model", "thoughtLevel", "color", "permissionMode",
    "maxTurns", "memory", "tools", "disallowedTools", "skills", "background",
    "injectAgentsMd", "mcpServers",
}
# `tools:` is a literal allow-list at runtime: no alias resolution, no
# intersection with real tools. A name that does not exist (FetchURL is Kimi's
# name for WebFetch) silently removes that capability from the subagent.
BUILTIN_TOOLS = {
    "Agent", "AskUserQuestion", "Bash", "Edit", "Glob", "Grep", "Read", "Skill",
    "TodoWrite", "WebFetch", "WebSearch", "Write",
}
# Agent types the runtime provides itself. A user agent whose name differs
# from one of them only by case shows up as a near-duplicate in the listing
# (the model picks between the two at random), and an unusual-cased
# subagent_type then matches both and is rejected as ambiguous.
BUILTIN_AGENTS = {"general-purpose", "Explore"}
# The model is shown `- name: description (Tools: …)` and nothing else about
# an agent, so the description is its only trigger; past this it stops being
# scannable next to the others.
AGENT_DESCRIPTION_LIMIT = 200
# Mechanisms this repo removed on purpose; a mention means a stale reference.
STALE_MARKERS = ["Anti-rationalization", "AR-1", "KIMI_SKILL_DIR", "git_conventions", "whenToUse",
                 "gcommit", "git-workflow"]


def check(name, ok, detail=""):
    print(f"{'OK  ' if ok else 'FAIL'} {name}{(' — ' + detail) if detail else ''}")
    if not ok:
        FAILS.append(name)


def read(path):
    with open(os.path.join(ROOT, path), encoding="utf-8") as handle:
        return handle.read()


def load(path):
    return json.loads(read(path))


def check_json():
    # Glob under ROOT, not under the working directory: the script takes a
    # repo-root argument and must behave the same wherever it is run from.
    paths = ["marketplace.json"] \
        + [os.path.relpath(p, ROOT)
           for p in glob.glob(os.path.join(ROOT, "plugins/*/.zcode-plugin/plugin.json"))] \
        + [os.path.relpath(p, ROOT)
           for p in glob.glob(os.path.join(ROOT, "plugins/*/hooks/hooks.json"))]
    bad = []
    for path in paths:
        try:
            load(path)
        except ValueError as exc:
            bad.append(f"{path}: {exc}")
    check("json parses", not bad, "; ".join(bad))


def check_versions():
    market = load("marketplace.json")
    readmes = {name: read(name) for name in ("README.md", "README.en.md")}
    for entry in market["plugins"]:
        name, version = entry["name"], entry["version"]
        manifest = load(f"plugins/{name}/.zcode-plugin/plugin.json")
        check(f"{name}: manifest == marketplace", manifest["version"] == version,
              f'{manifest["version"]} vs {version}')
        for readme, text in readmes.items():
            row = re.search(rf"`plugins/{name}`\s*\|\s*([0-9][^ ]*)\s*\|", text)
            check(f"{name}: {readme} row == {version}",
                  bool(row) and row.group(1) == version,
                  row.group(1) if row else "row not found")
        # Plugins that carry their version in code (serverInfo.version) keep a second
        # copy in src/version.mjs; a bump that misses it makes the MCP handshake lie.
        version_file = os.path.join(ROOT, "plugins", name, "src", "version.mjs")
        if os.path.isfile(version_file):
            declared = re.search(r"PLUGIN_VERSION\s*=\s*['\"]([^'\"]+)['\"]", read(f"plugins/{name}/src/version.mjs"))
            check(f"{name}: src/version.mjs == {version}",
                  bool(declared) and declared.group(1) == version,
                  declared.group(1) if declared else "PLUGIN_VERSION not found")


def check_agent_count():
    count = len(glob.glob(os.path.join(ROOT, "plugins/dev-workflow/assets/agents/*.md")))
    market = load("marketplace.json")
    entry = next(p for p in market["plugins"] if p["name"] == "dev-workflow")
    sources = {
        "plugin.json": load("plugins/dev-workflow/.zcode-plugin/plugin.json")["description"],
        "marketplace.json": entry["description"],
        "README.md": read("README.md"),
        "README.en.md": read("README.en.md"),
    }
    for label, text in sources.items():
        check(f"dev-workflow: {label} states {count} agents", f"{count} " in text)


def frontmatter_keys(path):
    text = open(path, encoding="utf-8").read()
    match = re.match(r"^---\n(.*?)\n---\n", text, re.S)
    if not match:
        return None, ""
    keys = [line.split(":")[0].strip()
            for line in match.group(1).splitlines() if re.match(r"^[A-Za-z_]+:", line)]
    return keys, match.group(1)


def check_frontmatter():
    bad = []
    for path in glob.glob(os.path.join(ROOT, "plugins/dev-workflow/skills/*/SKILL.md")):
        keys, front = frontmatter_keys(path)
        owner = os.path.basename(os.path.dirname(path))
        if keys is None:
            bad.append(f"{owner}: no frontmatter")
            continue
        if set(keys) - SKILL_KEYS:
            bad.append(f"{owner}: extra keys {sorted(set(keys) - SKILL_KEYS)}")
        if "name" not in keys or "description" not in keys:
            bad.append(f"{owner}: missing name/description")
        desc = re.search(r"^description:\s*(.*)$", front, re.M)
        if desc and len(desc.group(1)) > 1024:
            bad.append(f"{owner}: description over 1024 chars")
    check("skill frontmatter", not bad, "; ".join(bad))

    bad = []
    for path in sorted(glob.glob(os.path.join(ROOT, "plugins/dev-workflow/assets/agents/*.md"))):
        keys, _ = frontmatter_keys(path)
        owner = os.path.basename(path)
        if keys is None:
            bad.append(f"{owner}: no frontmatter")
            continue
        if set(keys) - AGENT_KEYS:
            bad.append(f"{owner}: extra keys {sorted(set(keys) - AGENT_KEYS)}")
        if "name" not in keys or "description" not in keys:
            bad.append(f"{owner}: missing name/description")
        front = frontmatter_keys(path)[1]
        for field in ("tools", "disallowedTools"):
            listed = re.search(rf"^{field}:\n((?:  - \S+\n)+)", front, re.M)
            if not listed:
                continue
            unknown = [name for name in re.findall(r"  - (\S+)", listed.group(1))
                       if name not in BUILTIN_TOOLS and not name.startswith("mcp__")]
            if unknown:
                bad.append(f"{owner}: {field} has non-existent tool(s) {unknown}")
        if "FetchURL" in open(path, encoding="utf-8").read():
            bad.append(f"{owner}: mentions FetchURL (Kimi's name; ZCode's is WebFetch)")
    check("agent frontmatter", not bad, "; ".join(bad))


def check_agent_descriptions():
    """Trigger wording lives in `description` alone: ZCode drops the Kimi-only key."""
    builtin = {name.lower(): name for name in BUILTIN_AGENTS}
    agents = {}
    bad = []
    for path in sorted(glob.glob(os.path.join(ROOT, "plugins/dev-workflow/assets/agents/*.md"))):
        stem = os.path.basename(path)[:-3]
        front = frontmatter_keys(path)[1] or ""
        name = re.search(r"^name:\s*(.*)$", front, re.M)
        name = name.group(1).strip().strip("\"'") if name else ""
        desc = re.search(r"^description:\s*(.*)$", front, re.M)
        # The listing and subagent_type go by the frontmatter name, while the
        # sync hook copies by file name: the two have to agree.
        if name != stem:
            bad.append(f"{stem}: name `{name}` differs from its file name")
        if name in agents:
            bad.append(f"{name}: two files claim this name ({agents[name][0]} and {stem})")
        agents[name] = (stem, desc.group(1).strip().strip("\"'") if desc else "")
    known = {agent.lower() for agent in agents} | set(builtin)
    for name, (stem, desc) in agents.items():
        if name.lower() in builtin:
            bad.append(f"{stem}: collides with the built-in agent `{builtin[name.lower()]}`"
                       " (names match ignoring case)")
        if len(desc) > AGENT_DESCRIPTION_LIMIT:
            bad.append(f"{stem}: description over {AGENT_DESCRIPTION_LIMIT} chars ({len(desc)})")
        # Backticks in a description are reserved for agent names: a hand-off
        # to an agent that was renamed or removed makes the model pass a
        # subagent_type that does not exist. Tools such as `Read` keep their
        # capital initial and are not taken for a hand-off.
        for ref in re.findall(r"`([a-z][A-Za-z0-9-]*)`", desc):
            if ref.lower() not in known:
                bad.append(f"{stem}: hands off to unknown agent `{ref}`")
    check("agent descriptions", not bad, "; ".join(bad))


def check_stale_markers():
    hits = []
    # Local scratch and plan directories are not part of the repository even
    # when they sit inside it, so what they mention is nobody's drift.
    skipped = {".git", "node_modules", ".tmp", ".devflow"}
    for path in glob.glob(os.path.join(ROOT, "**", "*"), recursive=True):
        if not os.path.isfile(path) or skipped & set(os.path.normpath(path).split(os.sep)):
            continue
        if path.endswith((".png", ".ico", "check-consistency.py", "test-hooks.py", "agents-sync.md")):
            continue
        try:
            text = open(path, encoding="utf-8").read()
        except (UnicodeDecodeError, OSError):
            continue
        rel = os.path.relpath(path, ROOT)
        for marker in STALE_MARKERS:
            if marker in text:
                hits.append(f"{rel}: {marker}")
        # $ARGUMENTS is legitimate in slash commands, not in skills.
        if "$ARGUMENTS" in text and os.sep + "dev-workflow" in path:
            hits.append(f"{rel}: $ARGUMENTS")
    check("no stale references", not hits, "; ".join(hits))


def check_line_endings():
    # .wasm legitimately contains \r\n bytes. codegraph's grammars/LICENSES and
    # grammars/queries are verbatim upstream files (license texts, reference .scm) kept
    # byte-for-byte on purpose, so their line endings are not ours to normalise.
    binary_suffixes = (".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".wasm")
    vendored = [os.path.normcase(os.path.join(ROOT, "plugins", "codegraph", "grammars", part))
                for part in ("LICENSES", "queries")]

    def is_vendored(path):
        normalized = os.path.normcase(os.path.normpath(path))
        return any(normalized.startswith(f"{prefix}{os.sep}") for prefix in vendored)

    crlf = [os.path.relpath(path, ROOT)
            for path in glob.glob(os.path.join(ROOT, "plugins", "**", "*"), recursive=True)
            if os.path.isfile(path)
            and not path.endswith(binary_suffixes)
            and not is_vendored(path)
            and b"\r\n" in open(path, "rb").read()]
    check("no CRLF in plugins", not crlf, "; ".join(crlf))


def check_shell_syntax():
    bad = []
    for path in glob.glob(os.path.join(ROOT, "plugins/*/hooks/*.sh")):
        proc = subprocess.run(["bash", "-n", path], capture_output=True, text=True)
        if proc.returncode != 0:
            bad.append(f"{os.path.relpath(path, ROOT)}: {proc.stderr.strip()}")
    check("hook shell syntax", not bad, "; ".join(bad))


def check_hook_scripts():
    """Every script a hooks.json points at must exist and parse.

    A hook whose script is missing or broken fails silently at runtime, and
    for a hook-only plugin that is the whole plugin."""
    missing, broken = [], []
    node = shutil.which("node")
    prefix = "${ZCODE_PLUGIN_ROOT}/"
    for path in glob.glob(os.path.join(ROOT, "plugins/*/hooks/hooks.json")):
        plugin = os.path.basename(os.path.dirname(os.path.dirname(path)))
        for groups in load(os.path.relpath(path, ROOT)).get("hooks", {}).values():
            for group in groups:
                for hook in group.get("hooks", []):
                    for arg in hook.get("args", []):
                        if not arg.startswith(prefix):
                            continue
                        target = os.path.join(ROOT, "plugins", plugin, arg[len(prefix):])
                        if not os.path.isfile(target):
                            missing.append(f"{plugin}: {arg}")
                        elif node and target.endswith(".mjs"):
                            proc = subprocess.run(["node", "--check", target], capture_output=True, text=True)
                            if proc.returncode != 0:
                                broken.append(f"{plugin}/{os.path.basename(target)}: "
                                              f"{proc.stderr.strip()[:120]}")
    check("hook scripts resolve", not missing, "; ".join(missing))
    check("hook scripts parse", not broken, "; ".join(broken))


def check_skill_references():
    """A skill may point at its own references/ or scripts/, or at another skill's.

    SKILL.md and the reference documents it hands out are both scanned: the
    review protocol names the gate script as well."""
    skills_root = os.path.join(ROOT, "plugins/dev-workflow/skills")
    skill_dirs = glob.glob(os.path.join(skills_root, "*"))
    missing = []
    docs = glob.glob(os.path.join(skills_root, "*", "SKILL.md")) \
        + glob.glob(os.path.join(skills_root, "*", "references", "*.md"))
    for path in docs:
        owner = os.path.relpath(path, skills_root).split(os.sep)[0]
        text = open(path, encoding="utf-8").read()
        for ref in re.findall(r"`[^`\n]*references/([A-Za-z0-9._-]+\.md)`", text):
            if not any(os.path.isfile(os.path.join(d, "references", ref)) for d in skill_dirs):
                missing.append(f"{owner}: {ref}")
        for script in re.findall(r"scripts/([A-Za-z0-9._-]+\.(?:mjs|cjs|js|py|sh))", text):
            if not any(os.path.isfile(os.path.join(d, "scripts", script)) for d in skill_dirs):
                missing.append(f"{owner}: {script}")
    check("skill references resolve", not missing, "; ".join(missing))


def check_marketplace_sources():
    """ZCode reports an entry without `source` as plugin_marketplace_invalid
    ("Plugin has no install source"), so the plugin is listed but cannot be
    installed by anyone who adds the marketplace."""
    bad = []
    for entry in load("marketplace.json")["plugins"]:
        name, source = entry["name"], entry.get("source")
        if not isinstance(source, str) or not source.strip():
            bad.append(f"{name}: no install source")
            continue
        if source.startswith("./"):
            manifest = os.path.join(ROOT, source[2:], ".zcode-plugin", "plugin.json")
            if not os.path.isfile(manifest):
                bad.append(f"{name}: source {source} has no .zcode-plugin/plugin.json")
    check("marketplace sources resolve", not bad, "; ".join(bad))


def main():
    if not os.path.isfile(os.path.join(ROOT, "marketplace.json")):
        print(f"not a marketplace root: {ROOT}")
        return 2
    for probe in (check_json, check_versions, check_marketplace_sources,
                  check_agent_count, check_frontmatter, check_agent_descriptions,
                  check_stale_markers, check_line_endings, check_shell_syntax,
                  check_hook_scripts, check_skill_references):
        probe()
    if FAILS:
        print(f"\n{len(FAILS)} CHECK(S) FAILED: {', '.join(FAILS)}")
        return 1
    print("\nALL CHECKS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
