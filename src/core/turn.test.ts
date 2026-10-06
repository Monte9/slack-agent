import assert from "node:assert/strict";
import { test } from "node:test";
import { instructionsNote } from "./turn.js";

test("a session hears that its instructions changed; a new session or an unchanged one hears nothing", () => {
  const session = { sessionId: "s1", createdAt: "", lastTurnAt: "", turns: 3, model: "m", instructionsHash: "a" };
  assert.match(instructionsNote(session, "b"), /^\[system\] Your instructions changed/);
  assert.equal(instructionsNote(session, "a"), "");
  assert.equal(instructionsNote(undefined, "a"), "");
  assert.match(instructionsNote({ ...session, instructionsHash: undefined }, "a"), /changed/);
});
