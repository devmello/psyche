import { readFileSync } from "node:fs";
import { bool, type CommandSpec, str } from "../command.ts";
import type { Ctx } from "../context.ts";
import { CliError } from "../errors.ts";
import { kv, table } from "../output.ts";
import { readAll } from "../prompt.ts";
import { callOrUnavailable } from "./util.ts";

/**
 * Vault commands handle metadata and secure prompts only (security §4): a secret is read from a
 * no-echo prompt or stdin, sent once in `vault.add`, and never printed, logged or put in argv.
 */

const KINDS = ["api_key", "login", "note", "ssh_key"] as const;
type AddKind = (typeof KINDS)[number];

async function readSecret(ctx: Ctx, label: string, fromStdin: boolean): Promise<string> {
  if (fromStdin) {
    const value = (await readAll(ctx.deps.io.stdin)).replace(/\r?\n$/, "");
    if (!value) throw new CliError("usage", "stdin was empty");
    return value;
  }
  if (!ctx.deps.prompter.interactive) {
    throw new CliError(
      "usage",
      "No terminal for a secret prompt; pipe the secret with --secret-stdin",
    );
  }
  const value = await ctx.deps.prompter.secret(label);
  if (!value) throw new CliError("usage", `${label} is empty`);
  return value;
}

function parseBindings(
  values: string[] | undefined,
): ({ origin: string } | { host: string } | { connector: string })[] {
  return (values ?? []).map((b) => {
    if (b.startsWith("connector:")) return { connector: b.slice("connector:".length) };
    if (/^https?:\/\//.test(b)) {
      const u = new URL(b);
      return { origin: u.origin };
    }
    if (/^[a-z0-9.-]+$/i.test(b)) return { host: b.toLowerCase() };
    throw new CliError(
      "usage",
      `Binding must be an origin (https://…), a host or connector:<id>; got ${b}`,
    );
  });
}

const STATUS_HUMAN = (s: Record<string, unknown>) =>
  kv({
    state: s.state,
    items: s.itemCount,
    slots: s.slots,
    "recovery key confirmed": s.recoveryConfirmed,
    "auto-lock (min)": s.autoLockMinutes,
    "locks at": s.lockAt,
  });

export const vaultCommands: CommandSpec[] = [
  {
    path: ["vault", "status"],
    summary: "Show whether the vault is locked, its key slots and item count",
    async run(ctx) {
      const res = (await callOrUnavailable(await ctx.gateway(), "vault.status", {})) as {
        status: Record<string, unknown>;
      };
      return { data: res, human: STATUS_HUMAN(res.status) };
    },
  },
  {
    path: ["vault", "list"],
    summary: "List credentials (names, slugs and bindings; never values)",
    options: { kind: { type: "string", description: "Filter by kind" } },
    async run(ctx, { opts }) {
      const kind = str(opts, "kind");
      const res = (await callOrUnavailable(
        await ctx.gateway(),
        "vault.list",
        kind ? { kind } : {},
      )) as {
        credentials: Record<string, unknown>[];
      };
      const rows = res.credentials.map((c) => ({
        ...c,
        placeholder: `{{cred:${String(c.slug)}}}`,
        bound: (c.bindings as Record<string, string>[]).map((b) => Object.values(b)[0]),
      }));
      return {
        data: res,
        human: table(rows, {
          name: "name",
          kind: "kind",
          placeholder: "placeholder",
          bindings: "bound",
          uses: "useCount",
          "last used": "lastUsedAt",
        }),
      };
    },
  },
  {
    path: ["vault", "add"],
    summary: "Add a credential; the secret is read from a hidden prompt or stdin",
    args: [{ name: "name", description: "Display name", required: true }],
    options: {
      kind: {
        type: "string",
        description: `Kind: ${KINDS.join(" | ")} (default api_key)`,
        choices: KINDS,
      },
      slug: { type: "string", description: "Placeholder slug ({{cred:<slug>}})" },
      bind: {
        type: "string",
        multiple: true,
        description: "Origin, host or connector:<id> (repeatable)",
      },
      username: { type: "string", description: "Username (login)" },
      header: { type: "string", description: "Header name for an API key (e.g. x-api-key)" },
      prefix: { type: "string", description: "Header value prefix (e.g. 'Bearer ')" },
      "secret-stdin": { type: "boolean", description: "Read the secret from stdin" },
      "key-file": { type: "string", description: "Private key file (ssh_key)" },
      "require-auth": { type: "boolean", description: "Ask for user presence on every use" },
    },
    async run(ctx, { args, opts }) {
      const kind = (str(opts, "kind") ?? "api_key") as AddKind;
      if (!KINDS.includes(kind))
        throw new CliError("usage", `--kind must be one of ${KINDS.join(", ")}`);
      const stdin = bool(opts, "secret-stdin");
      let secret: Record<string, string>;
      switch (kind) {
        case "api_key": {
          const header = str(opts, "header");
          const prefix = str(opts, "prefix");
          secret = {
            token: await readSecret(ctx, "API key", stdin),
            ...(header ? { headerName: header } : {}),
            ...(prefix ? { headerPrefix: prefix } : {}),
          };
          break;
        }
        case "login": {
          const username = str(opts, "username") ?? (await ctx.deps.prompter.text("Username"));
          if (!username) throw new CliError("usage", "--username is required for a login");
          secret = { username, password: await readSecret(ctx, "Password", stdin) };
          break;
        }
        case "note":
          secret = { text: await readSecret(ctx, "Note text", stdin) };
          break;
        case "ssh_key": {
          const file = str(opts, "key-file");
          secret = {
            privateKey: file
              ? readFileSync(file, "utf8")
              : await readSecret(ctx, "Private key", stdin),
          };
          break;
        }
      }
      const slug = str(opts, "slug");
      const res = (await callOrUnavailable(await ctx.gateway(), "vault.add", {
        kind,
        name: args[0] as string,
        ...(slug ? { slug } : {}),
        bindings: parseBindings(opts.bind as string[] | undefined),
        secret,
        ...(bool(opts, "require-auth") ? { requireAuthEachUse: true } : {}),
      })) as { credential: { name: string; slug: string } };
      return {
        data: res,
        human: `Added ${res.credential.name}; refer to it as {{cred:${res.credential.slug}}}`,
      };
    },
  },
  {
    path: ["vault", "import"],
    summary: "Import a password-manager CSV export (1Password, Bitwarden, Chrome)",
    description: "Delete the CSV afterwards: it holds every password in plain text.",
    args: [{ name: "file", description: "CSV file, or - for stdin", required: true }],
    options: {
      format: {
        type: "string",
        description: "auto | 1password | bitwarden | chrome",
        choices: ["auto", "1password", "bitwarden", "chrome"],
      },
    },
    async run(ctx, { args, opts }) {
      const file = args[0] as string;
      const csv = file === "-" ? await readAll(ctx.deps.io.stdin) : readFileSync(file, "utf8");
      const format = str(opts, "format") ?? "auto";
      const res = (await callOrUnavailable(await ctx.gateway(), "vault.import", {
        format,
        csv,
      })) as {
        imported: unknown[];
        skipped?: unknown[];
      };
      return {
        data: res,
        human: `Imported ${res.imported.length}, skipped ${res.skipped?.length ?? 0}.${file === "-" ? "" : ` Now delete ${file}.`}`,
      };
    },
  },
  {
    path: ["vault", "lock"],
    summary: "Lock the vault now",
    async run(ctx) {
      const res = (await callOrUnavailable(await ctx.gateway(), "vault.lock", {})) as {
        status: Record<string, unknown>;
      };
      return { data: res, human: STATUS_HUMAN(res.status) };
    },
  },
  {
    path: ["vault", "unlock"],
    summary: "Unlock the vault (keychain slot, or the recovery key with --recovery)",
    options: {
      reason: { type: "string", description: "Why (shown in the unlock prompt and the audit log)" },
      recovery: {
        type: "boolean",
        description: "Unlock with the printed recovery key (hidden prompt)",
      },
      "secret-stdin": { type: "boolean", description: "Read the recovery key from stdin" },
    },
    async run(ctx, { opts }) {
      const reason = str(opts, "reason") ?? "psyche vault unlock (CLI)";
      const recovery = bool(opts, "recovery") || bool(opts, "secret-stdin");
      const recoveryKey = recovery
        ? await readSecret(ctx, "Recovery key", bool(opts, "secret-stdin"))
        : undefined;
      const res = (await callOrUnavailable(await ctx.gateway(), "vault.unlock", {
        reason,
        ...(recoveryKey ? { recoveryKey } : {}),
      })) as { status: Record<string, unknown> };
      return { data: res, human: STATUS_HUMAN(res.status) };
    },
  },
];
