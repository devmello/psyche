import { PsycheError } from "@psyche/protocol";

/**
 * WebAuthn for a client of another computer's Gateway (remote-gateway design §6.2, R2). A passkey
 * belongs to the Gateway's relying party (`gateway.publicOrigin`'s host), and Chromium only lets a
 * page create or use one for its own site. The app's own pages are not that site, so the ceremony
 * runs in a hidden window loaded from the Gateway's origin, which is a real page of the right
 * site: the platform authenticator (Touch ID on a Mac) then sees the right origin and RP ID.
 *
 * The window has no preload and no Node, one purpose and one ceremony at a time. The renderer
 * never gets a handle on it: it passes WebAuthn options in, and gets the credential JSON back.
 */

export interface WebAuthnWindow {
  /** Loads the Gateway's own page so the window's origin is the Gateway's. */
  load(url: string): Promise<void>;
  /** Runs a script in that page and resolves with what it returns (user activation granted). */
  run(script: string): Promise<unknown>;
  close(): void;
}

export interface PasskeyHostOptions {
  /** The Gateway's origin as this app dialed it (https). */
  origin: string;
  createWindow: () => WebAuthnWindow;
  /** A ceremony that never finishes (the sheet is ignored) is given up after this long. */
  timeoutMs?: number;
}

/** What the page script answers: the credential, or the DOMException's name and message. */
type PageResult = { ok: true; credential: unknown } | { ok: false; name: string; message: string };

const NOT_ALLOWED = new Set(["NotAllowedError", "AbortError"]);

/** The in-page script for one ceremony; the options are embedded as a JSON literal. */
export function ceremonyScript(kind: "create" | "get", options: unknown): string {
  return `(async () => {
  const kind = ${JSON.stringify(kind)};
  const options = ${JSON.stringify(options)};
  try {
    const pkc = globalThis.PublicKeyCredential;
    if (
      globalThis.isSecureContext !== true ||
      !pkc ||
      typeof pkc.parseCreationOptionsFromJSON !== "function" ||
      typeof pkc.parseRequestOptionsFromJSON !== "function"
    ) {
      return { ok: false, name: "NotSupportedError", message: "WebAuthn is not available" };
    }
    const credential =
      kind === "create"
        ? await navigator.credentials.create({ publicKey: pkc.parseCreationOptionsFromJSON(options) })
        : await navigator.credentials.get({ publicKey: pkc.parseRequestOptionsFromJSON(options) });
    if (!credential || typeof credential.toJSON !== "function") {
      return { ok: false, name: "NotAllowedError", message: "No passkey was returned" };
    }
    return { ok: true, credential: credential.toJSON() };
  } catch (e) {
    return { ok: false, name: String((e && e.name) || "Error"), message: String((e && e.message) || e) };
  }
})()`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export class PasskeyHost {
  readonly #origin: URL;
  readonly #createWindow: () => WebAuthnWindow;
  readonly #timeoutMs: number;
  #busy = false;

  constructor(options: PasskeyHostOptions) {
    this.#origin = new URL(options.origin);
    this.#createWindow = options.createWindow;
    this.#timeoutMs = options.timeoutMs ?? 120_000;
  }

  /** Whether a passkey ceremony can be attempted for this Gateway at all. */
  get available(): boolean {
    return this.#origin.protocol === "https:";
  }

  create(options: unknown): Promise<unknown> {
    return this.#ceremony("create", options);
  }

  get(options: unknown): Promise<unknown> {
    return this.#ceremony("get", options);
  }

  /** The RP ID the options name must be this Gateway's host, exactly: never a parent domain. */
  #checkRp(kind: "create" | "get", options: Record<string, unknown>): void {
    const named =
      kind === "create" ? (isRecord(options.rp) ? options.rp.id : undefined) : options.rpId;
    if (named !== undefined && named !== this.#origin.hostname) {
      throw new PsycheError("forbidden", "That passkey is for a different site than this Gateway");
    }
  }

  async #ceremony(kind: "create" | "get", options: unknown): Promise<unknown> {
    if (!this.available) {
      throw new PsycheError("unavailable", "Passkeys need the Gateway at an https address");
    }
    if (!isRecord(options)) throw new PsycheError("invalid_params", "Passkey options are missing");
    this.#checkRp(kind, options);
    if (this.#busy) throw new PsycheError("conflict", "A passkey prompt is already open");
    this.#busy = true;
    const win = this.#createWindow();
    let timer: NodeJS.Timeout | undefined;
    try {
      // `/healthz` is public, tiny and the Gateway's own: a page of the right origin.
      await win.load(new URL("/healthz", this.#origin).toString());
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new PsycheError("timeout", "The passkey prompt timed out", { retryable: true })),
          this.#timeoutMs,
        );
      });
      const result = (await Promise.race([
        win.run(ceremonyScript(kind, options)),
        timeout,
      ])) as PageResult;
      if (result?.ok === true) return result.credential;
      const name = result?.ok === false ? result.name : "Error";
      const message = result?.ok === false ? result.message : "The passkey prompt failed";
      throw new PsycheError(NOT_ALLOWED.has(name) ? "cancelled" : "forbidden", message, {
        details: { name },
      });
    } catch (err) {
      if (err instanceof PsycheError) throw err;
      throw new PsycheError(
        "unavailable",
        "Psyche couldn't reach the Gateway to ask for a passkey",
        {
          retryable: true,
        },
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      win.close();
      this.#busy = false;
    }
  }
}
