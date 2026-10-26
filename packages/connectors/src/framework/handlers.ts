import {
  Connector as ConnectorSchema,
  createValidator,
  defineMethod,
  type MethodSpec,
  PsycheError,
} from "@psyche/protocol";
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import type { ConnectorRegistry } from "./registry.ts";
import type { ConnectorRecord } from "./types.ts";

/**
 * `connectors.*` API handlers for the Gateway (S01 mounts them). `connectors.list` / `get` match
 * the methods already in packages/protocol; the others are proposed in docs/status/s09.md for
 * an additive `protocol:` PR and defined here with the same `defineMethod` shape meanwhile.
 * Handlers never return secrets: records hold placeholders and ids, tokens live in the vault.
 */
const Id = Type.String({ minLength: 1, maxLength: 128 });
const Rule = Type.Union([Type.Literal("allow"), Type.Literal("ask"), Type.Literal("deny")]);
const ScopeMode = Type.Union([Type.Literal("read"), Type.Literal("read_act")]);

const CatalogueAction = Type.Object({
  id: Type.String(),
  title: Type.String(),
  sideEffect: Type.String(),
  approvalKind: Type.Optional(Type.String()),
  defaultRule: Rule,
});
const CatalogueEntrySchema = Type.Object({
  type: Type.String(),
  id: Type.String(),
  label: Type.String(),
  description: Type.String(),
  category: Type.String(),
  vendor: Type.String(),
  auth: Type.String(),
  scopes: Type.Object({ read: Type.Array(Type.String()), read_act: Type.Array(Type.String()) }),
  actions: Type.Array(CatalogueAction),
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
});

export const CONNECTOR_METHODS = {
  "connectors.catalogue": defineMethod({
    params: Type.Object({}),
    result: Type.Object({ entries: Type.Array(CatalogueEntrySchema) }),
    scope: "operator.read",
    description: "Directory of connectors: first-party, remote MCP presets, coming soon.",
  }),
  "connectors.list": defineMethod({
    params: Type.Object({}),
    result: Type.Object({ connectors: Type.Array(ConnectorSchema) }),
    scope: "operator.read",
    description: "Lists configured connectors.",
  }),
  "connectors.get": defineMethod({
    params: Type.Object({ connectorId: Id }),
    result: Type.Object({ connector: ConnectorSchema }),
    scope: "operator.read",
    description: "Returns one connector.",
  }),
  "connectors.connect": defineMethod({
    params: Type.Object({
      catalogueId: Id,
      scopeMode: ScopeMode,
      label: Type.Optional(Type.String({ maxLength: 200 })),
      config: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      connectorId: Type.Optional(Id),
    }),
    result: Type.Object({ connector: ConnectorSchema }),
    scope: "operator.admin",
    sideEffecting: true,
    description: "Connects (or re-authorizes) a connector; runs its sign-in flow.",
  }),
  "connectors.disconnect": defineMethod({
    params: Type.Object({ connectorId: Id }),
    result: Type.Object({ connector: ConnectorSchema }),
    scope: "operator.admin",
    sideEffecting: true,
    description: "Disconnects, revokes tokens and invalidates pending work.",
  }),
  "connectors.status": defineMethod({
    params: Type.Object({ connectorId: Id }),
    result: Type.Object({
      ok: Type.Boolean(),
      status: Type.String(),
      detail: Type.Optional(Type.String()),
      checkedAt: Type.Number(),
    }),
    scope: "operator.read",
    description: "Health check of one connector.",
  }),
  "connectors.setMatrix": defineMethod({
    params: Type.Object({ connectorId: Id, matrix: Type.Record(Type.String(), Rule) }),
    result: Type.Object({ connector: ConnectorSchema }),
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Sets allow / ask / deny per action; destructive and financial actions refuse allow.",
  }),
  "connectors.configure": defineMethod({
    params: Type.Object({ connectorId: Id, config: Type.Record(Type.String(), Type.Unknown()) }),
    result: Type.Object({ connector: ConnectorSchema }),
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Merges non-secret settings into a connector's config (null removes a key) without reconnecting it.",
  }),
} as const;

export type ConnectorMethodName = keyof typeof CONNECTOR_METHODS;
type Params<M extends ConnectorMethodName> = Static<(typeof CONNECTOR_METHODS)[M]["params"]>;
type Result<M extends ConnectorMethodName> = Static<(typeof CONNECTOR_METHODS)[M]["result"]>;
export type ConnectorHandlers = {
  [M in ConnectorMethodName]: (params: unknown) => Promise<Result<M>>;
};

/** Protocol `Connector` shape of a record (the schemas are the same fields, camelCase). */
export function toWire(record: ConnectorRecord): Static<typeof ConnectorSchema> {
  return {
    id: record.id,
    type: record.type,
    label: record.label,
    account: record.account,
    scopes: record.scopes,
    scopeMode: record.scopeMode,
    actionMatrix: record.actionMatrix,
    credentialId: record.credentialId,
    status: record.status,
    config: record.config,
    lastSync: record.lastSync,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function validated<M extends ConnectorMethodName>(name: M, params: unknown): Params<M> {
  const spec = CONNECTOR_METHODS[name] as MethodSpec<TSchema, TSchema>;
  const v = createValidator(spec.params);
  const value = params ?? {};
  if (!v.check(value)) {
    throw new PsycheError("invalid_params", `${name}: ${v.errors(value).join("; ")}`);
  }
  return value as Params<M>;
}

export function connectorHandlers(registry: ConnectorRegistry): ConnectorHandlers {
  return {
    "connectors.catalogue": async (p) => {
      validated("connectors.catalogue", p);
      return { entries: registry.catalogue() as Result<"connectors.catalogue">["entries"] };
    },
    "connectors.list": async (p) => {
      validated("connectors.list", p);
      return { connectors: (await registry.list()).map(toWire) };
    },
    "connectors.get": async (p) => ({
      connector: toWire(await registry.get(validated("connectors.get", p).connectorId)),
    }),
    "connectors.connect": async (p) => {
      const v = validated("connectors.connect", p);
      const record = await registry.connect({
        catalogueId: v.catalogueId,
        scopeMode: v.scopeMode,
        ...(v.label === undefined ? {} : { label: v.label }),
        ...(v.config === undefined ? {} : { config: v.config }),
        ...(v.connectorId === undefined ? {} : { connectorId: v.connectorId }),
      });
      return { connector: toWire(record) };
    },
    "connectors.disconnect": async (p) => ({
      connector: toWire(
        await registry.disconnect(validated("connectors.disconnect", p).connectorId),
      ),
    }),
    "connectors.status": async (p) => {
      const h = await registry.status(validated("connectors.status", p).connectorId);
      return {
        ok: h.ok,
        status: h.status,
        checkedAt: h.checkedAt,
        ...("detail" in h && h.detail !== undefined ? { detail: h.detail } : {}),
      };
    },
    "connectors.setMatrix": async (p) => {
      const v = validated("connectors.setMatrix", p);
      return { connector: toWire(await registry.setMatrix(v.connectorId, v.matrix)) };
    },
    "connectors.configure": async (p) => {
      const v = validated("connectors.configure", p);
      return { connector: toWire(await registry.configure(v.connectorId, v.config)) };
    },
  };
}
