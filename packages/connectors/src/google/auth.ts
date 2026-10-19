import { PsycheError, type Target } from "@psyche/protocol";
import { createPkce, randomState, startLoopback } from "../framework/loopback.ts";
import type { ConnectorContext, ScopeMode, StoredTokens } from "../framework/types.ts";

/**
 * Google OAuth for installed apps (research KQ4; Google "OAuth 2.0 for iOS & Desktop Apps"):
 * a Desktop client the owner creates in their own Cloud project, loopback redirect on
 * 127.0.0.1, PKCE S256, `access_type=offline` for a refresh token. Tokens are vault items
 * (through `TokenVault`), never config. Onboarding copy: docs/copy/onboarding.md "Setting up
 * Google"; the 7-day Testing expiry message: docs/copy/system-messages.md.
 */
export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";

const S = "https://www.googleapis.com/auth/";
export const GOOGLE_SCOPES = {
  gmailModify: `${S}gmail.modify`,
  gmailReadonly: `${S}gmail.readonly`,
  gmailSend: `${S}gmail.send`,
  calendar: `${S}calendar`,
  calendarReadonly: `${S}calendar.readonly`,
  driveFile: `${S}drive.file`,
} as const;

/** `modify` (labels, archive, drafts, send) or the narrower `readonly + send` pair. */
export type GmailScopeChoice = "modify" | "readonly_send";

export function scopesFor(mode: ScopeMode, gmail: GmailScopeChoice = "modify"): string[] {
  if (mode === "read") {
    return [GOOGLE_SCOPES.gmailReadonly, GOOGLE_SCOPES.calendarReadonly, GOOGLE_SCOPES.driveFile];
  }
  const mail =
    gmail === "modify"
      ? [GOOGLE_SCOPES.gmailModify]
      : [GOOGLE_SCOPES.gmailReadonly, GOOGLE_SCOPES.gmailSend];
  return [...mail, GOOGLE_SCOPES.calendar, GOOGLE_SCOPES.driveFile];
}

/** Seven days: refresh tokens of an External app left in Testing expire after this. */
export const TESTING_MODE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface GoogleClientConfig {
  clientId: string;
  /** Desktop clients have a non-confidential secret; kept as a vault placeholder anyway. */
  clientSecret?: string;
}

export interface GoogleAuthOptions {
  /** Open the consent URL in the owner's browser. */
  openBrowser(url: URL): void | Promise<void>;
  /** Approval id for resolving the client secret placeholder (credential_fill). */
  approveSecret?: (placeholder: string, target: Target) => Promise<string>;
  timeoutMs?: number;
}

export class GoogleAuthError extends PsycheError {
  readonly reason: "token_revoked" | "testing_mode_expired" | "missing_scopes" | "exchange_failed";
  constructor(reason: GoogleAuthError["reason"], message: string) {
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
}

export class GoogleAuth {
  readonly #id: string;
  readonly #ctx: ConnectorContext;
  readonly #client: GoogleClientConfig;
  readonly #opts: GoogleAuthOptions;
  #cached: StoredTokens | undefined;

  constructor(
    connectorId: string,
    ctx: ConnectorContext,
    client: GoogleClientConfig,
    opts: GoogleAuthOptions,
  ) {
    if (!/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/.test(client.clientId)) {
      throw new PsycheError(
        "invalid_params",
        "clientId must be a Google OAuth client id (…apps.googleusercontent.com)",
      );
    }
    if (client.clientSecret !== undefined && !client.clientSecret.startsWith("{{cred:")) {
      throw new PsycheError(
        "invalid_params",
        "clientSecret must be a {{cred:…}} vault placeholder",
      );
    }
    this.#id = connectorId;
    this.#ctx = ctx;
    this.#client = client;
    this.#opts = opts;
  }

  /** Interactive consent; returns the granted scopes. */
  async authorize(scopes: string[], signal?: AbortSignal): Promise<StoredTokens> {
    const state = randomState();
    const pkce = createPkce();
    const loopback = await startLoopback(state);
    try {
      const url = new URL(GOOGLE_AUTH_URL);
      url.search = new URLSearchParams({
        client_id: this.#client.clientId,
        redirect_uri: loopback.redirectUri,
        response_type: "code",
        scope: scopes.join(" "),
        access_type: "offline",
        prompt: "consent",
        // No include_granted_scopes: a read-only reconnect must not inherit earlier write grants.
        state,
        code_challenge: pkce.challenge,
        code_challenge_method: pkce.method,
      }).toString();
      await this.#opts.openBrowser(url);
      const params = await loopback.wait(this.#opts.timeoutMs ?? 5 * 60_000, signal);
      const code = params.get("code");
      if (code === null || code === "")
        throw new GoogleAuthError("exchange_failed", "no authorization code");
      const tokens = await this.#token(
        {
          grant_type: "authorization_code",
          code,
          code_verifier: pkce.verifier,
          redirect_uri: loopback.redirectUri,
        },
        signal,
      );
      const granted = new Set((tokens.scope ?? "").split(/\s+/).filter((x) => x !== ""));
      const missing = scopes.filter((s) => !granted.has(s));
      const extra = [...granted].filter((g) => g.startsWith(S) && !scopes.includes(g));
      if (extra.length > 0) {
        // Never hold more than the mode allows (a read-only connection with gmail.send).
        await this.#revokeToken(tokens.refreshToken ?? tokens.accessToken, signal);
        throw new GoogleAuthError(
          "missing_scopes",
          `Google granted more than requested (${extra.map((m) => m.replace(S, "")).join(", ")}); revoke Psyche's access in your Google account and connect again`,
        );
      }
      if (missing.length > 0) {
        throw new GoogleAuthError(
          "missing_scopes",
          `Google did not grant: ${missing.map((m) => m.replace(S, "")).join(", ")}`,
        );
      }
      if (tokens.refreshToken === undefined) {
        throw new GoogleAuthError("exchange_failed", "Google returned no refresh token");
      }
      tokens.obtainedAt = this.#ctx.clock.now();
      await this.#save(tokens);
      return tokens;
    } finally {
      await loopback.close();
    }
  }

  /** A valid access token, refreshing when it expires within a minute. */
  async accessToken(signal?: AbortSignal, force = false): Promise<string> {
    const t = this.#cached ?? (await this.#ctx.tokens.load(this.#id));
    if (t === undefined) throw new GoogleAuthError("token_revoked", "not signed in to Google");
    this.#cached = t;
    if (!force && t.expiresAt !== undefined && t.expiresAt - 60_000 > this.#ctx.clock.now()) {
      return t.accessToken;
    }
    if (t.refreshToken === undefined)
      throw new GoogleAuthError("token_revoked", "no refresh token");
    let fresh: StoredTokens;
    try {
      fresh = await this.#token(
        { grant_type: "refresh_token", refresh_token: t.refreshToken },
        signal,
      );
    } catch (err) {
      if (err instanceof GoogleAuthError && err.reason === "token_revoked") {
        this.#cached = undefined;
        const age = t.obtainedAt === undefined ? 0 : this.#ctx.clock.now() - t.obtainedAt;
        if (
          age >= TESTING_MODE_TTL_MS - 60 * 60_000 &&
          age <= TESTING_MODE_TTL_MS + 24 * 60 * 60_000
        ) {
          throw new GoogleAuthError(
            "testing_mode_expired",
            "Google signed you out after 7 days because the Psyche client is in Testing mode",
          );
        }
      }
      throw err;
    }
    const merged: StoredTokens = {
      ...t,
      ...fresh,
      refreshToken: fresh.refreshToken ?? t.refreshToken,
    };
    await this.#save(merged);
    return merged.accessToken;
  }

  async revoke(signal?: AbortSignal): Promise<void> {
    const t = this.#cached ?? (await this.#ctx.tokens.load(this.#id));
    this.#cached = undefined;
    if (t === undefined) return;
    await this.#revokeToken(t.refreshToken ?? t.accessToken, signal);
    await this.#ctx.tokens.clear(this.#id);
  }

  async #revokeToken(token: string, signal?: AbortSignal): Promise<void> {
    await this.#ctx
      .fetch(GOOGLE_REVOKE_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }).toString(),
        ...(signal === undefined ? {} : { signal }),
      })
      .catch(() => undefined);
  }

  async #save(tokens: StoredTokens): Promise<void> {
    this.#cached = tokens;
    await this.#ctx.tokens.save(this.#id, tokens);
  }

  async #secret(): Promise<string | undefined> {
    const placeholder = this.#client.clientSecret;
    if (placeholder === undefined) return undefined;
    const credentials = this.#ctx.credentials;
    const approve = this.#opts.approveSecret;
    if (credentials === undefined || approve === undefined) {
      throw new PsycheError("unavailable", "client secret needs the credential broker");
    }
    const target: Target = { kind: "origin", value: new URL(GOOGLE_TOKEN_URL).origin };
    const handle = await credentials.resolve(
      placeholder,
      target,
      await approve(placeholder, target),
      {
        executor: "connector",
      },
    );
    return handle.use((v) => v);
  }

  async #token(form: Record<string, string>, signal?: AbortSignal): Promise<StoredTokens> {
    const body = new URLSearchParams({ ...form, client_id: this.#client.clientId });
    const secret = await this.#secret();
    if (secret !== undefined) body.set("client_secret", secret);
    const res = await this.#ctx.fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: body.toString(),
      ...(signal === undefined ? {} : { signal }),
    });
    const json = (await res.json().catch(() => ({}))) as TokenResponse;
    if (!res.ok || json.access_token === undefined) {
      if (json.error === "invalid_grant") {
        throw new GoogleAuthError(
          "token_revoked",
          "Google rejected the refresh token (revoked or expired)",
        );
      }
      // Never echo the response body: it may contain the request's secrets in some proxies.
      throw new GoogleAuthError(
        "exchange_failed",
        `token endpoint returned ${res.status} ${json.error ?? ""}`.trim(),
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
