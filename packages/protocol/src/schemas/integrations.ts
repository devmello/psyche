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

export const AutomationKind = StringEnum(
  ["cron", "interval", "watch", "heartbeat", "briefing", "reminder"],
  {
    $id: "AutomationKind",
    description: "`reminder` is a one-shot: `schedule` is an ISO-8601 instant",
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
      Type.String({ description: "Regex over the fetched text; capture group 1 is the value" }),
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
    trigger: StringEnum(["schedule", "manual"]),
    scheduledFor: IsoDateTime,
    coalesced: Type.Integer({ minimum: 1, description: "Missed ticks folded into this run" }),
    startedAt: IsoDateTime,
    endedAt: Nullable(IsoDateTime),
    status: AutomationRunStatus,
    summary: Nullable(Type.String()),
    notificationId: Nullable(Id),
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
  },
  { $id: "UpcomingItem" },
);
export type UpcomingItem = Static<typeof UpcomingItem>;
