import { type Static, Type } from "@sinclair/typebox";
import { Id, IsoDateTime, JsonObject, Nullable, StringEnum } from "../common.ts";

/** Data model §6 — metadata mirror only; secrets never cross the protocol. */
export const CredentialKind = StringEnum(
  ["login", "api_key", "oauth_token", "ssh_key", "note", "payment_link", "signing_key"],
  { $id: "CredentialKind" },
);
export type CredentialKind = Static<typeof CredentialKind>;

export const CredentialBinding = Type.Union(
  [
    Type.Object({ origin: Type.String() }),
    Type.Object({ host: Type.String() }),
    Type.Object({ connector: Type.String() }),
  ],
  { $id: "CredentialBinding" },
);
export type CredentialBinding = Static<typeof CredentialBinding>;

export const CredentialMeta = Type.Object(
  {
    id: Id,
    kind: CredentialKind,
    name: Type.String(),
    slug: Type.String({ pattern: "^[a-z0-9][a-z0-9-]*$" }),
    bindings: Type.Array(CredentialBinding),
    ownerConnectorId: Nullable(Id),
    lastUsedAt: Nullable(IsoDateTime),
    useCount: Type.Integer({ minimum: 0 }),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
  },
  { $id: "CredentialMeta" },
);
export type CredentialMeta = Static<typeof CredentialMeta>;

/** Data model §6 `credential_uses`: one row per resolve attempt, never a value (feature G14). */
export const CredentialUse = Type.Object(
  {
    id: Id,
    credentialId: Id,
    taskId: Nullable(Id),
    approvalId: Nullable(Type.String()),
    executor: StringEnum(["browser", "connector", "sandbox", "ssh"]),
    /** Origin or host. */
    target: Type.String(),
    outcome: StringEnum(["filled", "denied", "failed"]),
    /** Denial reason (`target_mismatch`, `approval_expired`, …) when not filled. */
    reason: Nullable(Type.String()),
    createdAt: IsoDateTime,
  },
  { $id: "CredentialUse" },
);
export type CredentialUse = Static<typeof CredentialUse>;

/** Key slot that unlocks the vault (security §4.2). */
export const VaultKeySlot = StringEnum(["keychain", "safe_storage", "key_file", "recovery"], {
  $id: "VaultKeySlot",
});
export type VaultKeySlot = Static<typeof VaultKeySlot>;

export const VaultStatus = Type.Object(
  {
    state: StringEnum(["uninitialized", "locked", "unlocked"]),
    /** Slots present on disk. */
    slots: Type.Array(VaultKeySlot),
    /** The owner confirmed the recovery key is stored (setup is incomplete until then). */
    recoveryConfirmed: Type.Boolean(),
    autoLockMinutes: Type.Integer({ minimum: 1 }),
    /** When the idle timer locks the vault, if unlocked. */
    lockAt: Nullable(IsoDateTime),
    itemCount: Type.Integer({ minimum: 0 }),
  },
  { $id: "VaultStatus" },
);
export type VaultStatus = Static<typeof VaultStatus>;

/**
 * Secret part of a vault item, client → Gateway only (add / edit). Results and events never
 * carry it. Fields per data model §6 `items.secret`.
 */
export const CredentialSecretInput = Type.Object(
  {
    username: Type.Optional(Type.String()),
    password: Type.Optional(Type.String()),
    /** TOTP seed (base32 or an `otpauth://` URI); `.totp` resolves to the current code. */
    totpSecret: Type.Optional(Type.String()),
    token: Type.Optional(Type.String()),
    /** Header the token is sent in (`Authorization`, `X-Api-Key`). Not secret. */
    headerName: Type.Optional(Type.String()),
    /** Prefix before the token in the header value, e.g. `Bearer `. Not secret. */
    headerPrefix: Type.Optional(Type.String()),
    privateKey: Type.Optional(Type.String()),
    text: Type.Optional(Type.String()),
  },
  { $id: "CredentialSecretInput", additionalProperties: false },
);
export type CredentialSecretInput = Static<typeof CredentialSecretInput>;

/** Data model §8. */
export const ConnectorStatus = StringEnum(["connected", "disconnected", "error", "needs_auth"], {
  $id: "ConnectorStatus",
});

export const ActionRule = StringEnum(["allow", "ask", "deny"], { $id: "ActionRule" });

export const Connector = Type.Object(
  {
    id: Id,
    type: Type.String({
      description:
        "google | microsoft | imap | jmap | stripe_link | mcp | apple:<app> | search:<provider>",
    }),
    label: Type.String(),
    account: Nullable(Type.String()),
    scopes: Type.Array(Type.String()),
    scopeMode: StringEnum(["read", "read_act"]),
    actionMatrix: Type.Record(Type.String(), ActionRule),
    credentialId: Nullable(Id),
    status: ConnectorStatus,
    config: JsonObject,
    lastSync: Nullable(JsonObject),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
  },
  { $id: "Connector" },
);
export type Connector = Static<typeof Connector>;

export const ChannelType = StringEnum(
  ["webchat", "telegram", "imessage", "whatsapp", "signal", "slack", "discord", "email", "sms"],
  { $id: "ChannelType" },
);
export type ChannelType = Static<typeof ChannelType>;

export const DmPolicy = StringEnum(["pairing", "allowlist", "open", "disabled"], {
  $id: "DmPolicy",
});
export type DmPolicy = Static<typeof DmPolicy>;

export const Channel = Type.Object(
  {
    id: Id,
    type: ChannelType,
    account: Type.String(),
    dmPolicy: DmPolicy,
    allowFrom: Type.Array(Type.String()),
    groupAllowFrom: Type.Array(Type.String()),
    requireMention: Type.Boolean(),
    ownerIds: Type.Array(Type.String()),
    dmScope: StringEnum(["main", "per-peer", "per-channel-peer"]),
    nodeId: Nullable(Id),
    status: StringEnum(["active", "paused", "error", "disconnected"]),
    config: JsonObject,
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
  },
  { $id: "Channel" },
);
export type Channel = Static<typeof Channel>;

export const AutomationKind = StringEnum(["cron", "interval", "watch", "heartbeat", "briefing"], {
  $id: "AutomationKind",
});

export const Delivery = Type.Object(
  {
    thread: Type.Optional(Id),
    channel: Type.Optional(Id),
    webhook: Type.Optional(Type.String()),
    none: Type.Optional(Type.Boolean()),
  },
  { $id: "Delivery" },
);

export const Automation = Type.Object(
  {
    id: Id,
    kind: AutomationKind,
    title: Type.String(),
    schedule: Type.String({ description: "cron expression, ISO-8601 duration or watch interval" }),
    timezone: Type.String(),
    sessionTarget: Type.String({ description: "main | isolated | named:<id>" }),
    delivery: Delivery,
    prompt: Type.String(),
    scratch: Nullable(Type.String()),
    enabled: Type.Boolean(),
    nextRunAt: Nullable(IsoDateTime),
    lastRunAt: Nullable(IsoDateTime),
    lastStatus: Nullable(Type.String()),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
  },
  { $id: "Automation" },
);
export type Automation = Static<typeof Automation>;
