---
description: Generate a changelog from git history — grouped by version tag (or by commit type), conventional-commit aware.
argument-hint: "[--file <path>] [--to <ref>] [--from <ref>] [--count <n>]"
---

Generate a changelog from git history.

Workflow:

1. Look for release tags: `git tag --sort=-v:refname | head -20`.
2. Determine the range:
   - If `$ARGUMENTS` gives `--from` / `--to` refs (e.g. `--from v1.0.0 --to v2.0.0`), use them.
   - If tags exist and no explicit range is given: one section per tag range (newest first), plus an `Unreleased` section for commits after the newest tag; skip ranges with no conventional commits.
   - If no tags exist: use the full history, or the last N commits when the user passed a number in `$ARGUMENTS`.
3. For each range read `git log <range> --format='%s'` and bucket each subject:
   - `feat` → `### Features`
   - `fix` → `### Bug Fixes`
   - `perf` → `### Performance`
   - `refactor` → `### Refactoring` (only user-visible changes; drop cosmetic ones)
   - `docs` / `style` → `### Documentation` (style-only commits are usually skipped)
   - `test` / `chore` / `ci` / `build` / `revert` → `### Maintenance`
   - Non-conventional subjects → `Uncategorized`, but only include them when they are meaningful.
4. Format the changelog:
   - Header per version: `## [<version>] - YYYY-MM-DD` (use the tag name if it looks like a version, otherwise the tag itself), `## [Unreleased]` for the top section.
   - Bullets: `<short-hash> <subject>`, one per commit, no wrapping; skip trivial commits (typos, merge commits, formatting-only).
5. If `--file <path>` is given (default target `CHANGELOG.md` when it exists in the repo): merge with the existing file, inserting new sections above the old ones without duplicating entries, and show the user a preview of the new content — write only after explicit confirmation.
6. Otherwise print the full markdown to stdout and report how many commits were included and how many were skipped (with the reason).
