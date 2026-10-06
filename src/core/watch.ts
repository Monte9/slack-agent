import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentAdapter } from "../agent/types.js";
import { statsLine } from "./format.js";
import { ledgerPathFor, type LedgerLine } from "./ledger.js";
import { workspaceFor } from "./scope.js";

const POLL_MS = 1000;
const WIDTH = 160;
/** A crash in the console, the one thing that can happen before the bot can write its ledger. */
const CRASH = /ELIFECYCLE|^Error|Error:|\[ERROR\]/;
/** Bolt's Socket Mode errors are routine; the ledger records the connection state instead. */
const ROUTINE = /WebSocket error/;

export function crashLine(line: string): string | undefined {
  return CRASH.test(line) && !ROUTINE.test(line) ? line : undefined;
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > WIDTH ? `${flat.slice(0, WIDTH - 1)}…` : flat;
}

function time(at?: string): string {
  return (at ? new Date(at) : new Date()).toTimeString().slice(0, 8);
}

/** One ledger line as one line of text. */
export function describeLedger(e: LedgerLine): string {
  switch (e.type) {
    case "started":
      return `started, pid ${e.pid}, ${e.memory} memory files`;
    case "connection":
      return `connection ${e.state}`;
    case "mention":
      return `mention from ${e.user} in ${e.channel} thread ${e.thread} (queue ${e.queue}, ${e.earlier} earlier): ${e.text}`;
    case "denied":
      return `denied ${e.user} in ${e.channel} thread ${e.thread}: ${e.text}`;
    case "command":
      return `command ${e.command} from ${e.user} in ${e.channel}`;
    case "turn":
      return (
        `turn ${e.turn} · ${statsLine(e.stats)}` +
        `${e.revised ? ", revised" : ""}${e.error ? ", error" : ""}${e.fresh ? ", fresh session" : ""} · session ${e.session}`
      );
    case "posted": {
      const messages = `${e.messages} message${e.messages === 1 ? "" : "s"}`;
      return e.elsewhere
        ? `posted ${messages} in ${e.elsewhere.channel}, asked in ${e.channel} thread ${e.thread}`
        : `posted ${messages} in ${e.channel} thread ${e.thread}${e.broadcast ? ", sent to channel" : ""}`;
    }
    case "problem":
      return `problem with the ${e.what}: ${clip(e.error)}`;
    case "recovered":
      return `recovered placeholder ${e.ts} in ${e.channel}`;
    case "policy":
      return `policy ${e.decision} ${e.tool}${e.rule ? ` (${e.rule})` : ""}${e.reason ? `: ${e.reason}` : ""}`;
  }
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
 * Print what the bot is doing as it happens: the ledger (what happened around the agent), the agent's own
 * transcript of the session being written, and crashes from the console. The transcript followed is the newest,
 * since a new session writes session.json only when its first turn ends; one that starts while watching is read
 * from its start.
 */
export function watch(stateDir: string, adapter: AgentAdapter): void {
  const startedAt = Date.now();
  const ledger = new Follower(ledgerPathFor(stateDir));
  const consoleLog = new Follower(join(stateDir, "bot.log"));
  const transcripts = adapter.transcripts.dir(workspaceFor(stateDir));
  let session: Follower | undefined;
  console.error(`Watching ${ledger.path}, the sessions in ${transcripts}, and crashes in ${consoleLog.path}`);
  setInterval(() => {
    for (const line of ledger.lines()) {
      try {
        const event = JSON.parse(line) as LedgerLine;
        console.log(`${time(event.at)} ${describeLedger(event)}`);
      } catch {
        // A torn write; the next line stands on its own.
      }
    }
    for (const line of consoleLog.lines()) {
      const crash = crashLine(line);
      if (crash) console.log(`${time()} console ${crash.trim()}`);
    }
    const newest = newestTranscript(transcripts);
    if (newest && newest !== session?.path) session = new Follower(newest, statSync(newest).birthtimeMs > startedAt);
    for (const line of session?.lines() ?? []) {
      for (const event of adapter.transcripts.read(line)) console.log(`${time(event.at)} ${event.kind} ${clip(event.text)}`);
    }
  }, POLL_MS);
}
