import { existsSync, readFileSync } from "node:fs";
import type { Gate, GateDecision } from "../agent/types.js";

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

export type Allow = "nobody" | "owner" | "everyone";

export interface Rule {
  /** A tool name with `*` wildcards, or `Tool(argument*)` to match a command prefix or a file path. */
  match: string;
  allow: Allow;
  reason?: string;
}

export interface Policy {
  rules: Rule[];
}

/** The main argument of a tool call, the part a `Tool(argument)` pattern is matched against. */
function argumentOf(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "Bash") return String(input.command ?? "");
  if (WRITE_TOOLS.has(toolName)) return String(input.file_path ?? input.notebook_path ?? "");
  if (toolName === "Read") return String(input.file_path ?? "");
  const first = Object.values(input).find((v) => typeof v === "string");
  return typeof first === "string" ? first : "";
}

function globToRegExp(glob: string): RegExp {
  return new RegExp(`^${glob.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "s");
}

/** `Edit` rules cover every tool that edits a file, as Claude Code's own permission rules do. */
function toolMatches(pattern: string, toolName: string): boolean {
  if (pattern === "Edit" && WRITE_TOOLS.has(toolName)) return true;
  return globToRegExp(pattern).test(toolName);
}

export function ruleMatches(rule: Rule, toolName: string, input: Record<string, unknown>): boolean {
  const withArgument = /^([^()]+)\((.*)\)$/s.exec(rule.match);
  if (!withArgument) return toolMatches(rule.match, toolName);
  const [, tool = "", argument = ""] = withArgument;
  return toolMatches(tool, toolName) && globToRegExp(argument).test(argumentOf(toolName, input));
}

export function decide(
  policy: Policy,
  toolName: string,
  input: Record<string, unknown>,
  isOwner: boolean,
): { rule?: Rule; decision: GateDecision } {
  const rule = policy.rules.find((r) => ruleMatches(r, toolName, input));
  if (!rule || rule.allow === "everyone" || (rule.allow === "owner" && isOwner)) return { rule, decision: { allow: true } };
  const why = rule.reason ? ` (${rule.reason})` : "";
  const reason = rule.allow === "nobody" ? `Not allowed from Slack${why}.` : `Only the owner can do that${why}. Ask them to run it.`;
  return { rule, decision: { allow: false, reason } };
}

/** Read on every turn, so edits to the file apply without a restart. A missing file means no rules. */
export function loadPolicy(path: string): Policy {
  if (!existsSync(path)) return { rules: [] };
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Policy>;
  const rules = Array.isArray(raw.rules) ? raw.rules : [];
  for (const rule of rules) {
    if (typeof rule.match !== "string" || !["nobody", "owner", "everyone"].includes(rule.allow)) {
      throw new Error(`${path}: each rule needs a "match" string and an "allow" of nobody, owner or everyone`);
    }
  }
  return { rules };
}

/** The rules as prose for the system prompt, so the agent explains a refusal instead of attempting it. */
export function describePolicy(policy: Policy): string {
  const list = (allow: Allow) => policy.rules.filter((r) => r.allow === allow).map((r) => r.match);
  const nobody = list("nobody");
  const owner = list("owner");
  if (nobody.length === 0 && owner.length === 0) return "";
  const lines = ["Tool policy, enforced outside your control; when a task needs one of these, say so instead of trying:"];
  if (nobody.length > 0) lines.push(`Never available from Slack: ${nobody.join(", ")}.`);
  if (owner.length > 0) lines.push(`Owner only, refused for anyone else: ${owner.join(", ")}.`);
  return lines.join("\n");
}

export interface GateContext {
  requester: string;
  isOwner: boolean;
  policy: Policy;
  /** Paths no session may write through, such as the real and scoped memory directories. */
  protectedPaths: string[];
  /** Called for every denial and every owner-only allowance. */
  record: (decision: PolicyDecision) => void;
}

export interface PolicyDecision {
  requester: string;
  owner: boolean;
  tool: string;
  decision: "allow" | "deny";
  rule?: string;
  reason?: string;
  input: string;
}

function touchesProtected(toolName: string, input: Record<string, unknown>, protectedPaths: string[]): boolean {
  const target = WRITE_TOOLS.has(toolName) || toolName === "Bash" ? argumentOf(toolName, input) : "";
  return target !== "" && protectedPaths.some((p) => target.includes(p));
}

/** The gate: the memory guard first, then the policy rules. Denials and owner-only allowances are recorded. */
export function createGate(context: GateContext): Gate {
  return ({ toolName, input }) => {
    let decision: GateDecision = { allow: true };
    let rule: Rule | undefined;
    if (touchesProtected(toolName, input, context.protectedPaths)) {
      decision = { allow: false, reason: "Memory is read-only from Slack. Ask the owner to update it from a desktop session." };
    } else {
      ({ rule, decision } = decide(context.policy, toolName, input, context.isOwner));
    }
    if (!decision.allow || rule?.allow === "owner") {
      context.record({
        requester: context.requester,
        owner: context.isOwner,
        tool: toolName,
        decision: decision.allow ? "allow" : "deny",
        rule: rule?.match,
        reason: decision.allow ? undefined : decision.reason,
        input: JSON.stringify(input).slice(0, 300),
      });
    }
    return decision;
  };
}
