import { spawn } from "node:child_process";
import { createClaudeAdapter } from "./agent/claude.js";
import { loadConfig } from "./config.js";
import { acquireLock } from "./core/lock.js";
import { startSlack } from "./core/slack.js";
import { TurnRunner } from "./core/turn.js";

const config = loadConfig();
try {
  acquireLock(config.stateDir);
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
// A sleeping Mac drops the Socket Mode connection, so hold it awake on AC power for as long as this process lives.
if (process.platform === "darwin") spawn("/usr/bin/caffeinate", ["-s", "-w", String(process.pid)], { stdio: "ignore" }).unref();
const adapter = createClaudeAdapter({ model: config.model, effort: config.effort });
const runner = new TurnRunner(config, adapter, "mclaude");

console.log(`Project ${config.project}`);
console.log(`Workspace ${runner.workspace}, ${runner.sharedMemory.length} shared memory files`);
runner.ledger.record({ type: "started", pid: process.pid, project: config.project, memory: runner.sharedMemory.length });

await startSlack(config, runner, adapter.name);
