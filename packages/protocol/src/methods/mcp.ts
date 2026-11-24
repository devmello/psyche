import { type Static, Type } from "@sinclair/typebox";
import { Id, Nullable, StringEnum } from "../common.ts";
import { ApprovalRequest } from "../schemas/permissions.ts";
import { defineMethod, OkResult } from "./define.ts";

/**
 * `mcp.*` (architecture §4.9; security §11 "MCP servers"): how the Gateway runs MCP servers, for
 * `psyche security audit` and Settings. Server configs themselves live in the `mcp.servers`
 * setting; this reports what the host made of them.
 */

export const McpServerStatus = Type.Object(
  {
    id: Type.String(),
    name: Type.String(),
    trust: StringEnum(["bundled", "verified", "unknown"]),
    transport: StringEnum(["stdio", "http"]),
    /** Reaches the network: a remote (http) server, or a stdio server with allowed domains. */
    network: Type.Boolean(),
    /** Its tools are registered (it connected). */
    connected: Type.Boolean(),
    /** Turned off by the owner (`mcp.setEnabled`): kept in the config, not running. Default on. */
    enabled: Type.Optional(Type.Boolean()),
    /**
     * The owner's word on whether this server moves money (`mcp.handlesMoney.set`): `true` makes
     * every tool a payment, `false` none; absent leaves it to the tool's name and description.
     */
    handlesMoney: Type.Optional(Type.Boolean()),
    /** Written by Psyche itself (its code is in `agent-connectors/<id>`); always tier `unknown`. */
    madeBy: Type.Optional(Type.Literal("psyche")),
    /** The agent-made server's version (from its manifest). */
    version: Type.Optional(Type.String()),
  },
  { $id: "McpServerStatus" },
);
export type McpServerStatus = Static<typeof McpServerStatus>;

/** A `{{cred:slug}}` vault placeholder; MCP server secrets are never sent or stored as values. */
const CredPlaceholder = Type.String({
  pattern: "^\\{\\{cred:[a-z0-9][a-z0-9-]{0,63}(\\.[a-z]+)?\\}\\}$",
});

/**
 * A server the owner adds from Settings → MCP (#529): a command (stdio, always sandboxed under
 * srt or in its own container) or an HTTPS URL. Becomes one `mcp.servers` entry once its trust
 * card is approved.
 */
export const McpServerInput = Type.Object(
  {
    /** Stable id; tools register as `mcp__<id>__<tool>`. */
    id: Type.String({ pattern: "^[a-z][a-z0-9-]{1,40}$" }),
    name: Type.String({ minLength: 1, maxLength: 100 }),
    transport: Type.Union([
      Type.Object({
        kind: Type.Literal("stdio"),
        /** argv; no shell. */
        command: Type.Array(Type.String({ minLength: 1, maxLength: 1_000 }), {
          minItems: 1,
          maxItems: 64,
        }),
        /** Plain values or `{{cred:slug}}` placeholders (each read under its own approval). */
        env: Type.Optional(
          Type.Record(
            Type.String({ pattern: "^[A-Z_][A-Z0-9_]{0,63}$" }),
            Type.String({ maxLength: 4_000 }),
          ),
        ),
      }),
      Type.Object({
        kind: Type.Literal("http"),
        url: Type.String({ pattern: "^https://", maxLength: 2_000 }),
        /** Default: OAuth when the server asks for it, else none. */
        auth: Type.Optional(
          Type.Union([
            Type.Object({ kind: Type.Literal("none") }),
            Type.Object({ kind: Type.Literal("oauth") }),
            Type.Object({ kind: Type.Literal("bearer"), credential: CredPlaceholder }),
          ]),
        ),
      }),
    ]),
    /** Domains a stdio server may reach through the sandbox proxy; default none. */
    allowedDomains: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 253 }), { maxItems: 50 }),
    ),
  },
  { $id: "McpServerInput" },
);
export type McpServerInput = Static<typeof McpServerInput>;

/** One tool as the probe saw it. Name and description are written by the server: untrusted. */
export const McpProbedTool = Type.Object(
  {
    name: Type.String(),
    description: Type.String(),
    /** From the server's annotations (`readOnlyHint` / `destructiveHint`); `write` when absent. */
    sideEffect: StringEnum(["read", "write", "destructive"]),
    /** Findings from the description scan; a blocking one keeps the tool from the agent. */
    warnings: Type.Array(Type.Object({ code: Type.String(), detail: Type.String() })),
    /** Not offered to the agent (a blocking warning). */
    blocked: Type.Boolean(),
  },
  { $id: "McpProbedTool" },
);
export type McpProbedTool = Static<typeof McpProbedTool>;

/** What `mcp.probe` found, staged for `mcp.add` (expires after 30 minutes). */
export const McpProposal = Type.Object(
  {
    id: Id,
    server: McpServerInput,
    tools: Type.Array(McpProbedTool),
    /** The `tools/list` hash the trust card binds; `mcp.add` refuses a server whose list changed. */
    toolsListHash: Type.String(),
    /** Where it can reach: an HTTP server's origin, or a stdio server's allowed domains. */
    network: Type.Object({ reaches: Type.Boolean(), hosts: Type.Array(Type.String()) }),
    /** How the probe ran it: `srt`, `container`, or `remote` for an HTTP server. */
    isolation: StringEnum(["srt", "container", "remote"]),
    /** The server's stderr tail or error from the probe, redacted (untrusted). */
    diagnostics: Type.Optional(Type.String()),
    expiresAt: Type.Integer({ description: "Epoch ms" }),
  },
  { $id: "McpProposal" },
);
export type McpProposal = Static<typeof McpProposal>;

/** One tool of a configured server, with whether the agent is offered it. Words are the server's: untrusted. */
export const McpServerTool = Type.Object(
  {
    /** The server's own tool name (the agent sees it as `mcp__<server>__<tool>`). */
    name: Type.String(),
    description: Type.String(),
    /** From the server's annotations when it gave any (`readOnlyHint` / `destructiveHint`); a hint, not policy. */
    sideEffect: Type.Optional(StringEnum(["read", "write", "destructive"])),
    /** The owner has not turned it off (`mcp.tools.set`). */
    enabled: Type.Boolean(),
    /** Kept from the agent by a blocking description finding, whatever `enabled` says. */
    blocked: Type.Boolean(),
  },
  { $id: "McpServerTool" },
);
export type McpServerTool = Static<typeof McpServerTool>;

/**
 * One env variable (stdio) or the bearer token (http) of a server. Names and state only: a value
 * never leaves the Gateway.
 */
export const McpServerSecret = Type.Object(
  {
    /** The env variable, or `Authorization` for a remote server's bearer token. */
    name: Type.String(),
    /** Where its value is kept: the vault, or (an older or hand-edited config) in plain config. */
    storage: StringEnum(["vault", "config"]),
    /** A value exists: a vault item for a vault secret, a non-empty value for config. */
    isSet: Type.Boolean(),
  },
  { $id: "McpServerSecret" },
);
export type McpServerSecret = Static<typeof McpServerSecret>;

/**
 * What the owner may change on a server already added (`mcp.update`). Every field is optional and
 * is applied on top of the stored config by the Gateway, which decides whether the result needs a
 * trust card by comparing it with what is stored; the caller never says so. A server's kind
 * (command or URL) does not change: remove it and add another.
 */
export const McpServerChanges = Type.Object(
  {
    /** The display name: the only change that applies without a trust card. */
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    /** A command server's argv (command and arguments). */
    command: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 1_000 }), { minItems: 1, maxItems: 64 }),
    ),
    /** Env variables to set (plain value or a `{{cred:slug}}` placeholder) or, with null, remove. */
    env: Type.Optional(
      Type.Record(
        Type.String({ pattern: "^[A-Z_][A-Z0-9_]{0,63}$" }),
        Nullable(Type.String({ maxLength: 4_000 })),
      ),
    ),
    /** A URL server's address. */
    url: Type.Optional(Type.String({ pattern: "^https://", maxLength: 2_000 })),
    /** A URL server's authentication. */
    auth: Type.Optional(
      Type.Union([
        Type.Object({ kind: Type.Literal("none") }),
        Type.Object({ kind: Type.Literal("oauth") }),
        Type.Object({ kind: Type.Literal("bearer"), credential: CredPlaceholder }),
      ]),
    ),
    /** A command server's allowed domains (replaces the list). */
    allowedDomains: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 253 }), { maxItems: 50 }),
    ),
  },
  { $id: "McpServerChanges" },
);
export type McpServerChanges = Static<typeof McpServerChanges>;

/**
 * A server's config as the edit form shows it: what runs and where it connects. Secrets are
 * names only (`mcp.secrets` says whether each is set); plain env values are not echoed either.
 */
export const McpServerConfigView = Type.Object(
  {
    id: Type.String(),
    name: Type.String(),
    kind: StringEnum(["command", "url"]),
    command: Type.Optional(Type.Array(Type.String())),
    url: Type.Optional(Type.String()),
    allowedDomains: Type.Array(Type.String()),
    envNames: Type.Array(Type.String()),
    auth: Type.Optional(StringEnum(["none", "oauth", "bearer"])),
    /** False for a Psyche-made or shared server and a built-in one: only its name can change. */
    editable: Type.Boolean(),
  },
  { $id: "McpServerConfigView" },
);
export type McpServerConfigView = Static<typeof McpServerConfigView>;

const ServerId = Type.String({ minLength: 1, maxLength: 64 });

/** One file of an agent-made server's code, as the owner sees it. */
export const SelfConnectorFile = Type.Object(
  {
    /** Relative, `/`-separated, no `..`. */
    path: Type.String(),
    content: Type.String(),
    bytes: Type.Integer({ minimum: 0 }),
  },
  { $id: "SelfConnectorFile" },
);
export type SelfConnectorFile = Static<typeof SelfConnectorFile>;

/**
 * An MCP App (a `ui://` resource a tool declares): HTML the server wrote, so untrusted data that
 * only ever renders in the artifact sandbox (generative-ui-2026 P9). It carries no way back: the
 * frame has no network, no tool channel and no storage; the declared CSP and permissions are
 * shown to the owner, never granted.
 */
export const McpApp = Type.Object(
  {
    serverId: Type.String(),
    uri: Type.String(),
    html: Type.String(),
    csp: Type.Record(Type.String(), Type.Unknown()),
    permissions: Type.Record(Type.String(), Type.Unknown()),
    provenance: Type.Literal("untrusted"),
  },
  { $id: "McpApp" },
);
export type McpApp = Static<typeof McpApp>;

export const McpMethods = {
  "mcp.app": defineMethod({
    params: Type.Object({
      tool: Type.String({
        minLength: 1,
        maxLength: 200,
        description: "The tool's name as the transcript shows it (mcp__<server>__<tool>)",
      }),
    }),
    result: Type.Object(
      {
        available: Type.Boolean({
          description: "False when the tool declares no app, is off, or its server is not running",
        }),
        app: Type.Optional(McpApp),
      },
      { $id: "McpAppResult" },
    ),
    scope: "operator.read",
    description:
      "The MCP App (ui:// resource) the named tool declares, read from its own running server: only a resource that server's pinned tools declare is served, never a URI from the caller. The HTML is server-authored and untrusted: render it only in the artifact sandbox, after the owner chooses to run it. It cannot call tools or read anything else.",
  }),
  "mcp.app.call": defineMethod({
    params: Type.Object(
      {
        toolCallId: Id,
        name: Type.String({
          pattern: "^[A-Za-z0-9_-]{1,64}$",
          description: "The server's own tool name, without the mcp__<server>__ prefix",
        }),
        arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      },
      { additionalProperties: false },
    ),
    result: Type.Object(
      {
        isError: Type.Boolean(),
        output: Type.Unknown({
          description: "What the tool returned (blocks and structured data)",
        }),
      },
      { $id: "McpAppCallResult" },
    ),
    scope: "operator.write",
    sideEffecting: true,
    description:
      "A tool call an MCP App panel makes for its page (generative-ui-2026 P9). The server is never named by the caller: it is the server of the transcript tool call that showed the app (toolCallId), so an app can only call its own server's tools, never another server's or a Psyche tool. The call is recorded in that chat as a from-widget message with the tool and every argument, then gated exactly like a model's call: the Permission Broker with the server's allow/ask/deny rules, an approval card for ask rows, money-intent checks and a receipt for writes. The app's arguments are untrusted: the turn is tainted (source mcp_app), so a card shows the taint banner and a standing grant never approves a write the app asked for unless the existing rules already allow it. Returns the tool's result when the call finishes (after the owner's tap, when it asks); a refusal comes back as isError. conflict when the chat is busy.",
  }),
  "mcp.status": defineMethod({
    params: Type.Object({}),
    result: Type.Object({
      /**
       * How stdio servers are isolated: `srt` (sandbox-runtime), `container` (each in its own
       * sandbox container), `vm` (in the sandbox guest: the sandbox PC on Windows) or `none` (no
       * launcher: non-bundled stdio servers are refused, never run bare).
       */
      launcher: StringEnum(["srt", "container", "vm", "none"]),
      servers: Type.Array(McpServerStatus),
    }),
    scope: "operator.read",
    description:
      "The MCP launcher in use and each configured server's trust, transport and network reach.",
  }),
  "mcp.probe": defineMethod({
    params: Type.Object({ server: McpServerInput }),
    result: Type.Object(
      { proposal: McpProposal, approval: ApprovalRequest },
      { $id: "McpProbeResult" },
    ),
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Side-effecting: starts the server sandboxed (srt or a container; never bare), lists its tools without registering them, stops it, and opens a device-only skill_install trust card (details.kind mcp_server) with the tools and network reach. unavailable when no sandbox launcher exists for a stdio server; conflict when the id is taken.",
  }),
  "mcp.add": defineMethod({
    params: Type.Object({ proposalId: Id, approvalId: Id }),
    result: Type.Object({ server: McpServerStatus }),
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Side-effecting: adds a probed server to mcp.servers with its approved trust card; approval_required without it, conflict when its tools changed since the probe.",
  }),
  "mcp.remove": defineMethod({
    params: Type.Object({ serverId: Type.String({ minLength: 1, maxLength: 64 }) }),
    result: OkResult,
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Side-effecting: removes a server from mcp.servers; its tools unregister and its grants are revoked.",
  }),
  "mcp.config": defineMethod({
    params: Type.Object({ serverId: ServerId }),
    result: Type.Object({ config: McpServerConfigView }, { $id: "McpConfigResult" }),
    scope: "operator.admin",
    description:
      "A configured server's command or URL, allowed domains and env variable names, to prefill the edit form. Admin only because arguments are the owner's own text. Never a secret value. not_found for an unknown server.",
  }),
  "mcp.update": defineMethod({
    params: Type.Object({ id: ServerId, changes: McpServerChanges }),
    result: Type.Object(
      {
        /** True when the change is already in effect (a display name, or nothing differed). */
        applied: Type.Boolean(),
        server: McpServerStatus,
        /** Set when the change needs approval: finish with `mcp.add { proposalId, approvalId }`. */
        proposal: Type.Optional(McpProposal),
        approval: Type.Optional(ApprovalRequest),
      },
      { $id: "McpUpdateResult" },
    ),
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Side-effecting: edits a server in place. A display name applies at once. Anything that changes what runs or where it connects (command, arguments, URL, auth, allowed domains, env names or secrets) is probed in the sandbox and opens the same device-only trust card as mcp.probe, showing the old and the new config; the old server keeps running until mcp.add with that approved card, which restarts it with the new config. Never applied silently. Not available for a Psyche-made, shared or built-in server (only its name). not_found for an unknown server; invalid_params when a field does not fit the server's kind.",
  }),
  "mcp.test": defineMethod({
    params: Type.Object({ id: ServerId }),
    result: Type.Object(
      {
        ok: Type.Boolean(),
        toolCount: Type.Integer({ minimum: 0 }),
        /** The server's own tool names (untrusted: render as data). */
        tools: Type.Array(Type.String()),
        /** Why it failed, redacted and shortened (untrusted). */
        error: Type.Optional(Type.String()),
      },
      { $id: "McpTestResult" },
    ),
    scope: "operator.admin",
    description:
      "Checks an added server with its approved config: asks the running server for its tools, or, when it is on but not connected, starts the stored config once in the sandbox and stops it. Changes no config, raises no trust card and takes no config from the caller. Admin because it can start a process. not_found for an unknown server; unavailable (reason paused or not_running) for a paused server or one the Gateway does not run.",
  }),
  "mcp.tools": defineMethod({
    params: Type.Object({ serverId: ServerId }),
    result: Type.Object(
      {
        tools: Type.Array(McpServerTool),
        /** False while the server is off or did not connect: there is no listing to show. */
        available: Type.Boolean(),
      },
      { $id: "McpToolsResult" },
    ),
    scope: "operator.read",
    description:
      "A configured server's tools (name, description, side effect when annotated) and whether each is offered to the agent. Descriptions are server-authored: render as data. not_found for an unknown server.",
  }),
  "mcp.tools.set": defineMethod({
    params: Type.Object({
      serverId: ServerId,
      tool: Type.String({ minLength: 1, maxLength: 200 }),
      enabled: Type.Boolean(),
    }),
    result: Type.Object({ tools: Type.Array(McpServerTool) }, { $id: "McpToolsSetResult" }),
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Side-effecting: offers a tool to the agent or withholds it (kept in the server's mcp.servers entry; the server keeps running and its grants stay). A tool the description scan blocked stays off. not_found for an unknown server or tool.",
  }),
  "mcp.handlesMoney.set": defineMethod({
    params: Type.Object({
      serverId: ServerId,
      /** `always`: every tool is a payment. `never`: none is. `auto`: judged by name and description. */
      mode: StringEnum(["auto", "always", "never"]),
      /** Fresh approval: the `policy_change` card from a first `approval_required` call (any mode but `always`). */
      approvalId: Type.Optional(Id),
    }),
    result: Type.Object({ server: McpServerStatus }, { $id: "McpHandlesMoneySetResult" }),
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Side-effecting: the owner's word on whether a server's tools move money. always: every tool is financial (Touch ID or the Mac password on each call); never: none is, whatever its tools are called; auto: judged by each tool's name and description. Changing it restarts the server. Anything but always lowers protection and first answers approval_required with a device-only policy_change card; the retry with its approvalId is spent once. not_found for an unknown server.",
  }),
  "mcp.setEnabled": defineMethod({
    params: Type.Object({ serverId: ServerId, enabled: Type.Boolean() }),
    result: Type.Object({ server: McpServerStatus }, { $id: "McpSetEnabledResult" }),
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Side-effecting: turns a server off without removing it (its tools unregister, it stops, its grants are revoked) or back on (it starts again; secrets ask for their own approval). not_found for an unknown server.",
  }),
  "mcp.secrets": defineMethod({
    params: Type.Object({ serverId: ServerId }),
    result: Type.Object({ secrets: Type.Array(McpServerSecret) }, { $id: "McpSecretsResult" }),
    scope: "operator.read",
    description:
      "The env variables and bearer token a server is configured with, by name, and whether each is set. Never a value. not_found for an unknown server.",
  }),
  "mcp.secrets.replace": defineMethod({
    params: Type.Object({
      serverId: ServerId,
      name: Type.String({ minLength: 1, maxLength: 64 }),
      value: Type.String({ minLength: 1, maxLength: 4_000 }),
    }),
    result: Type.Object({ secret: McpServerSecret }, { $id: "McpSecretsReplaceResult" }),
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Side-effecting: stores a new value for one of the server's env variables (or its bearer token) in the vault, bound to that server, and restarts the server so it takes effect. A value kept in plain config moves to the vault. The value travels client to Gateway only. not_found for an unknown server or name; unavailable while the vault is locked.",
  }),
  "mcp.files.read": defineMethod({
    params: Type.Object({ serverId: ServerId }),
    result: Type.Object(
      {
        files: Type.Array(SelfConnectorFile),
        version: Type.String(),
        runtime: StringEnum(["node", "python"]),
        entry: Type.String(),
        /** The code on disk no longer hashes to what the owner approved: the server does not start. */
        modified: Type.Boolean(),
      },
      { $id: "SelfConnectorFilesResult" },
    ),
    scope: "operator.read",
    description:
      "The code of an agent-made MCP server (madeBy psyche), read-only. not_found for an unknown server or one not made by Psyche.",
  }),
  "mcp.files.write": defineMethod({
    params: Type.Object({
      serverId: ServerId,
      path: Type.String({ minLength: 1, maxLength: 200 }),
      content: Type.String({ maxLength: 200_000 }),
    }),
    result: Type.Object(
      { proposal: McpProposal, approval: ApprovalRequest },
      { $id: "SelfConnectorFilesWriteResult" },
    ),
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Side-effecting: the owner edits one file of an agent-made server. The server stops (its code no longer matches the approved tree) until the change is approved on a device-only trust card showing the diff; approve it, then mcp.add with the returned proposal. invalid_params for a bad path or size; not_found for a server not made by Psyche.",
  }),
} as const;
