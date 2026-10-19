import { randomBytes } from "node:crypto";
import type {
  FetchLike,
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import { PsycheError } from "@psyche/protocol";

/**
 * OAuth 2.1 for remote MCP servers (architecture §4.9). Psyche identifies itself with a Client ID
 * Metadata Document (CIMD, SEP-991): its `client_id` is an HTTPS URL serving the JSON from
 * `clientMetadataDocument()`. Dynamic Client Registration is deprecated and never used: a server
 * whose authorization server accepts neither the CIMD URL nor a pre-registered client id fails
 * to connect. Public client, PKCE S256 (done by the SDK), loopback redirect, `state` checked by the
 * loopback receiver.
 */
export interface McpTokenStore {
  load(serverId: string): Promise<StoredOAuthTokens | undefined>;
  save(serverId: string, tokens: StoredOAuthTokens): Promise<void>;
  clear(serverId: string): Promise<void>;
}

/** Test / dev store. Production stores tokens as `oauth_token` vault items. */
export class MemoryTokenStore implements McpTokenStore {
  readonly #tokens = new Map<string, StoredOAuthTokens>();
  async load(serverId: string) {
    const t = this.#tokens.get(serverId);
    return t === undefined ? undefined : structuredClone(t);
  }
  async save(serverId: string, tokens: StoredOAuthTokens) {
    this.#tokens.set(serverId, structuredClone(tokens));
  }
  async clear(serverId: string) {
    this.#tokens.delete(serverId);
  }
}

export interface McpOAuthOptions {
  /** HTTPS URL (with a path) of Psyche's client metadata document. */
  clientMetadataUrl?: string;
  clientName?: string;
  tokenStore: McpTokenStore;
  /** Show the authorization URL to the owner (open the browser, post a card). */
  openAuthorizationUrl(input: { serverId: string; url: URL }): void | Promise<void>;
  /** How long to wait for the owner to finish signing in. Default 5 minutes. */
  timeoutMs?: number;
}

/** The JSON to publish at `clientMetadataUrl` (CIMD requires `client_id`, name, redirect URIs). */
export function clientMetadataDocument(clientMetadataUrl: string, clientName = "Psyche") {
  return {
    client_id: clientMetadataUrl,
    client_name: clientName,
    redirect_uris: ["http://127.0.0.1/callback"],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    application_type: "native",
  };
}

export class PsycheOAuthProvider implements OAuthClientProvider {
  readonly #serverId: string;
  readonly #options: McpOAuthOptions;
  readonly #preRegisteredClientId: string | undefined;
  readonly #scopes: string[] | undefined;
  #redirectUrl: string | undefined;
  #state: string | undefined;
  #verifier: string | undefined;
  #discovery: OAuthDiscoveryState | undefined;
  #tokens: StoredOAuthTokens | undefined;
  #loaded = false;
  /** Set once the SDK asked to redirect the owner; the host then waits for the callback. */
  authorizationUrl: URL | undefined;
  /** True only while a loopback receiver is listening for this provider's callback. */
  armed = false;

  constructor(
    serverId: string,
    options: McpOAuthOptions,
    extra: { clientId?: string; scopes?: string[] } = {},
  ) {
    this.#serverId = serverId;
    this.#options = options;
    this.#preRegisteredClientId = extra.clientId;
    this.#scopes = extra.scopes;
    if (options.clientMetadataUrl !== undefined) {
      const u = new URL(options.clientMetadataUrl);
      if (u.protocol !== "https:" || u.pathname === "/") {
        throw new PsycheError(
          "invalid_params",
          "clientMetadataUrl must be an HTTPS URL with a path",
        );
      }
    }
  }

  setRedirectUrl(url: string | undefined): void {
    this.#redirectUrl = url;
  }

  get redirectUrl(): string | undefined {
    return this.#redirectUrl;
  }

  get clientMetadataUrl(): string | undefined {
    return this.#preRegisteredClientId === undefined ? this.#options.clientMetadataUrl : undefined;
  }

  get clientMetadata(): OAuthClientMetadata {
    const meta: OAuthClientMetadata = {
      client_name: this.#options.clientName ?? "Psyche",
      redirect_uris: [this.#redirectUrl ?? "http://127.0.0.1/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
    if (this.#scopes !== undefined) meta.scope = this.#scopes.join(" ");
    return meta;
  }

  state(): string {
    this.#state = randomBytes(24).toString("base64url");
    return this.#state;
  }

  get expectedState(): string | undefined {
    return this.#state;
  }

  /**
   * Pre-registered id, else the CIMD URL. There is deliberately no `saveClientInformation`: the
   * SDK then cannot run Dynamic Client Registration at all (it throws before any request), and
   * an authorization server that accepts neither id simply rejects the authorization request.
   */
  clientInformation(): StoredOAuthClientInformation | undefined {
    if (this.#preRegisteredClientId !== undefined)
      return { client_id: this.#preRegisteredClientId };
    const cimd = this.#options.clientMetadataUrl;
    return cimd === undefined ? undefined : { client_id: cimd };
  }

  async tokens(): Promise<StoredOAuthTokens | undefined> {
    if (!this.#loaded) {
      this.#tokens = await this.#options.tokenStore.load(this.#serverId);
      this.#loaded = true;
    }
    return this.#tokens;
  }

  async saveTokens(tokens: StoredOAuthTokens): Promise<void> {
    this.#tokens = tokens;
    this.#loaded = true;
    await this.#options.tokenStore.save(this.#serverId, tokens);
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    if (!this.armed) {
      throw new PsycheError("unauthorized", "re-authorization required; reconnect the server");
    }
    this.authorizationUrl = url;
    await this.#options.openAuthorizationUrl({ serverId: this.#serverId, url });
  }

  saveCodeVerifier(verifier: string): void {
    this.#verifier = verifier;
  }

  codeVerifier(): string {
    if (this.#verifier === undefined) throw new PsycheError("conflict", "no PKCE verifier saved");
    return this.#verifier;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.#discovery = state;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.#discovery;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    if (scope === "all" || scope === "tokens") {
      this.#tokens = undefined;
      await this.#options.tokenStore.clear(this.#serverId);
    }
    if (scope === "all" || scope === "verifier") this.#verifier = undefined;
    if (scope === "all" || scope === "discovery") this.#discovery = undefined;
  }

  /** The authorization server's DCR endpoint, once discovered; requests to it are blocked. */
  get registrationEndpoint(): string | undefined {
    const meta = this.#discovery?.authorizationServerMetadata as
      | { registration_endpoint?: string }
      | undefined;
    return meta?.registration_endpoint;
  }

  get timeoutMs(): number {
    return this.#options.timeoutMs ?? 5 * 60 * 1000;
  }
}

/** Wraps the transport's fetch so no request ever reaches a DCR endpoint. */
export function blockRegistration(base: FetchLike, provider: PsycheOAuthProvider): FetchLike {
  return (input, init) => {
    const reg = provider.registrationEndpoint;
    const url = typeof input === "string" ? input : input.href;
    if (reg !== undefined && new URL(url).href === new URL(reg).href) {
      return Promise.reject(
        new PsycheError("policy_denied", "dynamic client registration is not supported"),
      );
    }
    return base(input, init);
  };
}
