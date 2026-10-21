import type {
  ApprovalKind,
  Clock,
  CredentialBroker,
  JsonObject,
  SideEffect,
  ToolCallAuthority,
  ToolCallDescription,
} from "@psyche/protocol";

/**
 * Connector framework (architecture §4.9, data model §8, features M4 / M11). A connector is a
 * first-party adapter (Google, search, fetch; later Microsoft / IMAP / JMAP) or an MCP preset,
 * exposing tools with the same metadata as MCP tools (`mcp__<connector>__<tool>`), an action
 * matrix the owner sets to allow / ask / deny, and a read-only vs read-and-act scope chosen at
 * connect time.
 */

export type ScopeMode = "read" | "read_act";
export type ActionRule = "allow" | "ask" | "deny";

/** One row of a connector's action matrix (shown in Permissions, M11). */
export interface ConnectorAction {
  /** Matrix key, e.g. `gmail.send`, `calendar.delete`. */
  id: string;
  title: string;
  sideEffect: SideEffect;
  /** Approval kind the broker uses for this action (`send_email`, `calendar_write`, …). */
  approvalKind?: ApprovalKind;
  defaultRule: ActionRule;
}

export type ConnectorCategory = "first_party" | "remote_mcp" | "community";

/** Directory metadata (M4 data); the UI (S12) renders it, nothing here is model-visible. */
export interface CatalogueEntry {
  /** Connector type, `connectors.type` (`google`, `search:brave`, `mcp`, …). */
  type: string;
  /** Stable catalogue id (`google`, `slack`, `web-fetch`). */
  id: string;
  label: string;
  description: string;
  category: ConnectorCategory;
  vendor: string;
  auth: "oauth" | "api_key" | "none" | "app_password" | "token";
  /** Scopes requested per mode; empty for connectors without OAuth. */
  scopes: Record<ScopeMode, string[]>;
  actions: ConnectorAction[];
  /** Remote MCP presets: the first-party server endpoint. */
  remote?: { url: string; transport: "http"; readOnlyUrl?: string };
  /** Pointer into docs/copy or the package README for the setup steps. */
  setupGuide?: string;
  docsUrl?: string;
  /** False for entries whose implementation is a later milestone (shown as "coming soon"). */
  available: boolean;
  /**
   * One per machine (the Apple apps, web search): a second connect is refused with
   * `conflict` / `details.reason: "already_connected"` (#549). Per-account types stay multi.
   */
  singleInstance?: boolean;
}

/** Durable connector record (data model §8 `connectors`). */
export interface ConnectorRecord {
  id: string;
  type: string;
  label: string;
  account: string | null;
  scopes: string[];
  scopeMode: ScopeMode;
  actionMatrix: Record<string, ActionRule>;
  credentialId: string | null;
  status: "connected" | "disconnected" | "error" | "needs_auth";
  config: JsonObject;
  lastSync: JsonObject | null;
  createdAt: string;
  updatedAt: string;
}

/** Persistence seam until the `connectors` table lands in packages/db (see docs/status/s09.md). */
export interface ConnectorStore {
  get(id: string): Promise<ConnectorRecord | undefined>;
  list(): Promise<ConnectorRecord[]>;
  put(record: ConnectorRecord): Promise<void>;
  delete(id: string): Promise<void>;
}

/** OAuth token persistence (vault-backed in production; the S06 write API is pending). */
export interface StoredTokens {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms. */
  expiresAt?: number;
  scope?: string;
  tokenType?: string;
  /** Epoch ms of the consent that produced the refresh token (for the 7-day Testing hint). */
  obtainedAt?: number;
}

export interface TokenVault {
  load(connectorId: string): Promise<StoredTokens | undefined>;
  save(connectorId: string, tokens: StoredTokens): Promise<void>;
  clear(connectorId: string): Promise<void>;
}

export type FetchFn = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Where attachments and downloads go (the Library, S13); returns a library item id. */
export interface LibrarySink {
  put(input: {
    name: string;
    mimeType: string;
    bytes: Uint8Array;
    source: { connectorId: string; ref: string };
    provenance: "untrusted";
  }): Promise<{ libraryItemId: string }>;
}

export type ConnectorEvent =
  | { type: "status"; connectorId: string; status: ConnectorRecord["status"]; reason?: string }
  /**
   * Pending work bound to this connection is no longer valid (account changed, disconnected,
   * scopes narrowed, token revoked): tasks and approvals that reference it must be invalidated.
   */
  | {
      type: "invalidated";
      connectorId: string;
      reason: "account_changed" | "disconnected" | "scope_changed" | "token_revoked";
      previousAccount: string | null;
      account: string | null;
    }
  | { type: "synced"; connectorId: string; changes: number; full: boolean }
  | { type: "matrix_changed"; connectorId: string; matrix: Record<string, ActionRule> };

export interface ConnectorContext {
  clock: Clock;
  fetch: FetchFn;
  credentials?: CredentialBroker;
  tokens: TokenVault;
  library?: LibrarySink;
  emit(event: ConnectorEvent): void;
}

export interface ToolRunContext {
  signal: AbortSignal;
  callId: string;
  /** Approval the broker issued for this call, when it asked. */
  approvalId?: string;
  /** What authorized the dispatch (approval or standing grant), as the loop verified it. */
  authority?: ToolCallAuthority;
}

export interface ToolOutput {
  output: unknown;
  isError?: boolean;
  /** Connectors return third-party content: `untrusted` unless the data is the owner's own config. */
  provenance: "trusted" | "untrusted";
  /** External ids for the receipt (message id, event id, …). */
  externalRefs?: Record<string, string | number>;
  /** One-line receipt summary for write actions. */
  receiptSummary?: string;
}

/** A tool a connector exposes; `name` is the bare tool name (`gmail_send`). */
export interface ConnectorTool {
  name: string;
  /** Matrix row this tool belongs to. */
  action: string;
  description: string;
  inputSchema: Record<string, unknown>;
  sideEffect: SideEffect;
  describeCall?: (params: unknown) => ToolCallDescription;
  execute(params: unknown, ctx: ToolRunContext): Promise<ToolOutput>;
}

export interface ConnectInput {
  scopeMode: ScopeMode;
  config: JsonObject;
  signal?: AbortSignal;
  /**
   * A sign-in the owner finishes elsewhere has started: the consent page (or device-code page)
   * and whether it was opened in the owner's browser. With this set, a connector that cannot
   * open a browser still waits for the owner, who opens `url` from the app (#505).
   */
  onAuthorization?: (pending: PendingAuthorization) => void;
}

export interface PendingAuthorization {
  url: string;
  userCode?: string;
  /** Epoch ms. */
  expiresAt: number;
  opened: boolean;
}

export interface ConnectResult {
  account: string | null;
  scopes: string[];
  credentialId?: string | null;
  config?: JsonObject;
  /**
   * `needs_auth` when the connection exists but a grant outside the sign-in is missing (macOS
   * Automation for an Apple app, #549); `config.permission` says which. Default `connected`.
   */
  status?: "connected" | "needs_auth";
}

export interface SyncResult {
  changes: number;
  full: boolean;
  cursor: JsonObject;
}

export interface ConnectorHealth {
  ok: boolean;
  status: ConnectorRecord["status"];
  detail?: string;
  checkedAt: number;
  /** Merged into the record's config when the status is persisted (`permission: null` clears). */
  config?: JsonObject;
}

/** One connected instance, created by a `ConnectorFactory` per record. */
export interface Connector {
  readonly id: string;
  readonly type: string;
  connect(input: ConnectInput): Promise<ConnectResult>;
  disconnect(): Promise<void>;
  actions(): ConnectorAction[];
  tools(): ConnectorTool[];
  /** Incremental sync; `cursor` is what the previous sync returned (`lastSync`). */
  sync?(cursor: JsonObject | null, signal?: AbortSignal): Promise<SyncResult>;
  health(): Promise<ConnectorHealth>;
}

export interface ConnectorFactory {
  entry: CatalogueEntry;
  create(record: ConnectorRecord, ctx: ConnectorContext): Connector;
}
