/**
 * Composer slash commands (feature C9; UI design §3.2). The grammar mirrors `agent-core`'s
 * `parseComposerInput` (the kit cannot import the agent runtime): a leading `/name` with an
 * optional argument, `//text` sends text that starts with a slash, anything else is a message.
 * The chat column executes the commands with protocol methods.
 */

export type CommandName =
  | "model"
  | "new"
  | "btw"
  | "fork"
  | "schedule"
  | "incognito"
  | "forget"
  | "remember"
  | "plan"
  | "status"
  | "export"
  | "stop";

export interface CommandInfo {
  name: CommandName;
  args: "none" | "optional" | "required";
  hint: string;
  description: string;
}

export const COMMANDS: readonly CommandInfo[] = [
  {
    name: "model",
    args: "optional",
    hint: "provider/model",
    description: "Pick this thread's model",
  },
  { name: "new", args: "none", hint: "", description: "Start a new side chat" },
  { name: "btw", args: "required", hint: "question", description: "Ask aside in a side chat" },
  { name: "fork", args: "optional", hint: "message", description: "Fork this thread from here" },
  {
    name: "schedule",
    args: "required",
    hint: "when and what",
    description: "Create an automation",
  },
  {
    name: "incognito",
    args: "optional",
    hint: "message",
    description: "Start a chat that is not remembered",
  },
  {
    name: "forget",
    args: "required",
    hint: "subject",
    description: "Retract what is remembered about something",
  },
  {
    name: "remember",
    args: "required",
    hint: "fact",
    description: "Note a fact in today's memory",
  },
  {
    name: "plan",
    args: "optional",
    hint: "goal",
    description: "Switch this thread to plan mode (read-only)",
  },
  { name: "status", args: "none", hint: "", description: "Show model, mode and running work" },
  { name: "export", args: "optional", hint: "md | json", description: "Export this thread" },
  { name: "stop", args: "none", hint: "", description: "Stop the current run" },
];

export type CommandParse =
  | { type: "message"; text: string }
  | { type: "command"; name: CommandName; arg: string }
  | { type: "error"; message: string };

const MODEL_REF = /^[a-z0-9][a-z0-9_.-]*\/\S+$/;

export function parseCommand(input: string): CommandParse {
  const trimmed = input.trim();
  if (trimmed.startsWith("//")) return { type: "message", text: trimmed.slice(1) };
  const m = /^\/([a-z]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (m === null) return { type: "message", text: input };
  const name = m[1] as string;
  const arg = (m[2] ?? "").trim();
  const info = COMMANDS.find((c) => c.name === name);
  if (info === undefined) {
    return {
      type: "error",
      message: `There's no /${name} command. Start with // to send text that begins with a slash.`,
    };
  }
  if (info.args === "none" && arg !== "") {
    return { type: "error", message: `/${name} takes no arguments.` };
  }
  if (info.args === "required" && arg === "") {
    return { type: "error", message: `Usage: /${name} <${info.hint}>` };
  }
  if (name === "model" && arg !== "" && !MODEL_REF.test(arg)) {
    return {
      type: "error",
      message: "Usage: /model provider/model, for example anthropic/claude-sonnet-5-5",
    };
  }
  if (
    name === "export" &&
    arg !== "" &&
    arg.toLowerCase() !== "md" &&
    arg.toLowerCase() !== "json"
  ) {
    return { type: "error", message: "Usage: /export [md | json]" };
  }
  return { type: "command", name: info.name, arg };
}

/** Commands for the autocomplete menu while the composer holds only `/` plus a partial name. */
export function matchCommands(text: string): CommandInfo[] {
  const m = /^\/([a-z]*)$/.exec(text);
  if (m === null) return [];
  const prefix = m[1] ?? "";
  return COMMANDS.filter((c) => c.name.startsWith(prefix));
}

/** What a picked command inserts: the name, plus a space when it takes an argument. */
export function completion(info: CommandInfo): string {
  return info.args === "none" ? `/${info.name}` : `/${info.name} `;
}
