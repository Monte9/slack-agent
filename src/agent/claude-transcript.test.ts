import assert from "node:assert/strict";
import { test } from "node:test";
import { readTranscriptLine } from "./claude-transcript.js";

const at = "2026-10-01T18:31:12.000Z";

test("an assistant entry gives its text and one event per tool call", () => {
  const entry = {
    type: "assistant",
    timestamp: at,
    message: {
      content: [
        { type: "thinking", thinking: "private" },
        { type: "text", text: "Looking." },
        { type: "tool_use", name: "Bash", input: { command: "git status", description: "Show working tree status" } },
        { type: "tool_use", name: "Skill", input: { skill: "create-pr" } },
      ],
    },
  };
  assert.deepEqual(readTranscriptLine(JSON.stringify(entry)), [
    { at, kind: "text", text: "Looking." },
    { at, kind: "tool", text: "Bash Show working tree status" },
    { at, kind: "tool", text: "Skill create-pr" },
  ]);
});

test("a tool result shows only when it failed, and unknown or broken lines show nothing", () => {
  const results = {
    type: "user",
    timestamp: at,
    message: { content: [{ type: "tool_result", is_error: true, content: "Memory is read-only from Slack." }, { type: "tool_result", content: "ok" }] },
  };
  assert.deepEqual(readTranscriptLine(JSON.stringify(results)), [{ at, kind: "tool error", text: "Memory is read-only from Slack." }]);
  assert.deepEqual(readTranscriptLine(JSON.stringify({ type: "attachment", attachment: { type: "skill_listing" } })), []);
  assert.deepEqual(readTranscriptLine("not json"), []);
});
