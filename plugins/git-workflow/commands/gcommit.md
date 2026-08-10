---
description: Create a conventional-format git commit — check readiness, analyze changes, generate the message, and commit after user confirmation.
argument-hint: "[scope] [--amend] [--no-add]"
---

Create a conventional-format git commit for the current changes.

Workflow:

1. Run `git status --short`, `git diff --stat` and `git diff --staged --stat` to see the full picture. Do not stage anything yet — the readiness check runs on the whole working tree first, so a blocker never leaves secrets sitting in the index.
2. Readiness check, before staging and before generating any message:
   - Single responsibility: decide whether the changed files form one logical change. If they span multiple concerns, list a suggested split (what should be excluded or committed separately) instead of folding them together.
   - Sensitive content: scan the diff for keys, tokens, cookies, private keys, `.env` files, production URLs, debug logs, and temporary files. Report any hits as blockers.
   - Verification evidence: look for real, runnable evidence (`tests run`, `build`, `diff review`, `manual repro`). If none exists, mark the change as `unverified` in the message — never invent checks.
   - Contract alignment (lightweight): if this session has a Handoff contract from `change-plan` or `/handoff`, compare the change against its Goal / Must-have / Out of scope; note drift or out-of-scope expansions. Skip silently if no contract exists.
   - Show any blockers to the user and wait for their decision before continuing. If the user still wants to commit with open blockers, the body must state them honestly instead of fabricating evidence.
3. Stage the change: if nothing is staged, run `git add -A` unless `$ARGUMENTS` contains `--no-add`. When step 2 proposed a split, stage only the agreed subset with explicit paths rather than `-A`.
4. Analyze the diff and choose the commit `type` — exactly one of: `feat` (new feature), `fix` (bug fix), `docs`, `style` (formatting only), `refactor`, `perf`, `test`, `chore`, `ci`, `build`, `revert`.
5. Determine the `scope`: use `$1` when it is present and does not start with `-`, otherwise infer it from the changed module or file names (e.g. `auth`, `api`, `cli`). Omit it when the change is cross-cutting or no good scope exists.
6. Generate the message following these rules:
	   - Subject: `<type>(<scope>): <subject>` — imperative mood, lowercase first letter, no trailing period, at most 50 characters.
	   - Blank line: exactly one empty line between subject and body. Without it git folds the body into the subject and `%b` comes out empty.
	   - Body: write naturally, keep it short. Start with a one-line why if the subject alone does not make it clear. Then add `- ` bullets for what changed, one per meaningful change. Verification goes on the last line as a `- ` bullet naming the real check (`tests run`, `build`, `diff review`, `manual repro`). No forced section labels, no filler text. If the subject already says it all, omit the body entirely.
7. Show the full message to the user and wait for explicit confirmation before committing.
8. Commit with a quoted heredoc so the blank line and the bullet layout survive byte for byte:
	   ```bash
	   git commit -F - <<'MSG'
	   feat(auth): add token refresh

	   access tokens expired mid-session and forced a re-login
	   - add refresh call in src/auth/session.ts before each request
	   - store the refresh token in the existing secure store
	   - tests run: pnpm test src/auth (12 passed)
	   MSG
	   ```
   Append `--amend` to the `git commit` line when `$ARGUMENTS` contains `--amend`. Do not use repeated `-m` flags: each `-m` becomes one unwrapped paragraph, which silently destroys the bullet layout above.
9. After committing, run `git log -1 --format=%B` and report the parsed subject and body so the user can confirm the formatting landed.
