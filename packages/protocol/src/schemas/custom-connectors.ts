import { type Static, Type } from "@sinclair/typebox";
import { Id, StringEnum } from "../common.ts";

/**
 * Custom connectors (feature M9; security §4.5, §11): a declarative REST connector the agent may
 * draft and only the owner may enable. The manifest is the whole connector: no code runs, the
 * Gateway's executor turns each tool call into one HTTPS request to an allowlisted host, with
 * the credential resolved from the vault (`{{cred:slug}}`) and never shown to the model.
 * Installing opens the same device-only `skill_install` trust card as skills and plugins, with
 * `details.kind: "connector"`.
 */

/** `{{cred:slug}}` or `{{cred:slug.field}}` (security §4.5). */
export const CredentialPlaceholder = Type.String({
  pattern: "^\\{\\{cred:[a-z0-9][a-z0-9-]{0,63}(\\.(username|password|totp|token|header))?\\}\\}$",
  description: "A vault placeholder; the value is resolved only inside the executor",
});

export const CustomConnectorAuth = Type.Union(
  [
    Type.Object({ kind: Type.Literal("none") }),
    Type.Object({ kind: Type.Literal("bearer"), credential: CredentialPlaceholder }),
    Type.Object({
      kind: Type.Literal("header"),
      name: Type.String({ pattern: "^[A-Za-z][A-Za-z0-9-]{0,63}$" }),
      credential: CredentialPlaceholder,
    }),
    Type.Object({
      kind: Type.Literal("query"),
      name: Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_.-]{0,63}$" }),
      credential: CredentialPlaceholder,
    }),
    Type.Object({
      kind: Type.Literal("basic"),
      credential: CredentialPlaceholder,
      description: Type.Optional(Type.String({ description: "Login item: username + password" })),
    }),
  ],
  { $id: "CustomConnectorAuth" },
);
export type CustomConnectorAuth = Static<typeof CustomConnectorAuth>;

export const CustomConnectorParam = Type.Object(
  {
    name: Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_.-]{0,63}$" }),
    in: StringEnum(["path", "query", "body"]),
    required: Type.Optional(Type.Boolean()),
    /** JSON Schema of the value (string, number, integer, boolean, array, object). */
    schema: Type.Record(Type.String(), Type.Unknown()),
    description: Type.Optional(Type.String({ maxLength: 1000 })),
  },
  { $id: "CustomConnectorParam" },
);
export type CustomConnectorParam = Static<typeof CustomConnectorParam>;

export const CustomConnectorTool = Type.Object(
  {
    name: Type.String({ pattern: "^[a-z][a-z0-9_]{0,63}$" }),
    description: Type.String({ maxLength: 2000 }),
    method: StringEnum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    /** Path under `baseUrl` with `{name}` for path params, e.g. `/v1/items/{id}`. */
    path: Type.String({ pattern: "^/[A-Za-z0-9._~!$&'()*+,;=:@/{}%-]*$", maxLength: 500 }),
    params: Type.Array(CustomConnectorParam, { maxItems: 50 }),
    /** The tier the owner reviews: `read` tools run on the matrix, writes ask, destructive never allow. */
    sideEffect: StringEnum(["read", "write", "destructive"]),
    defaultRule: Type.Optional(StringEnum(["allow", "ask", "deny"])),
  },
  { $id: "CustomConnectorTool" },
);
export type CustomConnectorTool = Static<typeof CustomConnectorTool>;

export const CustomConnectorManifest = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    id: Type.String({ pattern: "^[a-z][a-z0-9-]{1,40}$" }),
    name: Type.String({ minLength: 1, maxLength: 100 }),
    description: Type.String({ maxLength: 2000 }),
    version: Type.String({ maxLength: 40 }),
    /** `https://api.example.com/v2`; requests go only here and to `hosts`. */
    baseUrl: Type.String({ pattern: "^https://" }),
    /** Exact hostnames requests and redirects may reach (`baseUrl`'s host included). */
    hosts: Type.Array(Type.String({ pattern: "^[a-z0-9.-]+$" }), { minItems: 1, maxItems: 10 }),
    auth: CustomConnectorAuth,
    tools: Type.Array(CustomConnectorTool, { minItems: 1, maxItems: 50 }),
    /** Where the draft came from (shown on the card). */
    source: Type.Optional(
      Type.Object({
        kind: StringEnum(["openapi", "declarative"]),
        title: Type.Optional(Type.String({ maxLength: 200 })),
        drafted: Type.Optional(StringEnum(["owner", "agent"])),
      }),
    ),
  },
  { $id: "CustomConnectorManifest" },
);
export type CustomConnectorManifest = Static<typeof CustomConnectorManifest>;

/** A staged custom connector; the trust card shows `text` (the canonical manifest) in full. */
export const CustomConnectorProposal = Type.Object(
  {
    id: Id,
    kind: Type.Literal("connector"),
    approvalKind: Type.Literal("skill_install"),
    manifest: CustomConnectorManifest,
    /** Canonical JSON of the manifest, pretty-printed: exactly what the hash covers. */
    text: Type.String(),
    /** `sha256:` of the canonical manifest (the binding's `treeHash`). */
    hash: Type.String(),
    findings: Type.Array(
      Type.Object({
        rule: Type.String(),
        severity: StringEnum(["info", "warn", "high"]),
        message: Type.String(),
      }),
    ),
    scopeMode: StringEnum(["read", "read_act"]),
    bindingHash: Type.String(),
    grantKey: Type.String(),
    expiresAt: Type.Integer({ minimum: 0, description: "Epoch ms" }),
    update: Type.Optional(
      Type.Object({
        fromHash: Type.String(),
        diff: Type.String({ description: "Line diff of `text`" }),
      }),
    ),
  },
  { $id: "CustomConnectorProposal" },
);
export type CustomConnectorProposal = Static<typeof CustomConnectorProposal>;
