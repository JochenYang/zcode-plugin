#!/usr/bin/env python3
"""Tests for plugins/dev-workflow/hooks/on-dispatch.sh.

The hook runs before every Agent tool call and must never block it: exit 0, one JSON
line, an additionalContext for PreToolUse and no permission decision. The sentence
depends on the dispatched type, and a prompt that merely mentions the key
`subagent_type` must not select it — only the real field does.

    python plugins/dev-workflow/tests/test-on-dispatch.py

Requires Python 3.8+ and bash. No third-party packages.
"""
import json
import os
import subprocess
import sys
from pathlib import Path

HOOK = Path(__file__).resolve().parent.parent / "hooks" / "on-dispatch.sh"

FAILURES = []

SHARED = (
    ("forbids editing the files it owns", "do not edit the files it owns"),
    ("says a DONE status is not evidence", "a DONE status is not evidence"),
    ("prefers continuing over a new dispatch", "continue it with SendMessage instead of starting a new one"),
)
# type → the closing step its reminder must name
CASES = {
    "builder": "test-changed and review",
    "tester": "test-changed and review",
    "dba": "test-changed and review",
    "reviewer": "review only the new diff",
    "guard": "review only the new diff",
    "detective": "Reproduce the one step",
    "Explore": "Reproduce the one step",
    "general-purpose": "Reproduce the one step",
}


def check(label, ok, detail=""):
    print(f"{'OK  ' if ok else 'FAIL'} {label}{(' — ' + detail) if detail else ''}")
    if not ok:
        FAILURES.append(label)


def run(payload):
    """Run the hook the way the app does: the payload on stdin, a clean ZCODE_* env."""
    env = {k: v for k, v in os.environ.items() if not k.startswith("ZCODE_")}
    return subprocess.run(["bash", str(HOOK)], input=payload, capture_output=True, text=True,
                          encoding="utf-8", env=env, timeout=30)


def context_of(proc):
    """The hookSpecificOutput object, after checking the shape every run must have."""
    check("exits 0", proc.returncode == 0, proc.stderr.strip()[:120])
    check("writes nothing to stderr", proc.stderr == "", proc.stderr[:120])
    lines = [line for line in proc.stdout.splitlines() if line.strip()]
    check("prints exactly one JSON line", len(lines) == 1, proc.stdout[:120])
    # The hook output schema is strict: pure ASCII on one line keeps control characters out of it.
    check("stdout is plain ASCII", proc.stdout.isascii(), proc.stdout[:120])
    check("stdout has no carriage return", "\r" not in proc.stdout)
    try:
        out = json.loads(lines[0])["hookSpecificOutput"]
    except (ValueError, KeyError, IndexError):
        check("output is a hookSpecificOutput object", False, proc.stdout[:120])
        return {}
    check("event is PreToolUse", out.get("hookEventName") == "PreToolUse")
    check("carries no permission decision", "permissionDecision" not in out)
    return out


def payload(kind, prompt="List your tools."):
    return json.dumps({
        "hook_event_name": "PreToolUse", "tool_name": "Agent", "permission_mode": "yolo",
        "tool_input": {"description": "probe", "prompt": prompt, "subagent_type": kind},
    })


def test_each_type_gets_its_own_closing_step():
    for kind, phrase in CASES.items():
        out = context_of(run(payload(kind)))
        text = out.get("additionalContext", "")
        check(f"{kind}: names its closing step", phrase in text, text[-110:])
        check(f"{kind}: the context is not empty", bool(text.strip()))


def test_every_reminder_carries_the_shared_part():
    for kind in ("builder", "reviewer", "Explore"):
        text = context_of(run(payload(kind))).get("additionalContext", "")
        for label, needle in SHARED:
            check(f"{kind}: {label}", needle in text, text[:90])


def test_a_prompt_that_mentions_the_key_does_not_select_the_variant():
    """The prompt is JSON-escaped inside the payload, so its quotes carry backslashes —
    even when the mention itself is surrounded by quotes, the worst case."""
    prompt = 'the docs say: use "subagent_type": "reviewer" for a review'
    text = context_of(run(payload("builder", prompt))).get("additionalContext", "")
    check("the real field wins over a mention inside the prompt", "test-changed and review" in text, text[-110:])
    check("and the mention is not taken for a review dispatch", "review only the new diff" not in text)


def test_an_empty_payload_still_answers():
    proc = subprocess.run(["bash", str(HOOK)], input="", capture_output=True, text=True,
                          encoding="utf-8", timeout=30)
    text = context_of(proc).get("additionalContext", "")
    check("empty stdin gets the generic reminder", "Reproduce the one step" in text, text[-110:])


def test_the_three_reminders_are_not_the_same_sentence():
    tails = {kind: context_of(run(payload(kind))).get("additionalContext", "") for kind in ("builder", "reviewer", "Explore")}
    check("implementation, review and analysis differ", len(set(tails.values())) == 3)


def main():
    if not HOOK.is_file():
        print(f"hook not found: {HOOK}")
        return 2
    for test in (test_each_type_gets_its_own_closing_step,
                 test_every_reminder_carries_the_shared_part,
                 test_a_prompt_that_mentions_the_key_does_not_select_the_variant,
                 test_an_empty_payload_still_answers,
                 test_the_three_reminders_are_not_the_same_sentence):
        print(f"\n[{test.__name__}]")
        test()
    print("\n" + ("FAILED: " + ", ".join(FAILURES) if FAILURES else "OK"))
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(main())
