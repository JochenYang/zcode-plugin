#!/usr/bin/env node
// PreToolUse hook for Bash: reject a git commit whose message breaks the
// convention before git runs.
//
// The convention:
//   <type>(<scope>): <subject>   lowercase first letter, no period, <= 50 chars
//   body (optional)               one "- " bullet per change, last line
//                                 `Verified: <what was run>` (may wrap)
//
// Only a message that the command itself writes is judged: -m/--message and
// -F/--file (a file, or "-" fed by a heredoc or a here-string). A commit that
// writes no new message (--amend --no-edit, -C, --fixup, a bare `git commit`,
// which never takes its message from stdin) passes. So does anything this
// hook cannot read: a message that still contains an expansion it cannot
// resolve, an unreadable file, input it cannot make sense of. A convention
// guard must never be the reason a commit fails.
//
// Needs node 14 or later on PATH; hooks get no built-in fallback. Without it
// the hook does not run and every commit passes.
//
// Exit code is always 0.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";

const TYPES = ["feat", "fix", "docs", "style", "refactor", "perf", "test", "chore", "build", "ci", "revert"];
const SUBJECT_LIMIT = 50;
// The scope has no case rule of its own and `!` is Conventional Commits'
// breaking-change marker; what the convention constrains is the description.
const SUBJECT_HEAD = new RegExp(`^(?:${TYPES.join("|")})(?:\\([^()]+\\))?!?: `);
const SUBJECT = new RegExp(`${SUBJECT_HEAD.source}[a-z]`);
const VERIFIED = /^Verified: \S/;
// A word that still carries an expansion cannot be judged from its text alone.
const EXPANSION = /[$`]/;
const CAT_HEREDOC = /^\$\(cat <<-?(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1\r?\n([\s\S]*?)\r?\n\t*\2\r?\n?\)$/;
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;
// Quoted text is echoed back in a denial; bound it so a huge message cannot
// inflate the tool error or reflect a whole file into the conversation.
const ECHO_LIMIT = 120;

// Reserved words and wrappers a commit may hide behind: `if git commit …`,
// `do git commit …`, `{ git commit …; }`, `! git commit …`, `sudo git commit …`.
const LEADERS = new Set(["command", "exec", "nohup", "time", "nice", "env", "export", "sudo",
  "do", "then", "else", "elif", "if", "while", "until", "{", "!"]);
// Words that take options, so an option right after one is not a command name.
const OPTION_TAKERS = new Set(["command", "exec", "nohup", "time", "nice", "env", "sudo"]);
const GIT_GLOBAL_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);
const REUSE = new Set(["-C", "-c", "--reuse-message", "--reedit-message", "--fixup", "--squash"]);
// Long options that always take the value as the next word.
const COMMIT_LONG_WITH_VALUE = new Set(["--cleanup", "--author", "--date", "--template", "--pathspec-from-file"]);
const CONTROL = new Set([";", "&&", "||", "|", "|&", "&", "(", ")", "\n"]);
const REDIRECT = new Set([">", ">>", "<", ">&", "<&"]);

// ---------------------------------------------------------------- lexer ----

// Words with their quotes removed, plus operators. No expansion is performed;
// a word is only marked when bash would expand something in it. Heredoc
// bodies are collected in the order their operators appear, so a command can
// find the body its `-F -` reads.
function lex(text) {
  const tokens = [];
  const heredocs = [];
  const waiting = [];
  let word = "";
  let started = false;
  let expanded = false;
  let quote = null;

  const endWord = () => {
    if (!started) return;
    tokens.push({ word, expanded });
    word = "";
    started = false;
    expanded = false;
  };
  const operator = (value) => {
    endWord();
    tokens.push({ op: value });
  };

  for (let i = 0; i < text.length;) {
    const c = text[i];

    if (quote === "'") {
      if (c === "'") quote = null;
      else word += c;
      i += 1;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === "\\" && i + 1 < text.length && '"\\$`\n'.includes(text[i + 1])) {
        if (text[i + 1] !== "\n") word += text[i + 1];
        i += 2;
        continue;
      } else {
        word += c;
        if (c === "$" || c === "`") expanded = true;
      }
      i += 1;
      continue;
    }

    if (c === "'" || c === '"') {
      quote = c;
      started = true;
      i += 1;
      continue;
    }
    if (c === "\\" && i + 1 < text.length) {
      if (text[i + 1] !== "\n") word += text[i + 1];
      started = true;
      i += 2;
      continue;
    }

    if (c === "\n") {
      endWord();
      let j = i + 1;
      // The bodies of every heredoc opened on the line just ended follow here.
      while (waiting.length > 0) {
        const slot = waiting.shift();
        const lines = [];
        for (;;) {
          const stop = text.indexOf("\n", j);
          const line = stop === -1 ? text.slice(j) : text.slice(j, stop);
          const bare = slot.dash ? line.replace(/^\t+/, "") : line;
          if (bare === slot.delim) {
            j = stop === -1 ? text.length : stop + 1;
            break;
          }
          // <<- strips the leading tabs of the body lines as well.
          lines.push(bare);
          if (stop === -1) {
            j = text.length;
            break;
          }
          j = stop + 1;
        }
        heredocs.push({ text: lines.join("\n"), literal: slot.literal });
      }
      i = j;
      tokens.push({ op: "\n" });
      continue;
    }

    if (c === " " || c === "\t" || c === "\r") {
      endWord();
      i += 1;
      continue;
    }

    if (text.startsWith("<<<", i)) {
      operator("<<<");
      i += 3;
      continue;
    }
    if (text.startsWith("<<", i)) {
      let j = i + 2;
      let dash = false;
      if (text[j] === "-") {
        dash = true;
        j += 1;
      }
      let k = j;
      while (text[k] === " " || text[k] === "\t") k += 1;
      const backquote = text[k] === "'" || text[k] === '"' ? text[k] : null;
      if (backquote) k += 1;
      const from = k;
      while (k < text.length && /[A-Za-z0-9_]/.test(text[k])) k += 1;
      const delim = text.slice(from, k);
      if (backquote && text[k] === backquote) k += 1;
      if (delim === "") {
        // Not a heredoc after all (a comparison, a literal in a printf, ...).
        word += c;
        started = true;
        i += 1;
        continue;
      }
      endWord();
      // An unquoted delimiter lets bash expand the body, so it is only literal
      // when it carries nothing to expand.
      waiting.push({ delim, dash, literal: backquote !== null });
      tokens.push({ heredoc: -1 }); // the index is filled in once the body is read
      i = k;
      continue;
    }

    const two = ["&&", "||", ">>", ";;", "|&", ">&", "<&"].find((pair) => text.startsWith(pair, i));
    if (two) {
      operator(two);
      i += 2;
      continue;
    }
    if (";|&<>()".includes(c)) {
      operator(c);
      i += 1;
      continue;
    }

    word += c;
    started = true;
    if (c === "$" || c === "`") expanded = true;
    i += 1;
  }
  endWord();

  // Point every heredoc token at its body.
  let seen = 0;
  for (const token of tokens) {
    if (token.heredoc === -1) token.heredoc = seen++;
  }
  return { tokens, heredocs };
}

// Split the token stream into simple commands. A redirection's target is not
// part of the command; a here-string's words become one inline body; a
// parenthesis is kept as a marker so a `cd` inside a subshell stays there.
function simpleCommands(tokens) {
  const commands = [];
  let current = [];
  const flush = () => {
    if (current.length > 0) commands.push(current);
    current = [];
  };
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.op === undefined) {
      current.push(token);
      continue;
    }
    if (REDIRECT.has(token.op)) {
      i += 1;
      continue;
    }
    if (token.op === "<<<") {
      const words = [];
      while (tokens[i + 1] !== undefined && tokens[i + 1].op === undefined) {
        i += 1;
        words.push(tokens[i]);
      }
      current.push({ text: words.map((part) => part.word).join(" "), literal: !words.some((part) => part.expanded) });
      continue;
    }
    if (token.op === "(" || token.op === ")") {
      flush();
      commands.push({ paren: token.op });
      continue;
    }
    if (CONTROL.has(token.op)) flush();
  }
  flush();
  return commands;
}

// A path the way Git Bash writes it: `/d/x` is `D:\x` on Windows and `~` is
// the home directory. Anything else is left to path.resolve.
function shellPath(value) {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return resolve(homedir(), value.slice(2));
  const drive = /^\/([a-zA-Z])(\/|$)/.exec(value);
  if (process.platform === "win32" && drive) return `${drive[1].toUpperCase()}:${value.slice(2)}`;
  return value;
}

// ------------------------------------------------------------- git commit ----

const isExpanded = (text) => EXPANSION.test(text);
const programName = (word) => basename(word).replace(/\.exe$/i, "").toLowerCase();
const echo = (text) => (text.length > ECHO_LIMIT ? `${text.slice(0, ECHO_LIMIT - 3)}...` : text);

// The message a `git commit` command writes, as lines, or null when it writes
// none that can be judged.
function commitMessage(parts, sources, variables, directory) {
  const words = parts.map((part) => part.word);
  if (words[0] !== "commit") return null;
  let index = 1;

  const messages = [];
  let file = null;
  while (index < words.length) {
    const option = words[index];
    const part = parts[index];
    if (option === "--") break;
    if (option === "-m" || option === "--message") {
      messages.push(parts[index + 1] ?? { word: "", expanded: false });
      index += 2;
      continue;
    }
    if (option.startsWith("--message=")) {
      messages.push({ word: option.slice("--message=".length), expanded: part.expanded });
      index += 1;
      continue;
    }
    if (option === "-F" || option === "--file") {
      file = parts[index + 1] ?? { word: "", expanded: false };
      index += 2;
      continue;
    }
    if (option.startsWith("--file=")) {
      file = { word: option.slice("--file=".length), expanded: part.expanded };
      index += 1;
      continue;
    }
    if (REUSE.has(option) || option.startsWith("--reuse-message=") || option.startsWith("--reedit-message=")
      || option.startsWith("--fixup=") || option.startsWith("--squash=")) {
      index += option.includes("=") ? 1 : 2;
      continue;
    }
    if (COMMIT_LONG_WITH_VALUE.has(option)) {
      index += 2;
      continue;
    }
    if (option.startsWith("--")) {
      index += 1;
      continue;
    }
    if (option.startsWith("-") && option.length > 1) {
      // A cluster of short options: -am, -qam "message", -F-, -m"message".
      let letter = 1;
      while (letter < option.length) {
        const flag = option[letter];
        const rest = option.slice(letter + 1);
        if (flag === "m" || flag === "F") {
          const value = rest !== "" ? { word: rest, expanded: part.expanded } : parts[index + 1];
          if (flag === "m") messages.push(value ?? { word: "", expanded: false });
          else file = value ?? { word: "", expanded: false };
          index += rest !== "" ? 0 : 1;
          break;
        }
        if ((flag === "C" || flag === "c" || flag === "t") && rest === "") {
          index += 1; // these take their value as the next word
          break;
        }
        letter += 1;
      }
      index += 1;
      continue;
    }
    index += 1; // a pathspec: options may still follow until "--"
  }

  const chunks = [];
  if (messages.length > 0) {
    for (const message of messages) {
      const substitution = CAT_HEREDOC.exec(message.word);
      if (substitution) {
        chunks.push({ text: substitution[3], literal: substitution[1] !== "" });
        continue;
      }
      const variable = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(message.word);
      if (variable && variables.has(variable[1])) {
        const value = variables.get(variable[1]);
        chunks.push({ text: value.word, literal: !value.expanded });
        continue;
      }
      chunks.push({ text: message.word, literal: !message.expanded });
    }
  } else if (file !== null) {
    if (file.word === "-") {
      const source = sources[0];
      if (source === undefined) return null; // stdin comes from somewhere this hook cannot see
      chunks.push(source);
    } else {
      if (file.expanded) return null;
      try {
        chunks.push({ text: readFileSync(resolve(directory, shellPath(file.word)), "utf8"), literal: true });
      } catch {
        return null;
      }
    }
  } else {
    return null; // the editor, a template, --amend --no-edit, -C: nothing new is written
  }

  // A chunk bash would still expand cannot be judged from its text.
  if (chunks.some((chunk) => !chunk.literal && isExpanded(chunk.text))) return null;

  const lines = chunks.map((chunk) => chunk.text).join("\n\n").replace(/\r\n?/g, "\n")
    .split("\n").map((line) => line.trimEnd());
  // git drops the commented part of a message it reads from a file.
  const kept = file !== null ? lines.filter((line) => !line.startsWith("#")) : lines;
  while (kept.length > 0 && kept[0] === "") kept.shift();
  while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();
  return kept.length > 0 ? kept : null;
}

function check(lines) {
  const problems = [];
  const [subject, ...body] = lines;
  if (!SUBJECT.test(subject)) {
    problems.push(SUBJECT_HEAD.test(subject)
      ? `the subject must start with a lowercase letter after the colon — got "${echo(subject)}"`
      : `the subject must be <type>(<scope>): <subject> with one of the types ${TYPES.join(", ")} — got "${echo(subject)}"`);
  }
  if (subject.length > SUBJECT_LIMIT) {
    problems.push(`the subject is ${subject.length} characters, the limit is ${SUBJECT_LIMIT}`);
  }
  if (subject.endsWith(".")) {
    problems.push("the subject must not end with a period");
  }

  // The Verified line may wrap, and it may directly follow the bullets. What
  // must hold: the last line that starts with "Verified:" has only bullets
  // before it and only its own wrapped text after it.
  let last = body.length - 1;
  while (last >= 0 && body[last].trim() === "") last -= 1;
  if (last < 0) return problems; // no body: nothing else to require

  let verifiedAt = -1;
  for (let i = 0; i <= last; i += 1) {
    if (VERIFIED.test(body[i])) verifiedAt = i;
  }
  if (verifiedAt < 0) {
    problems.push(`the body must end with a "Verified: <what was run>" line — got "${echo(body[last])}"`);
    verifiedAt = last + 1;
  }
  for (const line of body.slice(0, verifiedAt)) {
    if (line.trim() === "" || /^-(\s|$)/.test(line) || /^\s+\S/.test(line)) continue;
    problems.push(`every line of the body must be a "- " bullet or its indented continuation — got "${echo(line)}"`);
  }
  for (const line of body.slice(verifiedAt + 1, last + 1)) {
    if (line.trim() === "") continue;
    if (/^-(\s|$)/.test(line) || VERIFIED.test(line)) {
      problems.push(`nothing may follow the Verified line but its own wrapped text — got "${echo(line)}"`);
    }
  }
  return problems;
}

// Walk one shell script and return every convention problem in the commit
// messages it writes. `directory` is where relative paths resolve.
function violations(script, directory) {
  const { tokens, heredocs } = lex(script);
  const variables = new Map();
  const problems = [];
  const directories = [];
  let cwd = directory;

  for (const command of simpleCommands(tokens)) {
    if (command.paren !== undefined) {
      if (command.paren === "(") directories.push(cwd);
      else cwd = directories.pop() ?? cwd;
      continue;
    }
    const parts = command.filter((token) => token.word !== undefined);
    const sources = command.filter((token) => token.heredoc !== undefined).map((token) => heredocs[token.heredoc])
      .concat(command.filter((token) => token.literal !== undefined));

    let index = 0;
    while (index < parts.length) {
      const word = parts[index].word;
      if (LEADERS.has(word) || (word.startsWith("-") && index > 0 && OPTION_TAKERS.has(parts[index - 1].word))) {
        index += 1;
        continue;
      }
      break;
    }
    while (index < parts.length) {
      const assignment = ASSIGNMENT.exec(parts[index].word);
      if (!assignment) break;
      variables.set(assignment[1], { word: assignment[2], expanded: parts[index].expanded });
      index += 1;
    }
    const rest = parts.slice(index);
    if (rest.length === 0) continue;
    const words = rest.map((part) => part.word);

    const name = programName(words[0]);
    if (name === "cd") {
      if (rest[1] !== undefined && !words[1].startsWith("-") && !rest[1].expanded) {
        cwd = resolve(cwd, shellPath(words[1]));
      }
      continue;
    }
    if ((name === "sh" || name === "bash" || name === "zsh" || name === "dash" || name === "eval")
      && rest[name === "eval" ? 1 : 2] !== undefined && (name === "eval" || words[1] === "-c")) {
      problems.push(...violations(rest[name === "eval" ? 1 : 2].word, cwd));
      continue;
    }
    if (name !== "git") continue;

    // git's own global options end at the subcommand. `-C <path>` runs the
    // subcommand as if git had been started there, so a relative message
    // path resolves against it.
    let at = 1;
    let gitDirectory = cwd;
    while (at < rest.length) {
      const option = words[at];
      if (option === "-C") {
        if (rest[at + 1] !== undefined && !rest[at + 1].expanded) {
          gitDirectory = resolve(gitDirectory, shellPath(words[at + 1]));
        }
        at += 2;
        continue;
      }
      if (GIT_GLOBAL_WITH_VALUE.has(option)) {
        at += 2;
        continue;
      }
      if (option.startsWith("-")) {
        at += 1;
        continue;
      }
      break;
    }
    if (words[at] !== "commit") continue;

    const message = commitMessage(rest.slice(at), sources, variables, gitDirectory);
    if (message !== null) problems.push(...check(message));
  }
  return problems;
}

function main() {
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return;
  }
  const input = payload.tool_input ?? payload.toolInput;
  const script = input && typeof input.command === "string" ? input.command : "";
  if (!/\bgit\b/.test(script)) return; // fast path: the hook runs on every Bash call
  const directory = typeof payload.cwd === "string" && payload.cwd !== "" ? payload.cwd : process.cwd();

  let problems = [];
  try {
    problems = violations(script, directory);
  } catch {
    return; // never let a parsing mistake block a commit
  }
  if (problems.length === 0) return;

  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        `Commit message rejected: ${problems.join("; ")}. Rewrite the message and commit again; `
        + "--no-verify does not bypass this check.",
    },
  }));
}

main();
