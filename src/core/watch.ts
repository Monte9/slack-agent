import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { transcriptDirFor, workspaceFor } from "./scope.js";

const POLL_MS = 1000;
/** The bot.log lines worth a look. Bolt's Socket Mode errors are routine: it reconnects on its own. */
const LOG_EVENT = /\[mention\]|\[denied\]|\[turn|\[recovered\]|\[context\]|\[table\]|rror|ELIFECYCLE|connected over Socket Mode/;
const ROUTINE = /WebSocket error/;

interface ContentBlock {
  type?: string;
  name?: string;
  input?: Record<string, unknown>;
  is_error?: boolean;
  content?: unknown;
}

export function logEvent(line: string): string | undefined {
  return LOG_EVENT.test(line) && !ROUTINE.test(line) ? line : undefined;
}

function summary(input: Record<string, unknown>): string {
  const value = input.description ?? input.command ?? input.file_path ?? input.pattern ?? input.query ?? input.url ?? input.skill;
  const text = typeof value === "string" ? value : JSON.stringify(input);
  return text.length > 140 ? `${text.slice(0, 137)}...` : text;
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.map((part) => (typeof part?.text === "string" ? part.text : "")).join(" ") : "";
}

/** One transcript line as watch events: each tool call, and each tool result that came back as an error. */
export function transcriptEvents(line: string): string[] {
  let entry: { type?: string; message?: { content?: unknown } };
  try {
    entry = JSON.parse(line);
  } catch {
    return [];
  }
  const blocks: ContentBlock[] = Array.isArray(entry.message?.content) ? entry.message.content : [];
  if (entry.type === "assistant") {
    return blocks.filter((b) => b.type === "tool_use").map((b) => `[tool] ${b.name} ${summary(b.input ?? {})}`);
  }
  if (entry.type === "user") {
    return blocks.filter((b) => b.type === "tool_result" && b.is_error).map((b) => `[tool error] ${resultText(b.content).slice(0, 140)}`);
  }
  return [];
}

function sizeOf(path: string): number {
  return existsSync(path) ? statSync(path).size : 0;
}

/** What has been appended to a file since the last call, whole lines only. */
export class Follower {
  private offset: number;
  private rest = Buffer.alloc(0);

  constructor(
    readonly path: string,
    fromStart = false,
  ) {
    this.offset = fromStart ? 0 : sizeOf(path);
  }

  lines(): string[] {
    const size = sizeOf(this.path);
    if (size < this.offset) {
      this.offset = 0;
      this.rest = Buffer.alloc(0);
    }
    if (size === this.offset) return [];
    const added = Buffer.alloc(size - this.offset);
    const fd = openSync(this.path, "r");
    try {
      readSync(fd, added, 0, added.length, this.offset);
    } finally {
      closeSync(fd);
    }
    this.offset = size;
    // Split on the newline byte, never inside a multibyte character.
    const chunk = Buffer.concat([this.rest, added]);
    const end = chunk.lastIndexOf(0x0a);
    this.rest = chunk.subarray(end + 1);
    return end < 0 ? [] : chunk.subarray(0, end).toString("utf8").split("\n");
  }
}

function newestTranscript(dir: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => join(dir, name));
  return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

/**
 * Print what the bot is doing as it happens: mentions, denials, turns, errors and restarts from bot.log, and
 * each tool call of the session being written. That is the newest transcript rather than session.json, which
 * a new session only writes when its first turn ends; a session that starts while watching is read from its start.
 */
export function watch(stateDir: string): void {
  const startedAt = Date.now();
  const log = new Follower(join(stateDir, "bot.log"));
  const transcripts = transcriptDirFor(workspaceFor(stateDir));
  let session: Follower | undefined;
  console.error(`Watching ${log.path} and the sessions in ${transcripts}`);
  setInterval(() => {
    for (const line of log.lines()) {
      const event = logEvent(line);
      if (event) console.log(event);
    }
    const newest = newestTranscript(transcripts);
    if (newest && newest !== session?.path) session = new Follower(newest, statSync(newest).birthtimeMs > startedAt);
    for (const line of session?.lines() ?? []) for (const event of transcriptEvents(line)) console.log(event);
  }, POLL_MS);
}
