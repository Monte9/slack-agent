import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { RunStats } from "../agent/types.js";
import type { PolicyDecision } from "../policy/gate.js";

/**
 * What happened around the agent: who asked, what was posted, how the bot is doing. What the agent saw and
 * did is in its own session transcript, so nothing here repeats it beyond a mention's opening words.
 */
export type LedgerEvent =
  | { type: "started"; pid: number; project: string; memory: number }
  | { type: "connection"; state: string }
  | { type: "mention"; user: string; channel: string; thread: string; queue: number; earlier: number; text: string }
  | { type: "denied"; user: string; channel: string; thread: string; text: string }
  | { type: "duplicate"; channel: string; ts: string; retry?: number; reason?: string }
  | { type: "command"; user: string; channel: string; thread: string; command: string }
  | {
      type: "turn";
      channel: string;
      thread: string;
      session: string;
      turn: number;
      stats: RunStats;
      revised: boolean;
      error: boolean;
      fresh: boolean;
    }
  | {
      type: "posted";
      channel: string;
      thread: string;
      ts: string;
      messages: number;
      broadcast: boolean;
      /** The reply itself, when it went to another channel; the thread then holds a link to it. */
      elsewhere?: { channel: string; ts: string };
    }
  | { type: "problem"; what: string; error: string }
  | { type: "recovered"; channel: string; ts: string }
  | ({ type: "policy" } & PolicyDecision);

export type LedgerLine = LedgerEvent & { at: string };

export function ledgerPathFor(stateDir: string): string {
  return join(stateDir, "events.jsonl");
}

/** The bot ledger, one JSON line per event, readable by the owner only since mentions carry Slack text. */
export class Ledger {
  readonly path: string;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.path = ledgerPathFor(stateDir);
  }

  record(event: LedgerEvent): void {
    appendFileSync(this.path, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, { mode: 0o600 });
  }
}
