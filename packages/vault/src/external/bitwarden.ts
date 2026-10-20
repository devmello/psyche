import { execFile } from "node:child_process";
import { fail } from "../errors.ts";
import type { TokenProvider } from "./onepassword.ts";

/**
 * Bitwarden as an external, read-only credential source (feature G11; security §4.8 (a)), the
 * same shape as 1Password (G10). Psyche keeps a reference (the item's id or unique name) and the
 * bindings; one field is read at fill time through the Bitwarden CLI and nothing is written back.
 *
 * The CLI needs an unlocked session: `BW_SESSION`, the key `bw unlock --raw` prints. It is a vault
 * item (connector-owned, `bitwarden`) read for each call as a one-shot handle and set in the
 * child's env only: never in the Gateway's env, config, argv or logs.
 */

/** Fields Psyche reads; `totp` is the current code (`bw get totp`), never the seed. */
export type BitwardenField = "username" | "password" | "totp" | "token" | "private_key" | "notes";

export interface BitwardenRef {
  /** Item id, or its exact name when that is unique. */
  item: string;
}

export interface BitwardenSource {
  readonly kind: "cli";
  unavailableReason(): Promise<string | null>;
  /** Read one field. Rejects `not_found` when the item or field does not exist. */
  readField(ref: BitwardenRef, field: BitwardenField): Promise<string>;
}

/**
 * A reference goes into `bw get … <item>` as one argv entry: no controls, and no leading `-`, so it
 * can never be read as a flag.
 */
export function checkBitwardenRef(ref: BitwardenRef): void {
  const v = ref.item;
  if (
    typeof v !== "string" ||
    v.length === 0 ||
    v.length > 128 ||
    /\p{Cc}/u.test(v) ||
    v.startsWith("-")
  ) {
    fail("invalid_params", "a Bitwarden item must be 1–128 characters, not starting with -");
  }
}

/** Bitwarden item types the vault may read: login, secure note, SSH key. Cards and identities are refused. */
const READABLE_TYPES = new Set([1, 2, 5]);
const REFUSED_TYPE: Record<number, string> = { 3: "card", 4: "identity" };

/** Custom field names an API key may live under, when the item is not a login. */
const TOKEN_FIELDS = ["token", "api key", "api_key", "apikey", "credential", "secret"];

export interface BwCliOptions {
  /** Trusted path to the `bw` binary. */
  bw: string;
  /** `BW_SESSION`, from the vault. */
  session: TokenProvider;
  /** `BITWARDENCLI_APPDATA_DIR`: where the CLI keeps its encrypted local data (default its own). */
  appDataDir?: string;
  timeoutMs?: number;
  /** Injected for tests. */
  run?: (file: string, args: string[], env: Record<string, string>) => Promise<string>;
}

type Failure = "not_found" | "ambiguous" | "locked" | "failed";

function classify(stderr: string): Failure {
  if (/more than one result/i.test(stderr)) return "ambiguous";
  if (/not found/i.test(stderr)) return "not_found";
  if (/vault is locked|not logged in|session key is invalid|you are not logged in/i.test(stderr))
    return "locked";
  return "failed";
}

/**
 * `bw get <field> <item> --nointeraction`, no shell, nothing inherited but PATH and HOME. Output
 * is the value; errors are rebuilt from a category and never carry the CLI's output.
 */
export class BwCliSource implements BitwardenSource {
  readonly kind = "cli" as const;
  readonly #o: BwCliOptions;

  constructor(options: BwCliOptions) {
    this.#o = options;
  }

  async #exec(args: string[]): Promise<string> {
    const handle = await this.#o.session();
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? "",
      BW_NOINTERACTION: "true",
    };
    if (this.#o.appDataDir !== undefined) env.BITWARDENCLI_APPDATA_DIR = this.#o.appDataDir;
    handle.use((s) => {
      env.BW_SESSION = s;
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
                    Object.assign(new Error("bw failed"), { failure: classify(String(stderr)) }),
                  ),
          );
        }));
    try {
      return await run(this.#o.bw, [...args, "--nointeraction"], env);
    } catch (err) {
      const failure = (err as { failure?: Failure }).failure ?? "failed";
      if (failure === "not_found")
        return fail("not_found", "Bitwarden has no such item or field", { reason: "bw_not_found" });
      if (failure === "ambiguous")
        return fail("not_found", "more than one Bitwarden item has that name: link it by id", {
          reason: "bw_ambiguous",
        });
      if (failure === "locked")
        return fail("unavailable", "the Bitwarden session is locked or expired", {
          reason: "bw_locked",
        });
      return fail("unavailable", "the Bitwarden CLI failed", { reason: "bw_failed" });
    } finally {
      env.BW_SESSION = "";
    }
  }

  async unavailableReason(): Promise<string | null> {
    try {
      const status = JSON.parse(await this.#exec(["status"])) as { status?: unknown };
      return status.status === "unlocked" ? null : `bw status is ${String(status.status)}`;
    } catch {
      return "bw status failed: check the session key";
    }
  }

  /** The whole item, for fields `bw get <field>` has no command for; cards and identities refused. */
  async #item(ref: BitwardenRef): Promise<Record<string, unknown>> {
    let item: Record<string, unknown>;
    try {
      item = JSON.parse(await this.#exec(["get", "item", ref.item])) as Record<string, unknown>;
    } catch (err) {
      if (err instanceof SyntaxError)
        return fail("unavailable", "the Bitwarden CLI answered something else", {
          reason: "bw_failed",
        });
      throw err;
    }
    const type = Number(item.type);
    if (!READABLE_TYPES.has(type)) {
      return fail(
        "policy_denied",
        `Psyche does not read Bitwarden ${REFUSED_TYPE[type] ?? "items of this type"}`,
        {
          reason: "bw_refused_type",
        },
      );
    }
    return item;
  }

  async readField(ref: BitwardenRef, field: BitwardenField): Promise<string> {
    checkBitwardenRef(ref);
    let value: unknown;
    if (field === "username" || field === "password" || field === "totp" || field === "notes") {
      // These have one command each, so the item's JSON (other fields included) stays in the CLI.
      // Card and identity items have no username, password or TOTP for `bw get`; what any value
      // holds is checked against the vault's refusals before it is filled.
      value = await this.#exec(["get", field, ref.item]);
    } else {
      const item = await this.#item(ref);
      if (field === "private_key") {
        value = (item.sshKey as { privateKey?: unknown } | null | undefined)?.privateKey;
      } else {
        const custom = (Array.isArray(item.fields) ? item.fields : []) as {
          name?: unknown;
          value?: unknown;
          type?: unknown;
        }[];
        const named = custom.find((f) =>
          TOKEN_FIELDS.includes(
            String(f.name ?? "")
              .trim()
              .toLowerCase(),
          ),
        );
        value = named?.value ?? (item.login as { password?: unknown } | null | undefined)?.password;
      }
    }
    if (typeof value !== "string" || value.length === 0)
      return fail("not_found", `the Bitwarden item has no ${field}`, { reason: "bw_empty" });
    // `bw get` prints the value with no trailing newline; a value never ends in one either.
    return value.replace(/\r?\n$/, "");
  }
}
