/**
 * Composer slash commands (feature C9). The agent core only parses; the Gateway executes the
 * intent and the UI uses `COMPOSER_COMMANDS` for autocompletion. Text that is not a known
 * command is a normal message; `//text` escapes a leading slash.
 */

export type ComposerIntent =
  | { kind: "model"; model?: string }
  | { kind: "new" }
  /** Side chat that does not enter the main transcript. */
  | { kind: "btw"; text: string }
  | { kind: "fork"; text?: string }
  | { kind: "schedule"; text: string }
  | { kind: "incognito"; text?: string }
  | { kind: "forget"; subject: string }
  | { kind: "remember"; text: string }
  | { kind: "plan"; text?: string }
  | { kind: "status" }
  | { kind: "export"; format: "md" | "json" }
  | { kind: "stop" };

export type ComposerCommandName = ComposerIntent["kind"];

export interface ComposerCommandInfo {
  name: ComposerCommandName;
  args: "none" | "optional" | "required";
  hint: string;
  description: string;
}

export const COMPOSER_COMMANDS: readonly ComposerCommandInfo[] = [
  { name: "model", args: "optional", hint: "provider/model", description: "Pick this thread's model" },
  { name: "new", args: "none", hint: "", description: "Start a new thread" },
  { name: "btw", args: "required", hint: "question", description: "Ask aside without derailing the turn" },
  { name: "fork", args: "optional", hint: "message", description: "Fork this thread from here" },
  { name: "schedule", args: "required", hint: "when and what", description: "Create an automation" },
  { name: "incognito", args: "optional", hint: "message", description: "Start a thread that is not remembered" },
  { name: "forget", args: "required", hint: "subject", description: "Retract what Psyche remembers about something" },
  { name: "remember", args: "required", hint: "fact", description: "Note a fact in today's memory" },
  { name: "plan", args: "optional", hint: "goal", description: "Switch to plan mode (read-only)" },
  { name: "status", args: "none", hint: "", description: "Show model, mode, usage and running tasks" },
  { name: "export", args: "optional", hint: "md | json", description: "Export this thread" },
  { name: "stop", args: "none", hint: "", description: "Stop the current run" },
];

export type ComposerParse =
  | { type: "message"; text: string }
  | { type: "command"; intent: ComposerIntent }
  | { type: "error"; command: string; message: string };

const MODEL_REF = /^[a-z0-9][a-z0-9_.-]*\/\S+$/;

/** Parse composer input into a message, a command intent or a usage error. */
export function parseComposerInput(input: string): ComposerParse {
  const trimmed = input.trim();
  if (trimmed.startsWith("//")) return { type: "message", text: trimmed.slice(1) };
  const m = /^\/([a-z]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (m === null) return { type: "message", text: input };
  const name = m[1] as string;
  const arg = (m[2] ?? "").trim();
  const info = COMPOSER_COMMANDS.find((c) => c.name === name);
  if (info === undefined) {
    return { type: "error", command: name, message: `unknown command /${name}` };
  }
  const usage = (message: string): ComposerParse => ({ type: "error", command: name, message });
  if (info.args === "none" && arg !== "") return usage(`/${name} takes no arguments`);
  if (info.args === "required" && arg === "") return usage(`usage: /${name} <${info.hint}>`);
  const optional = arg === "" ? {} : { text: arg };
  const command = (intent: ComposerIntent): ComposerParse => ({ type: "command", intent });
  switch (name as ComposerCommandName) {
    case "model":
      if (arg !== "" && !MODEL_REF.test(arg)) return usage("model must be provider/model");
      return command(arg === "" ? { kind: "model" } : { kind: "model", model: arg });
    case "new":
      return command({ kind: "new" });
    case "btw":
      return command({ kind: "btw", text: arg });
    case "fork":
      return command({ kind: "fork", ...optional });
    case "schedule":
      return command({ kind: "schedule", text: arg });
    case "incognito":
      return command({ kind: "incognito", ...optional });
    case "forget":
      return command({ kind: "forget", subject: arg });
    case "remember":
      return command({ kind: "remember", text: arg });
    case "plan":
      return command({ kind: "plan", ...optional });
    case "status":
      return command({ kind: "status" });
    case "export": {
      const format = arg === "" ? "md" : arg.toLowerCase();
      if (format !== "md" && format !== "json") return usage("usage: /export [md | json]");
      return command({ kind: "export", format });
    }
    case "stop":
      return command({ kind: "stop" });
  }
}

/** Commands matching a partial `/pre` for autocompletion. */
export function completeComposerCommand(prefix: string): ComposerCommandInfo[] {
  const p = prefix.replace(/^\//, "").toLowerCase();
  return COMPOSER_COMMANDS.filter((c) => c.name.startsWith(p));
}
