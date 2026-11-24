#!/usr/bin/env python3
"""Regression matrix for skills/review/scripts/review-gate.mjs.

The gate decides whether a multi-round review has converged. It is the only
thing standing between an open finding and a "converged" verdict, so each of
its eight gates, the cross-checks between the fields, and the failure exits
are pinned here against the real script.

    python plugins/dev-workflow/tests/test-review-gate.py [--gate PATH]

Requires Python 3.8+ and node on PATH. No third-party packages.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
GATE = os.path.join(os.path.dirname(HERE), "skills", "review", "scripts", "review-gate.mjs")

FAILURES = []


def check(label, ok, detail=""):
    print(f"{'OK  ' if ok else 'FAIL'} {label}{(' — ' + detail) if detail else ''}")
    if not ok:
        FAILURES.append(label)


def finding(fid, severity, decision, **extra):
    return dict(id=fid, severity=severity, decision=decision, **extra)


def state(**overrides):
    """A review that has converged at round 2, unless a case says otherwise."""
    base = {
        "round": 2,
        "max_rounds": 3,
        "required_clean_rounds": 2,
        "clean_rounds": 2,
        "new_blocking_count": 0,
        "baseline_frozen": True,
        "baseline_finding_ids": [],
        "findings": [],
        "structure_comparison": {"status": "pass", "warnings_reviewed": True},
        "context_not_read": False,
        "status_inconsistent": False,
        "manual_stop_count": 0,
    }
    for key, value in overrides.items():
        if value is ...:
            del base[key]
        else:
            base[key] = value
    return base


P1 = dict(severity="P1", original_severity="P1", decision="accepted", repeat_count=1,
          confirmed=True, verified_fixed=True)

# (label, state, expected action, expected gate or None, expected exit code)
CASES = [
    ("two clean rounds with a frozen baseline converge", state(), "converged", 6, 0),
    ("round 1 converges when one clean round is enough and needs no structure comparison",
     state(round=1, required_clean_rounds=1, clean_rounds=1, structure_comparison=...),
     "converged", 6, 0),
    ("a blocking finding the user confirmed and rejected is closed, not open",
     state(findings=[finding("F1", **{**P1, "decision": "rejected", "verified_fixed": False})],
           baseline_finding_ids=["F1"]),
     "converged", 6, 0),
    ("gate 1: a downgraded blocking finding needs the user",
     state(findings=[finding("F1", "P2", "downgraded", original_severity="P1")], clean_rounds=0),
     "needs_user_confirmation", 1, 0),
    ("gate 1: a rejected blocking finding needs the user",
     state(findings=[finding("F1", **{**P1, "decision": "rejected", "confirmed": False,
                                      "verified_fixed": False})],
           new_blocking_count=1, clean_rounds=0),
     "needs_user_confirmation", 1, 0),
    ("gate 1: a blocking finding marked intentional needs the user",
     state(findings=[finding("F1", **{**P1, "decision": "intentional", "confirmed": False})],
           clean_rounds=0),
     "needs_user_confirmation", 1, 0),
    ("gate 2: the same finding twice needs the user, even when it is closed",
     state(findings=[finding("F1", "P2", "accepted", repeat_count=2, verified_fixed=True)]),
     "needs_user_confirmation", 2, 0),
    ("gate 3: round 2 without a structure comparison needs the user",
     state(structure_comparison=...), "needs_user_confirmation", 3, 0),
    ("gate 3: a failed structure comparison needs the user",
     state(structure_comparison={"status": "fail", "warnings_reviewed": True}),
     "needs_user_confirmation", 3, 0),
    ("gate 3: warnings nobody reviewed need the user",
     state(structure_comparison={"status": "warn", "warnings_reviewed": False}),
     "needs_user_confirmation", 3, 0),
    ("gate 4: context that was not read needs the user",
     state(context_not_read=True, context_not_read_evidence=["docs/plans/x.md missing"]),
     "needs_user_confirmation", 4, 0),
    ("gate 5: too many manual stops need the user",
     state(manual_stop_count=2, manual_stop_reason=["flaky runner"]),
     "needs_user_confirmation", 5, 0),
    ("gate 8: a new blocking finding whose fix is not verified yet keeps the review going",
     state(findings=[finding("F1", **{**P1, "verified_fixed": False})],
           new_blocking_count=1, clean_rounds=0),
     "continue", 8, 0),
    ("gate 6: the last round that converges is converged, not stopped",
     state(round=3), "converged", 6, 0),
    ("gate 6: reviewed warnings count as a passed structure comparison",
     state(structure_comparison={"status": "warn", "warnings_reviewed": True}),
     "converged", 6, 0),
    ("gate 2: an escalated repeat needs the user on its own",
     state(findings=[finding("F1", "P2", "accepted", repeat_count=1, repeat_escalated=True,
                             verified_fixed=True)]),
     "needs_user_confirmation", 2, 0),
    ("gate 2: an intentional finding that repeats is not escalated",
     state(findings=[finding("F1", "P2", "intentional", repeat_count=2, confirmed=True)]),
     "converged", 6, 0),
    ("gate 1: a downgrade without an original severity counts as once blocking",
     state(findings=[finding("F1", "P2", "downgraded")], clean_rounds=0),
     "needs_user_confirmation", 1, 0),
    ("gate 7: the last round that did not converge stops",
     state(round=3, findings=[finding("F1", "P2", "accepted")]),
     "stop_max_rounds", 7, 0),
    ("gate 8: round 1 with an open non-blocking finding continues",
     state(round=1, clean_rounds=0, findings=[finding("F1", "P2", "pending")]),
     "continue", 8, 0),
    ("gate 8: one clean round is not enough when two are required",
     state(clean_rounds=1), "continue", 8, 0),
    ("gate 8: convergence needs a frozen baseline", state(baseline_frozen=False), "continue", 8, 0),
    # first-match-wins: gate 1 is asked before anything later is looked at
    ("gate 1 wins over the open-item and max-round checks",
     state(round=3, clean_rounds=0,
           findings=[finding("F1", **{**P1, "decision": "rejected", "confirmed": False,
                                       "verified_fixed": False})],
           new_blocking_count=1),
     "needs_user_confirmation", 1, 0),
]

# (label, argv, a fragment the error list must contain)
INVALID = [
    ("new_blocking_count that disagrees with the findings is rejected",
     [state(findings=[finding("F1", **{**P1, "verified_fixed": False})])], "new_blocking_count mismatch"),
    ("a frozen baseline may only list closed findings",
     [state(findings=[finding("F1", **{**P1, "verified_fixed": False})], new_blocking_count=1,
            baseline_finding_ids=["F1"])], "is not closed"),
    ("clean_rounds above the round number is rejected",
     [state(clean_rounds=3)], "clean_rounds cannot exceed round"),
    ("a manual stop without a reason is rejected",
     [state(manual_stop_count=1)], "manual_stop_reason required"),
    ("context marked as not read without evidence is rejected",
     [state(context_not_read=True)], "context_not_read_evidence required"),
    ("a finding without a severity is rejected",
     [state(findings=[{"id": "F1", "decision": "pending"}])], "severity must be P0-P3"),
    ("a baseline id that is not a finding is rejected",
     [state(baseline_finding_ids=["F9"])], "not found in findings"),
    ("a frozen baseline without an id list is rejected",
     [state(baseline_finding_ids=...)], "baseline_finding_ids required"),
    ("requiring more clean rounds than there are rounds is rejected",
     [state(required_clean_rounds=4)], "required_clean_rounds cannot exceed max_rounds"),
    ("a missing state path is rejected", [], "usage: review-gate.mjs"),
]


def run_gate(gate, argv):
    proc = subprocess.run(["node", gate] + argv, capture_output=True, text=True,
                          encoding="utf-8", timeout=30)
    try:
        out = json.loads(proc.stdout)
    except ValueError:
        out = {}
    return proc.returncode, out


def write_state(tmp, name, payload):
    path = os.path.join(tmp, name)
    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(payload, handle, ensure_ascii=False)
    return path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gate", default=GATE)
    args = parser.parse_args()
    if not os.path.isfile(args.gate):
        print(f"gate not found: {args.gate}")
        return 2
    if shutil.which("node") is None:
        print("node not found on PATH; the gate script cannot run")
        return 2

    with tempfile.TemporaryDirectory(prefix="review-gate-test-") as tmp:
        for index, (label, payload, action, gate_number, code) in enumerate(CASES):
            path = write_state(tmp, f"case{index}.json", payload)
            got_code, out = run_gate(args.gate, [path])
            check(label, out.get("action") == action and out.get("gate") == gate_number
                  and got_code == code,
                  f"want {action}/{gate_number}/exit {code}, got {out.get('action')}/"
                  f"{out.get('gate')}/exit {got_code} {out.get('reasons', '')}")

        for index, (label, payload, fragment) in enumerate(INVALID):
            if payload:
                path = write_state(tmp, f"invalid{index}.json", payload[0])
                argv = [path]
            else:
                argv = []
            got_code, out = run_gate(args.gate, argv)
            errors = " ".join(str(e) for e in out.get("errors", []))
            check(label, got_code == 2 and out.get("action") == "invalid_state"
                  and fragment in errors,
                  f"exit {got_code}, {out.get('action')}, errors: {errors[:120]}")

        missing = run_gate(args.gate, [os.path.join(tmp, "nope.json")])
        check("an unreadable state file is rejected",
              missing[0] == 2 and missing[1].get("action") == "invalid_state",
              f"exit {missing[0]}, {missing[1].get('action')}")

    print("\n" + ("FAILED: " + ", ".join(FAILURES) if FAILURES else "OK"))
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(main())
