import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { crashLine, describeLedger, Follower } from "./watch.js";

const at = "2026-10-01T18:31:12.000Z";

test("the console shows only crashes, not Bolt's routine Socket Mode noise", () => {
  assert.equal(crashLine(" ELIFECYCLE  Command failed with exit code 1."), " ELIFECYCLE  Command failed with exit code 1.");
  assert.equal(crashLine("Error: config.json: project path does not exist: /x"), "Error: config.json: project path does not exist: /x");
  assert.equal(crashLine("[ERROR]  bolt-app WebSocket error! SMWebsocketError"), undefined);
  assert.equal(crashLine("[WARN]  bolt-app A pong wasn't received from the server before the timeout of 5000ms!"), undefined);
});

test("ledger lines read as one line of text each", () => {
  assert.equal(
    describeLedger({ at, type: "mention", user: "U1", channel: "C1", thread: "1.2", queue: 0, earlier: 3, text: "share #3297" }),
    "mention from U1 in C1 thread 1.2 (queue 0, 3 earlier): share #3297",
  );
  const stats = { durationMs: 14_000, costUsd: 0.4, toolCalls: 1, inputTokens: 89_000, outputTokens: 623, contextTokens: 52_000 };
  assert.equal(
    describeLedger({ at, type: "turn", channel: "C1", thread: "1.2", session: "s1", turn: 1, stats, revised: false, error: false, fresh: false }),
    "turn 1 · 14s · 1 tool call · 89k in / 623 out · 52k context · ~$0.40 at API rates · session s1",
  );
  assert.equal(
    describeLedger({ at, type: "posted", channel: "C1", thread: "1.2", ts: "3.4", messages: 1, broadcast: true }),
    "posted 1 message in C1 thread 1.2, sent to channel",
  );
  assert.equal(
    describeLedger({ at, type: "posted", channel: "C1", thread: "1.2", ts: "3.4", messages: 1, broadcast: false, elsewhere: { channel: "C2", ts: "5.6" } }),
    "posted 1 message in C2, asked in C1 thread 1.2",
  );
  assert.equal(
    describeLedger({ at, type: "policy", requester: "U1", owner: true, tool: "Bash", decision: "allow", rule: "Bash(git push*)", input: "{}" }),
    "policy allow Bash (Bash(git push*))",
  );
});

test("a follower returns whole new lines only, even when a write splits a character", () => {
  const path = join(mkdtempSync(join(tmpdir(), "watch-")), "events.jsonl");
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
