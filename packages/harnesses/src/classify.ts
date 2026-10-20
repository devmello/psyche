import type { HarnessAction } from "@psyche/agent-core";

/**
 * Claude Code's tool calls as Psyche harness actions (feature C10): the side-effect class, the
 * target the card shows, and an existing approval kind where one fits. Edits are `file_write`
 * (the card shows the change), shell commands `exec`, a `git push` is `git_push` (always asked,
 * `once` only, never forced), a fetch of a page `new_origin`. A tool Psyche does not know is a
 * `write`: an unclassified action is never treated as harmless.
 */

export interface PathMap {
  /** Where the repository is inside the sandbox, e.g. `/workspace/repo`. */
  container: string;
  /** The same folder on the owner's machine. */
  host: string;
}

const READS = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead", "TodoRead"]);
const EDITS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
/** Harness-internal bookkeeping with no effect outside the session. */
const INTERNAL = new Set(["TodoWrite", "Task", "ExitPlanMode", "BashOutput", "KillShell"]);

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** A container path as the owner's path, when it lies in the repository. */
export function hostPath(path: string, map: PathMap): string {
  if (path === map.container) return map.host;
  if (path.startsWith(`${map.container}/`)) return `${map.host}${path.slice(map.container.length)}`;
  return path;
}

function diffOf(input: Record<string, unknown>): string | undefined {
  if (typeof input.old_string === "string" && typeof input.new_string === "string") {
    const minus = input.old_string.split("\n").map((l) => `-${l}`);
    const plus = input.new_string.split("\n").map((l) => `+${l}`);
    return [...minus, ...plus].join("\n");
  }
  if (typeof input.content === "string")
    return input.content
      .split("\n")
      .map((l) => `+${l}`)
      .join("\n");
  return undefined;
}

export function classifyClaudeTool(tool: string, raw: unknown, map: PathMap): HarnessAction {
  const input = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const file = str(input.file_path) || str(input.notebook_path) || str(input.path);
  if (READS.has(tool)) {
    const path = file === "" ? map.host : hostPath(file, map);
    return {
      tool,
      input: raw,
      sideEffect: "read",
      targetKind: "path",
      target: { kind: "path", value: path },
      summary: `${tool} ${path}`,
    };
  }
  if (INTERNAL.has(tool)) {
    return { tool, input: raw, sideEffect: "none", summary: `${tool} (session bookkeeping)` };
  }
  if (EDITS.has(tool)) {
    const path = hostPath(file, map);
    const diff = diffOf(input);
    return {
      tool,
      input: raw,
      sideEffect: "write",
      targetKind: "path",
      target: { kind: "path", value: path },
      summary: `${tool === "Write" ? "Write" : "Edit"} ${path}`,
      kind: "file_write",
      bindingFields: { operation: tool, realPath: path },
      details: { path, operation: tool, ...(diff === undefined ? {} : { diff }) },
    };
  }
  if (tool === "Bash") {
    const command = str(input.command);
    const push = /^\s*git(\s+-\S+(\s+\S+)?)*\s+push\b/.exec(command);
    if (push !== null) {
      // A forced push rewrites the remote's history: destructive, `once` only.
      const force = /(^|\s)(-f|--force|--force-with-lease)(\s|=|$)|\s\+\S/.test(command);
      return {
        tool,
        input: raw,
        sideEffect: force ? "destructive" : "write",
        targetKind: "command",
        target: { kind: "command", value: command.slice(0, 1000) },
        summary: `git push from ${map.host}`,
        kind: "git_push",
        bindingFields: { repo: map.host, command },
        details: { repo: map.host, command, force },
      };
    }
    return {
      tool,
      input: raw,
      sideEffect: "write",
      targetKind: "command",
      target: { kind: "command", value: command.slice(0, 1000) },
      summary: `Run \`${command.slice(0, 80)}\` in the sandbox`,
      kind: "exec",
      bindingFields: { argv: ["bash", "-c", command], cwd: map.container, network: "proxy" },
      details: { command, cwd: map.container, repo: map.host },
    };
  }
  if (tool === "WebFetch") {
    let origin = "";
    try {
      origin = new URL(str(input.url)).origin;
    } catch {
      origin = str(input.url);
    }
    return {
      tool,
      input: raw,
      sideEffect: "read",
      targetKind: "origin",
      target: { kind: "origin", value: origin },
      summary: `Fetch ${str(input.url).slice(0, 200)}`,
      kind: "new_origin",
    };
  }
  if (tool === "WebSearch") {
    return {
      tool,
      input: raw,
      sideEffect: "read",
      summary: `Search the web: ${str(input.query).slice(0, 120)}`,
    };
  }
  return {
    tool,
    input: raw,
    sideEffect: "write",
    summary: `${tool} (a tool Psyche does not know)`,
  };
}
