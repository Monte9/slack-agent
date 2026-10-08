const HEREDOC = /^<<-?[ \t]*(['"]?)([^\s'";&|<>()]+)\1/;
const KEYWORD = /^(?:if|then|else|elif|do|while|until|!|\{)\s+/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S*)\s+/;
const WRAPPER = /^(?:sudo|env|command|exec|nohup|time|xargs)(?:\s+-\S+)*\s+/;
const GIT_GLOBALS = /^git(?:\s+(?:--no-pager|(?:-C|-c|--git-dir|--work-tree)(?:=|\s+)(?:'[^']*'|"[^"]*"|\S+)))+(?=\s|$)/;
const SHELL_STRING = /^(?:(?:ba|z|da)?sh\s+-\w*c\w*|eval)\s+(?:'([^']*)'|"((?:\\.|[^"\\])*)"|(.+))$/s;

/**
 * The simple commands a Bash command line runs, normalized so a `Bash(git push*)` rule sees `git push`
 * whether it comes first, after `cd repo &&`, inside `$(…)` or `bash -c`, or behind `sudo` or `git -C`.
 * Quoted text, comments and heredoc bodies are data, not commands. This is a guardrail for an agent that
 * follows instructions, not a shell sandbox: it doesn't expand variables or aliases.
 */
export function commandsOf(line: string): string[] {
  const found: string[] = [];
  scan(line, 0, "", found);
  return found.flatMap(normalize);
}

/** Splits `s` from `i` into commands until `close` or the end, and returns the index after `close`. */
function scan(s: string, i: number, close: ")" | "`" | "", found: string[]): number {
  let current = "";
  let depth = 0;
  const heredocs: string[] = [];
  const finish = () => {
    if (current.trim()) found.push(current.trim());
    current = "";
  };
  while (i < s.length) {
    const c = s[i] ?? "";
    const next = s[i + 1];
    if (c === close && depth === 0) {
      finish();
      return i + 1;
    }
    let end = i + 1;
    if (c === "\\") end = i + 2;
    else if (c === "'") end = s.indexOf("'", i + 1) + 1 || s.length;
    else if (c === '"') end = doubleQuoted(s, i, found);
    else if (c === "$" && next === "(") end = scan(s, i + 2, ")", found);
    else if (c === "`") end = scan(s, i + 1, "`", found);
    else if (c === "#" && /(^|\s)$/.test(current)) {
      const newline = s.indexOf("\n", i);
      i = newline === -1 ? s.length : newline;
      continue;
    } else if (c === "<" && next === "<" && s[i - 1] !== "<" && s[i + 2] !== "<") {
      const heredoc = HEREDOC.exec(s.slice(i));
      if (heredoc) {
        heredocs.push(heredoc[2] ?? "");
        end = i + heredoc[0].length;
      }
    } else if (c === "\n") {
      finish();
      i = skipBodies(s, i + 1, heredocs.splice(0));
      continue;
    } else if (c === "&" && (next === ">" || s[i - 1] === ">" || s[i - 1] === "<")) {
      // A redirection such as 2>&1 or &>file, not a separator.
    } else if (c === ";" || c === "|" || c === "&" || c === "(" || c === ")") {
      if (c === "(") depth++;
      if (c === ")") depth = Math.max(0, depth - 1);
      finish();
      i++;
      continue;
    }
    current += s.slice(i, end);
    i = end;
  }
  finish();
  return i;
}

/** The index after the double-quoted string at `i`, collecting the commands its `$(…)` and backticks run. */
function doubleQuoted(s: string, i: number, found: string[]): number {
  let j = i + 1;
  while (j < s.length && s[j] !== '"') {
    if (s[j] === "\\") j += 2;
    else if (s[j] === "$" && s[j + 1] === "(") j = scan(s, j + 2, ")", found);
    else if (s[j] === "`") j = scan(s, j + 1, "`", found);
    else j++;
  }
  return Math.min(j + 1, s.length);
}

/** Skips the heredoc bodies that start at `i`, one per delimiter, and returns the index after the last. */
function skipBodies(s: string, i: number, delimiters: string[]): number {
  for (const delimiter of delimiters) {
    while (i < s.length) {
      const newline = s.indexOf("\n", i);
      const lineEnd = newline === -1 ? s.length : newline;
      const line = s.slice(i, lineEnd);
      i = lineEnd + 1;
      if (line.trim() === delimiter) break;
    }
  }
  return Math.min(i, s.length);
}

/** Strips what runs a command without being it, and adds the commands a `bash -c` or `eval` string runs. */
function normalize(command: string): string[] {
  let text = command;
  for (let previous = ""; previous !== text; ) {
    previous = text;
    text = text.replace(KEYWORD, "").replace(ASSIGNMENT, "").replace(WRAPPER, "");
  }
  text = text.replace(/^\S*\/(?=\S)/, "").replace(GIT_GLOBALS, "git");
  const nested = SHELL_STRING.exec(text);
  const inner = nested ? commandsOf(nested[1] ?? nested[2] ?? nested[3] ?? "") : [];
  return text ? [text, ...inner] : inner;
}
