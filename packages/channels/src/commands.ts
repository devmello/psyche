/**
 * Slash commands over chat (OpenClaw command authorization, security §9). Commands run only for
 * owners and `commandsAllowFrom`; `/approve` additionally needs an owner identity, which the
 * approval router checks. Anything else that starts with `/` from an authorized sender is passed
 * to the Gateway as a command (`/new`, `/stop`, `/status`, skill commands).
 */

export interface ParsedCommand {
  name: string;
  args: string[];
  raw: string;
}

/** Commands the channel service answers itself. */
export const BUILTIN_COMMANDS = ["approve", "deny", "whoami", "help"] as const;

/**
 * Parses `/name[@bot] args…`. Returns undefined for non-commands. A `@bot` suffix naming another
 * bot means the command is not for us (undefined).
 */
export function parseCommand(text: string, botUsername?: string): ParsedCommand | undefined {
  const m = /^\/([A-Za-z][A-Za-z0-9_]{0,31})(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/.exec(
    text.trim(),
  );
  if (m === null) return undefined;
  const target = m[2];
  if (
    target !== undefined &&
    (botUsername === undefined || target.toLowerCase() !== botUsername.toLowerCase())
  ) {
    return undefined;
  }
  const rest = (m[3] ?? "").trim();
  return {
    name: (m[1] ?? "").toLowerCase(),
    args: rest === "" ? [] : rest.split(/\s+/),
    raw: text.trim(),
  };
}

export type ApprovalCommand =
  | { ok: true; ref: string; decision: "approve" | "deny" }
  | { ok: false; usage: string };

const APPROVE_WORDS = new Set(["approve", "yes", "y", "allow", "ok"]);
const DENY_WORDS = new Set(["deny", "no", "n", "reject"]);

/** `/approve <ref> approve|deny` and `/deny <ref>`. */
export function parseApprovalCommand(command: ParsedCommand): ApprovalCommand {
  const usage = "Usage: /approve <ref> approve|deny";
  const ref = command.args[0]?.toLowerCase();
  if (ref === undefined) return { ok: false, usage };
  if (command.name === "deny") return { ok: true, ref, decision: "deny" };
  const word = (command.args[1] ?? "").toLowerCase();
  if (APPROVE_WORDS.has(word)) return { ok: true, ref, decision: "approve" };
  if (DENY_WORDS.has(word)) return { ok: true, ref, decision: "deny" };
  return { ok: false, usage };
}
