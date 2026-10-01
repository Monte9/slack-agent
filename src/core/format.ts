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

/** Words outside code fences and the table. Neither is prose, so neither counts against the cap. */
export function wordCount(text: string): number {
  const unfenced = text.replace(/```[\s\S]*?```/g, " ");
  const table = splitTable(unfenced);
  const prose = table ? `${table.before} ${table.after}` : unfenced;
  return prose.split(/\s+/).filter((w) => /\w/.test(w)).length;
}

/**
 * Convert the markdown an agent writes into Slack mrkdwn. Code blocks pass through untouched.
 * Blank lines go too: Slack hides tall messages behind "Show more", and a blank line is a line.
 */
export function toMrkdwn(markdown: string): string {
  const parts = markdown.split(/(```[\s\S]*?```)/g);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part;
      return part
        .replace(/\n[ \t]*\n+/g, "\n")
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

/** Split on paragraph boundaries so no chunk exceeds Slack's comfortable message size. */
export function chunk(text: string, limit = SLACK_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of text.split(/\n\n/)) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length > limit && current) {
      chunks.push(current);
      current = paragraph;
    } else {
      current = candidate;
    }
    while (current.length > limit) {
      chunks.push(current.slice(0, limit));
      current = current.slice(limit);
    }
  }
  if (current) chunks.push(current);
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
