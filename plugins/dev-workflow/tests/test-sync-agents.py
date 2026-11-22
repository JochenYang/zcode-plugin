#!/usr/bin/env python3
"""Regression tests for plugins/dev-workflow/hooks/sync-agents.sh.

The hook must refresh an agent the user has not touched, and must never
overwrite one the user has edited. On Windows the plugin root is a backslash
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

FAILURES = []


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
        self.state = self.data / "agent-sync.state"

    def write_bundled(self, text):
        self.bundled.write_text(text, encoding="utf-8", newline="\n")

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


def main():
    if not HOOK.is_file():
        print(f"hook not found: {HOOK}")
        return 2
    for test in (test_first_install_adds_the_agent, test_refreshes_an_untouched_agent,
                 test_never_overwrites_a_locally_edited_agent,
                 test_reads_state_written_by_the_buggy_version,
                 test_state_hashes_have_no_leading_backslash):
        test()
    print("\n" + ("FAILED: " + ", ".join(FAILURES) if FAILURES else "OK"))
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(main())
