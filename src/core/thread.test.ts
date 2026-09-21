import assert from "node:assert/strict";
import { test } from "node:test";
import { formatContext, plainText, type ContextMessage } from "./thread.js";

const names: Record<string, string> = { U1: "Martijn", U2: "Monte", UBOT: "mclaude" };
const nameOf = (id: string) => names[id] ?? id;

test("mrkdwn becomes plain text with names and URLs kept", () => {
  assert.equal(
    plainText("<@U2> see <https://github.com/o/r/pull/3162|fix(RB-9710): batch updates> in <#C1|team-eng> &amp; <https://x.y>", nameOf),
    "@Monte see fix(RB-9710): batch updates (https://github.com/o/r/pull/3162) in #team-eng & https://x.y",
  );
  assert.equal(plainText("<!here> and <!subteam^S1|@eng>", nameOf), "@here and @eng");
});

const thread: ContextMessage[] = [
  { ts: "100.1", user: "U1", text: "Would you be able to review these?\n<https://github.com/o/r/pull/3162|#3162>" },
  { ts: "100.2", user: "U2", text: "Yes, for sure" },
  { ts: "100.3", user: "U2", text: "<@UBOT> please review both" },
  { ts: "100.4", user: "UBOT", text: "🤔 thinking" },
];

test("a thread keeps what came before the mention, oldest first, and drops the rest", () => {
  const { text, count } = formatContext("thread", [...thread].reverse(), "100.3", nameOf);
  assert.equal(count, 2);
  assert.match(text, /^The thread this was posted in/);
  assert.match(text, /- Martijn at 1970-01-01 00:01 UTC: Would you be able to review these\?\n  #3162 \(https:\/\/github.com\/o\/r\/pull\/3162\)\n- Monte at .*: Yes, for sure$/);
  assert.doesNotMatch(text, /please review both|thinking/);
});

test("nothing before the mention means no context block", () => {
  assert.deepEqual(formatContext("channel", [thread[2]!], "100.3", nameOf), { text: "", count: 0 });
});

test("a bot card with no text still shows its attachment, and long messages are cut", () => {
  const messages: ContextMessage[] = [
    { ts: "1.0", bot_profile: { name: "GitHub" }, attachments: [{ fallback: "[o/r] PR #3164: remove legacy replay" }] },
    { ts: "2.0", user: "U1", text: "x".repeat(2500) },
  ];
  const { text } = formatContext("channel", messages, "3.0", nameOf);
  assert.match(text, /^The channel messages just above this one/);
  assert.match(text, /- GitHub at .*: \[attachment: \[o\/r\] PR #3164: remove legacy replay\]/);
  assert.match(text, new RegExp(`- Martijn at .*: x{2000}…$`));
});
