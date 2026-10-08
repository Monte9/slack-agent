import assert from "node:assert/strict";
import { test } from "node:test";
import {
  channelShare,
  chunk,
  footerLine,
  linkedChannels,
  listBlock,
  modelName,
  proseBlocks,
  splitTable,
  strayShare,
  tableBlock,
  toMrkdwn,
  wordCount,
} from "./format.js";

test("model ids read the way Claude's Slack app names them", () => {
  assert.equal(modelName("claude-opus-5[1m]"), "Opus 5");
  assert.equal(modelName("claude-sonnet-5-5"), "Sonnet 5.5");
  assert.equal(modelName("claude-haiku-4-5-20251001"), "Haiku 4.5");
  assert.equal(modelName("some-other-model"), "some-other-model");
});

test("the footer under a reply is time, tool calls, model and effort", () => {
  const line = footerLine({ durationMs: 309_400, toolCalls: 22, model: "claude-opus-5[1m]", effort: "high" });
  assert.equal(line, "5m 9s · 22 tool calls · Opus 5 · high effort");
  assert.equal(footerLine({ durationMs: 37_000, toolCalls: 1 }), "37s · 1 tool call");
});

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
  const post = [
    "*Release 0.1.2* (diff)",
    "*Fixes*",
    "- [#12](https://x.y/12): one two three four",
    "- [ABC-34: t](https://x.y/34): five",
    "- [retry uploads #56](https://x.y/56): six",
    "*Risk: low*",
    "- seven eight",
  ];
  assert.equal(wordCount(post.join("\n")), 8);
  assert.equal(wordCount("- [the docs](https://x.y/docs): one two"), 4);
});

test("bullets become a native list, nested by indent, with links and code kept", () => {
  const plain = (text: string, code = false) => ({ type: "text", text, style: code ? { bold: false, code: true } : { bold: false } });
  assert.deepEqual(listBlock(["• <https://x.y/12|PR #12>: retry uploads", "  • nested `code`"]), {
    type: "rich_text",
    elements: [
      {
        type: "rich_text_list",
        style: "bullet",
        indent: 0,
        elements: [{ type: "rich_text_section", elements: [{ type: "link", url: "https://x.y/12", text: "PR #12", style: { bold: false } }, plain(": retry uploads")] }],
      },
      { type: "rich_text_list", style: "bullet", indent: 1, elements: [{ type: "rich_text_section", elements: [plain("nested "), plain("code", true)] }] },
    ],
  });
});

test("a list item with a mention, an emoji code or italics stays text", () => {
  assert.equal(listBlock(["• asked <@U1>"]), undefined);
  assert.equal(listBlock(["• shipped :rocket:"]), undefined);
  assert.equal(listBlock(["• _maybe_ later"]), undefined);
});

test("prose splits into expanded sections and native lists, and a bullet in code stays code", () => {
  const blocks = proseBlocks("*Fixes*\n• one\n• two\n\n*Risk: low*\n• three");
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["section", "rich_text", "section", "rich_text"],
  );
  assert.deepEqual(blocks[2], { type: "section", text: { type: "mrkdwn", text: "*Risk: low*" }, expand: true });
  assert.deepEqual(
    proseBlocks("*Fixes*\n• one", false).map((b) => b.type),
    ["section"],
  );
  assert.deepEqual(
    proseBlocks("```\n• not a list\n```").map((b) => b.type),
    ["section"],
  );
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
