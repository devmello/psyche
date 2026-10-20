import { execFile } from "node:child_process";
import type { ResolvedSecret } from "@psyche/protocol";
import { fail } from "../errors.ts";

/**
 * 1Password as an external, read-only credential source (feature G10; security §4.8 (a)).
 * Psyche keeps only a reference (`vault` + `item`) and the bindings; values are read at fill
 * time through the 1Password CLI with a service-account token, or through a Connect server,
 * and never written back. The token itself is a vault item (connector-owned, `onepassword`).
 */

/** Fields Psyche reads from a 1Password item; `totp` is the current code, not the seed. */
export type OnePasswordField =
  | "username"
  | "password"
  | "totp"
  | "credential"
  | "private_key"
  | "notes";

export interface OnePasswordRef {
  /** Vault name or id. */
  vault: string;
  /** Item title or id. */
  item: string;
}

export interface OnePasswordSource {
  readonly kind: "cli" | "connect";
  unavailableReason(): Promise<string | null>;
  /** Read one field. Rejects `not_found` when the item or field does not exist. */
  readField(ref: OnePasswordRef, field: OnePasswordField): Promise<string>;
}

/** The service-account (CLI) or Connect token, handed over as a one-shot handle. */
export type TokenProvider = () => Promise<ResolvedSecret>;

/** Names go into `op://` references and Connect filters: no separators, quotes or controls. */
export function checkRef(ref: OnePasswordRef): void {
  for (const [k, v] of Object.entries(ref)) {
    if (typeof v !== "string" || v.length === 0 || v.length > 128 || /[/?#"\\\p{Cc}]/u.test(v)) {
      fail("invalid_params", `1Password ${k} must be 1–128 characters without / ? # " or \\`);
    }
  }
}

// --- CLI ------------------------------------------------------------------------------------------

const CLI_FIELD: Record<OnePasswordField, string> = {
  username: "username",
  password: "password",
  totp: "one-time password?attribute=otp",
  credential: "credential",
  private_key: "private key",
  notes: "notesPlain",
};

export interface OpCliOptions {
  /** Trusted path to the `op` binary. */
  op: string;
  token: TokenProvider;
  timeoutMs?: number;
  /** Injected for tests. */
  run?: (file: string, args: string[], env: Record<string, string>) => Promise<string>;
}

/**
 * `op read "op://<vault>/<item>/<field>"` with `OP_SERVICE_ACCOUNT_TOKEN` in the child's env only
 * (nothing else inherited but PATH and HOME), no shell. Output is the value; errors never carry it.
 */
export class OpCliSource implements OnePasswordSource {
  readonly kind = "cli" as const;
  readonly #o: OpCliOptions;

  constructor(options: OpCliOptions) {
    this.#o = options;
  }

  async unavailableReason(): Promise<string | null> {
    try {
      await this.#exec(["whoami", "--format", "json"]);
      return null;
    } catch {
      return "op whoami failed: check the service-account token";
    }
  }

  async #exec(args: string[]): Promise<string> {
    const handle = await this.#o.token();
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? "",
    };
    handle.use((t) => {
      env.OP_SERVICE_ACCOUNT_TOKEN = t;
    });
    const run =
      this.#o.run ??
      ((f: string, a: string[], e: Record<string, string>) =>
        new Promise<string>((resolve, reject) => {
          execFile(
            f,
            a,
            { env: e, shell: false, timeout: this.#o.timeoutMs ?? 30_000, maxBuffer: 1 << 20 },
            (err, stdout, stderr) =>
              err === null
                ? resolve(stdout)
                : reject(
                    Object.assign(new Error("op failed"), {
                      notFound: /isn't an item|not found|no item/i.test(String(stderr)),
                    }),
                  ),
          );
        }));
    try {
      return await run(this.#o.op, args, env);
    } catch (err) {
      if ((err as { notFound?: boolean }).notFound === true) {
        return fail("not_found", "1Password has no such item or field", { reason: "op_not_found" });
      }
      return fail("unavailable", "the 1Password CLI failed", { reason: "op_failed" });
    } finally {
      env.OP_SERVICE_ACCOUNT_TOKEN = "";
    }
  }

  async readField(ref: OnePasswordRef, field: OnePasswordField): Promise<string> {
    checkRef(ref);
    const value = await this.#exec([
      "read",
      `op://${ref.vault}/${ref.item}/${CLI_FIELD[field]}`,
      "--no-newline",
    ]);
    if (value.length === 0)
      return fail("not_found", `the 1Password item has no ${field}`, { reason: "op_empty" });
    return value;
  }
}

// --- Connect --------------------------------------------------------------------------------------

export interface OpConnectOptions {
  /** `https://…` or a loopback `http://127.0.0.1:8080`. */
  baseUrl: string;
  token: TokenProvider;
  fetchImpl?: typeof fetch;
}

interface ConnectField {
  id?: string;
  label?: string;
  purpose?: string;
  type?: string;
  value?: string;
  totp?: string;
}

const UUID_RE = /^[a-z0-9]{26}$/;

/**
 * 1Password Connect REST (`/v1/vaults`, `/v1/vaults/{id}/items`, `/v1/vaults/{id}/items/{id}`),
 * Bearer token per request, redirects not followed, errors rebuilt without bodies.
 */
export class OpConnectSource implements OnePasswordSource {
  readonly kind = "connect" as const;
  readonly #o: OpConnectOptions;
  readonly #base: URL;

  constructor(options: OpConnectOptions) {
    this.#o = options;
    this.#base = new URL(options.baseUrl);
    const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(this.#base.hostname);
    if (this.#base.protocol !== "https:" && !(this.#base.protocol === "http:" && loopback)) {
      throw new RangeError("Connect must be https, or http on loopback");
    }
  }

  async #get(path: string): Promise<unknown> {
    const handle = await this.#o.token();
    const headers = new Headers({ Accept: "application/json" });
    handle.use((t) => headers.set("Authorization", `Bearer ${t}`));
    let res: Response;
    try {
      res = await (this.#o.fetchImpl ?? fetch)(new URL(path, this.#base), {
        headers,
        redirect: "manual",
      });
    } catch {
      return fail("unavailable", "1Password Connect is unreachable", {
        reason: "connect_unreachable",
      });
    } finally {
      headers.delete("Authorization");
    }
    if (res.status === 404)
      return fail("not_found", "1Password has no such item", { reason: "connect_not_found" });
    if (!res.ok)
      return fail("unavailable", `1Password Connect answered ${res.status}`, {
        reason: "connect_error",
      });
    return res.json();
  }

  async unavailableReason(): Promise<string | null> {
    try {
      await this.#get("/v1/vaults");
      return null;
    } catch {
      return "1Password Connect did not answer /v1/vaults";
    }
  }

  async #id(path: string, nameField: "name" | "title", value: string): Promise<string> {
    if (UUID_RE.test(value)) return value;
    const list = (await this.#get(
      `${path}?filter=${encodeURIComponent(`${nameField} eq "${value}"`)}`,
    )) as { id?: string }[];
    const id = Array.isArray(list) && list.length === 1 ? list[0]?.id : undefined;
    if (typeof id !== "string")
      return fail("not_found", "1Password reference is missing or ambiguous", {
        reason: "connect_ambiguous",
      });
    return id;
  }

  async readField(ref: OnePasswordRef, field: OnePasswordField): Promise<string> {
    checkRef(ref);
    const vaultId = await this.#id("/v1/vaults", "name", ref.vault);
    const itemId = await this.#id(`/v1/vaults/${vaultId}/items`, "title", ref.item);
    const item = (await this.#get(`/v1/vaults/${vaultId}/items/${itemId}`)) as {
      fields?: ConnectField[];
    };
    const fields = item.fields ?? [];
    const pick = (f: (x: ConnectField) => boolean) => fields.find(f);
    const found =
      field === "username"
        ? pick((x) => x.purpose === "USERNAME")
        : field === "password"
          ? pick((x) => x.purpose === "PASSWORD")
          : field === "totp"
            ? pick((x) => x.type === "OTP")
            : field === "notes"
              ? pick((x) => x.purpose === "NOTES")
              : pick((x) => (x.label ?? x.id ?? "").toLowerCase().replace(/\s+/g, "_") === field);
    const value = field === "totp" ? found?.totp : found?.value;
    if (typeof value !== "string" || value.length === 0) {
      return fail("not_found", `the 1Password item has no ${field}`, {
        reason: "connect_no_field",
      });
    }
    return value;
  }
}
