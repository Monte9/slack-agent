import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export interface Config {
  /** Absolute path to the repo the agent works in. Its memory is the bot's identity. */
  project: string;
  /** Slack user id of the owner. Privileged actions are allowed for this user only. */
  owner: string;
  /** Slack user ids the bot answers. Everyone else is told they are not on the list. */
  allowlist: string[];
  /** Glob-like patterns (prefix + `*`) for memory files that enter a Slack session. */
  memoryShare: string[];
  /** Which agent runtime runs the session. */
  adapter: "claude";
  /** Model override for the adapter, or null for the runtime default. */
  model: string | null;
  /** Reasoning effort override, or null for the model's default. */
  effort: Effort | null;
  /** Where the bot keeps its session file, generated workspace and ledger. */
  stateDir: string;
  /** A markdown file appended to the agent's system prompt, for house style. Read on every turn. */
  instructionsFile: string;
  /** Replies longer than this are sent back to the agent once to be shortened. */
  maxReplyWords: number;
  /** The tool policy: who may use which tools. Read on every turn. See policy.example.json. */
  policyFile: string;
  slack: {
    botToken: string;
    appToken: string;
  };
}

export function expandHome(path: string): string {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function loadEnv(): void {
  const envPath = resolve(process.cwd(), ".env");
  if (existsSync(envPath)) process.loadEnvFile(envPath);
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}. Copy .env.example to .env and fill it in.`);
  return value;
}

function assertString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`config.json: "${key}" must be a non-empty string`);
  }
  return value;
}

function assertStringArray(obj: Record<string, unknown>, key: string): string[] {
  const value = obj[key];
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new Error(`config.json: "${key}" must be an array of strings`);
  }
  return value;
}

export function loadConfig(): Config {
  loadEnv();
  const configPath = resolve(process.cwd(), process.env.CONFIG_PATH ?? "config.json");
  if (!existsSync(configPath)) {
    throw new Error(`No config at ${configPath}. Copy config.example.json to config.json and fill it in.`);
  }
  const raw = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;

  const project = resolve(expandHome(assertString(raw, "project")));
  if (!existsSync(project)) throw new Error(`config.json: project path does not exist: ${project}`);

  const adapter = assertString(raw, "adapter");
  if (adapter !== "claude") throw new Error(`config.json: unknown adapter "${adapter}"`);

  const model = raw.model == null ? null : assertString(raw, "model");
  const effort = raw.effort == null ? null : assertString(raw, "effort");
  if (effort !== null && !EFFORTS.includes(effort as Effort)) {
    throw new Error(`config.json: "effort" must be one of ${EFFORTS.join(", ")}`);
  }
  const stateDir = resolve(expandHome(typeof raw.stateDir === "string" ? raw.stateDir : "~/.slack-agent"));
  const instructionsFile = resolve(
    expandHome(typeof raw.instructionsFile === "string" && raw.instructionsFile ? raw.instructionsFile : join(stateDir, "instructions.md")),
  );
  const policyFile = resolve(
    expandHome(typeof raw.policyFile === "string" && raw.policyFile ? raw.policyFile : join(stateDir, "policy.json")),
  );
  const maxReplyWords = raw.maxReplyWords == null ? 80 : Number(raw.maxReplyWords);
  if (!Number.isInteger(maxReplyWords) || maxReplyWords < 10) {
    throw new Error('config.json: "maxReplyWords" must be an integer of at least 10');
  }

  return {
    instructionsFile,
    policyFile,
    maxReplyWords,
    project,
    owner: assertString(raw, "owner"),
    allowlist: assertStringArray(raw, "allowlist"),
    memoryShare: assertStringArray(raw, "memoryShare"),
    adapter,
    model,
    effort: effort as Effort | null,
    stateDir,
    slack: {
      botToken: required("SLACK_BOT_TOKEN"),
      appToken: required("SLACK_APP_TOKEN"),
    },
  };
}

/** Same as loadConfig, but without Slack tokens, for the local CLI. */
export function loadConfigWithoutSlack(): Omit<Config, "slack"> {
  process.env.SLACK_BOT_TOKEN ??= "unused";
  process.env.SLACK_APP_TOKEN ??= "unused";
  const { slack: _slack, ...rest } = loadConfig();
  return rest;
}
