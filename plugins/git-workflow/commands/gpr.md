---
description: Generate a pull request description from the current branch's changes — summary, grouped changes, verification, and remaining risks.
argument-hint: "[--base <branch>]"
---

Generate a pull request description for the current branch.

Workflow:

1. Detect the current branch with `git branch --show-current`.
2. Determine the base branch: use `$ARGUMENTS`'s `--base` value if given, otherwise try in order `main`, `master`, `develop` (check with `git rev-parse --verify --quiet <branch>`).
3. Collect commits with `git log <base>..HEAD --format='%h %s'` — the format string must stay quoted, otherwise the shell splits it and git reads `%s` as a revision. If the range is empty, fall back to `git log -20 --format='%h %s'` and say so in the PR description.
4. Build the description with these four sections:
   - **Summary**: one to three sentences on what the PR does and why.
   - **Changes**: bullet list grouped by change type (feat/fix/docs/refactor/perf/test/chore), grounded in `git diff --stat <base>...HEAD`.
   - **Verification**: for each meaningful change, how it was verified (tests run, builds passed, manual checks); mark anything not verified explicitly as unverified.
   - **Risks / Follow-ups**: untested paths, breaking changes, migrations, or known gaps — be honest; if nothing is open, state that explicitly.
5. Write the description in the user's language (Chinese input → Chinese description; English input → English).
6. Output the markdown block to the user. Do NOT push the branch or open the PR unless the user explicitly asks.
