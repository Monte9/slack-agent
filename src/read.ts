import { webApi } from "@slack/bolt";
import { loadConfig } from "./config.js";
import { SlackReader } from "./core/read.js";

/**
 * `slack-agent read`: Slack as the bot sees it, for a turn to run when its thread is not enough.
 *   channels                                           the channels it is in
 *   history <channel> [--since 1d] [--limit 30]        the latest messages, oldest first
 *   thread <link> | thread <channel> <ts>              a thread, oldest first
 *   search <words> [--since 7d] [--channel <channel>]  messages with every word, threads included
 * A channel is an id, a <#C…> link, a message link or a #name.
 */
const flags = new Map<string, string>();
const words: string[] = [];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i] ?? "";
  if (arg.startsWith("--")) flags.set(arg.slice(2), args[++i] ?? "");
  else words.push(arg);
}
const [command, ...rest] = words;

try {
  const config = loadConfig();
  // The default retries for about 30 minutes; a turn waiting on this should fail fast instead.
  const client = new webApi.WebClient(config.slack.botToken, { retryConfig: { retries: 2 } });
  const reader = new SlackReader(client, (await client.auth.test()).url ?? "");
  if (command === "channels") console.log(await reader.describeChannels());
  else if (command === "history") console.log(await reader.describeHistory(rest[0] ?? "", flags.get("since") ?? "1d", Number(flags.get("limit") ?? 30)));
  else if (command === "thread") console.log(await reader.describeThread(rest));
  else if (command === "search") console.log(await reader.describeSearch(rest.join(" "), flags.get("since") ?? "7d", flags.get("channel")));
  else throw new Error("Usage: slack-agent read channels | history <channel> | thread <link> | search <words>");
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
