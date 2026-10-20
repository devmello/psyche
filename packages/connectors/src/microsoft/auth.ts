import { PsycheError } from "@psyche/protocol";
import { createPkce, randomState, startLoopback } from "../framework/loopback.ts";
import type {
  ConnectorContext,
  PendingAuthorization,
  ScopeMode,
  StoredTokens,
} from "../framework/types.ts";

/**
 * Microsoft identity platform v2 for a public (desktop) client the owner registers in their own
 * Entra tenant or personal account (feature M6): authorization code + PKCE S256 on a loopback
 * redirect (`http://127.0.0.1/callback`; Entra ignores the port for loopback addresses), or the
 * device code flow for a Gateway without a browser (server mode). No client secret. Tokens are
 * vault items through `TokenVault`, never config. Microsoft has no per-app token revocation
 * endpoint, so disconnect clears the tokens and the copy points the owner at their account's
 * app permissions page.
 */
export const MS_LOGIN_ORIGIN = "https://login.microsoftonline.com";
export const MS_CONSENT_PAGE = "https://myaccount.microsoft.com/applications";

export const MICROSOFT_SCOPES = {
  offline: "offline_access",
  user: "User.Read",
  mailRead: "Mail.Read",
  mailReadWrite: "Mail.ReadWrite",
  mailSend: "Mail.Send",
  calendarsRead: "Calendars.Read",
  calendarsReadWrite: "Calendars.ReadWrite",
  contactsRead: "Contacts.Read",
  /** Only Psyche's own app folder in OneDrive (`/drive/special/approot`), like Google `drive.file`. */
  filesAppFolder: "Files.ReadWrite.AppFolder",
} as const;

const OIDC = new Set(["offline_access", "openid", "profile", "email"]);

export function microsoftScopesFor(mode: ScopeMode): string[] {
  const s = MICROSOFT_SCOPES;
  if (mode === "read") {
    return [s.offline, s.user, s.mailRead, s.calendarsRead, s.contactsRead];
  }
  return [
    s.offline,
    s.user,
    s.mailReadWrite,
    s.mailSend,
    s.calendarsReadWrite,
    s.contactsRead,
    s.filesAppFolder,
  ];
}

/** `https://graph.microsoft.com/Mail.Read` → `mail.read`. */
export function normalizeScope(scope: string): string {
  return scope.replace(/^https:\/\/graph\.microsoft\.com\//i, "").toLowerCase();
}

export type MicrosoftFlow = "auth_code" | "device_code";

export interface DeviceCodePrompt {
  userCode: string;
  verificationUri: string;
  /** Epoch ms. */
  expiresAt: number;
  /** Microsoft's own sentence (untrusted text; show the code and URL, not this). */
  message: string;
}

export interface MicrosoftAuthOptions {
  /** Auth code flow: open the consent URL in the owner's browser. */
  openBrowser?(url: URL): void | Promise<void>;
  /** Device code flow: show the owner the code and the URL to enter it at. */
  showDeviceCode?(prompt: DeviceCodePrompt): void | Promise<void>;
  /** Loopback wait / device code lifetime cap. Default 5 min / the code's own expiry. */
  timeoutMs?: number;
  /** Device code polling wait (tests replace it). */
  sleep?(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface MicrosoftClientConfig {
  clientId: string;
  /** `common` (default), `consumers`, `organizations`, a tenant GUID or a verified domain. */
  tenant: string;
  flow: MicrosoftFlow;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TENANT = /^(common|consumers|organizations|[0-9a-f-]{36}|[a-z0-9-]+(\.[a-z0-9-]+)+)$/i;

export function parseMicrosoftClient(config: Record<string, unknown>): MicrosoftClientConfig {
  if (typeof config.clientId !== "string" || !GUID.test(config.clientId)) {
    throw new PsycheError(
      "invalid_params",
      "config.clientId must be an Entra application (client) id",
    );
  }
  const tenant = typeof config.tenant === "string" ? config.tenant : "common";
  if (!TENANT.test(tenant))
    throw new PsycheError("invalid_params", "config.tenant is not a tenant id");
  const flow = config.flow === "device_code" ? "device_code" : "auth_code";
  return { clientId: config.clientId, tenant: tenant.toLowerCase(), flow };
}

export class MicrosoftAuthError extends PsycheError {
  readonly reason:
    | "token_revoked"
    | "missing_scopes"
    | "extra_scopes"
    | "exchange_failed"
    | "declined"
    | "expired";
  constructor(reason: MicrosoftAuthError["reason"], message: string) {
    super("unauthorized", message, { details: { reason } });
    this.reason = reason;
  }
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  interval?: number;
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new PsycheError("cancelled", "authorization cancelled"));
      },
      { once: true },
    );
  });

export class MicrosoftAuth {
  readonly #id: string;
  readonly #ctx: ConnectorContext;
  readonly #client: MicrosoftClientConfig;
  readonly #opts: MicrosoftAuthOptions;
  #cached: StoredTokens | undefined;

  constructor(
    connectorId: string,
    ctx: ConnectorContext,
    client: MicrosoftClientConfig,
    opts: MicrosoftAuthOptions,
  ) {
    this.#id = connectorId;
    this.#ctx = ctx;
    this.#client = client;
    this.#opts = opts;
  }

  #endpoint(path: "authorize" | "token" | "devicecode"): string {
    return `${MS_LOGIN_ORIGIN}/${encodeURIComponent(this.#client.tenant)}/oauth2/v2.0/${path}`;
  }

  /** Interactive consent with the configured flow; checks the granted scopes both ways. */
  async authorize(
    scopes: string[],
    signal?: AbortSignal,
    onAuthorization?: (pending: PendingAuthorization) => void,
  ): Promise<StoredTokens> {
    const tokens =
      this.#client.flow === "device_code"
        ? await this.#deviceCode(scopes, signal, onAuthorization)
        : await this.#authCode(scopes, signal, onAuthorization);
    const granted = new Set((tokens.scope ?? "").split(/\s+/).filter(Boolean).map(normalizeScope));
    const wanted = scopes.map(normalizeScope).filter((s) => !OIDC.has(s));
    const missing = wanted.filter((s) => !granted.has(s));
    const extra = [...granted].filter((g) => !OIDC.has(g) && !wanted.includes(g));
    if (extra.length > 0) {
      // Microsoft returns every scope the app was ever granted. A read-only connection must
      // not hold Mail.Send; there is no per-app revocation API, so the owner removes it.
      throw new MicrosoftAuthError(
        "extra_scopes",
        `Microsoft granted more than this connection needs (${extra.join(", ")}). Remove Psyche under ${MS_CONSENT_PAGE} and connect again.`,
      );
    }
    if (missing.length > 0) {
      throw new MicrosoftAuthError(
        "missing_scopes",
        `Microsoft did not grant: ${missing.join(", ")}`,
      );
    }
    if (tokens.refreshToken === undefined) {
      throw new MicrosoftAuthError("exchange_failed", "Microsoft returned no refresh token");
    }
    tokens.obtainedAt = this.#ctx.clock.now();
    await this.#save(tokens);
    return tokens;
  }

  async #authCode(
    scopes: string[],
    signal?: AbortSignal,
    onAuthorization?: (pending: PendingAuthorization) => void,
  ): Promise<StoredTokens> {
    const open = this.#opts.openBrowser;
    if (open === undefined && onAuthorization === undefined) {
      throw new PsycheError(
        "unavailable",
        "no browser for Microsoft sign-in; use flow device_code",
      );
    }
    const state = randomState();
    const pkce = createPkce();
    const loopback = await startLoopback(state);
    try {
      const url = new URL(this.#endpoint("authorize"));
      url.search = new URLSearchParams({
        client_id: this.#client.clientId,
        response_type: "code",
        redirect_uri: loopback.redirectUri,
        response_mode: "query",
        scope: scopes.join(" "),
        state,
        code_challenge: pkce.challenge,
        code_challenge_method: pkce.method,
        prompt: "select_account",
      }).toString();
      const timeoutMs = this.#opts.timeoutMs ?? 5 * 60_000;
      let opened = false;
      try {
        if (open !== undefined) {
          await open(url);
          opened = true;
        }
      } catch (err) {
        // No browser here (a server): the owner opens the link from the app instead.
        if (onAuthorization === undefined) throw err;
      }
      onAuthorization?.({ url: url.href, expiresAt: this.#ctx.clock.now() + timeoutMs, opened });
      const params = await loopback.wait(timeoutMs, signal);
      const code = params.get("code");
      if (code === null || code === "") {
        throw new MicrosoftAuthError(
          params.get("error") === "access_denied" ? "declined" : "exchange_failed",
          "no authorization code",
        );
      }
      return await this.#token(
        {
          grant_type: "authorization_code",
          code,
          code_verifier: pkce.verifier,
          redirect_uri: loopback.redirectUri,
          scope: scopes.join(" "),
        },
        signal,
      );
    } finally {
      await loopback.close();
    }
  }

  async #deviceCode(
    scopes: string[],
    signal?: AbortSignal,
    onAuthorization?: (pending: PendingAuthorization) => void,
  ): Promise<StoredTokens> {
    const show = this.#opts.showDeviceCode;
    if (show === undefined && onAuthorization === undefined)
      throw new PsycheError("unavailable", "no surface to show the device code");
    const res = await this.#ctx.fetch(this.#endpoint("devicecode"), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        client_id: this.#client.clientId,
        scope: scopes.join(" "),
      }).toString(),
      ...(signal === undefined ? {} : { signal }),
    });
    const dc = (await res.json().catch(() => ({}))) as {
      device_code?: string;
      user_code?: string;
      verification_uri?: string;
      expires_in?: number;
      interval?: number;
      message?: string;
    };
    if (!res.ok || typeof dc.device_code !== "string" || typeof dc.user_code !== "string") {
      throw new MicrosoftAuthError("exchange_failed", `device code request failed (${res.status})`);
    }
    const verificationUri =
      typeof dc.verification_uri === "string" && /^https:\/\//.test(dc.verification_uri)
        ? dc.verification_uri
        : "https://microsoft.com/devicelogin";
    const now = this.#ctx.clock.now();
    const lifetime = Math.min(
      (dc.expires_in ?? 900) * 1000,
      this.#opts.timeoutMs ?? Number.POSITIVE_INFINITY,
    );
    const prompt = {
      userCode: dc.user_code.slice(0, 32),
      verificationUri,
      expiresAt: now + lifetime,
      message: String(dc.message ?? "").slice(0, 500),
    };
    await show?.(prompt);
    onAuthorization?.({
      url: prompt.verificationUri,
      userCode: prompt.userCode,
      expiresAt: prompt.expiresAt,
      opened: false,
    });
    const sleep = this.#opts.sleep ?? defaultSleep;
    let interval = Math.max(1, dc.interval ?? 5) * 1000;
    const deadline = now + lifetime;
    for (let attempt = 0; attempt < 1000; attempt++) {
      if (this.#ctx.clock.now() > deadline)
        throw new MicrosoftAuthError("expired", "the device code expired");
      await sleep(interval, signal);
      try {
        return await this.#token(
          {
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            device_code: dc.device_code,
          },
          signal,
        );
      } catch (err) {
        const code = err instanceof DeviceCodePending ? err.code : undefined;
        if (code === "authorization_pending") continue;
        if (code === "slow_down") {
          interval += 5000;
          continue;
        }
        throw err;
      }
    }
    throw new MicrosoftAuthError("expired", "the device code expired");
  }

  /** A valid access token, refreshing when it expires within a minute. */
  async accessToken(signal?: AbortSignal, force = false): Promise<string> {
    const t = this.#cached ?? (await this.#ctx.tokens.load(this.#id));
    if (t === undefined)
      throw new MicrosoftAuthError("token_revoked", "not signed in to Microsoft");
    this.#cached = t;
    if (!force && t.expiresAt !== undefined && t.expiresAt - 60_000 > this.#ctx.clock.now()) {
      return t.accessToken;
    }
    if (t.refreshToken === undefined)
      throw new MicrosoftAuthError("token_revoked", "no refresh token");
    const fresh = await this.#token(
      { grant_type: "refresh_token", refresh_token: t.refreshToken },
      signal,
    );
    // Microsoft rotates refresh tokens: the new one replaces the old one atomically (§4.8).
    const merged: StoredTokens = {
      ...t,
      ...fresh,
      refreshToken: fresh.refreshToken ?? t.refreshToken,
    };
    await this.#save(merged);
    return merged.accessToken;
  }

  /** Disconnect: Microsoft has no per-app revoke endpoint; forget the tokens. */
  async clear(): Promise<void> {
    this.#cached = undefined;
    await this.#ctx.tokens.clear(this.#id);
  }

  async #save(tokens: StoredTokens): Promise<void> {
    this.#cached = tokens;
    await this.#ctx.tokens.save(this.#id, tokens);
  }

  async #token(form: Record<string, string>, signal?: AbortSignal): Promise<StoredTokens> {
    const body = new URLSearchParams({ ...form, client_id: this.#client.clientId });
    const res = await this.#ctx.fetch(this.#endpoint("token"), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: body.toString(),
      ...(signal === undefined ? {} : { signal }),
    });
    const json = (await res.json().catch(() => ({}))) as TokenResponse;
    if (!res.ok || json.access_token === undefined) {
      const error = json.error ?? "";
      if (error === "authorization_pending" || error === "slow_down")
        throw new DeviceCodePending(error);
      if (error === "authorization_declined")
        throw new MicrosoftAuthError("declined", "sign-in was declined");
      if (error === "expired_token" || error === "bad_verification_code") {
        throw new MicrosoftAuthError("expired", "the device code expired");
      }
      if (error === "invalid_grant" || error === "interaction_required") {
        throw new MicrosoftAuthError("token_revoked", "Microsoft rejected the refresh token");
      }
      // Never echo the body: error_description can carry request details.
      throw new MicrosoftAuthError(
        "exchange_failed",
        `token endpoint returned ${res.status} ${error}`.trim(),
      );
    }
    const out: StoredTokens = { accessToken: json.access_token };
    if (json.refresh_token !== undefined) out.refreshToken = json.refresh_token;
    if (json.expires_in !== undefined)
      out.expiresAt = this.#ctx.clock.now() + json.expires_in * 1000;
    if (json.scope !== undefined) out.scope = json.scope;
    if (json.token_type !== undefined) out.tokenType = json.token_type;
    return out;
  }
}

class DeviceCodePending extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
