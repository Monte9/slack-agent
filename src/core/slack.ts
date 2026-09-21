import { App, LogLevel } from "@slack/bolt";
import type { KnownBlock } from "@slack/types";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent } from "../agent/types.js";
import type { Config } from "../config.js";
import { chunk, statsLine, toMrkdwn } from "./format.js";
import { statusText } from "./status.js";
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

/** A reply section, with the small grey stats line under it when this is the last part. */
function replyBlocks(text: string, footer?: string): KnownBlock[] {
  const blocks: KnownBlock[] = [{ type: "section", text: { type: "mrkdwn", text } }];
  if (footer) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: footer }] });
  return blocks;
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
  const app = new App({
    token: config.slack.botToken,
    appToken: config.slack.appToken,
    socketMode: true,
    logLevel: LogLevel.INFO,
  });

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
    console.log(`[recovered] orphaned placeholder ${orphan.ts} in ${orphan.channel}`);
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

    if (!config.allowlist.includes(mention.user)) {
      await reply(`Sorry <@${mention.user}>, you are not on my allowlist. Ask <@${config.owner}> to add you.`);
      return;
    }

    const text = mention.text.replace(mentionPattern, "").trim();
    const command = text.toLowerCase();

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
      console.warn(`[context] could not read the ${where}: ${message}`);
      context.text = `(The ${where} this was posted in could not be read: ${message}. Ask for what you need rather than guessing.)`;
    }
    console.log(
      `[mention] ${mention.user} in ${mention.channel} thread ${threadTs} (queue ${depth}, ${context.count} earlier): ${text.slice(0, 120)}`,
    );
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

      const parts = chunk(toMrkdwn(outcome.text || "(no reply)"));
      const prefix = outcome.rotated ? "_The previous session could not be resumed, so this is a fresh one._\n\n" : "";
      const stats = { ...outcome.stats, durationMs: Date.now() - startedAt };
      const footer = statsLine(stats);
      // The first message carries the answer plus a context block; overflow goes as plain replies.
      const first = `${prefix}${parts[0] ?? ""}`;
      await client.chat.update({
        channel: mention.channel,
        ts: placeholderTs,
        text: first,
        blocks: replyBlocks(first, parts.length === 1 ? footer : undefined),
      });
      for (const [i, part] of parts.slice(1).entries()) {
        const last = i === parts.length - 2;
        await client.chat.postMessage({
          channel: mention.channel,
          thread_ts: threadTs,
          text: part,
          blocks: replyBlocks(part, last ? footer : undefined),
        });
      }
      inflight.clear();
      await react("eyes", true);
      await react(outcome.isError ? "x" : "white_check_mark");
      console.log(
        `[turn ${outcome.session.turns}] ${footer}, ${outcome.text.length} chars in ${parts.length} message(s)` +
          `${outcome.revised ? ", revised" : ""}${outcome.isError ? ", error" : ""}${outcome.rotated ? ", fresh session" : ""}, session ${outcome.sessionId}`,
      );
    } catch (error) {
      clearInterval(ticker);
      inflight.clear();
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[turn failed] ${message}`);
      await update(`Something went wrong: \`${message.slice(0, 500)}\``);
      await react("eyes", true);
      await react("x");
    }
  });

  await app.start();
  console.log(`@${botName} connected over Socket Mode. Owner ${config.owner}, allowlist ${config.allowlist.length}.`);
}
