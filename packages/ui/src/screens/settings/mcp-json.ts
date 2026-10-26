import type { McpServerInput } from "@psyche/protocol";
import { type McpDraft, splitCommand } from "./mcp-input.ts";
import { secretSlug } from "./mcp-preset-build.ts";
import type { McpSecret } from "./use-mcp.tsx";

/**
 * Pasting a server's JSON into the Add form: the `mcpServers` format other MCP clients share
 * (`{"mcpServers": {"name": {"command": "npx", "args": [...], "env": {...}}}}`, a bare
 * `{"name": {...}}`, or one server's own object). It only fills the form: nothing is added until
 * the owner checks the server and approves its trust card. Values that look like secrets are kept
 * in memory for the vault and never reach the config (`withImported` turns them into placeholders).
 */

/** An env variable or header the JSON gave, with a value that must not enter plain config. */
export interface ImportedSecret {
  /** The env variable, or `Authorization` for a remote server's bearer token. */
  name: string;
  value: string;
  bearer: boolean;
}

export interface ImportedServer {
  /** The server's key in the JSON, or its `name`. */
  name: string;
  draft: McpDraft;
  /** Env values that are not secrets, kept as they are. */
  env: Readonly<Record<string, string>>;
  secrets: readonly ImportedSecret[];
  /** What this form has no place for (`cwd`, other headers, an invalid env name), by name. */
  ignored: readonly string[];
}

export type ImportResult =
  | { ok: true; servers: readonly ImportedServer[] }
  | { ok: false; reason: "empty" | "invalid" | "shape" | "noServers" };

const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|PAT|COOKIE|SESSION)/i;
const SECRET_VALUE =
  /^(sk-|sk_|rk_|pk_live|ghp_|gho_|ghs_|github_pat_|glpat-|xox[abeprs]-|shpat_|AKIA|AIza|ya29\.|eyJ[A-Za-z0-9_-]{10,}\.)/;
const PLACEHOLDER = /^\{\{cred:[a-z0-9][a-z0-9-]{0,63}(\.[a-z]+)?\}\}$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;

const looksSecret = (name: string, value: string) =>
  SECRET_NAME.test(name) || SECRET_VALUE.test(value);

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);

/** An argv as one editable line: words with spaces or quotes are quoted the way `splitCommand` reads. */
export function joinCommand(argv: readonly string[]): string {
  return argv
    .map((a) => (/[\s"']/.test(a) || a === "" ? (a.includes('"') ? `'${a}'` : `"${a}"`) : a))
    .join(" ");
}

function one(key: string, raw: Obj): ImportedServer | null {
  const title = typeof raw.name === "string" && raw.name.trim() !== "" ? raw.name.trim() : key;
  const url =
    typeof raw.url === "string"
      ? raw.url
      : typeof raw.serverUrl === "string"
        ? raw.serverUrl
        : null;
  const known = new Set(["name", "command", "args", "env", "url", "serverUrl", "headers", "type"]);
  const ignored = Object.keys(raw).filter((k) => !known.has(k));
  const secrets: ImportedSecret[] = [];
  const env: Record<string, string> = {};

  if (url !== null && typeof raw.command !== "string") {
    if (isObject(raw.headers)) {
      for (const [h, v] of Object.entries(raw.headers)) {
        const token = typeof v === "string" ? v.replace(/^Bearer\s+/i, "").trim() : "";
        if (/^authorization$/i.test(h) && token !== "" && !PLACEHOLDER.test(token)) {
          secrets.push({ name: "Authorization", value: token, bearer: true });
        } else {
          ignored.push(h);
        }
      }
    }
    return {
      name: title,
      draft: { name: title, kind: "url", command: "", url: url.trim(), domains: "" },
      env,
      secrets,
      ignored,
    };
  }

  if (typeof raw.command !== "string" || raw.command.trim() === "") return null;
  const argv = [
    ...splitCommand(raw.command),
    ...(Array.isArray(raw.args) ? raw.args.filter((a): a is string => typeof a === "string") : []),
  ];
  if (isObject(raw.env)) {
    for (const [k, v] of Object.entries(raw.env)) {
      if (typeof v !== "string" || v === "") continue;
      if (!ENV_NAME.test(k)) ignored.push(k);
      else if (PLACEHOLDER.test(v)) env[k] = v;
      else if (looksSecret(k, v)) secrets.push({ name: k, value: v, bearer: false });
      else env[k] = v;
    }
  }
  return {
    name: title,
    draft: { name: title, kind: "command", command: joinCommand(argv), url: "", domains: "" },
    env,
    secrets,
    ignored,
  };
}

const isServer = (o: Obj) =>
  typeof o.command === "string" || typeof o.url === "string" || typeof o.serverUrl === "string";

/** The servers in pasted JSON, ready to fill the form. */
export function parseMcpJson(text: string): ImportResult {
  if (text.trim() === "") return { ok: false, reason: "empty" };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (!isObject(json)) return { ok: false, reason: "shape" };
  const block = isObject(json.mcpServers)
    ? json.mcpServers
    : isObject(json.servers)
      ? json.servers
      : null;
  const entries: [string, Obj][] =
    isServer(json) && block === null
      ? [[typeof json.name === "string" ? json.name : "Server", json]]
      : Object.entries(block ?? json).flatMap(([k, v]) =>
          isObject(v) && isServer(v) ? [[k, v] as [string, Obj]] : [],
        );
  const servers = entries.flatMap(([k, v]) => {
    const s = one(k, v);
    return s === null ? [] : [s];
  });
  return servers.length === 0 ? { ok: false, reason: "noServers" } : { ok: true, servers };
}

/**
 * The `mcp.probe` input for a form filled from JSON: the form's input plus the JSON's plain env,
 * and each secret as a `{{cred:slug}}` placeholder with the vault item to store first.
 */
export function withImported(
  input: McpServerInput,
  imported: ImportedServer,
  nonce: string,
): { input: McpServerInput; secrets: McpSecret[] } {
  const secrets: McpSecret[] = [];
  const placeholderFor = (s: ImportedSecret): string => {
    const slug = secretSlug(input.id, s.name, nonce);
    secrets.push({
      slug,
      name: `${imported.draft.name} ${s.name}`.slice(0, 200),
      token: s.value,
      ...(s.bearer ? { header: { name: "Authorization", prefix: "Bearer " } } : {}),
    });
    return `{{cred:${slug}}}`;
  };
  const t = input.transport;
  if (t.kind === "http") {
    const bearer = imported.secrets.find((s) => s.bearer);
    return {
      input: {
        ...input,
        transport: bearer
          ? { ...t, auth: { kind: "bearer", credential: placeholderFor(bearer) } }
          : t,
      },
      secrets,
    };
  }
  const env: Record<string, string> = { ...imported.env };
  for (const s of imported.secrets) if (!s.bearer) env[s.name] = placeholderFor(s);
  return {
    input: { ...input, transport: Object.keys(env).length > 0 ? { ...t, env } : t },
    secrets,
  };
}
