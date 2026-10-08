import assert from "node:assert/strict";
import { test } from "node:test";
import { commandsOf } from "./commands.js";

test("chained commands each count, whatever joins them", () => {
  assert.deepEqual(commandsOf("cd /repo && git push --force origin main; echo done | tail -1 || true & wait"), [
    "cd /repo",
    "git push --force origin main",
    "echo done",
    "tail -1",
    "true",
    "wait",
  ]);
  assert.deepEqual(commandsOf("make build\ngit push"), ["make build", "git push"]);
});

test("quoted operators are text, not separators", () => {
  assert.deepEqual(commandsOf(`git commit -m "fix a && b; c | d" && git log -1`), [`git commit -m "fix a && b; c | d"`, "git log -1"]);
  assert.deepEqual(commandsOf("echo 'x; rm -rf /'"), ["echo 'x; rm -rf /'"]);
});

test("redirections are not separators", () => {
  assert.deepEqual(commandsOf("make build 2>&1 >/dev/null &>out.log"), ["make build 2>&1 >/dev/null &>out.log"]);
});

test("command substitutions and backticks are commands, even inside double quotes", () => {
  assert.ok(commandsOf(`echo "$(git push --force)"`).includes("git push --force"));
  assert.ok(commandsOf("echo `git push -f`").includes("git push -f"));
  assert.ok(commandsOf("echo $(cd /repo && git push)").includes("git push"));
});

test("a heredoc body is data, and its quotes don't leak into the rest of the line", () => {
  const line = `cd /repo && gh pr review 7 --approve --body "$(cat <<'EOF'
It's fine; rm -rf / is only text here.
EOF
)" 2>&1 | tail -5`;
  const commands = commandsOf(line);
  assert.ok(commands.some((c) => c.startsWith("gh pr review 7 --approve")));
  assert.ok(commands.includes("cd /repo"));
  assert.ok(commands.includes("tail -5"));
  assert.ok(!commands.some((c) => c.startsWith("rm")));
});

test("a command after a heredoc's line still counts", () => {
  const commands = commandsOf("cat > notes.txt <<EOF && git push --force\nbody\nEOF\necho after");
  assert.ok(commands.includes("git push --force"));
  assert.ok(commands.includes("echo after"));
  assert.ok(!commands.includes("body"));
});

test("a here-string is not a heredoc", () => {
  assert.ok(commandsOf("cat <<< 'x'\ngit push --force").includes("git push --force"));
});

test("comments are skipped", () => {
  assert.deepEqual(commandsOf("ls # don't && git push\npwd"), ["ls", "pwd"]);
});

test("subshells, groups and conditionals expose their commands", () => {
  assert.ok(commandsOf("(cd /repo && git push)").includes("git push"));
  assert.ok(commandsOf("{ git push; }").includes("git push"));
  assert.ok(commandsOf("if true; then git push; fi").includes("git push"));
});

test("assignments, wrappers, paths and git's global options are stripped", () => {
  assert.deepEqual(commandsOf("FOO=1 sudo git -C /repo push --force"), ["git push --force"]);
  assert.deepEqual(commandsOf("env -i A='b c' /usr/bin/git --no-pager push"), ["git push"]);
  assert.deepEqual(commandsOf("echo x | xargs git push"), ["echo x", "git push"]);
});

test("bash -c and eval strings are commands too", () => {
  assert.ok(commandsOf("bash -lc 'cd /repo && git push --force'").includes("git push --force"));
  assert.ok(commandsOf(`eval "git push --force"`).includes("git push --force"));
});
