import assert from "node:assert/strict";
import { test } from "node:test";
import { channelShare, chunk, linkedChannels, splitTable, strayShare, tableBlock, toMrkdwn, wordCount } from "./format.js";

const reply = [
  "Six kinds. The target is the bottom row.",
  "| Kind | Files | Lines |",
  "|---|---:|---:|",
  "| Root `AGENTS.md` | 2 | 149 |",
  "| **Skills** | 26 | [7.7k](https://x.y/s) |",
  "| Plans | | 10.3k |",
  "Want the delete list?",
].join("\n");

test("a table splits from the text around it, and a link's pipe is not a column", () => {
  const table = splitTable(toMrkdwn(reply));
  assert.equal(table?.before, "Six kinds. The target is the bottom row.");
  assert.equal(table?.after, "Want the delete list?");
  assert.deepEqual(table?.align, [undefined, "right", "right"]);
  assert.deepEqual(table?.rows.slice(2), [
    ["*Skills*", "26", "<https://x.y/s|7.7k>"],
    ["Plans", "", "10.3k"],
  ]);
});

test("cells keep code, bold and links, the header is bold, and an empty cell is a space", () => {
  const block = tableBlock(splitTable(toMrkdwn(reply))!);
  const cell = (r: number, c: number) => block.rows[r]?.[c];
  const rich = (...elements: unknown[]) => ({ type: "rich_text", elements: [{ type: "rich_text_section", elements }] });
  assert.deepEqual(block.column_settings, [{ is_wrapped: true }, { align: "right", is_wrapped: true }, { align: "right", is_wrapped: true }]);
  assert.deepEqual(cell(0, 0), rich({ type: "text", text: "Kind", style: { bold: true } }));
  assert.deepEqual(
    cell(1, 0),
    rich({ type: "text", text: "Root ", style: { bold: false } }, { type: "text", text: "AGENTS.md", style: { bold: false, code: true } }),
  );
  assert.deepEqual(cell(2, 0), rich({ type: "text", text: "Skills", style: { bold: true } }));
  assert.deepEqual(cell(2, 2), rich({ type: "link", url: "https://x.y/s", text: "7.7k", style: { bold: false } }));
  assert.deepEqual(cell(3, 1), { type: "raw_text", text: " " });
});

test("no table inside code, without body rows, past Slack's row limit, or from a heading rule", () => {
  assert.equal(splitTable("```\n| a | b |\n|---|---|\n| 1 | 2 |\n```"), undefined);
  assert.equal(splitTable("| a | b |\n|---|---|"), undefined);
  assert.equal(splitTable(["| n |", "|---|", ...Array.from({ length: 100 }, (_, i) => `| ${i} |`)].join("\n")), undefined);
  assert.equal(splitTable("Summary\n---\nmore"), undefined);
});

test("a long reply splits on line breaks, never inside a table or code block, and a table adds nothing to its size", () => {
  const table = ["| PR | What |", "|---|---|", ...Array.from({ length: 4 }, (_, i) => `| #${i} | ${"x".repeat(30)} |`)].join("\n");
  const code = ["```", "a".repeat(20), "b".repeat(20), "```"].join("\n");
  assert.deepEqual(chunk(["Summary line.", table, "After the table.", code].join("\n"), { limit: 50 }), [
    ["Summary line.", table, "After the table."].join("\n"),
    code,
  ]);
  assert.ok(chunk(["Summary line.", table].join("\n"), { limit: 50, tables: false }).every((part) => part.length <= 50));
  assert.deepEqual(chunk("y".repeat(90), { limit: 50 }), ["y".repeat(50), "y".repeat(40)]);
});

test("a code block too long for one message is cut between lines and closed and reopened in each part", () => {
  const lines = Array.from({ length: 6 }, (_, i) => `line ${i} ${"z".repeat(10)}`);
  const parts = chunk(["```ts", ...lines, "```"].join("\n"), { limit: 50 });
  assert.ok(parts.every((part) => part.startsWith("```ts\n") && part.endsWith("\n```") && part.length <= 50));
  assert.deepEqual(
    parts.flatMap((part) => part.split("\n").slice(1, -1)),
    lines,
  );
  assert.deepEqual(chunk(`${"word ".repeat(15)}end`, { limit: 30 }), [
    "word word word word word word",
    "word word word word word word",
    "word word word end",
  ]);
});

test("table rows do not count toward the word cap", () => {
  assert.equal(wordCount(reply), 12);
});

test("changelog entries do not count toward the word cap, and the lines around them do", () => {
  const post = ["*Release 0.1.2* (diff)", "*Fixes*", "- [#12](https://x.y/12): one two three four", "- [ABC-34: t](https://x.y/34): five", "*Risk: low*", "- seven eight"];
  assert.equal(wordCount(post.join("\n")), 8);
});

test("blank lines go, except one before a bold line that starts a section, and a bullet is not a section", () => {
  assert.equal(toMrkdwn("**One**\n- a\n\n\n**Two**\n\n- b\n\nplain\n\n* c"), "*One*\n• a\n\n*Two*\n• b\nplain\n• c");
});

test("a [channel] first line asks for the channel too and is not posted; anywhere else it is text", () => {
  assert.deepEqual(channelShare("[channel]\n*PR for review:* <https://x.y/1|t #1>"), {
    text: "*PR for review:* <https://x.y/1|t #1>",
    broadcast: true,
  });
  assert.deepEqual(channelShare("Opened #1. [channel] is how I share."), { text: "Opened #1. [channel] is how I share.", broadcast: false });
});

test("a [channel] first line that names a channel asks for that channel instead, in any link form", () => {
  const to = { text: "Needs an owner", broadcast: false, to: "C0123ABCD" };
  assert.deepEqual(channelShare("[channel <#C0123ABCD>]\nNeeds an owner"), to);
  assert.deepEqual(channelShare("[channel <#C0123ABCD|eng>] Needs an owner"), to);
  assert.deepEqual(channelShare("[channel C0123ABCD]\nNeeds an owner"), to);
});

test("a [channel] line below the first, or naming a channel without its link, is stray; one in a sentence is not", () => {
  assert.equal(strayShare("I can post there after all. Posting now.\n\n[channel <#C0123ABCD>]\nNeeds an owner"), true);
  assert.equal(strayShare("[channel #eng]\nNeeds an owner"), true);
  assert.equal(strayShare("[channel <#C0123ABCD>]\nNeeds an owner"), false);
  assert.equal(strayShare("Opened #1. [channel] is how I share."), false);
});

test("the channels a message links, with or without a name, and not one typed as text", () => {
  assert.deepEqual(linkedChannels("post it in <#C0123ABCD> and <#C0456EFGH|releases>, not #general"), new Set(["C0123ABCD", "C0456EFGH"]));
  assert.equal(linkedChannels("post it in #eng").size, 0);
});
