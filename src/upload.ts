import { basename } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { webApi } from "@slack/bolt";
import { loadConfig } from "./config.js";
import { parseLink } from "./core/read.js";

/**
 * `slack-agent upload <channel | message link> <file> [--comment <text>] [--title <text>] [--broadcast]`:
 * posts a local file as the bot, so a turn can share an image without the token reaching the session.
 * A message link posts into that message's thread; a channel id or <#C…> link posts at the top level.
 * `--broadcast` with a message link also shows an image in the channel, like "Also send to channel".
 */
const flags = new Map<string, string>();
const words: string[] = [];
let broadcast = false;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i] ?? "";
  if (arg === "--broadcast") broadcast = true;
  else if (arg.startsWith("--")) flags.set(arg.slice(2), args[++i] ?? "");
  else words.push(arg);
}
const [target = "", file = ""] = words;

type UploadResult = { files?: { files?: { id?: string }[] }[] };

try {
  if (!target || !file) {
    throw new Error("Usage: slack-agent upload <channel | message link> <file> [--comment <text>] [--title <text>] [--broadcast]");
  }
  const link = parseLink(target);
  const channel = link?.channel ?? /^<?#?([CG][A-Z0-9]{6,})(?:\|[^>]*)?>?$/.exec(target)?.[1];
  if (!channel) throw new Error(`"${target}" is not a channel id or a message link`);
  const threadTs = link ? (link.thread ?? link.ts) : undefined;
  if (broadcast && !threadTs) throw new Error("--broadcast needs a message link to reply under");
  const config = loadConfig();
  // The default retries for about 30 minutes; a turn waiting on this should fail fast instead.
  const client = new webApi.WebClient(config.slack.botToken, { retryConfig: { retries: 2 } });
  const comment = flags.get("comment");
  const title = flags.get("title");
  const upload = {
    file,
    filename: basename(file),
    ...(title ? { title } : {}),
    ...(comment ? { initial_comment: comment } : {}),
  };

  if (broadcast && threadTs) {
    // Files cannot be broadcast, so upload it unshared and post it as an image block with reply_broadcast.
    const result = (await client.files.uploadV2({ file, filename: basename(file), ...(title ? { title } : {}) })) as UploadResult;
    const id = result.files?.[0]?.files?.[0]?.id;
    if (!id) throw new Error("Slack returned no file id for the upload");
    const blocks = [
      ...(comment ? [{ type: "section" as const, text: { type: "mrkdwn" as const, text: comment } }] : []),
      { type: "image" as const, slack_file: { id }, alt_text: title ?? basename(file) },
    ];
    for (let attempt = 1; ; attempt++) {
      try {
        await client.chat.postMessage({ channel, thread_ts: threadTs, reply_broadcast: true, text: comment ?? title ?? basename(file), blocks });
        break;
      } catch (error) {
        // A just-uploaded image is still processing for a few seconds and the block is rejected until it is ready.
        if (attempt >= 6 || !String(error).includes("invalid_blocks")) throw error;
        await sleep(2000);
      }
    }
  } else if (threadTs) {
    await client.files.uploadV2({ ...upload, channel_id: channel, thread_ts: threadTs });
  } else {
    await client.files.uploadV2({ ...upload, channel_id: channel });
  }
  const where = threadTs ? ` in thread ${threadTs}${broadcast ? ", also sent to the channel" : ""}` : "";
  console.log(`Uploaded ${basename(file)} to <#${channel}>${where}`);
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
