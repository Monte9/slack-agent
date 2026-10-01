import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Ledger } from "./ledger.js";

test("the ledger appends one timestamped JSON line per event, readable by the owner only", () => {
  const ledger = new Ledger(mkdtempSync(join(tmpdir(), "ledger-")));
  ledger.record({ type: "connection", state: "connected" });
  ledger.record({ type: "denied", user: "U1", channel: "C1", thread: "1.2", text: "do you work?" });
  const lines = readFileSync(ledger.path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(
    lines.map(({ at: _at, ...event }) => event),
    [
      { type: "connection", state: "connected" },
      { type: "denied", user: "U1", channel: "C1", thread: "1.2", text: "do you work?" },
    ],
  );
  assert.match(lines[0].at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(statSync(ledger.path).mode & 0o777, 0o600);
});
