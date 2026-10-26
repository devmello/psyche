import type { McpServerInput } from "@psyche/protocol";
import { t } from "../../i18n/core.ts";
import type { MessageId } from "../../i18n/messages/index.ts";
import type { McpSecret } from "./use-mcp.tsx";

/**
 * A ready-made MCP server in the Add connector gallery (data in `mcp-presets.ts`). Only real,
 * well-known servers: a vendor's own remote URL or an official / widely used package. Its words
 * live in the catalogue as `gallery.preset.<id>.*` (`presetText`), so adding a preset is one
 * data entry plus its strings.
 */

export type PresetCategory =
  | "files"
  | "dev"
  | "productivity"
  | "comms"
  | "web"
  | "everyday"
  | "finance";

/** A value the owner gives: a key (kept in the vault), or plain text such as a folder. */
export interface PresetField {
  id: string;
  kind: "secret" | "text";
  /** stdio: set as this environment variable (a secret goes in as a vault placeholder). */
  env?: string;
  /** Replaces `{id}` in the command's arguments, or in the server's address. */
  arg?: true;
  /** Host names the owner lists (comma-separated): the sandbox may reach them. */
  domains?: true;
  /** A key must start with this (Stripe's `rk_`: a restricted key, so the server stays read only). */
  prefix?: string;
  /** Where to get the key; shown as a link. */
  helpUrl?: string;
  placeholder?: string;
  optional?: true;
}

export type PresetIcon =
  | "folder"
  | "database"
  | "brain"
  | "git"
  | "bug"
  | "tasks"
  | "doc"
  | "cloud"
  | "globe"
  | "search"
  | "browser"
  | "weather"
  | "clock"
  | "map"
  | "music"
  | "home"
  | "card"
  | "chat"
  | "table";

export type PresetTransport =
  | { kind: "stdio"; command: readonly string[]; domains?: readonly string[] }
  | { kind: "http"; url: string; auth: "oauth" | "bearer" | "none" };

export interface McpPreset {
  /** The server id: tools register as `mcp__<id>__<tool>`. */
  id: string;
  label: string;
  category: PresetCategory;
  icon: PresetIcon;
  /** The vendor's own server (shown as Official), or a community one. */
  official: boolean;
  popular?: true;
  transport: PresetTransport;
  fields: readonly PresetField[];
  docsUrl: string;
}

export type PresetKey = "desc" | "example" | `field.${string}.label` | `field.${string}.help`;

/** A preset's words, in the active language. */
export function presetText(preset: McpPreset, key: PresetKey): string {
  return t(`gallery.preset.${presetMessageId(preset)}.${key}` as MessageId);
}

/** Message ids hold no hyphen: `brave-search` → `braveSearch`. */
export function presetMessageId(preset: McpPreset): string {
  return preset.id.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** `mcp-<server>-<field>-<4 random chars>`: a vault slug no earlier add can collide with. */
export function secretSlug(serverId: string, field: string, nonce: string): string {
  return `mcp-${serverId}-${field}-${nonce}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .slice(0, 64);
}

export type PresetValues = Readonly<Record<string, string>>;

/** Fields still empty, or a key that does not start as it must. */
export function missingFields(preset: McpPreset, values: PresetValues): string[] {
  return preset.fields
    .filter((f) => {
      const v = (values[f.id] ?? "").trim();
      if (v === "") return f.optional !== true;
      return f.prefix !== undefined && !v.startsWith(f.prefix);
    })
    .map((f) => f.id);
}

/** `{id}` placeholders in an argument or address, filled from the owner's values. */
function fill(text: string, preset: McpPreset, values: PresetValues): string {
  return text.replace(/\{(\w+)\}/g, (whole, id: string) => {
    const f = preset.fields.find((x) => x.id === id && x.arg === true);
    return f ? (values[id] ?? "").trim() : whole;
  });
}

function listed(preset: McpPreset, values: PresetValues): string[] {
  return preset.fields
    .filter((f) => f.domains === true)
    .flatMap((f) => (values[f.id] ?? "").split(/[\s,]+/))
    .filter((d) => d !== "");
}

/**
 * The `mcp.probe` request for a preset, and the vault items to store first. A key never enters
 * the config: the server gets `{{cred:slug}}`, resolved by the broker when it starts.
 */
export function presetServer(
  preset: McpPreset,
  values: PresetValues,
  nonce: string,
): { input: McpServerInput; secrets: McpSecret[] } {
  const secrets: McpSecret[] = [];
  const placeholderFor = (f: PresetField): string => {
    const slug = secretSlug(preset.id, f.id, nonce);
    secrets.push({
      slug,
      name: `${preset.label} ${presetText(preset, `field.${f.id}.label`)}`,
      token: (values[f.id] ?? "").trim(),
      ...(preset.transport.kind === "http"
        ? { header: { name: "Authorization", prefix: "Bearer " } }
        : {}),
    });
    return `{{cred:${slug}}}`;
  };
  const value = (f: PresetField) => (values[f.id] ?? "").trim();
  const used = preset.fields.filter((f) => value(f) !== "");
  const tr = preset.transport;
  if (tr.kind === "http") {
    const key = used.find((f) => f.kind === "secret");
    return {
      input: {
        id: preset.id,
        name: preset.label,
        transport: {
          kind: "http",
          url: fill(tr.url, preset, values),
          ...(tr.auth === "bearer" && key
            ? { auth: { kind: "bearer" as const, credential: placeholderFor(key) } }
            : tr.auth === "none"
              ? { auth: { kind: "none" as const } }
              : {}),
        },
      },
      secrets,
    };
  }
  const args = tr.command.map((a) => fill(a, preset, values));
  const env: Record<string, string> = {};
  for (const f of used) {
    if (f.env === undefined || (f.kind === "text" && f.domains)) continue;
    env[f.env] = f.kind === "secret" ? placeholderFor(f) : value(f);
  }
  const domains = [...new Set([...(tr.domains ?? []), ...listed(preset, values)])];
  return {
    input: {
      id: preset.id,
      name: preset.label,
      transport: {
        kind: "stdio",
        command: args.filter((a) => a !== ""),
        ...(Object.keys(env).length > 0 ? { env } : {}),
      },
      ...(domains.length > 0 ? { allowedDomains: [...domains] } : {}),
    },
    secrets,
  };
}
