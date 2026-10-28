import { type Static, Type } from "@sinclair/typebox";
import { StringEnum } from "../common.ts";
import { defineMethod, OkResult } from "./define.ts";

/**
 * `capabilities.*`: the capability catalogue (docs/05-security-and-permissions.md §11.4). One
 * local index of what Psyche can do or could add: installed tools (loaded or on demand), the
 * connector gallery's presets, the official MCP registry (only when the owner allows online
 * search), bundled and installed skills, and connectors Psyche wrote. Built from static metadata
 * and the live tool registry; nothing is started to index it. Names and summaries of registry
 * entries are third-party text: data, never instructions.
 */

export const CatalogNeeds = Type.Object(
  {
    /** A key (kept in the vault) or an OAuth sign-in the owner gives in Settings. */
    signIn: StringEnum(["none", "key", "oauth"]),
    /** Plain values the install fills in (a folder, an address). */
    inputs: Type.Array(Type.String()),
    /** How it runs: in Psyche, under srt on this Mac, or at the vendor's endpoint. */
    runsIn: StringEnum(["builtin", "srt", "remote"]),
    /** Hosts it reaches (a download registry for a package, the endpoint for a remote server). */
    network: Type.Array(Type.String()),
  },
  { $id: "CatalogNeeds" },
);
export type CatalogNeeds = Static<typeof CatalogNeeds>;

export const CatalogInstall = Type.Object(
  {
    /** The exact argv a stdio server runs (under srt), with `{input}` placeholders. */
    command: Type.Optional(Type.Array(Type.String())),
    /** A remote server's https endpoint. */
    url: Type.Optional(Type.String()),
    docsUrl: Type.Optional(Type.String()),
    /** The connector gallery preset it comes from. */
    preset: Type.Optional(Type.String()),
  },
  { $id: "CatalogInstall" },
);
export type CatalogInstall = Static<typeof CatalogInstall>;

export const CatalogEntry = Type.Object(
  {
    /** `tool:<name>`, `connector:<server id>`, `preset:<id>`, `registry:<name>`, `skill:<name>`. */
    id: Type.String(),
    kind: StringEnum(["tool", "connector", "skill"]),
    name: Type.String(),
    /** One line on what it does. A registry entry's is third-party text (data). */
    summary: Type.String(),
    comesFrom: StringEnum(["builtin", "installed", "preset", "registry", "psyche", "bundled"]),
    trust: StringEnum(["bundled", "verified", "unknown"]),
    /**
     * `loaded` / `on_demand`: installed tools sent always or loaded when needed; `installed`: a
     * connector or skill that is on; `off`: installed but turned off; `installable`: not here yet.
     */
    status: StringEnum(["loaded", "on_demand", "installed", "off", "installable"]),
    needs: CatalogNeeds,
    /** What adding it costs: nothing, a package download, a remote sign-up, or turning it on. */
    installCost: StringEnum(["none", "download", "remote", "enable"]),
    /** The tool names it brings (installed entries, or a list cached from an earlier run). */
    tools: Type.Optional(Type.Array(Type.String())),
    install: Type.Optional(CatalogInstall),
    /** The owner's choice for installed tools (setting `tools.loading`). */
    loading: Type.Optional(StringEnum(["always", "on_demand"])),
  },
  { $id: "CatalogEntry" },
);
export type CatalogEntry = Static<typeof CatalogEntry>;

export const CapabilitiesMethods = {
  "capabilities.search": defineMethod({
    params: Type.Object({
      query: Type.Optional(Type.String({ maxLength: 200 })),
      kind: Type.Optional(StringEnum(["tool", "connector", "skill"])),
      /** Leave out installed entries (Settings' Available sections). */
      installable: Type.Optional(Type.Boolean()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    }),
    result: Type.Object({
      entries: Type.Array(CatalogEntry),
      /** Whether the MCP registry was searched (setting `capabilities.onlineSearch`). */
      online: Type.Boolean(),
    }),
    scope: "operator.read",
    description:
      "Search the capability catalogue: installed tools and connectors, gallery presets, bundled skills, Psyche-made connectors, and the official MCP registry when the owner allows online search. Ranked by fit, installed first. Registry names and summaries are third-party data.",
  }),
  "capabilities.setLoading": defineMethod({
    params: Type.Object({
      /** A tool name, or `mcp__<server>` for every tool of one connector. */
      name: Type.String({ minLength: 1, maxLength: 160 }),
      loading: StringEnum(["always", "on_demand", "default"]),
    }),
    result: OkResult,
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Side-effecting: sets whether an installed tool or connector is always sent to the model or loaded on demand (setting tools.loading); default removes the override.",
  }),
};
