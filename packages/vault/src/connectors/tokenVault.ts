import type { CredentialBinding } from "@psyche/protocol";
import type { Vault } from "../vault.ts";

/**
 * The token shape `@psyche/connectors` stores (`StoredTokens`), declared here structurally so
 * the vault does not import the connectors package.
 */
export interface StoredConnectorTokens {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms. */
  expiresAt?: number;
  /** Space-separated OAuth scopes. */
  scope?: string;
  tokenType?: string;
  /** Epoch ms of the consent that produced the refresh token. */
  obtainedAt?: number;
}

export interface VaultTokenVaultOptions {
  /** Item name shown in Settings → Credentials. Default: `"<connectorId> (OAuth)"`. */
  name?: (connectorId: string) => string;
  /** Extra bindings, e.g. the API hosts the token is sent to. Always includes `{connector}`. */
  bindings?: (connectorId: string) => CredentialBinding[];
}

const iso = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString());
const ms = (s: string | null) => (s === null ? undefined : Date.parse(s));

/** `connector-<id>`, lowercased to the placeholder grammar. */
export function connectorSlug(connectorId: string): string {
  const s = `connector-${connectorId.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`
    .replace(/-+$/, "")
    .slice(0, 64);
  return s;
}

/**
 * `TokenVault` for `@psyche/connectors` (feature G13): OAuth tokens become `oauth_token` items
 * owned by the connector and bound to `{connector: <id>}`, encrypted in `vault.db`, surviving
 * restarts. `clear` (disconnect) revokes the item, which emits `onRevoked` and
 * `credential.updated {change: "revoked"}` so connection-bound work is invalidated.
 * Tokens are plain strings only inside the connector that asked for them.
 */
export class VaultTokenVault {
  readonly #vault: Vault;
  readonly #o: VaultTokenVaultOptions;

  constructor(vault: Vault, options: VaultTokenVaultOptions = {}) {
    this.#vault = vault;
    this.#o = options;
  }

  async load(connectorId: string): Promise<StoredConnectorTokens | undefined> {
    const meta = this.#vault.connectorItem(connectorId);
    if (meta === undefined) return undefined;
    const read = await this.#vault.connectorTokens(meta.id, connectorId);
    const out: StoredConnectorTokens = { accessToken: read.accessToken.use((v) => v) };
    if (read.refreshToken !== null) out.refreshToken = read.refreshToken.use((v) => v);
    const expiresAt = ms(read.expiresAt);
    if (expiresAt !== undefined) out.expiresAt = expiresAt;
    if (read.scopes.length > 0) out.scope = read.scopes.join(" ");
    if (read.tokenType !== null) out.tokenType = read.tokenType;
    const obtainedAt = ms(read.obtainedAt);
    if (obtainedAt !== undefined) out.obtainedAt = obtainedAt;
    return out;
  }

  async save(connectorId: string, tokens: StoredConnectorTokens): Promise<void> {
    const set = {
      accessToken: tokens.accessToken,
      ...(tokens.refreshToken === undefined ? {} : { refreshToken: tokens.refreshToken }),
      ...(tokens.expiresAt === undefined ? {} : { expiresAt: iso(tokens.expiresAt) as string }),
      ...(tokens.scope === undefined ? {} : { scopes: tokens.scope.split(/\s+/).filter(Boolean) }),
      ...(tokens.tokenType === undefined ? {} : { tokenType: tokens.tokenType }),
      ...(tokens.obtainedAt === undefined ? {} : { obtainedAt: iso(tokens.obtainedAt) as string }),
    };
    let meta = this.#vault.connectorItem(connectorId);
    if (meta === undefined) {
      meta = await this.#vault.store({
        connectorId,
        slug: connectorSlug(connectorId),
        name: this.#o.name?.(connectorId) ?? `${connectorId} (OAuth)`,
        bindings: [{ connector: connectorId }, ...(this.#o.bindings?.(connectorId) ?? [])],
        tokens: set,
      });
      if (set.tokenType === undefined && set.obtainedAt === undefined) return;
    }
    await this.#vault.replaceConnectorTokens(meta.id, connectorId, set);
  }

  /** Disconnect: overwrite and delete the item and emit the invalidation event. */
  async clear(connectorId: string): Promise<void> {
    const meta = this.#vault.connectorItem(connectorId);
    if (meta === undefined) return;
    await this.#vault.revoke(meta.id, connectorId, "disconnect");
  }
}
