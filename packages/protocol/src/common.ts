import {
  Kind,
  type SchemaOptions,
  type Static,
  type TSchema,
  Type,
  TypeRegistry,
} from "@sinclair/typebox";

/**
 * A string enum emitted as `{ type: "string", enum: [...] }` so JSON Schema consumers
 * (quicktype → Swift `enum`, TypeScript unions) get a named, closed set instead of an
 * `anyOf` of literals. Registered as a custom TypeBox kind so `Value.Check` and
 * `TypeCompiler` validate it.
 */
export interface TStringEnum<T extends string = string> extends TSchema {
  [Kind]: "StringEnum";
  static: T;
  type: "string";
  enum: readonly T[];
}

TypeRegistry.Set("StringEnum", (schema: unknown, value: unknown) => {
  const s = schema as { enum: readonly string[] };
  return typeof value === "string" && s.enum.includes(value);
});

export function StringEnum<const T extends readonly string[]>(
  values: T,
  options: SchemaOptions = {},
): TStringEnum<T[number]> {
  return Type.Unsafe<T[number]>({
    ...options,
    [Kind]: "StringEnum",
    type: "string",
    enum: [...values],
  }) as TStringEnum<T[number]>;
}

/** `T | null | absent` — the wire shape of a nullable column. */
export function Nullable<T extends TSchema>(schema: T) {
  return Type.Optional(Type.Union([schema, Type.Null()]));
}

/** Identifier. ULIDs in production (`docs/04-data-model.md`); any non-empty string in tests. */
export const Id = Type.String({ minLength: 1, maxLength: 64, description: "ULID in production" });
export type Id = Static<typeof Id>;

/** Strict ULID, for validators that want it. */
export const Ulid = Type.String({ pattern: "^[0-7][0-9A-HJKMNP-TV-Z]{25}$", description: "ULID" });

/** ISO-8601 UTC timestamp, e.g. `2026-10-18T20:11:05Z` or with milliseconds. */
export const IsoDateTime = Type.String({
  pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,9})?(Z|[+-]\\d{2}:\\d{2})$",
  description: "ISO-8601 timestamp (UTC)",
});
export type IsoDateTime = Static<typeof IsoDateTime>;

/** `sha256:<hex>` digests used for binding hashes, content hashes and audit chains. */
export const Sha256 = Type.String({ pattern: "^sha256:[0-9a-f]{64}$" });
export type Sha256 = Static<typeof Sha256>;

/** `provider/model`, e.g. `anthropic/claude-sonnet-5-5` or `ollama/qwen3:8b`. */
export const ModelRef = Type.String({
  pattern: "^[a-z0-9][a-z0-9_.-]*/.+$",
  description: "provider/model",
});
export type ModelRef = Static<typeof ModelRef>;

/** Arbitrary JSON object (opaque payloads, JSON Schema documents, connector config). */
export const JsonObject = Type.Record(Type.String(), Type.Unknown(), {
  description: "JSON object",
});
export type JsonObject = Static<typeof JsonObject>;

/** A JSON Schema document (tool input schemas). Validated structurally, not semantically. */
export const JsonSchema = Type.Record(Type.String(), Type.Unknown(), {
  description: "JSON Schema",
});
export type JsonSchema = Static<typeof JsonSchema>;

// --- Vocabulary (architecture §4.3, §4.6; security §3.1) ---------------------------------------

/** Where content came from. Nothing `untrusted` is ever an instruction (security §3.6). */
export const Provenance = StringEnum(["owner", "agent", "untrusted", "system"], {
  $id: "Provenance",
});
export type Provenance = Static<typeof Provenance>;

/** How the owner gave an input when it was not typed or clicked: `voice` (voice-mode-2026 §4.6). */
export const InputVia = StringEnum(["voice"], { $id: "InputVia" });
export type InputVia = Static<typeof InputVia>;

/** Side-effect class every tool and node capability declares. */
export const SideEffect = StringEnum(["none", "read", "write", "destructive", "financial"], {
  $id: "SideEffect",
});
export type SideEffect = Static<typeof SideEffect>;

/** What a tool acts on; the Permission Broker canonicalizes the target per kind. */
export const TargetKind = StringEnum(["origin", "path", "account", "command", "recipient", "app"], {
  $id: "TargetKind",
});
export type TargetKind = Static<typeof TargetKind>;

/** Canonical target of a tool call or capability invocation. */
export const Target = Type.Object(
  {
    kind: TargetKind,
    value: Type.String({
      description: "Canonical form: origin, absolute path, account id, argv, recipient, bundle id",
    }),
    display: Type.Optional(Type.String({ description: "Human-readable form for cards and logs" })),
  },
  { $id: "Target" },
);
export type Target = Static<typeof Target>;

/** Provenance class a tool assigns to its results. */
export const ProvenanceOut = StringEnum(["trusted", "untrusted"], { $id: "ProvenanceOut" });
export type ProvenanceOut = Static<typeof ProvenanceOut>;

/** Thread permission mode (security §3.2). */
export const PermissionMode = StringEnum(["plan", "manual", "balanced", "auto"], {
  $id: "PermissionMode",
});
export type PermissionMode = Static<typeof PermissionMode>;

/** Broker decision. */
export const Decision = StringEnum(["allow", "ask", "deny"], { $id: "Decision" });
export type Decision = Static<typeof Decision>;

/** Grant scopes (architecture §4.6). `session` is stored as `always` with a session expiry. */
export const GrantScope = StringEnum(["once", "task", "site", "session", "always"], {
  $id: "GrantScope",
});
export type GrantScope = Static<typeof GrantScope>;

/** Device token scopes (security §10). Chosen by the owner, never declared by the client. */
export const DeviceScope = StringEnum(
  ["operator.read", "operator.write", "operator.approvals", "operator.admin", "node"],
  { $id: "DeviceScope" },
);
export type DeviceScope = Static<typeof DeviceScope>;

/** Delivery surfaces for approvals and notifications. Channel surfaces are `<channel>:<id>`. */
export const Surface = Type.String({
  description: '"desktop" | "notification" | "web" | "<channel>:<peerId>"',
  minLength: 1,
});
export type Surface = Static<typeof Surface>;

/** Token usage of one model call or one run (data model §2 `runs.usage`, §10 `usage`). */
export const Usage = Type.Object(
  {
    input: Type.Integer({ minimum: 0 }),
    output: Type.Integer({ minimum: 0 }),
    cacheRead: Type.Integer({ minimum: 0 }),
    cacheWrite: Type.Integer({ minimum: 0 }),
    reasoning: Type.Integer({ minimum: 0 }),
    costUsd: Type.Number({ minimum: 0 }),
  },
  { $id: "Usage" },
);
export type Usage = Static<typeof Usage>;

export const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  costUsd: 0,
};
