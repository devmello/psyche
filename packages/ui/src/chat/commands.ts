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
  fullOptions,
  modelOptions,
  modeOptions,
} from "./command-args.ts";

export type CommandName =
  | "model"
  | "mode"
  | "full"
  | "new"
  | "btw"
  | "fork"
  | "compare"
  | "schedule"
  | "incognito"
  | "forget"
  | "remember"
  | "teach"
  | "plan"
  | "research"
  | "status"
  | "export"
  | "clear"
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
type HintedCommand = Exclude<CommandName, "new" | "status" | "stop" | "clear">;

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
  command("full", "optional", { kind: "enum", options: fullOptions }),
  command("new", "none"),
  command("btw", "required"),
  command("fork", "optional"),
  command("compare", "optional"),
  command("schedule", "required"),
  command("incognito", "optional"),
  command("forget", "required"),
  command("remember", "required"),
  command("teach", "required"),
  command("plan", "optional"),
  command("research", "required"),
  command("status", "none"),
  command("export", "optional", { kind: "enum", options: exportOptions }),
  command("clear", "none"),
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
  // Not one of ours ("/tmp is full, clean it up"): it is text for the agent, not a mistyped command.
  if (info === undefined) return { type: "message", text: input };
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
    !["manual", "balanced", "auto", "full", "plan"].includes(arg.toLowerCase())
  ) {
    return { type: "error", message: t("chat.commands.usageMode") };
  }
  if (name === "full" && arg !== "" && arg.toLowerCase() !== "on" && arg.toLowerCase() !== "off") {
    return { type: "error", message: t("chat.commands.usageFull") };
  }
  if (
    name === "export" &&
    arg !== "" &&
    arg.toLowerCase() !== "md" &&
    arg.toLowerCase() !== "json"
  ) {
    return { type: "error", message: t("chat.commands.usageExport") };
  }
  return {
    type: "command",
    name: info.name,
    arg: name === "mode" || name === "full" ? arg.toLowerCase() : arg,
  };
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

/** A user-invocable skill the menu lists under "Skills" (the Gateway's `skills.commands` row). */
export interface SkillMenuItem {
  readonly name: string;
  readonly description: string;
}

/** The Gateway's skill reference (`$name`): lowercase words joined by hyphens. */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface MenuMatches {
  readonly commands: CommandInfo[];
  readonly skills: SkillMenuItem[];
}

/**
 * The menu rows for a composer that holds `/` plus a partial name: the built-in commands, then the
 * skills. A skill named like a built-in command is left out (the built-in wins), as is one whose
 * name the `$name` reference cannot carry, and a repeated name. Both lists are filtered by the
 * prefix typed; skills come sorted by name.
 */
export function matchMenu(text: string, skills: readonly SkillMenuItem[]): MenuMatches {
  const m = /^\/([a-z0-9-]*)$/.exec(text);
  if (m === null) return { commands: [], skills: [] };
  const prefix = m[1] ?? "";
  const builtin = new Set<string>(COMMANDS.map((c) => c.name));
  const seen = new Set<string>();
  const found: SkillMenuItem[] = [];
  for (const s of skills) {
    if (!SKILL_NAME.test(s.name) || builtin.has(s.name) || seen.has(s.name)) continue;
    seen.add(s.name);
    if (s.name.startsWith(prefix)) found.push(s);
  }
  found.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { commands: COMMANDS.filter((c) => c.name.startsWith(prefix)), skills: found };
}

/**
 * What a picked skill inserts: `$name` and a space, the reference the Gateway reads in an owner
 * message, so the owner types the request after it.
 */
export function skillCompletion(skill: SkillMenuItem): string {
  return `$${skill.name} `;
}
