import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Claude Code keys a project's memory and transcripts on its absolute path,
 * with every "/" and "." replaced by "-". A generated workspace therefore gets
 * its own memory directory, and we fill that directory with symlinks to the
 * subset of the real memory that may enter a shared Slack session.
 */
export function projectKey(absolutePath: string): string {
  return absolutePath.replace(/[/.]/g, "-");
}

/** Where Claude Code writes a project's session transcripts, one `<sessionId>.jsonl` each. */
export function transcriptDirFor(absolutePath: string): string {
  return join(homedir(), ".claude", "projects", projectKey(absolutePath));
}

/** The bot's workspace: its sessions' working directory, and so the key of its memory and transcripts. */
export function workspaceFor(stateDir: string): string {
  return join(stateDir, "workspace");
}

export function memoryDirFor(absolutePath: string): string {
  return join(homedir(), ".claude", "projects", projectKey(absolutePath), "memory");
}

/**
 * Memory is kept at the main checkout's root and shared by every git worktree,
 * so a project configured as a worktree must resolve to that root.
 */
export function memoryRootFor(project: string): string {
  try {
    const commonDir = execFileSync("git", ["-C", project, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return dirname(commonDir);
  } catch {
    return project;
  }
}

function matcher(patterns: string[]): (name: string) => boolean {
  const regexes = patterns.map(
    (p) => new RegExp(`^${p.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`),
  );
  return (name) => regexes.some((r) => r.test(name));
}

/** Keep index lines whose link target is shared; drop sections left with no entries. */
function filterIndex(index: string, isShared: (name: string) => boolean): string {
  const lines = index.split("\n");
  const out: string[] = [];
  let pendingHeader: string | undefined;
  for (const line of lines) {
    if (/^#{2,6}\s/.test(line)) {
      pendingHeader = line;
      continue;
    }
    const link = /\]\(([^)]+\.md)\)/.exec(line);
    if (link) {
      if (!isShared(link[1] ?? "")) continue;
      if (pendingHeader !== undefined) {
        out.push("", pendingHeader);
        pendingHeader = undefined;
      }
      out.push(line);
    } else if (pendingHeader === undefined) {
      out.push(line);
    }
  }
  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

export interface ScopeResult {
  workspace: string;
  memoryDir: string;
  shared: string[];
}

/**
 * Rebuild the shared-scope workspace: a directory whose memory holds only the
 * files matching `share`. Everything else in the source memory is never loaded,
 * so no prompt can reveal it.
 */
export function buildScope(options: { project: string; stateDir: string; share: string[] }): ScopeResult {
  const workspace = workspaceFor(options.stateDir);
  const sourceMemory = memoryDirFor(memoryRootFor(options.project));
  const targetMemory = memoryDirFor(workspace);
  const isShared = matcher(options.share);

  rmSync(targetMemory, { recursive: true, force: true });
  mkdirSync(targetMemory, { recursive: true });
  mkdirSync(workspace, { recursive: true });

  const shared: string[] = [];
  if (existsSync(sourceMemory)) {
    for (const name of readdirSync(sourceMemory)) {
      if (name === "MEMORY.md") continue;
      if (!isShared(name)) continue;
      symlinkSync(join(sourceMemory, name), join(targetMemory, name));
      shared.push(name);
    }
    const indexPath = join(sourceMemory, "MEMORY.md");
    if (existsSync(indexPath)) {
      writeFileSync(join(targetMemory, "MEMORY.md"), filterIndex(readFileSync(indexPath, "utf8"), isShared));
    }
  }

  writeFileSync(
    join(workspace, "CLAUDE.md"),
    [
      "# Workspace",
      "",
      "This directory is a Slack bot's scope, not a codebase.",
      `The project is at \`${options.project}\`. Read its top-level instructions file before working in it,`,
      "and run every command from inside it.",
      "",
      "Your memory directory here is a curated, read-only view. Do not write to it.",
      "",
    ].join("\n"),
  );

  return { workspace, memoryDir: targetMemory, shared: shared.sort() };
}
