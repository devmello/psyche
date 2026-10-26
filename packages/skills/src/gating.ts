import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import type { SkillRequires } from "./frontmatter.ts";

/** What gating checks against. Build one per Gateway (or per thread when tools differ). */
export interface GateContext {
  platform: string;
  env: Readonly<Record<string, string | undefined>>;
  hasBin: (name: string) => boolean;
  /**
   * Registered and enabled tool names. `undefined` means "unknown" and tool requirements pass
   * (the loader cannot see the registry); the agent loop still only offers tools it has.
   */
  tools?: readonly string[];
}

export interface GateResult {
  eligible: boolean;
  /** Human-readable reasons, e.g. `missing binary: ffmpeg`. */
  missing: string[];
}

/** `email.*` matches `email.send`; `*` alone matches anything; otherwise exact. */
export function toolMatches(pattern: string, tool: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) return tool.startsWith(pattern.slice(0, -1));
  if (pattern.endsWith("*")) return tool.startsWith(pattern.slice(0, -1));
  return pattern === tool;
}

/**
 * Capability names skills declare (S20's `requires.tools`, OpenClaw-style families) and the
 * Gateway tools that provide them, with what the owner can do when none is there (issue #506).
 * A requirement is met by its own name or by any listed tool; unlisted names match only
 * themselves.
 */
export const TOOL_CAPABILITIES: Readonly<
  Record<string, { tools: readonly string[]; label: string; hint: string }>
> = {
  "email.*": {
    tools: ["gmail_*", "mail_*"],
    label: "email",
    hint: "connect Gmail or Apple Mail in Settings → Connectors",
  },
  "calendar.*": {
    // `calendar_find_free_time` (the Gateway's free-slot finder) is one of these.
    tools: ["calendar_*", "calendar.*"],
    label: "a calendar",
    hint: "connect Google Calendar or Apple Calendar in Settings → Connectors",
  },
  "messages.*": {
    tools: ["imessage_*", "imessage.*", "messages.*"],
    label: "messages",
    hint: "turn on iMessage in Settings → Channels",
  },
  "browser.*": {
    tools: ["browser.*"],
    label: "the agent browser",
    hint: "turn the browser on in Settings → Browser",
  },
  search: {
    tools: ["web_search"],
    label: "web search",
    hint: "add a search provider key in Settings → Model & providers",
  },
  fetch: {
    tools: ["web_fetch"],
    label: "web pages",
    hint: "web fetching comes with the web search provider",
  },
  memory_search: {
    tools: ["memory"],
    label: "memory search",
    hint: "memory is part of every Gateway; restart Psyche if it is missing",
  },
  "artifact.create": {
    tools: ["write_file"],
    label: "saving files",
    hint: "share a folder in Settings → File access",
  },
  "pdf.*": {
    tools: ["read_file"],
    label: "reading PDFs",
    hint: "share a folder in Settings → File access",
  },
  "sheet.*": {
    tools: ["read_file"],
    label: "reading spreadsheets",
    hint: "share a folder in Settings → File access",
  },
  exec: {
    tools: ["exec"],
    label: "the sandbox",
    hint: "the sandbox needs Docker or the VM (Settings → Server)",
  },
  // Apple apps, wave 1 (docs/connectors/apple-apps-2026.md §4, §7.3): the model-facing tool is
  // the helper capability with `_` (`notes.append` → `notes_append`).
  "notes.*": {
    tools: ["notes_*"],
    label: "notes",
    hint: "connect Apple Notes in Settings → Connectors",
  },
  "reminders.*": {
    tools: ["reminders_*"],
    label: "reminders",
    hint: "connect Apple Reminders in Settings → Connectors",
  },
  "contacts.*": {
    tools: ["contacts_*"],
    label: "contacts",
    hint: "connect Apple Contacts or Google Contacts in Settings → Connectors",
  },
  "music.*": {
    tools: ["music_*"],
    label: "music playback",
    hint: "connect Apple Music or Spotify in Settings → Connectors",
  },
  "files.*": {
    tools: ["files_*"],
    label: "your Mac's files",
    hint: "turn on Files in Settings → Connectors and share the folder in Settings → File access",
  },
  "shortcuts.*": {
    // `apps.shortcut_run` / `apps.shortcuts_list` are the names before the Shortcuts app.
    tools: ["shortcuts_*", "apps.shortcut*"],
    label: "Shortcuts",
    hint: "connect Shortcuts in Settings → Connectors",
  },
};

/** Whether `requirement` is met by a registered tool (its own name or a providing tool). */
export function capabilityMet(requirement: string, tools: readonly string[]): boolean {
  const providers = [requirement, ...(TOOL_CAPABILITIES[requirement]?.tools ?? [])];
  return providers.some((p) => tools.some((x) => toolMatches(p, x)));
}

/** "needs email: connect Gmail or Apple Mail in Settings → Connectors" (or the raw name). */
export function missingCapabilityText(requirement: string): string {
  const c = TOOL_CAPABILITIES[requirement];
  return c === undefined ? `missing tool: ${requirement}` : `needs ${c.label}: ${c.hint}`;
}

/** "needs email or a calendar (connect …; connect …)", or the raw tool names when unknown. */
function anyOfText(requirements: readonly string[]): string {
  const known = requirements.map((r) => TOOL_CAPABILITIES[r]);
  const names = requirements.map((r, i) => known[i]?.label ?? `the tool ${r}`);
  const hints = [...new Set(known.flatMap((k) => (k === undefined ? [] : [k.hint])))];
  return `needs ${names.join(" or ")}${hints.length === 0 ? "" : ` (${hints.join("; ")})`}`;
}

export function evaluateGates(requires: SkillRequires, ctx: GateContext): GateResult {
  const missing: string[] = [];
  if (requires.os.length > 0 && !requires.os.includes(ctx.platform))
    missing.push(`os: needs ${requires.os.join(" or ")}`);
  for (const bin of requires.bins) if (!ctx.hasBin(bin)) missing.push(`missing binary: ${bin}`);
  if (requires.anyBins.length > 0 && !requires.anyBins.some((b) => ctx.hasBin(b)))
    missing.push(`needs one of: ${requires.anyBins.join(", ")}`);
  for (const name of requires.env) {
    const v = ctx.env[name];
    if (v === undefined || v === "") missing.push(`missing env: ${name}`);
  }
  const tools = ctx.tools;
  if (tools !== undefined) {
    for (const t of requires.tools)
      if (!capabilityMet(t, tools)) missing.push(missingCapabilityText(t));
    if (requires.anyTools.length > 0 && !requires.anyTools.some((t) => capabilityMet(t, tools)))
      missing.push(anyOfText(requires.anyTools));
  }
  return { eligible: missing.length === 0, missing };
}

/** `hasBin` over `PATH` (executable files only), memoized. */
export function pathBinLookup(pathEnv = process.env.PATH ?? ""): (name: string) => boolean {
  const dirs = pathEnv.split(delimiter).filter((d) => d.length > 0);
  const cache = new Map<string, boolean>();
  return (name) => {
    if (!/^[A-Za-z0-9._+-]+$/.test(name)) return false;
    const hit = cache.get(name);
    if (hit !== undefined) return hit;
    const found = dirs.some((d) => {
      try {
        accessSync(join(d, name), constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
    cache.set(name, found);
    return found;
  };
}

export function defaultGateContext(tools?: readonly string[]): GateContext {
  return {
    platform: process.platform,
    env: process.env,
    hasBin: pathBinLookup(),
    ...(tools === undefined ? {} : { tools }),
  };
}
