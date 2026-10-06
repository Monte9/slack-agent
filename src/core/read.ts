import type { webApi } from "@slack/bolt";
import { permalink } from "./format.js";
import { messageLine, messageText, namesFor, userNames, when, type ContextMessage } from "./thread.js";

type WebClient = webApi.WebClient;

/** A message as the history and replies calls return it, with the thread fields read here. */
interface ReadMessage extends ContextMessage {
  ts: string;
  thread_ts?: string;
  reply_count?: number;
  latest_reply?: string;
}

interface Channel {
  id: string;
  name: string;
}

/** A search opens threads started up to this long before `--since` when they have replies inside it. */
const THREAD_LOOKBACK_S = 30 * 86_400;
/** Per channel, the most recently active threads a search opens. */
const MAX_THREADS = 20;
const MAX_MATCHES = 20;
const UNIT_SECONDS: Record<string, number> = { m: 60, h: 3_600, d: 86_400 };
const PRIVATE_NOTE = "Private channels are left out: listing them needs the groups:read scope. Read one by its id or link meanwhile.";

/** `30m`, `12h` or `7d` back from now, or a date, as a Slack ts. */
export function parseSince(value: string, now = Date.now()): string {
  const relative = /^(\d+)([mhd])$/.exec(value);
  const seconds = relative ? now / 1000 - Number(relative[1]) * (UNIT_SECONDS[relative[2] ?? ""] ?? 0) : Date.parse(value) / 1000;
  if (!Number.isFinite(seconds)) throw new Error(`--since takes 30m, 12h, 7d or a date, not "${value}"`);
  return seconds.toFixed(6);
}

/** The channel and message a Slack link points at, and the thread when it is a reply. */
export function parseLink(link: string): { channel: string; ts: string; thread?: string } | undefined {
  const match = /archives\/([CG][A-Z0-9]+)\/p(\d{10})(\d{6})(?:\S*?thread_ts=(\d+\.\d+))?/.exec(link);
  return match ? { channel: match[1] ?? "", ts: `${match[2]}.${match[3]}`, thread: match[4] } : undefined;
}

/** True when every word of the query is in the text, ignoring case. */
export function matches(text: string, query: string): boolean {
  const haystack = text.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

function withTs(messages: ContextMessage[] | undefined): ReadMessage[] {
  return (messages ?? []).filter((m): m is ReadMessage => typeof m.ts === "string");
}

/** Slack as the bot sees it, through its own token, so only the channels it is in. Each method returns text for the agent. */
export class SlackReader {
  private readonly lookup: (id: string) => Promise<string>;
  private channelList?: Promise<{ channels: Channel[]; privateHidden: boolean }>;

  constructor(
    private readonly client: WebClient,
    private readonly workspaceUrl: string,
  ) {
    this.lookup = userNames(client);
  }

  async describeChannels(): Promise<string> {
    const { channels, privateHidden } = await this.channels();
    const lines = channels.map((c) => `- #${c.name} (${c.id})`);
    return [`Channels I'm in (${channels.length}):`, ...lines, ...(privateHidden ? [PRIVATE_NOTE] : [])].join("\n");
  }

  async describeHistory(channelArg: string, since: string, limit: number): Promise<string> {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("--limit takes a whole number");
    const channel = await this.channelId(channelArg);
    const oldest = parseSince(since);
    const messages = (await this.history(channel, oldest, limit)).reverse();
    const label = await this.label(channel);
    if (messages.length === 0) return `Nothing in ${label} since ${when(oldest)}.`;
    const nameOf = await namesFor(messages, this.lookup);
    const lines = messages.map((m) => messageLine(m, nameOf, this.detail(channel, m)));
    return [`${label}, the latest ${messages.length} since ${when(oldest)}, oldest first:`, ...lines].join("\n");
  }

  async describeThread(args: string[]): Promise<string> {
    const link = parseLink(args[0] ?? "");
    const channel = link?.channel ?? (await this.channelId(args[0] ?? ""));
    const ts = link ? (link.thread ?? link.ts) : (args[1] ?? "");
    if (!ts) throw new Error("thread takes a message link, or a channel and the thread's ts");
    const messages = await this.replies(channel, ts);
    const nameOf = await namesFor(messages, this.lookup);
    const lines = messages.map((m) => messageLine(m, nameOf, permalink(this.workspaceUrl, channel, m.ts, ts)));
    return [`A thread in ${await this.label(channel)}, ${messages.length} messages, oldest first:`, ...lines].join("\n");
  }

  async describeSearch(query: string, since: string, channelArg?: string): Promise<string> {
    if (!query.trim()) throw new Error("search takes the words to look for");
    const oldest = parseSince(since);
    const { channels, privateHidden } = await this.channels();
    const ids = channelArg ? [await this.channelId(channelArg)] : channels.map((c) => c.id);
    const found: { channel: string; message: ReadMessage }[] = [];
    for (const channel of ids) {
      for (const message of await this.searchChannel(channel, query, oldest)) found.push({ channel, message });
    }
    found.sort((a, b) => Number(b.message.ts) - Number(a.message.ts));
    const note = privateHidden && !channelArg ? [PRIVATE_NOTE] : [];
    if (found.length === 0) return [`Nothing with "${query}" since ${when(oldest)}.`, ...note].join("\n");
    const shown = found.slice(0, MAX_MATCHES);
    const nameOf = await namesFor(
      shown.map((f) => f.message),
      this.lookup,
    );
    const lines: string[] = [];
    for (const { channel, message } of shown) {
      lines.push(messageLine(message, nameOf, `${await this.label(channel)}, ${this.detail(channel, message)}`));
    }
    const more = found.length > shown.length ? `, the newest ${shown.length} shown` : "";
    return [`${found.length} with "${query}" since ${when(oldest)}${more}, newest first:`, ...lines, ...note].join("\n");
  }

  /** Top-level messages with every word, plus replies in the threads most recently active since `oldest`. */
  private async searchChannel(channel: string, query: string, oldest: string): Promise<ReadMessage[]> {
    const since = Number(oldest);
    const top = await this.history(channel, Math.min(since, Date.now() / 1000 - THREAD_LOOKBACK_S).toFixed(6), 1000);
    const hit = (m: ReadMessage) => Number(m.ts) >= since && matches(messageText(m, (id) => id), query);
    const hits = top.filter(hit);
    const active = top
      .filter((m) => (m.reply_count ?? 0) > 0 && Number(m.latest_reply ?? 0) >= since)
      .sort((a, b) => Number(b.latest_reply) - Number(a.latest_reply))
      .slice(0, MAX_THREADS);
    for (const parent of active) {
      hits.push(...(await this.replies(channel, parent.ts)).filter((m) => m.ts !== parent.ts && hit(m)));
    }
    return hits;
  }

  /** The channels the bot is in. Private ones need groups:read; without it they are left out, and the caller says so. */
  private channels(): Promise<{ channels: Channel[]; privateHidden: boolean }> {
    this.channelList ??= this.listChannels();
    return this.channelList;
  }

  private async listChannels(): Promise<{ channels: Channel[]; privateHidden: boolean }> {
    const list = async (types: string): Promise<Channel[]> => {
      const channels: Channel[] = [];
      let cursor: string | undefined;
      do {
        const page = await this.client.users.conversations({ types, exclude_archived: true, limit: 200, cursor });
        for (const c of page.channels ?? []) if (c.id) channels.push({ id: c.id, name: c.name ?? c.id });
        cursor = page.response_metadata?.next_cursor || undefined;
      } while (cursor);
      return channels;
    };
    try {
      return { channels: await list("public_channel,private_channel"), privateHidden: false };
    } catch (error) {
      if (!String(error).includes("missing_scope")) throw error;
      return { channels: await list("public_channel"), privateHidden: true };
    }
  }

  /** A channel id from an id, a `<#C…>` link, a message link, or the #name of a channel the bot can list. */
  private async channelId(arg: string): Promise<string> {
    const id = parseLink(arg)?.channel ?? /^<?#?([CG][A-Z0-9]{6,})(?:\|[^>]*)?>?$/.exec(arg)?.[1];
    if (id) return id;
    const found = (await this.channels()).channels.find((c) => c.name === arg.replace(/^#/, ""));
    if (!found) throw new Error(`No channel "${arg}" among the ones I can list. Use its id or a link to it.`);
    return found.id;
  }

  private async label(channel: string): Promise<string> {
    const known = (await this.channels()).channels.find((c) => c.id === channel);
    return known ? `#${known.name}` : `<#${channel}>`;
  }

  private detail(channel: string, m: ReadMessage): string {
    const replies = m.reply_count ? `, ${m.reply_count} repl${m.reply_count === 1 ? "y" : "ies"}` : "";
    return `${permalink(this.workspaceUrl, channel, m.ts, m.thread_ts)}${replies}`;
  }

  /** Newest first, as Slack returns them. */
  private async history(channel: string, oldest: string, limit: number): Promise<ReadMessage[]> {
    const messages: ReadMessage[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.client.conversations.history({ channel, oldest, limit: Math.min(limit, 200), cursor });
      messages.push(...withTs(page.messages));
      cursor = page.response_metadata?.next_cursor || undefined;
    } while (cursor && messages.length < limit);
    return messages.slice(0, limit);
  }

  /** The parent first, then its replies, oldest first. */
  private async replies(channel: string, ts: string): Promise<ReadMessage[]> {
    const messages: ReadMessage[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.client.conversations.replies({ channel, ts, limit: 200, cursor });
      messages.push(...withTs(page.messages));
      cursor = page.response_metadata?.next_cursor || undefined;
    } while (cursor && messages.length < 1000);
    return messages;
  }
}
