import type { RawTextElement, RichTextBlock, RichTextElement, TableBlock } from "@slack/types";

/** Slack caps a section block's text at 3000 characters. */
const SLACK_LIMIT = 2900;

/** Slack's limits for one table block. */
const TABLE_MAX_ROWS = 100;
const TABLE_MAX_COLUMNS = 20;
const TABLE_MAX_CHARS = 10_000;

/** A table's delimiter row, such as `|---|:---:|---:|`. */
const DELIMITER_ROW = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
/** A piece of a table row: a code span or Slack link (either can hold a pipe), an escaped pipe, a pipe, or text. */
const ROW_TOKEN = /`[^`]*`|<(?:https?:|mailto:|[@#!])[^<>]*>|\\\||\||[^`<|\\]+|[\s\S]/g;
/** The mrkdwn a table cell keeps: code, bold and links. */
const CELL_FORMAT = /`([^`]+)`|\*(\S(?:[^*]*\S)?)\*|<(https?:\/\/[^|>]+)(?:\|([^>]+))?>/g;

export function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}

/**
 * The small grey line under a reply: `37s · 6 tool calls · 582k in / 1.5k out · 103k context · ~$1.20 at API rates`.
 * "in" is summed over the turn's requests and tracks cost; "context" is the last request and tracks growth.
 */
export function statsLine(s: {
  durationMs: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  contextTokens: number;
  costUsd: number;
}): string {
  const seconds = Math.round(s.durationMs / 1000);
  const time = seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
  const calls = `${s.toolCalls} tool call${s.toolCalls === 1 ? "" : "s"}`;
  const context = s.contextTokens ? ` · ${formatTokens(s.contextTokens)} context` : "";
  return `${time} · ${calls} · ${formatTokens(s.inputTokens)} in / ${formatTokens(s.outputTokens)} out${context} · ~$${s.costUsd.toFixed(2)} at API rates`;
}

/**
 * A reply whose first line is `[channel]` asks to be sent to the channel as well as the thread, and one whose
 * first line is `[channel <#C0123ABCD>]` asks to be posted in that channel instead.
 */
export function channelShare(reply: string): { text: string; broadcast: boolean; to?: string } {
  const marker = /^\s*\[channel(?:\s+<?#?([CG][A-Z0-9]+)(?:\|[^>\]]*)?>?)?\][ \t]*\n?/.exec(reply);
  if (!marker) return { text: reply, broadcast: false };
  const text = reply.slice(marker[0].length);
  return marker[1] ? { text, broadcast: false, to: marker[1] } : { text, broadcast: true };
}

/** A `[channel]` line that would post as text: below the first line, or naming a channel without its link. */
export function strayShare(reply: string): boolean {
  const share = channelShare(reply);
  return !share.broadcast && !share.to && /^[ \t]*\[channel\b/m.test(reply);
}

/** A message's link, from the workspace URL `auth.test` returns; a thread reply's opens in its thread. */
export function permalink(workspaceUrl: string, channel: string, ts: string, thread?: string): string {
  const link = `${workspaceUrl}archives/${channel}/p${ts.replace(".", "")}`;
  return thread && thread !== ts ? `${link}?thread_ts=${thread}&cid=${channel}` : link;
}

/** The channels a Slack message links, written `<#C0123ABCD>` or `<#C0123ABCD|name>`. */
export function linkedChannels(text: string): Set<string> {
  return new Set(Array.from(text.matchAll(/<#([CG][A-Z0-9]+)(?:\|[^>]*)?>/g), (match) => match[1] ?? ""));
}

/** A changelog entry: a bullet that opens with a link to a PR or ticket. Like a table row, it is data, not prose. */
const CHANGELOG_ENTRY = /^\s*[-*•]\s+\[(?:(?:PR )?#\d+|[A-Z][A-Z0-9]+-\d+)[^\]]*\]\(/;
/** A line that opens in bold, such as a release name or `*Fixes*`, starts a section. A `* ` bullet does not. */
const BOLD_START = String.raw`[ \t]*\*+[^\s*]`;
const BLANK_BEFORE_SECTION = new RegExp(String.raw`\n[ \t]*\n+(?=${BOLD_START})`, "g");
const BLANK_LINES = new RegExp(String.raw`\n[ \t]*\n+(?!${BOLD_START})`, "g");

/** Words outside code fences, the table and changelog entries. None of them is prose, so none counts against the cap. */
export function wordCount(text: string): number {
  const unfenced = text.replace(/```[\s\S]*?```/g, " ");
  const table = splitTable(unfenced);
  const prose = (table ? `${table.before}\n${table.after}` : unfenced)
    .split("\n")
    .filter((line) => !CHANGELOG_ENTRY.test(line))
    .join("\n");
  return prose.split(/\s+/).filter((w) => /\w/.test(w)).length;
}

/**
 * Convert the markdown an agent writes into Slack mrkdwn. Code blocks pass through untouched.
 * Blank lines go too, since Slack hides tall messages behind "Show more" and a blank line is a line,
 * except one before a bold line that starts a section, which keeps a long post readable.
 */
export function toMrkdwn(markdown: string): string {
  const parts = markdown.split(/(```[\s\S]*?```)/g);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part;
      return part
        .replace(BLANK_BEFORE_SECTION, "\n\n")
        .replace(BLANK_LINES, "\n")
        .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
        .replace(/\*\*(.+?)\*\*/g, "*$1*")
        .replace(/__(.+?)__/g, "_$1_")
        .replace(/~~(.+?)~~/g, "~$1~")
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "<$2|$1>")
        .replace(/^(\s*)[-*]\s+/gm, "$1• ")
        .replace(/^(\s*)(\d+)\.\s+/gm, "$1$2. ");
    })
    .join("");
}

interface Unit {
  text: string;
  /** What it adds to a message's section text. A table posts as its own block, so it adds nothing. */
  size: number;
}

/** A reply's lines, with each code block and table kept whole so a split never lands inside one. */
function units(text: string, tables: boolean): Unit[] {
  const lines = text.split("\n");
  const out: Unit[] = [];
  for (let i = 0; i < lines.length; ) {
    let end = i + 1;
    let table = false;
    if (lines[i]?.trimStart().startsWith("```")) {
      while (end < lines.length && !lines[end]?.trimStart().startsWith("```")) end++;
      end = Math.min(end + 1, lines.length);
    } else if (tables && lines[i]?.includes("|") && DELIMITER_ROW.test(lines[i + 1] ?? "")) {
      end = i + 2;
      while (end < lines.length && lines[end]?.includes("|")) end++;
      table = true;
    }
    const unit = lines.slice(i, end).join("\n");
    out.push({ text: unit, size: table ? 0 : unit.length });
    i = end;
  }
  return out;
}

/** A line cut into pieces of at most `room` characters, at a space where there is one. */
function wrap(line: string, room: number): string[] {
  const pieces: string[] = [];
  let rest = line;
  while (rest.length > room) {
    const space = rest.lastIndexOf(" ", room);
    const at = space > 0 ? space : room;
    pieces.push(rest.slice(0, at));
    rest = rest.slice(at).trimStart();
  }
  return [...pieces, rest];
}

/** Text too long for one message, cut on line breaks and then spaces. A code block is closed and reopened at each cut. */
function cut(text: string, limit: number): string[] {
  const open = /^\s*(```[^\n]*)\n/.exec(text)?.[1];
  const body = open ? text.replace(/^\s*```[^\n]*\n/, "").replace(/\n?```\s*$/, "") : text;
  const room = open ? limit - open.length - 5 : limit;
  const pieces: string[] = [];
  let current: string[] = [];
  let size = 0;
  for (const line of body.split("\n").flatMap((l) => wrap(l, room))) {
    if (current.length > 0 && size + line.length > room) {
      pieces.push(current.join("\n"));
      current = [];
      size = 0;
    }
    current.push(line);
    size += line.length + 1;
  }
  if (current.length > 0) pieces.push(current.join("\n"));
  return open ? pieces.map((piece) => `${open}\n${piece}\n\`\`\``) : pieces;
}

/**
 * Split a reply into messages on line breaks, each under Slack's section limit, never inside a code block or a
 * table. A table posts as its own block, so it does not count toward the limit; with `tables` false it is text.
 */
export function chunk(text: string, { limit = SLACK_LIMIT, tables = true } = {}): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let current: string[] = [];
  let size = 0;
  for (const unit of units(text, tables)) {
    if (current.length > 0 && size + unit.size > limit) {
      chunks.push(current.join("\n"));
      current = [];
      size = 0;
    }
    if (unit.size > limit) {
      chunks.push(...cut(unit.text, limit));
    } else {
      current.push(unit.text);
      size += unit.size + 1;
    }
  }
  if (current.length > 0) chunks.push(current.join("\n"));
  return chunks;
}

export interface MarkdownTable {
  before: string;
  rows: string[][];
  align: ("center" | "right" | undefined)[];
  after: string;
}

function tableCells(row: string): string[] {
  const cells: string[] = [];
  let cell = "";
  for (const [token] of row.trim().replace(/^\|/, "").replace(/\|$/, "").matchAll(ROW_TOKEN)) {
    if (token === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += token === "\\|" ? "|" : token;
    }
  }
  return [...cells, cell.trim()];
}

/**
 * The first table in a reply, outside code fences, and the text either side of it. Undefined when there
 * is none, or when it has no body rows or breaks Slack's limits, so that it stays text.
 */
export function splitTable(text: string): MarkdownTable | undefined {
  const lines = text.split("\n");
  let fenced = false;
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i] ?? "";
    const next = lines[i + 1] ?? "";
    if (line.trimStart().startsWith("```")) fenced = !fenced;
    if (fenced || !line.includes("|") || !next.includes("|") || !DELIMITER_ROW.test(next)) continue;
    const header = tableCells(line);
    const delimiters = tableCells(next);
    if (header.length !== delimiters.length) continue;
    let end = i + 2;
    while (end < lines.length && lines[end]?.includes("|")) end++;
    const body = lines.slice(i + 2, end).map((row) => {
      const cells = tableCells(row);
      return header.map((_, c) => cells[c] ?? "");
    });
    const rows = [header, ...body];
    const chars = rows.flat().join("").length;
    if (!body.length || rows.length > TABLE_MAX_ROWS || header.length > TABLE_MAX_COLUMNS || chars > TABLE_MAX_CHARS) return undefined;
    return {
      before: lines.slice(0, i).join("\n").trim(),
      rows,
      align: delimiters.map((d) => (d.endsWith(":") ? (d.startsWith(":") ? "center" : "right") : undefined)),
      after: lines.slice(end).join("\n").trim(),
    };
  }
  return undefined;
}

function richText(text: string, header: boolean): RichTextElement[] {
  const elements: RichTextElement[] = [];
  let last = 0;
  for (const match of text.matchAll(CELL_FORMAT)) {
    if (match.index > last) elements.push({ type: "text", text: text.slice(last, match.index), style: { bold: header } });
    const [, code, bold, url, label] = match;
    if (code) elements.push({ type: "text", text: code, style: { bold: header, code: true } });
    else if (bold) elements.push({ type: "text", text: bold, style: { bold: true } });
    else if (url) elements.push({ type: "link", url, text: label ?? url, style: { bold: header } });
    last = match.index + match[0].length;
  }
  if (last < text.length) elements.push({ type: "text", text: text.slice(last), style: { bold: header } });
  return elements;
}

/** A native Slack table: the header row bold, every column wrapped, aligned as the delimiter row says. */
export function tableBlock({ rows, align }: Pick<MarkdownTable, "rows" | "align">): TableBlock {
  return {
    type: "table",
    column_settings: align.map((a) => (a ? { align: a, is_wrapped: true } : { is_wrapped: true })),
    rows: rows.map((row, r) =>
      row.map((cell): RawTextElement | RichTextBlock =>
        // Slack rejects an empty cell.
        cell ? { type: "rich_text", elements: [{ type: "rich_text_section", elements: richText(cell, r === 0) }] } : { type: "raw_text", text: " " },
      ),
    ),
  };
}
