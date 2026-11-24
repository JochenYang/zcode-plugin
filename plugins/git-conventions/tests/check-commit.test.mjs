// Regression matrix for hooks/check-commit.mjs.
//
// Every case feeds the real hook the JSON the runtime would send and compares
// its decision, so a change to the parser that silently stops recognising one
// way of writing a commit (or starts rejecting a message it cannot judge)
// fails here instead of in a live session.
//
//   node --test plugins/git-conventions/tests/*.test.mjs

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const HOOK = fileURLToPath(new URL("../hooks/check-commit.mjs", import.meta.url));
const WIN32 = process.platform === "win32";

function run(command, cwd = process.cwd(), payload) {
  const body = payload ?? { hook_event_name: "PreToolUse", tool_name: "Bash", cwd, tool_input: { command } };
  const proc = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(body), encoding: "utf-8" });
  assert.equal(proc.status, 0, `hook must always exit 0, got ${proc.status}: ${proc.stderr}`);
  const out = (proc.stdout || "").trim();
  if (out === "") return { decision: "allow", reason: "" };
  const parsed = JSON.parse(out).hookSpecificOutput;
  assert.equal(parsed.hookEventName, "PreToolUse");
  return { decision: parsed.permissionDecision, reason: parsed.permissionDecisionReason };
}

const GOOD = "feat(auth): add token refresh\n\n- refresh the access token before each request\n- keep the refresh token in the secure store\nVerified: 12 unit tests passed";
const GOOD_HEREDOC = `cd /d/codes/app && git add -A && git commit -F - <<'MSG'\n${GOOD}\nMSG\n`;

// (label, command)
const ALLOWED = [
  ["a command without git", "npm test && npm run build"],
  ["git without a commit", "git status --short && git log --oneline -3 && git push origin main"],
  ["git mentioned inside a string", "echo \"git commit -m nope\""],
  ["a bare commit that opens the editor", "git commit"],
  ["a heredoc on a bare commit: git never reads the message from stdin", "git commit <<'MSG'\nNope\nMSG"],
  ["an amend that keeps the message", "git commit --amend --no-edit"],
  ["a reused message", "git commit -C HEAD"],
  ["a fixup commit", "git commit --fixup=HEAD"],
  ["a conventional subject with a scope", "git commit -m \"feat(auth): add token refresh\""],
  ["a conventional subject without a scope", "git commit -m 'fix: handle empty input'"],
  ...["docs", "style", "refactor", "perf", "test", "chore", "build", "ci", "revert"].map((type) => [`the ${type} type`, `git commit -m "${type}: tidy"`]),
  ["a monorepo scope", "git commit -m \"fix(@types/node): pin the minor version\""],
  ["a scope with a plus and upper-case letters", "git commit -m \"fix(C++Core): x\""],
  ["the breaking-change marker", "git commit -m \"feat(api)!: drop v1\""],
  ["a subject of exactly 50 characters", "git commit -m \"" + "fix(parser): " + "x".repeat(37) + "\""],
  ["two -m options with bullets and a Verified line", "git commit -m \"docs: update readme\" -m \"- fix the typo\nVerified: read the rendered page\""],
  ["a message with real newlines in one -m", `git commit -m "${GOOD}"`],
  ["a dollar sign inside single quotes, which bash never expands", "git commit -m 'fix: handle $HOME expansion'"],
  ["a heredoc fed through -F -", GOOD_HEREDOC],
  ["a heredoc with an unquoted delimiter and nothing to expand", "git commit -F - <<MSG\nchore: bump deps\nMSG"],
  ["a heredoc with an unquoted delimiter and an expansion, which is not judged", "git commit -F - <<MSG\nfix: $X\n\n- a\nVerified: t\nMSG"],
  ["a <<- heredoc with tab-indented lines", "git commit -F - <<-MSG\n\tfeat: add x\n\n\t- a\n\t- b\n\tVerified: t\n\tMSG"],
  ["a heredoc whose terminator has no trailing newline", "git commit -F - <<'MSG'\nfix: y\n\n- a\nVerified: t\nMSG"],
  ["a heredoc followed by more commands on later lines", "git commit -F - <<'MSG'\nfix: y\n\n- a\nVerified: t\nMSG\ngit push origin main\ngit status --short"],
  ["indented continuation lines of a bullet", "git commit -m \"fix(db): bound the query\n\n- add an index on users.email so the\n  lookup no longer scans the table\nVerified: EXPLAIN shows the index\""],
  ["a Verified line that wraps onto the next line", "git commit -m \"fix(shell): stop the restart loop\n\n- reset the attempt counter only when ready\n- cap the ladder at four steps\nVerified: tsc --noEmit clean; the failure path now converges within four\nattempts (retry -> rollback -> reinstall -> quit)\""],
  ["a Verified line separated from the bullets by a blank line", "git commit -m \"fix: x\n\n- a\n\nVerified: t\""],
  ["a cluster of short options before the message", "git commit -qam \"test(ci): pin the runner\""],
  ["an attached message", "git commit -m\"chore: tidy\""],
  ["a long option with its value", "git commit --message=\"chore: tidy\""],
  ["a file given as a long option", "git commit --file=__FILE_GOOD__"],
  ["git -C", "git -C /d/codes/app commit -m \"chore: bump deps\""],
  ["git with a -c setting", "git -c user.name=bot commit -m \"chore: bump deps\""],
  ["a long option with a value", "git commit --cleanup=strip --author \"Bot <bot@example.com>\" -m \"chore: bump deps\""],
  ["a template option with its file", "git commit -t /tmp/template -m \"chore: bump deps\""],
  ["--no-verify on a compliant message", "git commit --no-verify -m \"chore: ok\""],
  ["a variable assigned earlier on the same line", "MSG=\"feat: add x\"; git commit -m \"$MSG\""],
  ["a heredoc inside a command substitution", "git commit -m \"$(cat <<'MSG'\nfeat: add x\n\n- a\nVerified: t\nMSG\n)\""],
  ["an unquoted here-string of several words", "git commit -F - <<< chore: bump deps"],
  ["a here-string with an expansion, which is not judged", "git commit -F - <<< \"$(cat notes.txt)\""],
  ["a sh -c wrapper", "sh -c 'git commit -m \"feat: ok\"'"],
  ["eval", "eval 'git commit -m \"feat: ok\"'"],
  ["sudo", "sudo git commit -m \"chore: ok\""],
  ["a commit inside a subshell", "(cd /d/codes/app && git commit -m \"chore: ok\")"],
  ["a commit guarded by if", "if git commit -m \"chore: ok\"; then echo ok; fi"],
  ["a commit inside a for loop", "for f in a.txt; do git commit -m \"chore: ok\"; done"],
  ["an environment assignment before git", "GIT_AUTHOR_NAME=bot git commit -m \"chore: ok\""],
  ["time in front of git", "time git commit -m \"chore: ok\""],
  ["output redirected after the message", "git commit -m \"chore: ok\" 2>&1 | tail -2"],
  ["a backslash path in git -C", "git -C \"D:\\codes\\app\" commit -m \"chore: bump deps\""],
  ["a variable this hook cannot resolve", "git commit -m \"$BUILD_MSG\""],
  ["a command substitution this hook cannot read", "git commit -m \"$(cat notes.txt)\""],
  ["a message file that does not exist", "git commit -F .git/missing-message.txt"],
  ["a message file whose path has a space and cannot be read", "git commit -F \"C:/Users/Administrator/AppData/Local/Temp/agent trigger/msg.txt\""],
  ["a relative message file in the working directory", "__FILE_HOME__"],
  ["a script fed to bash through a heredoc, which is not analysed", "bash <<'EOF'\ngit commit -m \"Nope\"\nEOF"],
  ["a merge conflict resolution", "git commit --no-edit"],
  ["an empty message (git itself rejects it)", "git commit -m \"\""],
];

// (label, command, a fragment the reason must contain)
const DENIED = [
  ["an upper-case type", "git commit -m \"Feat(auth): Add token\"", "one of the types"],
  ["an unknown type", "git commit -m \"feature: add x\"", "one of the types"],
  ["no type at all", "git commit -m \"Add token refresh\"", "one of the types"],
  ["an upper-case first letter after the colon", "git commit -m \"fix: Handle it\"", "lowercase letter after the colon"],
  ["a digit after the colon, reported for what it is", "git commit -m \"chore(release): 0.7.7\"", "lowercase letter after the colon"],
  ["a subject of 51 characters", "git commit -m \"" + "fix(parser): " + "x".repeat(38) + "\"", "51 characters"],
  ["a subject that ends with a period", "git commit -m \"fix: crash.\"", "must not end with a period"],
  ["a body without a Verified line", "git commit -m \"feat: add x\n\n- a\n- b\"", "Verified"],
  ["a body line that is not a bullet", "git commit -m \"feat: add x\n\nalso changed y\nVerified: t\"", "must be a \"- \" bullet"],
  ["a trailer, which is not a bullet", "git commit -m \"feat: add x\n\n- a\nCo-authored-by: Someone <a@b.c>\nVerified: t\"", "must be a \"- \" bullet"],
  ["an empty Verified line", "git commit -m \"feat: add x\n\n- a\nVerified:\"", "Verified"],
  ["bullets after the Verified line", "git commit -m \"feat: add x\n\n- a\nVerified: t\n\n- b\"", "nothing may follow the Verified line"],
  ["two -m options where the second is not a bullet list", "git commit -m \"fix: x\" -m \"no bullet here\nVerified: t\"", "must be a \"- \" bullet"],
  ["a heredoc without a Verified line", "git commit -F - <<'MSG'\nfeat: add x\n\n- a\nMSG", "Verified"],
  ["a heredoc with a bad subject", "cd /d/codes/app && git add -A && git commit -F - <<'MSG'\nAdd token refresh.\n\n- a\nVerified: t\nMSG\n", "one of the types"],
  ["a heredoc with an unquoted delimiter and a bad subject", "git commit -F - <<MSG\nNope\nMSG", "one of the types"],
  ["a here-string with a bad subject", "git commit -F - <<< Nope", "one of the types"],
  ["the second commit of a chain", "git commit -m \"chore: ok\" && git commit -m \"nope\"", "one of the types"],
  ["--no-verify does not bypass the check", "git commit --no-verify -m \"Nope\"", "one of the types"],
  ["a bad message after --amend -m", "git commit --amend -m \"Nope\"", "one of the types"],
  ["a bad message inside a subshell", "(cd /d/codes/app && git commit -m \"Nope\")", "one of the types"],
  ["a bad message guarded by if", "if git commit -m \"Nope\"; then echo ok; fi", "one of the types"],
  ["a bad message inside a for loop", "for f in a.txt; do git commit -m \"Nope\"; done", "one of the types"],
  ["a bad message behind a negation", "! git commit -m \"Nope\"", "one of the types"],
  ["a bad message inside a brace group", "{ git commit -m \"Nope\"; }", "one of the types"],
  ["a bad message through eval", "eval 'git commit -m \"Nope\"'", "one of the types"],
  ["a bad message behind sudo", "sudo git commit -m \"Nope\"", "one of the types"],
  ["a bad message after an environment assignment", "GIT_AUTHOR_NAME=bot git commit -m \"Nope\"", "one of the types"],
  ["a bad message read from a file", "git commit -F __FILE_BAD__", "51 characters"],
  ["a bad message file in the working directory", "git commit -F __FILE_HOME__", "one of the types"],
];

function withFiles(dir, command) {
  return command
    .replaceAll("__FILE_GOOD__", "good.txt")
    .replaceAll("__FILE_BAD__", "bad.txt")
    .replaceAll("__FILE_HOME__", "home-msg.txt");
}

test("allow what carries no judgeable message or a compliant one", () => {
  const dir = mkdtempSync(join(tmpdir(), "git-conventions-"));
  try {
    writeFileSync(join(dir, "good.txt"), "fix(docs): repair the link\n\n- point it at the new page\nVerified: opened it\n");
    writeFileSync(join(dir, "home-msg.txt"), "chore: tidy\n");
    for (const [label, template] of ALLOWED) {
      const command = withFiles(dir, template);
      const got = run(command, dir);
      assert.equal(got.decision, "allow", `${label}: ${got.reason}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deny a message that breaks the convention and say why", () => {
  const dir = mkdtempSync(join(tmpdir(), "git-conventions-"));
  try {
    writeFileSync(join(dir, "bad.txt"), "fix(parser): " + "x".repeat(38) + "\n");
    writeFileSync(join(dir, "home-msg.txt"), "Nope\n");
    for (const [label, template, fragment] of DENIED) {
      const got = run(withFiles(dir, template), dir);
      assert.equal(got.decision, "deny", label);
      assert.ok(got.reason.includes("Commit message rejected"), label);
      assert.ok(got.reason.includes(fragment), `${label}: reason was ${got.reason}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a denial echoes the offending line only in part", () => {
  const long = "x".repeat(400);
  const got = run("git commit -m \"Nope " + long + "\"");
  assert.equal(got.decision, "deny");
  // The raw subject is 405 characters; the denial carries the fixed wording
  // plus at most 120 of them.
  assert.ok(!got.reason.includes(long), "the whole offending line was echoed");
  assert.ok(got.reason.length < 600, `reason is ${got.reason.length} characters`);
});

test("resolve a message file the way the shell would", () => {
  const dir = mkdtempSync(join(tmpdir(), "git-conventions-"));
  const posix = dir.replace(/\\/g, "/");
  try {
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "msg.txt"), "Nope\n");
    writeFileSync(join(dir, "good.txt"), "chore: tidy\n");
    writeFileSync(join(dir, "sub", "good.txt"), "Nope\n");
    assert.equal(run(`cd ${posix} && git commit -F msg.txt`, process.cwd()).decision, "deny");
    assert.equal(run(`git -C ${posix} commit -F msg.txt`, process.cwd()).decision, "deny");
    // A cd inside a subshell does not leak into the commands after it: with
    // the payload cwd set to the directory, `good.txt` is the compliant one,
    // while sub/good.txt holds "Nope" and would deny if the cd leaked.
    assert.equal(run(`(cd ${posix}/sub && git commit -m "chore: ok"); git commit -F good.txt`, dir).decision, "allow");
    assert.equal(run(`(cd ${posix}/sub && git commit -m "chore: ok"); cd ${posix}/sub && git commit -F good.txt`, dir).decision, "deny");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Git Bash paths resolve on Windows", { skip: !WIN32 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "git-conventions-"));
  try {
    writeFileSync(join(dir, "bad.txt"), "Nope\n");
    writeFileSync(join(dir, "good.txt"), "chore: tidy\n");
    const drive = /^([A-Za-z]):/.exec(dir)[1].toLowerCase();
    const msys = `/${drive}${dir.slice(2).replace(/\\/g, "/")}`;
    assert.equal(run(`cd ${msys} && git commit -F bad.txt`, process.cwd()).decision, "deny");
    assert.equal(run(`git -C ${msys} commit -F bad.txt`, process.cwd()).decision, "deny");
    assert.equal(run(`cd ${msys} && git commit -F good.txt`, process.cwd()).decision, "allow");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an input the hook cannot make sense of passes", () => {
  assert.equal(run("git commit -m \"nope\"", process.cwd(), {}).decision, "allow");
  const broken = spawnSync(process.execPath, [HOOK], { input: "{not json", encoding: "utf-8" });
  assert.equal(broken.status, 0);
  assert.equal(broken.stdout, "");
  const empty = spawnSync(process.execPath, [HOOK], { input: "", encoding: "utf-8" });
  assert.equal(empty.status, 0);
  assert.equal(empty.stdout, "");
});

test("skip work for commands without git", () => {
  const started = process.hrtime.bigint();
  run("npm test");
  const withoutGit = Number(process.hrtime.bigint() - started) / 1e6;
  const again = process.hrtime.bigint();
  run("git commit -m \"chore: ok\"");
  const withGit = Number(process.hrtime.bigint() - again) / 1e6;
  assert.ok(withoutGit < 2000 && withGit < 2000, `too slow: ${withoutGit}ms / ${withGit}ms`);
});
