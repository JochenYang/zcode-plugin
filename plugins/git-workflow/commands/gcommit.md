---
description: Create a conventional-format git commit — check readiness, analyze changes, generate the message, and commit after user confirmation.
argument-hint: "[scope] [--amend] [--no-add]"
---

Create a conventional-format git commit for the current changes.

Workflow:

1. Run `git status --short` and `git diff --staged --stat`. If nothing is staged, show the unstaged changes and stage them with `git add -A` unless the user passed `--no-add`.
2. Readiness check before generating any message:
   - Single responsibility: decide whether the changed files form one logical change. If they span multiple concerns, list a suggested split (what should be excluded or committed separately) instead of folding them together.
   - Sensitive content: scan the diff for keys, tokens, cookies, private keys, `.env` files, production URLs, debug logs, and temporary files. Report any hits as blockers.
   - Verification evidence: look for real, runnable evidence (`tests run`, `build`, `diff review`, `manual repro`). If none exists, mark the change as `unverified` in the message — never invent checks.
   - Contract alignment (lightweight): if this session has a Handoff contract from `change-plan`, compare the change against its Goal / Must-have / Out of scope; note drift or out-of-scope expansions. Skip silently if no contract exists.
   - Show any blockers to the user and wait for their decision before continuing. If the user still wants to commit with open blockers, the body must state them honestly instead of fabricating evidence.
3. Analyze the diff and choose the commit `type` — exactly one of: `feat` (new feature), `fix` (bug fix), `docs`, `style` (formatting only), `refactor`, `perf`, `test`, `chore`, `ci`, `build`, `revert`.
4. Determine the `scope`: use `$ARGUMENTS` if the user provided a scope, otherwise infer it from the changed module or file names (e.g. `auth`, `api`, `cli`). Omit it when the change is cross-cutting or no good scope exists.
5. Generate the message following these rules:
   - Subject: `<type>(<scope>): <subject>` — imperative mood, lowercase first letter, no trailing period, at most 50 characters.
   - Blank line: separate subject from body with exactly one empty line. Without it git folds the body into the subject and `%b` comes out empty.
   - Body: bullet list using `- ` prefix, grouped into three labeled sections (omit a section only when genuinely empty):
     - `* Purpose`: why this change is needed (the user value or problem it solves).
     - `* Changes`: one bullet per meaningful change — what was added/modified/removed and where.
     - `* Verification`: how it was verified, naming the real check (`diff review`, `tests run`, `build`, `manual repro`) — never write `git add` or other non-checks.
     - One bullet per line, wrap at 72 characters.
6. Show the full message to the user and wait for explicit confirmation before committing. If `--amend` was passed, prepare `git commit --amend` instead.
7. Commit using multiple `-m` flags so git inserts the blank line between subject and body automatically: `git commit -m "<subject>" -m "* Purpose: ..." -m "* Changes: ..." -m "* Verification: ..."`. Do not use `git commit -F -` unless you write the blank line explicitly.
8. After committing, run `git log -1 --format=%B` and report the parsed subject and body so the user can confirm.

$ARGUMENTS
