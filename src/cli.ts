import { createClaudeAdapter } from "./agent/claude.js";
import { loadConfigWithoutSlack } from "./config.js";
import { statusText } from "./core/status.js";
import { TurnRunner } from "./core/turn.js";

/**
 * Drive the same runner without Slack, for local checks:
 *   pnpm ask "what does my memory say about X"
 *   pnpm scope     rebuild the workspace and list what memory it shares
 *   pnpm status    print what `@bot status` would print
 */
const [command, ...rest] = process.argv.slice(2);
const config = loadConfigWithoutSlack();
const adapter = createClaudeAdapter({ model: config.model, effort: config.effort });
const runner = new TurnRunner(config, adapter, "mclaude");

if (command === "scope") {
  console.log(`Workspace: ${runner.workspace}`);
  console.log(`Shared memory (${runner.sharedMemory.length}):`);
  for (const name of runner.sharedMemory) console.log(`  ${name}`);
} else if (command === "status") {
  console.log(statusText(runner, adapter.name).replace(/\*/g, ""));
} else if (command === "ask") {
  const text = rest.join(" ").trim();
  if (!text) throw new Error('Usage: pnpm ask "your question"');
  const outcome = await runner.run({
    requester: config.owner,
    origin: "CLI",
    text,
    onEvent: (event) => {
      if (event.type === "init") console.error(`[session ${event.sessionId}] ${event.model} via ${event.credential}`);
      if (event.type === "tool") console.error(`[tool] ${event.name}: ${event.summary}`);
    },
  });
  console.log(outcome.text);
  console.error(`[turn ${outcome.session.turns}${outcome.rotated ? ", fresh session" : ""}${outcome.isError ? ", error" : ""}]`);
} else {
  throw new Error("Usage: pnpm ask <text> | pnpm scope | pnpm status");
}
