import { createClaudeAdapter } from "./agent/claude.js";
import { loadConfigWithoutSlack } from "./config.js";
import { watch } from "./core/watch.js";

/** `slack-agent watch`. Only reads, so it never touches the running bot (cli.ts rebuilds the workspace). */
const config = loadConfigWithoutSlack();
watch(config.stateDir, createClaudeAdapter({ model: config.model }));
