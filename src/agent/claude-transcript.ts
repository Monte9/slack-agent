import type { TranscriptEvent } from "./types.js";

interface ContentBlock {
  type?: string;
  name?: string;
  text?: string;
  input?: Record<string, unknown>;
  is_error?: boolean;
  content?: unknown;
}

function summary(input: Record<string, unknown>): string {
  const value = input.description ?? input.command ?? input.file_path ?? input.pattern ?? input.query ?? input.url ?? input.skill;
  return typeof value === "string" ? value : JSON.stringify(input);
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.map((part) => (typeof part?.text === "string" ? part.text : "")).join(" ") : "";
}

/**
 * One line of a Claude Code transcript as watch events: each tool call, each failed tool result, and the
 * agent's text, the reply included. Entry types it does not know are skipped, since the format is Claude Code's.
 */
export function readTranscriptLine(line: string): TranscriptEvent[] {
  let entry: { type?: string; timestamp?: string; message?: { content?: unknown } };
  try {
    entry = JSON.parse(line);
  } catch {
    return [];
  }
  const at = entry.timestamp;
  const blocks: ContentBlock[] = Array.isArray(entry.message?.content) ? entry.message.content : [];
  if (entry.type === "assistant") {
    return blocks.flatMap((b): TranscriptEvent[] => {
      if (b.type === "tool_use") return [{ at, kind: "tool", text: `${b.name} ${summary(b.input ?? {})}` }];
      return b.type === "text" && b.text?.trim() ? [{ at, kind: "text", text: b.text }] : [];
    });
  }
  if (entry.type === "user") {
    return blocks.filter((b) => b.type === "tool_result" && b.is_error).map((b) => ({ at, kind: "tool error", text: resultText(b.content) }));
  }
  return [];
}
