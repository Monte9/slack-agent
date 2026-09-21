import type { webApi } from "@slack/bolt";

type WebClient = webApi.WebClient;

/** The fields the context builder reads; a structural subset of the API's message types. */
export interface ContextMessage {
  ts?: string;
  user?: string;
  username?: string;
  bot_profile?: { name?: string };
  text?: string;
  attachments?: { fallback?: string; title?: string; text?: string }[];
}

export interface Mention {
  channel: string;
  ts: string;
  thread_ts?: string;
}

/** Enough for the agent to resolve "both" or "the above"; a whole thread is not the ask. */
const MAX_MESSAGES = 30;
const MAX_CHARS = 2000;
/** What a reader sees above a top-level mention. */
const CHANNEL_MESSAGES = 10;

/** Slack mrkdwn to plain text: mentions become names, links keep their URL, entities go back. */
export function plainText(text: string, nameOf: (id: string) => string): string {
  return text
    .replace(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g, (_, id: string) => `@${nameOf(id)}`)
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1")
    .replace(/<!(?:[^|>]+)\|([^>]+)>/g, "$1")
    .replace(/<!([^>]+)>/g, "@$1")
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "$2 ($1)")
    .replace(/<(https?:\/\/[^>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function when(ts: string): string {
  return `${new Date(Number(ts) * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function author(message: ContextMessage, nameOf: (id: string) => string): string {
  if (message.user) return nameOf(message.user);
  return message.bot_profile?.name ?? message.username ?? "bot";
}

/** Text plus attachment fallbacks, which is where an unfurled link or a GitHub card keeps its words. */
function body(message: ContextMessage, nameOf: (id: string) => string): string {
  const parts = [message.text ?? ""];
  for (const attachment of message.attachments ?? []) {
    const summary = attachment.fallback ?? [attachment.title, attachment.text].filter(Boolean).join(": ");
    if (summary) parts.push(`[attachment: ${summary}]`);
  }
  const text = plainText(parts.filter(Boolean).join("\n"), nameOf)
    .replace(/\n\s*\n+/g, "\n")
    .trim();
  const cut = text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}…` : text;
  return cut.replace(/\n/g, "\n  ");
}

/**
 * The messages before the mention, oldest first, as a block for the prompt. The mention itself is the
 * prompt's own body, and anything posted after it (the bot's placeholder included) is not context.
 */
export function formatContext(
  kind: "thread" | "channel",
  messages: ContextMessage[],
  mentionTs: string,
  nameOf: (id: string) => string,
): { text: string; count: number } {
  const earlier = messages
    .filter((m): m is ContextMessage & { ts: string } => typeof m.ts === "string" && Number(m.ts) < Number(mentionTs))
    .sort((a, b) => Number(a.ts) - Number(b.ts))
    .slice(-MAX_MESSAGES);
  if (earlier.length === 0) return { text: "", count: 0 };
  const heading =
    kind === "thread"
      ? "The thread this was posted in, oldest first; the message above is the latest:"
      : "The channel messages just above this one, oldest first:";
  const lines = earlier.map((m) => `- ${author(m, nameOf)} at ${when(m.ts)}: ${body(m, nameOf)}`);
  return { text: `${heading}\n${lines.join("\n")}`, count: earlier.length };
}

/** Display names by user id, one lookup each for the life of the process. */
export function userNames(client: WebClient): (id: string) => Promise<string> {
  const cache = new Map<string, Promise<string>>();
  return (id) => {
    let name = cache.get(id);
    if (!name) {
      name = client.users.info({ user: id }).then(
        (response) => response.user?.real_name || response.user?.name || id,
        () => id,
      );
      cache.set(id, name);
    }
    return name;
  };
}

async function threadMessages(client: WebClient, mention: Mention & { thread_ts: string }): Promise<ContextMessage[]> {
  const all: ContextMessage[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.conversations.replies({
      channel: mention.channel,
      ts: mention.thread_ts,
      latest: mention.ts,
      inclusive: false,
      limit: 200,
      cursor,
    });
    all.push(...(page.messages ?? []));
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor && all.length < 1000);
  return all;
}

/** What the sender was looking at: the thread the mention sits in, or the channel just above a top-level one. */
export async function fetchContext(
  client: WebClient,
  mention: Mention,
  lookup: (id: string) => Promise<string>,
): Promise<{ text: string; count: number }> {
  const kind = mention.thread_ts ? "thread" : "channel";
  const messages = mention.thread_ts
    ? await threadMessages(client, { ...mention, thread_ts: mention.thread_ts })
    : ((await client.conversations.history({ channel: mention.channel, latest: mention.ts, inclusive: false, limit: CHANNEL_MESSAGES }))
        .messages ?? []);
  const ids = new Set<string>();
  for (const m of messages) {
    if (m.user) ids.add(m.user);
    for (const match of (m.text ?? "").matchAll(/<@([A-Z0-9]+)/g)) ids.add(match[1] ?? "");
  }
  ids.delete("");
  const names = new Map(await Promise.all([...ids].map(async (id) => [id, await lookup(id)] as const)));
  return formatContext(kind, messages, mention.ts, (id) => names.get(id) ?? id);
}
