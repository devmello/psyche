/**
 * Composer slash commands (feature C9; UI design §3.2). The grammar mirrors `agent-core`'s
 * `parseComposerInput` (the kit cannot import the agent runtime): a leading `/name` with an
 * optional argument, `//text` sends text that starts with a slash, anything else is a message.
 * The chat column executes the commands with protocol methods.
 */

import { t } from "../i18n/core.ts";
import {
  type ArgSpec,
  currentModel,
  exportOptions,
  modelOptions,
  modeOptions,
} from "./command-args.ts";

export type CommandName =
  | "model"
  | "mode"
  | "new"
  | "btw"
  | "fork"
  | "schedule"
  | "incognito"
  | "forget"
  | "remember"
  | "teach"
  | "plan"
  | "research"
  | "status"
  | "export"
  | "stop";

export interface CommandInfo {
  name: CommandName;
  /** Whether the command takes an argument at all. */
  arity: "none" | "optional" | "required";
  /**
   * Declared when the argument comes from a known set: the composer then pops up the valid
   * values after `/name `. Absent for free text.
   */
  readonly args?: ArgSpec;
  /** The argument's placeholder (catalogue text, read at use). */
  readonly hint: string;
  readonly description: string;
}

/** Commands that take an argument, so have a hint (`/remember <fact>`). */
type HintedCommand = Exclude<CommandName, "new" | "status" | "stop">;

/** A command whose hint and description come from the catalogue as they are read. */
function command(name: CommandName, arity: CommandInfo["arity"], args?: ArgSpec): CommandInfo {
  return {
    name,
    arity,
    ...(args === undefined ? {} : { args }),
    get hint() {
      return arity === "none" ? "" : t(`chat.commands.${name as HintedCommand}.hint`);
    },
    get description() {
      return t(`chat.commands.${name}.description`);
    },
  };
}

export const COMMANDS: readonly CommandInfo[] = [
  command("model", "optional", {
    kind: "enum",
    options: modelOptions,
    current: currentModel,
  }),
  command("mode", "optional", {
    kind: "enum",
    options: modeOptions,
    current: (ctx) => ctx.permissionMode,
  }),
  command("new", "none"),
  command("btw", "required"),
  command("fork", "optional"),
  command("schedule", "required"),
  command("incognito", "optional"),
  command("forget", "required"),
  command("remember", "required"),
  command("teach", "required"),
  command("plan", "optional"),
  command("research", "required"),
  command("status", "none"),
  command("export", "optional", { kind: "enum", options: exportOptions }),
  command("stop", "none"),
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
    return { type: "error", message: t("chat.commands.unknown", { name }) };
  }
  if (info.arity === "none" && arg !== "") {
    return { type: "error", message: t("chat.commands.noArgs", { name }) };
  }
  if (info.arity === "required" && arg === "") {
    return { type: "error", message: t("chat.commands.usage", { name, hint: info.hint }) };
  }
  if (name === "model" && arg !== "" && !MODEL_REF.test(arg)) {
    return { type: "error", message: t("chat.commands.usageModel") };
  }
  if (
    name === "mode" &&
    arg !== "" &&
    !["manual", "balanced", "auto", "plan"].includes(arg.toLowerCase())
  ) {
    return { type: "error", message: t("chat.commands.usageMode") };
  }
  if (
    name === "export" &&
    arg !== "" &&
    arg.toLowerCase() !== "md" &&
    arg.toLowerCase() !== "json"
  ) {
    return { type: "error", message: t("chat.commands.usageExport") };
  }
  return { type: "command", name: info.name, arg: name === "mode" ? arg.toLowerCase() : arg };
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
  return info.arity === "none" ? `/${info.name}` : `/${info.name} `;
}
