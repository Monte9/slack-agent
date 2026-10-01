import { App, LogLevel, SocketModeReceiver } from "@slack/bolt";
import type { KnownBlock } from "@slack/types";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent } from "../agent/types.js";
import type { Config } from "../config.js";
import { channelShare, chunk, splitTable, statsLine, tableBlock, toMrkdwn } from "./format.js";
import { statusText } from "./status.js";
import type { Ledger } from "./ledger.js";
import { fetchContext, userNames } from "./thread.js";
import type { TurnRunner } from "./turn.js";

const PROGRESS_INTERVAL_MS = 2000;

export interface Activity {
  emoji: string;
  text: string;
}

const SERVER_EMOJI: Record<string, string> = {
  mixpanel: "📊",
  notion: "📝",
  github: "🐙",
  slack: "💬",
  vercel: "▲",
  gmail: "📧",
};

interface MentionEvent {
  user?: string;
  bot_id?: string;
  text: string;
  channel: string;
  ts: string;
  thread_ts?: string;
}

function basename(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

interface Inflight {
  channel: string;
  ts: string;
  mentionTs: string;
}

/**
 * The placeholder of the turn being worked on, on disk. A process that dies mid-turn
 * (a crash, a restart, a file save under `pnpm dev`) leaves it saying "thinking" forever;
 * the next process finds it here and says what happened.
 */
class InflightMarker {
  private readonly path: string;

  constructor(stateDir: string) {
    this.path = join(stateDir, "inflight.json");
  }

  set(value: Inflight): void {
    writeFileSync(this.path, JSON.stringify(value));
  }

  clear(): void {
    rmSync(this.path, { force: true });
  }

  take(): Inflight | undefined {
    if (!existsSync(this.path)) return undefined;
    const value = JSON.parse(readFileSync(this.path, "utf8")) as Inflight;
    this.clear();
    return value;
  }
}

/**
 * A reply section, with the small grey stats line under it when this is the last part.
 * A markdown table in it becomes a native table between the text around it, unless `tables` is false.
 */
function replyBlocks(text: string, footer?: string, tables = true): KnownBlock[] {
  const section = (mrkdwn: string): KnownBlock[] => (mrkdwn ? [{ type: "section", text: { type: "mrkdwn", text: mrkdwn } }] : []);
  const table = tables ? splitTable(text) : undefined;
  const blocks = table ? [...section(table.before), tableBlock(table), ...section(table.after)] : section(text);
  if (footer) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: footer }] });
  return blocks;
}

/** Slack can still reject a table (`invalid_blocks`); the reply then goes out with the table as text. */
async function sendReply<T>(ledger: Ledger, send: (blocks: KnownBlock[]) => Promise<T>, text: string, footer?: string): Promise<T> {
  try {
    return await send(replyBlocks(text, footer));
  } catch (error) {
    if (!String(error).includes("invalid_blocks") || !splitTable(text)) throw error;
    ledger.record({ type: "problem", what: "table", error: `Slack rejected it, so it went out as text: ${String(error)}` });
    return send(replyBlocks(text, footer, false));
  }
}

/** An emoji and one short, human line for the placeholder, from an agent event. */
export function describeActivity(event: Extract<AgentEvent, { type: "tool" | "phase" }>): Activity {
  if (event.type === "phase") {
    return event.name === "revising" ? { emoji: "✂️", text: "revising the reply" } : { emoji: "🤔", text: "thinking" };
  }
  const { name, summary } = event;
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) {
    const server = (mcp[1] ?? "").replace(/^claude_ai_/, "").replace(/_/g, " ");
    const tool = mcp[2] ?? "";
    return {
      emoji: SERVER_EMOJI[server.toLowerCase()] ?? "🔌",
      text: `${server}: ${tool.replace(/[-_]+/g, " ").toLowerCase()}`,
    };
  }
  switch (name) {
    case "ToolSearch":
      return { emoji: "🛠️", text: "loading tools" };
    case "Bash":
      return { emoji: "💻", text: `running \`${summary}\`` };
    case "Read":
      return { emoji: "📖", text: `reading ${basename(summary)}` };
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit":
      return { emoji: "✏️", text: `editing ${basename(summary)}` };
    case "Grep":
    case "Glob":
      return { emoji: "🔍", text: `searching for ${summary}` };
    case "WebFetch":
    case "WebSearch":
      return { emoji: "🌐", text: "browsing" };
    case "Agent":
      return { emoji: "🤖", text: "delegating to a subagent" };
    case "Skill":
      return { emoji: "🎯", text: `using the ${summary} skill` };
    default:
      return { emoji: "⚙️", text: name.toLowerCase() };
  }
}

export async function startSlack(config: Config, runner: TurnRunner, adapterName: string): Promise<void> {
  const { ledger } = runner;
  const receiver = new SocketModeReceiver({ appToken: config.slack.appToken, logLevel: LogLevel.INFO });
  for (const state of ["connected", "reconnecting", "disconnected"]) {
    receiver.client.on(state, () => ledger.record({ type: "connection", state }));
  }
  const app = new App({ token: config.slack.botToken, receiver, logLevel: LogLevel.INFO });

  const auth = await app.client.auth.test();
  const botUserId = auth.user_id ?? "";
  const botName = auth.user ?? "bot";
  const mentionPattern = new RegExp(`<@${botUserId}>`, "g");
  const nameOf = userNames(app.client);

  const inflight = new InflightMarker(config.stateDir);
  const orphan = inflight.take();
  if (orphan) {
    await app.client.chat
      .update({
        channel: orphan.channel,
        ts: orphan.ts,
        text: "I was restarted before I could answer this one. Mention me again if it still matters.",
        blocks: [],
      })
      .catch(() => undefined);
    await app.client.reactions.remove({ channel: orphan.channel, timestamp: orphan.mentionTs, name: "eyes" }).catch(() => undefined);
    ledger.record({ type: "recovered", channel: orphan.channel, ts: orphan.ts });
  }

  app.event("app_mention", async ({ event, client }) => {
    const mention = event as MentionEvent;
    if (mention.bot_id || !mention.user) return;
    const threadTs = mention.thread_ts ?? mention.ts;
    const reply = (text: string) =>
      client.chat.postMessage({ channel: mention.channel, thread_ts: threadTs, text });
    // Reactions need reactions:write; an app installed without it still works, just without the marker.
    const react = async (name: string, remove = false) => {
      try {
        const args = { channel: mention.channel, timestamp: mention.ts, name };
        await (remove ? client.reactions.remove(args) : client.reactions.add(args));
      } catch {
        // ignore: missing scope, or the reaction already in that state
      }
    };

    const text = mention.text.replace(mentionPattern, "").trim();
    if (!config.allowlist.includes(mention.user)) {
      ledger.record({ type: "denied", user: mention.user, channel: mention.channel, thread: threadTs, text: text.slice(0, 120) });
      await reply(`Sorry <@${mention.user}>, you are not on my allowlist. Ask <@${config.owner}> to add you.`);
      return;
    }

    const command = text.toLowerCase();
    if (command === "status" || command === "new") {
      ledger.record({ type: "command", user: mention.user, channel: mention.channel, thread: threadTs, command });
    }

    if (command === "status") {
      await reply(statusText(runner, adapterName));
      return;
    }
    if (command === "new") {
      if (mention.user !== config.owner) {
        await reply("Only the owner can start a new session.");
        return;
      }
      runner.rotate();
      await reply("Started fresh. The next mention opens a new session with the current shared memory.");
      return;
    }
    if (!text) {
      await reply("Mention me with a question or a task. `status` and `new` are the only commands.");
      return;
    }

    const depth = runner.depth;
    const startedAt = Date.now();
    let context = { text: "", count: 0 };
    try {
      context = await fetchContext(client, mention, nameOf);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const where = mention.thread_ts ? "thread" : "channel";
      ledger.record({ type: "problem", what: `${where} read`, error: message });
      context.text = `(The ${where} this was posted in could not be read: ${message}. Ask for what you need rather than guessing.)`;
    }
    ledger.record({
      type: "mention",
      user: mention.user,
      channel: mention.channel,
      thread: threadTs,
      queue: depth,
      earlier: context.count,
      text: text.slice(0, 120),
    });
    await react("eyes");

    let activity: Activity =
      depth > 0 ? { emoji: "⏳", text: `queued behind ${depth}, finishing the last one first` } : { emoji: "🤔", text: "thinking" };
    let toolCalls = 0;
    const elapsed = () => `${Math.round((Date.now() - startedAt) / 1000)}s · ${toolCalls} tool call${toolCalls === 1 ? "" : "s"}`;
    const progress = () => ({
      text: `${activity.emoji} ${activity.text}`,
      blocks: replyBlocks(`${activity.emoji} ${activity.text}`, elapsed()),
    });
    const placeholder = await client.chat.postMessage({ channel: mention.channel, thread_ts: threadTs, ...progress() });
    const placeholderTs = placeholder.ts ?? "";
    inflight.set({ channel: mention.channel, ts: placeholderTs, mentionTs: mention.ts });
    const update = (body: string) => client.chat.update({ channel: mention.channel, ts: placeholderTs, text: body });

    // A live clock: one edit every two seconds, which stays under Slack's ~50 chat.update calls a minute.
    const ticker = setInterval(() => {
      void client.chat.update({ channel: mention.channel, ts: placeholderTs, ...progress() }).catch(() => undefined);
    }, PROGRESS_INTERVAL_MS);

    try {
      const outcome = await runner.run({
        requester: mention.user,
        origin: `Slack #${mention.channel} thread ${threadTs}`,
        text,
        context: context.text,
        onEvent: (agentEvent) => {
          if (agentEvent.type === "tool") toolCalls += 1;
          if (agentEvent.type === "tool" || agentEvent.type === "phase") activity = describeActivity(agentEvent);
          if (agentEvent.type === "init") activity = { emoji: "🤔", text: "thinking" };
        },
      });
      clearInterval(ticker);

      const share = channelShare(outcome.text || "(no reply)");
      const parts = chunk(toMrkdwn(share.text || "(no reply)"));
      const prefix = outcome.rotated ? "_The previous session could not be resumed, so this is a fresh one._\n\n" : "";
      const stats = { ...outcome.stats, durationMs: Date.now() - startedAt };
      const footer = statsLine(stats);
      // The first message carries the answer plus a context block; overflow goes as plain replies.
      const first = `${prefix}${parts[0] ?? ""}`;
      let ts = placeholderTs;
      if (share.broadcast) {
        // Slack will not broadcast a reply and change its content in one update (no_dual_broadcast_content_update),
        // so a share is a new reply that also goes to the channel, without the stats line, and the placeholder goes.
        const shared = await sendReply(
          ledger,
          (blocks) => client.chat.postMessage({ channel: mention.channel, thread_ts: threadTs, text: first, blocks, reply_broadcast: true }),
          first,
        );
        ts = shared.ts ?? ts;
        await client.chat.delete({ channel: mention.channel, ts: placeholderTs }).catch(() => update("Shared in the channel."));
      } else {
        await sendReply(
          ledger,
          (blocks) => client.chat.update({ channel: mention.channel, ts: placeholderTs, text: first, blocks }),
          first,
          parts.length === 1 ? footer : undefined,
        );
      }
      for (const [i, part] of parts.slice(1).entries()) {
        const last = i === parts.length - 2;
        await sendReply(
          ledger,
          (blocks) => client.chat.postMessage({ channel: mention.channel, thread_ts: threadTs, text: part, blocks }),
          part,
          last ? footer : undefined,
        );
      }
      inflight.clear();
      await react("eyes", true);
      await react(outcome.isError ? "x" : "white_check_mark");
      ledger.record({
        type: "turn",
        channel: mention.channel,
        thread: threadTs,
        session: outcome.sessionId,
        turn: outcome.session.turns,
        stats,
        revised: outcome.revised,
        error: outcome.isError,
        fresh: outcome.rotated,
      });
      ledger.record({ type: "posted", channel: mention.channel, thread: threadTs, ts, messages: parts.length, broadcast: share.broadcast });
    } catch (error) {
      clearInterval(ticker);
      inflight.clear();
      const message = error instanceof Error ? error.message : String(error);
      ledger.record({ type: "problem", what: "turn", error: message });
      await update(`Something went wrong: \`${message.slice(0, 500)}\``);
      await react("eyes", true);
      await react("x");
    }
  });

  await app.start();
  console.log(`@${botName} connected over Socket Mode. Owner ${config.owner}, allowlist ${config.allowlist.length}.`);
}
