import { createHash } from "node:crypto";
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
  /** The URL the window is on now (after any redirect); must be exactly the page asked for. */
  currentUrl(): string;
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

/**
 * The page the ceremony runs on: a path of the Gateway's origin that the window serves itself
 * from a protocol handler (no network, so no Host content, redirect or script is ever involved).
 */
export const PASSKEY_PAGE_PATH = "/__psyche/webauthn";
export const PASSKEY_PAGE_HTML =
  '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'"><title>Psyche</title>';

const b64u = (s: unknown): Buffer | null =>
  typeof s === "string" && /^[A-Za-z0-9_-]*$/.test(s) ? Buffer.from(s, "base64url") : null;

/**
 * What main checks about a credential the page returned, before the renderer sees it: it was made
 * for this Gateway's origin, for the challenge main sent, of the right kind, under this RP ID.
 * A page that lied about any of these (patched APIs, another origin) is refused here.
 */
export function verifyCredential(
  kind: "create" | "get",
  credential: unknown,
  expect: { origin: string; rpId: string; challenge: string },
): void {
  const bad = (why: string): never => {
    throw new PsycheError("forbidden", `The passkey was not made for this Gateway (${why})`);
  };
  const resp = isRecord(credential) && isRecord(credential.response) ? credential.response : null;
  if (resp === null) return bad("no response");
  const raw = b64u(resp.clientDataJSON);
  if (raw === null) return bad("no client data");
  let client: unknown;
  try {
    client = JSON.parse(raw.toString("utf8"));
  } catch {
    return bad("client data");
  }
  if (!isRecord(client)) return bad("client data");
  if (client.type !== (kind === "create" ? "webauthn.create" : "webauthn.get")) return bad("type");
  if (client.origin !== expect.origin) return bad("origin");
  if (client.challenge !== expect.challenge) return bad("challenge");
  if (client.crossOrigin === true) return bad("cross-origin");
  const auth = b64u(resp.authenticatorData);
  if (auth === null || auth.length < 37) return bad("authenticator data");
  const rpIdHash = createHash("sha256").update(expect.rpId).digest();
  if (!auth.subarray(0, 32).equals(rpIdHash)) return bad("RP ID");
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

  /** The RP ID must be named, and be this Gateway's host exactly: never a parent domain. */
  #checkRp(kind: "create" | "get", options: Record<string, unknown>): void {
    const named =
      kind === "create" ? (isRecord(options.rp) ? options.rp.id : undefined) : options.rpId;
    if (named !== this.#origin.hostname) {
      throw new PsycheError("forbidden", "That passkey is for a different site than this Gateway");
    }
    if (typeof options.challenge !== "string" || options.challenge === "") {
      throw new PsycheError("invalid_params", "Passkey options have no challenge");
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
      const page = new URL(PASSKEY_PAGE_PATH, this.#origin).toString();
      await win.load(page);
      // A redirect or a navigation must not have taken the window anywhere else.
      if (win.currentUrl() !== page) {
        throw new PsycheError("forbidden", "The Gateway's page did not load as expected");
      }
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
      if (result?.ok === true) {
        verifyCredential(kind, result.credential, {
          origin: this.#origin.origin,
          rpId: this.#origin.hostname,
          challenge: options.challenge as string,
        });
        return result.credential;
      }
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
