import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Follower, logEvent, transcriptEvents } from "./watch.js";

test("the log keeps mentions, denials, turns and failures, and drops routine Socket Mode noise", () => {
  assert.equal(logEvent("[denied] U1 in C1 thread 1.2: hello"), "[denied] U1 in C1 thread 1.2: hello");
  assert.equal(logEvent(" ELIFECYCLE  Command failed with exit code 143."), " ELIFECYCLE  Command failed with exit code 143.");
  assert.equal(logEvent("[ERROR]  bolt-app WebSocket error! SMWebsocketError"), undefined);
  assert.equal(logEvent("[WARN]  bolt-app A pong wasn't received from the server before the timeout of 5000ms!"), undefined);
});

test("a transcript line is one event per tool call and per failed tool result", () => {
  const call = {
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "Looking." },
        { type: "tool_use", name: "Bash", input: { command: "git status", description: "Show working tree status" } },
        { type: "tool_use", name: "Skill", input: { skill: "create-pr" } },
      ],
    },
  };
  assert.deepEqual(transcriptEvents(JSON.stringify(call)), ["[tool] Bash Show working tree status", "[tool] Skill create-pr"]);
  const results = {
    type: "user",
    message: { content: [{ type: "tool_result", is_error: true, content: "Memory is read-only from Slack." }, { type: "tool_result", content: "ok" }] },
  };
  assert.deepEqual(transcriptEvents(JSON.stringify(results)), ["[tool error] Memory is read-only from Slack."]);
  assert.deepEqual(transcriptEvents("not json"), []);
});

test("a follower returns whole new lines only, even when a write splits a character", () => {
  const path = join(mkdtempSync(join(tmpdir(), "watch-")), "bot.log");
  writeFileSync(path, "before the watch\n");
  const follower = new Follower(path);
  const line = Buffer.from("second ✅\n");
  appendFileSync(path, "first\n");
  appendFileSync(path, line.subarray(0, 9));
  assert.deepEqual(follower.lines(), ["first"]);
  appendFileSync(path, line.subarray(9));
  assert.deepEqual(follower.lines(), ["second ✅"]);
  assert.deepEqual(follower.lines(), []);
});
