#!/usr/bin/env python3
"""Regression tests for plugins/dev-workflow/hooks/sync-agents.sh.

The hook must refresh an agent the user has not touched, must never
overwrite one the user has edited, and must remove one it wrote that the
plugin no longer bundles. On Windows the plugin root is a backslash
path and GNU sha1sum escapes such file names with a leading backslash, which
made every source hash differ from every target hash — so nothing was ever
refreshed after the first install.

    python plugins/dev-workflow/tests/test-sync-agents.py

Requires Python 3.8+ and bash. No third-party packages.
"""
import hashlib
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

PLUGIN = Path(__file__).resolve().parent.parent
HOOK = PLUGIN / "hooks" / "sync-agents.sh"
AGENT = "sample-agent.md"
V1 = "---\nname: sample-agent\ndescription: v1\n---\n\nbody v1\n"
V2 = "---\nname: sample-agent\ndescription: v2\n---\n\nbody v2\n"
EDITED = "---\nname: sample-agent\ndescription: local\n---\n\nedited by the user\n"
SECOND = "second-agent.md"
V1_SECOND = "---\nname: second-agent\ndescription: v1\n---\n\nbody v1\n"

FAILURES = []
EXIT_CODES = []


def check(label, ok, detail=""):
    print(f"{'OK  ' if ok else 'FAIL'} {label}{(' — ' + detail) if detail else ''}")
    if not ok:
        FAILURES.append(label)


def sha1(text):
    return hashlib.sha1(text.encode("utf-8")).hexdigest()


def run_hook(root, home, data):
    """Run the hook the way the app does: native paths, a clean ZCODE_* env."""
    env = {k: v for k, v in os.environ.items() if not k.startswith("ZCODE_") and k != "HOME"}
    env.update(HOME=str(home), ZCODE_PLUGIN_ROOT=str(root), ZCODE_PLUGIN_DATA=str(data))
    return subprocess.run(["bash", str(HOOK)], capture_output=True, text=True,
                          encoding="utf-8", env=env, timeout=30)


class Fixture:
    """A plugin root with one bundled agent, plus a fake HOME and data dir."""

    def __init__(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="sync-agents-test-"))
        self.root = self.tmp / "plugin"
        self.home = self.tmp / "home"
        self.data = self.tmp / "data"
        (self.root / ".zcode-plugin").mkdir(parents=True)
        (self.root / "assets" / "agents").mkdir(parents=True)
        (self.root / ".zcode-plugin" / "plugin.json").write_text(
            json.dumps({"name": "sample", "version": "1.0.0"}), encoding="utf-8")
        self.bundled = self.root / "assets" / "agents" / AGENT
        self.target = self.home / ".zcode" / "agents" / AGENT
        self.second_bundled = self.root / "assets" / "agents" / SECOND
        self.second_target = self.home / ".zcode" / "agents" / SECOND
        self.state = self.data / "agent-sync.state"

    def write_bundled(self, text):
        self.bundled.write_text(text, encoding="utf-8", newline="\n")

    def add_second_agent(self, text=V1_SECOND):
        self.second_bundled.write_text(text, encoding="utf-8", newline="\n")

    def write_target(self, text):
        self.target.parent.mkdir(parents=True, exist_ok=True)
        self.target.write_text(text, encoding="utf-8", newline="\n")

    def write_state(self, hash_prefix, text):
        """Write a state file as the hook would after writing `text`."""
        self.data.mkdir(parents=True, exist_ok=True)
        self.state.write_text(
            f"# synced-version 1.0.0\n{hash_prefix}{sha1(text)}  {AGENT}\n", encoding="utf-8")
        # The fast path skips everything when no bundled file is newer than the
        # state; make the bundled file the newer one, as after a plugin update.
        os.utime(self.state, (1, 1))

    def summary(self):
        line = next((l for l in self.proc.stdout.splitlines() if l.startswith("{")), "")
        try:
            return json.loads(line)["hookSpecificOutput"]["additionalContext"]
        except (ValueError, KeyError):
            return ""

    def run(self):
        self.proc = run_hook(self.root, self.home, self.data)
        EXIT_CODES.append(self.proc.returncode)
        return self.proc

    def cleanup(self):
        import shutil
        for child in sorted(self.tmp.rglob("*"), reverse=True):
            try:
                child.chmod(0o700)
            except OSError:
                pass
        shutil.rmtree(self.tmp, ignore_errors=True)


def test_first_install_adds_the_agent():
    fx = Fixture()
    try:
        fx.write_bundled(V1)
        proc = fx.run()
        check("first install copies the agent", fx.target.read_text(encoding="utf-8") == V1,
              proc.stderr.strip()[:120])
        check("first install reports it", "1 added" in fx.summary(), fx.summary()[:100])
    finally:
        fx.cleanup()


def test_refreshes_an_untouched_agent():
    """The regression: a plugin update must reach ~/.zcode/agents."""
    fx = Fixture()
    try:
        fx.write_bundled(V1)
        fx.run()
        fx.write_bundled(V2)
        fx.run()
        check("plugin update refreshes the untouched agent",
              fx.target.read_text(encoding="utf-8") == V2, fx.summary()[:120])
    finally:
        fx.cleanup()


def test_never_overwrites_a_locally_edited_agent():
    fx = Fixture()
    try:
        fx.write_bundled(V1)
        fx.run()
        fx.write_target(EDITED)
        fx.write_bundled(V2)
        fx.run()
        check("locally edited agent is left untouched",
              fx.target.read_text(encoding="utf-8") == EDITED, fx.summary()[:120])
        check("the hook says so", "Left untouched" in fx.summary(), fx.summary()[:120])
    finally:
        fx.cleanup()


def test_reads_state_written_by_the_buggy_version():
    """States written before the fix carry a leading backslash on every hash."""
    fx = Fixture()
    try:
        fx.write_target(V1)
        fx.write_state("\\", V1)
        fx.write_bundled(V2)
        fx.run()
        check("backslash-prefixed state is still recognised as hook-written",
              fx.target.read_text(encoding="utf-8") == V2, fx.summary()[:120])
    finally:
        fx.cleanup()


def test_state_hashes_have_no_leading_backslash():
    fx = Fixture()
    try:
        fx.write_bundled(V1)
        fx.run()
        lines = fx.state.read_text(encoding="utf-8").splitlines()[1:]
        check("state stores clean hashes", lines == [f"{sha1(V1)}  {AGENT}"], str(lines)[:120])
    finally:
        fx.cleanup()


def write_own_agent(fx):
    """An agent the plugin never bundled, so the hook never wrote it."""
    own = fx.target.parent / "own-agent.md"
    own.write_text("---\nname: own-agent\ndescription: mine\n---\n", encoding="utf-8",
                   newline="\n")
    return own


def state_lines(fx):
    return fx.state.read_text(encoding="utf-8").splitlines()[1:]


def test_removes_an_agent_the_plugin_no_longer_bundles():
    """Dropping `explore.md` from the plugin must reach existing installs too.

    ZCode ships its own `Explore`; a stale lowercase `explore` left in
    ~/.zcode/agents shows up beside it as a near-duplicate. One agent stays
    bundled, so only the record count tells the fast path that something
    changed: the state lists two agents, the bundle holds one."""
    fx = Fixture()
    try:
        fx.write_bundled(V1)
        fx.add_second_agent()
        fx.run()
        own = write_own_agent(fx)
        fx.bundled.unlink()
        fx.run()
        check("dropped agent is removed from the target", not fx.target.exists(),
              fx.summary()[:120])
        check("the agent still bundled is left alone",
              fx.second_target.read_text(encoding="utf-8") == V1_SECOND, fx.summary()[:120])
        check("the hook says so", "no longer bundles them: sample-agent" in fx.summary(),
              fx.summary()[:120])
        check("the user's own agent survives", own.exists())
        check("state now lists only the bundled agent",
              state_lines(fx) == [f"{sha1(V1_SECOND)}  {SECOND}"], str(state_lines(fx))[:120])
        proc = fx.run()
        check("a second run is silent", proc.stdout == "" and proc.returncode == 0,
              proc.stdout[:120])
    finally:
        fx.cleanup()


def test_keeps_a_dropped_agent_the_user_edited():
    fx = Fixture()
    try:
        fx.write_bundled(V1)
        fx.add_second_agent()
        fx.run()
        fx.write_target(EDITED)
        fx.bundled.unlink()
        fx.run()
        check("dropped but locally edited agent is left untouched",
              fx.target.read_text(encoding="utf-8") == EDITED, fx.summary()[:120])
        check("the hook says so", "No longer bundled" in fx.summary(), fx.summary()[:120])
        fx.run()
        check("it is not reported again on the next start", "sample-agent" not in fx.summary(),
              fx.summary()[:120])
    finally:
        fx.cleanup()


def test_removes_an_agent_recorded_by_the_buggy_version():
    """States written before 0.4.2 carry a leading backslash on every hash."""
    fx = Fixture()
    try:
        fx.write_target(V1)
        fx.add_second_agent()
        fx.write_state("\\", V1)
        fx.run()
        check("dropped agent is removed despite the backslash-prefixed record",
              not fx.target.exists(), fx.summary()[:120])
        check("the bundled agent is installed",
              fx.second_target.read_text(encoding="utf-8") == V1_SECOND, fx.summary()[:120])
    finally:
        fx.cleanup()


def test_an_empty_bundle_touches_nothing():
    """No bundled agent at all is a broken install, not a plugin that dropped
    every agent: the files and the state that lets a good install refresh
    them must survive."""
    fx = Fixture()
    try:
        fx.write_bundled(V1)
        fx.run()
        fx.bundled.unlink()
        proc = fx.run()
        check("installed agent is left in place",
              fx.target.is_file() and fx.target.read_text(encoding="utf-8") == V1,
              proc.stdout[:120])
        check("state still records it", state_lines(fx) == [f"{sha1(V1)}  {AGENT}"],
              str(state_lines(fx))[:120])
        check("and the hook stays silent", proc.stdout == "", proc.stdout[:120])
    finally:
        fx.cleanup()


def main():
    if not HOOK.is_file():
        print(f"hook not found: {HOOK}")
        return 2
    for test in (test_first_install_adds_the_agent, test_refreshes_an_untouched_agent,
                 test_never_overwrites_a_locally_edited_agent,
                 test_reads_state_written_by_the_buggy_version,
                 test_state_hashes_have_no_leading_backslash,
                 test_removes_an_agent_the_plugin_no_longer_bundles,
                 test_keeps_a_dropped_agent_the_user_edited,
                 test_removes_an_agent_recorded_by_the_buggy_version,
                 test_an_empty_bundle_touches_nothing):
        test()
    check("every hook run exits 0", all(code == 0 for code in EXIT_CODES), str(EXIT_CODES))
    print("\n" + ("FAILED: " + ", ".join(FAILURES) if FAILURES else "OK"))
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(main())
