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
      if (!tools.some((x) => toolMatches(t, x))) missing.push(`missing tool: ${t}`);
    if (
      requires.anyTools.length > 0 &&
      !requires.anyTools.some((t) => tools.some((x) => toolMatches(t, x)))
    )
      missing.push(`needs one of the tools: ${requires.anyTools.join(", ")}`);
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
