import { type Static, Type } from "@sinclair/typebox";
import { Id, IsoDateTime, JsonObject, Nullable, StringEnum, Usage } from "../common.ts";
import { AutomationTrigger, WorkflowEvent } from "./workflows.ts";

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
    /**
     * Where the secret lives (G9 / G10 / G11): the vault database, the system keychain, or an
     * external manager (1Password, Bitwarden) read at fill time.
     */
    backend: Type.Optional(StringEnum(["vault", "keychain", "1password", "bitwarden"])),
    /**
     * Gateway-owned items (#511): who manages the item and where in Settings it is removed.
     * `removable` says whether `vault.delete` takes it; when false, remove it through `setting`
     * (a provider key in Models, a channel token in Channels, a connector's token by
     * disconnecting it). Absent for items the owner created in the vault.
     */
    managedBy: Type.Optional(
      Type.Object({
        kind: StringEnum(["connector", "model_provider", "channel", "external_manager"]),
        setting: StringEnum(["connectors", "models", "channels", "credentials"]),
        removable: Type.Boolean(),
      }),
    ),
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

/** A 1Password item reference (G10): names or ids, never a value. */
export const OnePasswordRef = Type.Object(
  {
    vault: Type.String({ minLength: 1, maxLength: 128 }),
    item: Type.String({ minLength: 1, maxLength: 128 }),
  },
  { $id: "OnePasswordRef" },
);
export type OnePasswordRef = Static<typeof OnePasswordRef>;

/** A Bitwarden item reference (G11): its id, or its exact name when that is unique. Never a value. */
export const BitwardenRef = Type.Object(
  {
    item: Type.String({ minLength: 1, maxLength: 128 }),
  },
  { $id: "BitwardenRef" },
);
export type BitwardenRef = Static<typeof BitwardenRef>;

/** One of the owner's Link payment methods, redacted (G12). */
export const LinkPaymentMethod = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 128 }),
    brand: Type.String(),
    last4: Type.String({ maxLength: 4 }),
    nickname: Nullable(Type.String()),
    isDefault: Type.Boolean(),
  },
  { $id: "LinkPaymentMethod" },
);
export type LinkPaymentMethod = Static<typeof LinkPaymentMethod>;

/** Brand / last4 of a card: the one-time Link card or its funding method. Never the number. */
const MaskedCard = Type.Object({ brand: Type.String(), last4: Type.String({ maxLength: 4 }) });

/**
 * One Stripe Link spend (security §4.9) with the merchant's side of it: hold, capture, refund,
 * decline. Amounts are minor units. No card number, CVC or token ever appears here.
 */
export const VaultPayment = Type.Object(
  {
    spendRequestId: Type.String(),
    merchantName: Type.String(),
    merchantHost: Type.String(),
    amount: Type.Integer({ minimum: 0 }),
    currency: Type.String({ minLength: 3, maxLength: 3 }),
    /** Link's spend-request status: created … approved, succeeded, failed, denied, expired, canceled. */
    status: Type.String(),
    payment: Type.Object({
      state: StringEnum([
        "none",
        "held",
        "captured",
        "partially_refunded",
        "refunded",
        "declined",
        "released",
      ]),
      held: Type.Integer({ minimum: 0 }),
      captured: Type.Integer({ minimum: 0 }),
      refunded: Type.Integer({ minimum: 0 }),
    }),
    card: Nullable(MaskedCard),
    fundingSource: Nullable(MaskedCard),
    /** Merchant references: holdRef, orderNumber, merchantConfirmation, refundRef, declineCode. */
    refs: Type.Record(Type.String(), Type.String()),
    approvalId: Id,
    taskId: Nullable(Id),
    createdAt: IsoDateTime,
  },
  { $id: "VaultPayment" },
);
export type VaultPayment = Static<typeof VaultPayment>;

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
/** One action row of a connector (Permissions → connector matrix, M11). */
export const ConnectorCatalogueAction = Type.Object(
  {
    id: Type.String(),
    title: Type.String(),
    sideEffect: Type.String(),
    approvalKind: Type.Optional(Type.String()),
    defaultRule: StringEnum(["allow", "ask", "deny"]),
  },
  { $id: "ConnectorCatalogueAction" },
);

/** A directory row (M4 data): first-party connectors, remote MCP presets, custom. */
export const ConnectorCatalogueEntry = Type.Object(
  {
    type: Type.String(),
    id: Type.String(),
    label: Type.String(),
    description: Type.String(),
    category: Type.String(),
    vendor: Type.String(),
    auth: Type.String(),
    scopes: Type.Object({ read: Type.Array(Type.String()), read_act: Type.Array(Type.String()) }),
    actions: Type.Array(ConnectorCatalogueAction),
    remote: Type.Optional(
      Type.Object({
        url: Type.String(),
        transport: Type.Literal("http"),
        readOnlyUrl: Type.Optional(Type.String()),
      }),
    ),
    setupGuide: Type.Optional(Type.String()),
    docsUrl: Type.Optional(Type.String()),
    available: Type.Boolean(),
    /** False when the Gateway lacks what connecting needs (e.g. no OAuth client id configured). */
    configured: Type.Optional(Type.Boolean()),
  },
  { $id: "ConnectorCatalogueEntry" },
);
export type ConnectorCatalogueEntry = Static<typeof ConnectorCatalogueEntry>;

/**
 * A sign-in the owner has to finish elsewhere: the consent page to open (Google's, Microsoft's)
 * or a device code to enter. `connectors.connect` returns it at once; the connector turns
 * `connected` (or `error`) later, announced by `connectors.updated`.
 */
export const ConnectorAuthorization = Type.Object(
  {
    url: Type.String({ description: "https consent page, or the device-code verification page" }),
    userCode: Type.Optional(Type.String({ description: "Device code flow: the code to enter" })),
    expiresAt: Type.Integer({ minimum: 0, description: "Epoch ms" }),
    /** True when the Gateway already opened `url` in the owner's browser on its machine. */
    opened: Type.Boolean(),
  },
  { $id: "ConnectorAuthorization" },
);
export type ConnectorAuthorization = Static<typeof ConnectorAuthorization>;

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

/** Data model §8 `identities`: one person across channels (`identityLinks`, designated persons). */
export const ChannelIdentity = Type.Object(
  {
    id: Id,
    display: Type.String(),
    links: Type.Array(Type.String({ description: '"<channel>:<senderId>"' }), {
      description: "Sender ids merged into this identity",
    }),
    delegatedPersona: Nullable(Type.String({ description: "Persona overlay name (feature N10)" })),
    toolAllow: Nullable(Type.Array(Type.String(), { description: "Tool name globs" })),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
  },
  { $id: "ChannelIdentity" },
);
export type ChannelIdentity = Static<typeof ChannelIdentity>;

export const AutomationKind = StringEnum(
  ["cron", "interval", "watch", "heartbeat", "briefing", "reminder", "event"],
  {
    $id: "AutomationKind",
    description:
      "`reminder` is a one-shot: `schedule` is an ISO-8601 instant. `event` runs on its `trigger` (mail and meeting workflows §4.7), and its `schedule` is empty",
  },
);
export type AutomationKind = Static<typeof AutomationKind>;

export const Delivery = Type.Object(
  {
    thread: Type.Optional(Id),
    channel: Type.Optional(Id),
    webhook: Type.Optional(Type.String()),
    none: Type.Optional(Type.Boolean()),
  },
  { $id: "Delivery" },
);

/** Data model §8 `watches`: what a `watch` automation checks (feature O3). */
export const WatchCheck = StringEnum(["change", "text_present", "price_below", "price_above"], {
  $id: "WatchCheck",
});
export type WatchCheck = Static<typeof WatchCheck>;

export const WatchConfig = Type.Object(
  {
    url: Type.String({ minLength: 1 }),
    check: WatchCheck,
    selector: Type.Optional(
      Type.String({
        maxLength: 200,
        description: "Literal marker (not a regex); the check reads the text after it",
      }),
    ),
    text: Type.Optional(Type.String({ description: "text_present: the text to look for" })),
    threshold: Type.Optional(Type.Number({ description: "price_below / price_above" })),
  },
  { $id: "WatchConfig" },
);
export type WatchConfig = Static<typeof WatchConfig>;

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
    watch: Type.Optional(WatchConfig),
    lightContext: Type.Optional(
      Type.Boolean({ description: "Heartbeat: skip workspace bootstrap files (feature O2)" }),
    ),
    /** `kind: "event"`: what starts a run (docs/workflows/mail-and-meetings-2026.md §4.7). */
    trigger: Type.Optional(AutomationTrigger),
    /** Run each occurrence as a background specialist job (docs/agent/specialists-2026.md §4.10). */
    specialist: Type.Optional(
      Type.Object({
        role: Type.String({ minLength: 1, maxLength: 64 }),
        budget: Type.Optional(
          Type.Object({
            tokens: Type.Optional(Type.Integer({ minimum: 1 })),
            costUsd: Type.Optional(Type.Number({ minimum: 0 })),
            minutes: Type.Optional(Type.Integer({ minimum: 1 })),
          }),
        ),
        deliver: Type.Optional(StringEnum(["inbox", "thread"])),
      }),
    ),
  },
  { $id: "Automation" },
);
export type Automation = Static<typeof Automation>;

/** Data model §8 `automation_runs`: one launched run (history, `automation.run.*`). */
export const AutomationRunStatus = StringEnum(
  ["running", "done", "no_reply", "failed", "cancelled", "skipped"],
  { $id: "AutomationRunStatus" },
);
export type AutomationRunStatus = Static<typeof AutomationRunStatus>;

export const AutomationRun = Type.Object(
  {
    id: Id,
    automationId: Id,
    threadId: Nullable(Id),
    taskId: Nullable(Id),
    trigger: StringEnum(["schedule", "manual", "event"]),
    scheduledFor: IsoDateTime,
    coalesced: Type.Integer({ minimum: 1, description: "Missed ticks folded into this run" }),
    startedAt: IsoDateTime,
    endedAt: Nullable(IsoDateTime),
    status: AutomationRunStatus,
    summary: Nullable(Type.String()),
    notificationId: Nullable(Id),
    /** `trigger: "event"`: the events folded into this run (`coalesced` counts them). */
    events: Type.Optional(Type.Array(WorkflowEvent, { maxItems: 200 })),
    /** The agent run that did the work (its trace: `runs.get`). */
    runId: Nullable(Id),
    usage: Type.Optional(Usage),
  },
  { $id: "AutomationRun" },
);
export type AutomationRun = Static<typeof AutomationRun>;

/** One row of the Upcoming view (feature O4): everything that will run, with its next time. */
export const UpcomingItem = Type.Object(
  {
    kind: StringEnum(["automation", "reminder", "briefing", "heartbeat", "watch", "input_request"]),
    id: Id,
    title: Type.String(),
    nextRunAt: Nullable(IsoDateTime),
    enabled: Type.Boolean(),
    automationId: Type.Optional(Id),
    taskId: Type.Optional(Id),
    schedule: Type.Optional(Type.String()),
    timezone: Type.Optional(Type.String()),
    /** Event automations: what starts them ("On new mail from Dana"), with no next time. */
    trigger: Type.Optional(AutomationTrigger),
    lastRunAt: Type.Optional(Nullable(IsoDateTime)),
  },
  { $id: "UpcomingItem" },
);
export type UpcomingItem = Static<typeof UpcomingItem>;
