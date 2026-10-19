import type { Ctx } from "./context.ts";

export interface OptionSpec {
  type: "string" | "boolean";
  short?: string;
  description: string;
  multiple?: boolean;
  /** Values offered by shell completion. */
  choices?: readonly string[];
}

export interface ArgSpec {
  name: string;
  description: string;
  required?: boolean;
  variadic?: boolean;
}

export type OptionValues = Record<string, string | boolean | string[] | undefined>;

export interface CommandInput {
  args: string[];
  opts: OptionValues;
}

export interface CommandResult {
  /** What `--json` prints. */
  data: unknown;
  /** What a human sees; defaults to the JSON. */
  human?: string;
  exitCode?: number;
}

export interface CommandSpec {
  /** Path, e.g. `["pairing", "approve"]`. */
  path: readonly string[];
  summary: string;
  description?: string;
  args?: readonly ArgSpec[];
  options?: Record<string, OptionSpec>;
  run(ctx: Ctx, input: CommandInput): Promise<CommandResult>;
}

export function str(opts: OptionValues, key: string): string | undefined {
  const v = opts[key];
  return typeof v === "string" ? v : undefined;
}

export function bool(opts: OptionValues, key: string): boolean {
  return opts[key] === true;
}
