import assert from "node:assert/strict";
import { test } from "node:test";
import { permalink } from "./format.js";
import { matches, parseLink, parseSince } from "./read.js";

test("--since takes minutes, hours or days back from now, or a date", () => {
  const now = Date.parse("2026-01-02T12:00:00Z");
  assert.equal(parseSince("1d", now), (Date.parse("2026-01-01T12:00:00Z") / 1000).toFixed(6));
  assert.equal(parseSince("90m", now), (Date.parse("2026-01-02T10:30:00Z") / 1000).toFixed(6));
  assert.equal(parseSince("2025-12-30", now), (Date.parse("2025-12-30") / 1000).toFixed(6));
  assert.throws(() => parseSince("yesterday", now), /--since takes/);
});

test("a permalink parses back to its channel and message, and a reply's to its thread too", () => {
  const reply = permalink("https://x.slack.com/", "C0123ABCD", "1700000001.000200", "1700000000.000100");
  assert.equal(reply, "https://x.slack.com/archives/C0123ABCD/p1700000001000200?thread_ts=1700000000.000100&cid=C0123ABCD");
  assert.deepEqual(parseLink(reply), { channel: "C0123ABCD", ts: "1700000001.000200", thread: "1700000000.000100" });
  assert.deepEqual(parseLink(permalink("https://x.slack.com/", "C0123ABCD", "1700000000.000100")), {
    channel: "C0123ABCD",
    ts: "1700000000.000100",
    thread: undefined,
  });
  assert.equal(parseLink("C0123ABCD"), undefined);
});

test("a search matches every word, in any case and order", () => {
  assert.equal(matches("The API key leak is contained", "leak api"), true);
  assert.equal(matches("The API key leak is contained", "leak billing"), false);
});
