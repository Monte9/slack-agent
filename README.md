# slack-agent

A Slack bot that gives a local coding agent, and its memory, a persistent handle in your workspace.

You mention the bot in any channel. It runs one long-lived agent session on your machine, in your
project, with the memory that project has accumulated. Every mention, in every thread, lands in
that same session, so the bot remembers what it was asked an hour ago and what it found out.

The agent runtime is an adapter. The first one is the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview),
backed by your own `claude login`. The core does not care which runtime answers.

## How it works

- **Socket Mode, no public URL.** The bot runs where the memory lives, on your laptop, and holds a
  WebSocket to Slack. Nothing inbound.
- **One session.** A session id lives in `~/.slack-agent/session.json`. Restarting the bot resumes
  it. `@bot new` starts over. `@bot status` prints the context the session now carries per request,
  so you can see when `new` is due, and the id so you can resume the same session from a terminal
  after stopping the bot.
- **Thread context.** Before a turn, the bot reads the thread the mention sits in (or the ten
  channel messages above a top-level mention) with its own token and puts them in the prompt, oldest
  first, so "both", "this" and "the above" resolve. Names replace user ids and links keep their URL.
  The policy keeps the owner's Slack connector closed, so this is all of Slack the agent sees; when
  it is not enough, it is told to ask rather than guess.
- **One bot.** A second copy exits at startup naming the first one's pid (`~/.slack-agent/bot.pid`),
  so `dev` beside the service, or a copy left behind in a shell, cannot split the mentions between
  two sessions. `slack-agent restart` stops every copy and starts one.
- **Serial by design.** Mentions queue and run in order. The second person hears "queued behind 1".
- **Visible progress.** Your message gets 👀 when picked up and ✅ or ❌ when done. A placeholder reply
  shows what the agent is doing right now, with an emoji per activity (📖 reading, 💻 running, 📊 Mixpanel,
  ✂️ revising), and becomes the answer when it finishes. A small grey line under each answer gives the
  time, tool calls, tokens in and out, the context the session now carries, and cost at API list
  prices (on a subscription that is a usage proxy, not a charge). Tokens in are summed over the
  turn's requests, one per tool call, so they track cost; context is the last request and tracks growth.
- **Shared-scope memory.** The session runs in a generated workspace whose memory directory holds
  symlinks to only the memory files matching `memoryShare` (by default `project_*` and `reference_*`).
  Files that don't match are never loaded, so no prompt can reveal them. Memory is read-only from Slack.
- **Allowlist and owner.** Only Slack users on the allowlist get answers. The sender id comes from the
  Slack event, never from the message text.
- **A tool policy, one file.** `~/.slack-agent/policy.json` is a list of rules, first match wins:

  ```json
  { "match": "mcp__claude_ai_Gmail__*", "allow": "nobody", "reason": "personal mail stays out of Slack" }
  { "match": "Bash(gh pr merge*)",      "allow": "owner",  "reason": "merging is the owner's call" }
  ```

  `match` is a tool name with `*` wildcards, or `Tool(argument*)` for a command prefix or file path,
  the same shape as Claude Code's own permission rules. `allow` is `nobody`, `owner` or `everyone`;
  unmatched tools are allowed. Rules are enforced in a hook on every tool call, before any allow
  rule the runtime has, and re-read every turn so edits apply without a restart. The agent sees the
  rules in its system prompt, so it says what it cannot do instead of trying. Every denial and every
  owner-only use is one line in `~/.slack-agent/audit.jsonl`. Start from
  [`policy.example.json`](policy.example.json), which keeps personal connectors (Gmail, Calendar,
  Drive, Slack-as-you) out entirely and reserves push, merge, release and Notion writes for the owner.

## Setup

Requirements: Node 24+, pnpm, and a Claude Code login (`claude login`) on the machine that runs the bot.

1. **Create the Slack app** from [`manifest.json`](manifest.json). To give your instance its own name
   and description, copy `manifest.local.example.json` to `manifest.local.json` (gitignored); it is
   merged over the committed manifest. Either way works:
   - With the [Slack CLI](https://docs.slack.dev/tools/slack-cli): `slack login`, then
     `slack app install --environment deployed` from this directory. The CLI reads the merged manifest
     through `.slack/hooks.json` and records the app id in `.slack/apps.json` (gitignored). Rerun the
     install after changing scopes; the bot token keeps its value and gains the scope.
   - In the browser: at [api.slack.com/apps](https://api.slack.com/apps) choose *Create New App → From a
     manifest*, paste the file, and install the app to your workspace.
2. **Tokens.** Copy `.env.example` to `.env`. Fill `SLACK_BOT_TOKEN` (OAuth & Permissions → Bot User OAuth
   Token) and `SLACK_APP_TOKEN` (Basic Information → App-Level Tokens, scope `connections:write`).
   `slack app settings` opens the right page.
3. **Config.** Copy `config.example.json` to `config.json`. Set `project` to your repo, `owner` to your
   Slack user id, and `allowlist` to who may talk to the bot. Slack is instant messaging, so a reply is
   checked before it is posted: over `maxReplyWords` (default 80), or no link after consulting an external
   source, and it goes back to the agent once for a corrected version.
4. **House style**, optional. Write `~/.slack-agent/instructions.md` (or point `instructionsFile`
   elsewhere): link formats, URL patterns for your tools, anything about voice. It is appended to the
   agent's system prompt and re-read on every turn, so edits apply without a restart. The generic rules,
   such as "link what you cite", are in code; this file is for what is specific to your instance.
5. **Run.**

   ```bash
   pnpm install
   pnpm start
   ```

   Invite the bot to a channel and mention it. While changing the bot, run `pnpm dev` instead: it
   restarts on every source change, and the session resumes from disk, so there is never an old
   process serving stale code. A save mid-turn does cut that turn short.

### The `slack-agent` command

Put the command on your PATH once, then everything below is `slack-agent <verb>`:

```bash
pnpm link --global      # or: ln -s "$PWD/scripts/slack-agent" ~/.local/bin/slack-agent
```

`slack-agent start|stop|restart|status|logs` drive the background service, `install|uninstall`
add or remove it, `dev` runs the bot in the foreground with hot reload, `ask "question"` runs one
turn without Slack, `scope` rebuilds the shared memory workspace. `pnpm service <verb>` and
`pnpm dev|ask|scope` do the same from inside the repo.

### Run it unattended (macOS)

```bash
slack-agent install
```

That writes a launchd user agent and loads it: the bot starts now and at every login, and restarts
if it dies. It also builds a small app bundle at `~/Applications/Slack Agent.app` (the name comes
from `APP_DISPLAY_NAME`) with the bot's Slack avatar as its icon, so System Settings › Login Items
shows "Slack Agent" rather than "pnpm". The bundle is signed with a Developer ID or Apple Development certificate when
one is in the keychain, ad hoc otherwise. `pnpm service status` shows whether it is loaded, its pid and last exit code, and the
log tail; `stop`, `start`, `restart`, `logs` and `uninstall` do what they say. The log is
`~/.slack-agent/bot.log`. While changing the bot, `slack-agent stop` then `slack-agent dev`, and
`slack-agent start` when done; `dev` refuses to start beside the service. The bundle records the
`node` and `pnpm` on your PATH at install time, so after upgrading Node run `slack-agent install`
again: `restart` keeps the runtime it was installed with.

### Local checks without Slack

```bash
pnpm scope                 # rebuild the workspace and list the memory it shares
pnpm ask "what do you remember about X"
pnpm status
```

`pnpm ask` drives the same session the bot uses, as the owner.

## Security

- Your tokens and `config.json` are gitignored. Nothing of yours is in this repo.
- The bot answers only Slack users on `allowlist`, and reads the sender id from the Slack event, never
  from the message text. "The owner said to" carries no weight.
- The session sees only the memory files matching `memoryShare`. Choose those patterns so that personal
  notes never match.
- Memory directories are write-protected for every requester. The scoped memory is symlinked to the real
  one, so a write through it would change the original.
- Bot-authored messages are ignored, so two bots cannot talk each other into anything.
- A session driven from Slack should not be opened in a terminal at the same time. Stop the bot first,
  then `claude --resume <id>`.

## Adapters

Core owns Slack, the queue, the session file, memory scoping and the gate. An adapter implements
[`AgentAdapter`](src/agent/types.ts): run a prompt in a directory, resume a session, stream events, and
consult the gate before each tool call. A runtime without a per-tool callback declares
`toolGating: "runtime"` and is sandboxed as a whole instead.

## License

MIT
