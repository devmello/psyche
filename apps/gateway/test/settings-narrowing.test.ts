import { describe, expect, it } from "vitest";
import { isNarrowing } from "../src/handlers/settings-narrowing.ts";

/**
 * Narrowing changes skip the approval card; everything else keeps it. The function fails closed,
 * so each area has a list that must skip and a list of near-misses that must still card.
 */

type Row = [name: string, key: string, stored: unknown, next: unknown];

const P = "permissions.policy";
const ro = (path: string) => ({ path, mode: "ro" });
const rw = (path: string) => ({ path, mode: "rw" });

const NARROWING: Row[] = [
  // Folder policy
  ["remove a folder", P, { folders: [rw("/a"), ro("/b")] }, { folders: [ro("/b")] }],
  ["remove every folder", P, { folders: [rw("/a")] }, { folders: [] }],
  ["rw to ro", P, { folders: [rw("/a")] }, { folders: [ro("/a")] }],
  ["drop a workspace root", P, { workspaceRoots: ["/x", "/y"] }, { workspaceRoots: ["/x"] }],
  // Exec
  ["exec host off", P, { exec: { execHostEnabled: true } }, { exec: { execHostEnabled: false } }],
  ["exec host key removed", P, { exec: { execHostEnabled: true } }, { exec: {} }],
  [
    "read-only commands ask again",
    P,
    { exec: { readOnlyWithoutAsking: true } },
    { exec: { readOnlyWithoutAsking: false } },
  ],
  ["fewer env names", P, { exec: { allowEnv: ["A", "B"] } }, { exec: { allowEnv: ["A"] } }],
  // Policy rules, tiers and sites
  ["remove an allow rule", P, { allow: ["a", "b"] }, { allow: ["a"] }],
  ["add a deny rule", P, { deny: ["a"] }, { deny: ["a", "b"] }],
  [
    "lower an app tier in the policy",
    P,
    { apps: { "com.a.b": "interact" } },
    { apps: { "com.a.b": "read" } },
  ],
  ["site toward deny", P, { sites: { "a.com": "allow" } }, { sites: { "a.com": "deny" } }],
  ["more sensitive origins", P, { sensitiveOrigins: ["a"] }, { sensitiveOrigins: ["a", "b"] }],
  [
    "sensitive category on",
    P,
    { sensitiveCategories: { icloud: false } },
    { sensitiveCategories: { icloud: true } },
  ],
  // Connector matrices
  [
    "connector cell toward deny (policy)",
    P,
    { connectors: { gmail: { send: "ask", read: "allow" } } },
    { connectors: { gmail: { send: "deny", read: "ask" } } },
  ],
  [
    "connector matrix toward deny",
    "permissions.connectors.gmail",
    { send: "allow", read: "ask" },
    { send: "ask", read: "deny" },
  ],
  [
    "a new connector action at deny",
    "permissions.connectors.gmail",
    { send: "ask" },
    { send: "ask", delete: "deny" },
  ],
  ["fewer lifted floors", "permissions.liftedFloors.gmail", ["send", "delete"], ["send"]],
  ["no lifted floors", "permissions.liftedFloors.gmail", ["send"], []],
  // Computer use
  ["computer use off", "computerUse.enabled", true, false],
  ["computer use already off", "computerUse.enabled", undefined, false],
  [
    "lower an app tier",
    "computerUse.apps",
    [{ id: "com.apple.Notes", name: "Notes", tier: "interact" }],
    [{ id: "com.apple.Notes", name: "Notes", tier: "click" }],
  ],
  [
    "app to off",
    "computerUse.apps",
    [{ id: "com.apple.Notes", name: "Notes", tier: "read" }],
    [{ id: "com.apple.Notes", name: "Notes", tier: "off" }],
  ],
  ["a new app at off", "computerUse.apps", [], [{ id: "com.a.b", name: "B", tier: "off" }]],
  // Channels
  ["remove an allowFrom entry", "channels.telegram.allowFrom", ["1", "2"], ["2"]],
  ["empty allowFrom", "channels.telegram.allowFrom", ["1"], []],
  ["group list loses one entry", "channels.telegram.groupAllowFrom", ["g1", "g2"], ["g1"]],
  ["open to pairing", "channels.telegram.dmPolicy", "open", "pairing"],
  ["pairing to allowlist", "channels.telegram.dmPolicy", "pairing", "allowlist"],
  ["allowlist to disabled", "channels.telegram.dmPolicy", "allowlist", "disabled"],
];

const WIDENING: Row[] = [
  // Not a change: it keeps its card as before.
  ["the same policy again", P, { folders: [rw("/a")] }, { folders: [rw("/a")] }],
  ["the same dmPolicy again", "channels.telegram.dmPolicy", "pairing", "pairing"],
  // Folder policy
  ["add a folder", P, { folders: [ro("/a")] }, { folders: [ro("/a"), ro("/b")] }],
  ["add a folder from nothing", P, undefined, { folders: [ro("/a")] }],
  ["ro to rw", P, { folders: [ro("/a")] }, { folders: [rw("/a")] }],
  ["same path twice, one rw", P, { folders: [ro("/a")] }, { folders: [ro("/a"), rw("/a")] }],
  ["unknown folder mode", P, { folders: [ro("/a")] }, { folders: [{ path: "/a", mode: "x" }] }],
  ["add a workspace root", P, { workspaceRoots: ["/x"] }, { workspaceRoots: ["/x", "/y"] }],
  // Exec
  ["exec host on", P, { exec: { execHostEnabled: false } }, { exec: { execHostEnabled: true } }],
  ["exec host on from unset", P, {}, { exec: { execHostEnabled: true } }],
  [
    "read-only commands run without asking",
    P,
    { exec: { readOnlyWithoutAsking: false } },
    { exec: { readOnlyWithoutAsking: true } },
  ],
  ["more env names", P, { exec: { allowEnv: ["A"] } }, { exec: { allowEnv: ["A", "B"] } }],
  ["another exec key changes", P, { exec: { extra: 1 } }, { exec: { extra: 2 } }],
  ["exec binary path", "exec.srtPath", "/a", "/b"],
  // Policy rules
  ["add an allow rule", P, { allow: ["a"] }, { allow: ["a", "b"] }],
  ["remove a deny rule", P, { deny: ["a", "b"] }, { deny: ["a"] }],
  ["raise an app tier", P, { apps: { "com.a.b": "read" } }, { apps: { "com.a.b": "click" } }],
  ["drop an app (falls to an unknown default)", P, { apps: { "com.a.b": "off" } }, { apps: {} }],
  ["new site at allow", P, { sites: {} }, { sites: { "a.com": "allow" } }],
  ["drop a sensitive origin", P, { sensitiveOrigins: ["a", "b"] }, { sensitiveOrigins: ["a"] }],
  ["origins replace the bundled list", P, undefined, { sensitiveOrigins: ["a"] }],
  [
    "sensitive category off",
    P,
    { sensitiveCategories: { icloud: true } },
    { sensitiveCategories: { icloud: false } },
  ],
  ["default mode changes", P, { defaultMode: "balanced" }, { defaultMode: "manual" }],
  ["designated grants change", P, { designated: {} }, { designated: { a: { allow: ["x"] } } }],
  ["ask rules change", P, { ask: ["a"] }, { ask: [] }],
  // Connector matrices
  [
    "connector cell toward allow (policy)",
    P,
    { connectors: { gmail: { send: "deny" } } },
    { connectors: { gmail: { send: "ask" } } },
  ],
  [
    "connector matrix toward allow",
    "permissions.connectors.gmail",
    { send: "deny" },
    { send: "allow" },
  ],
  [
    "a new connector action at ask",
    "permissions.connectors.gmail",
    { send: "ask" },
    { send: "ask", delete: "ask" },
  ],
  [
    "a connector action dropped (back to its default)",
    "permissions.connectors.gmail",
    { send: "deny", read: "ask" },
    { read: "ask" },
  ],
  ["more lifted floors", "permissions.liftedFloors.gmail", ["send"], ["send", "delete"]],
  // Computer use
  ["computer use on", "computerUse.enabled", false, true],
  ["computer use on from unset", "computerUse.enabled", undefined, true],
  [
    "raise an app tier",
    "computerUse.apps",
    [{ id: "com.a.b", name: "B", tier: "read" }],
    [{ id: "com.a.b", name: "B", tier: "interact" }],
  ],
  ["a new app above off", "computerUse.apps", [], [{ id: "com.a.b", name: "B", tier: "read" }]],
  [
    "an app row dropped (back to the default)",
    "computerUse.apps",
    [{ id: "com.a.b", name: "B", tier: "off" }],
    [],
  ],
  // Channels
  ["add an allowFrom entry", "channels.telegram.allowFrom", ["1"], ["1", "2"]],
  ["allowFrom with no stored list", "channels.telegram.allowFrom", undefined, []],
  ["group list emptied (falls back to allowFrom)", "channels.telegram.groupAllowFrom", ["g1"], []],
  ["group list gains an entry", "channels.telegram.groupAllowFrom", ["g1"], ["g1", "g2"]],
  ["pairing to open", "channels.telegram.dmPolicy", "pairing", "open"],
  ["disabled to allowlist", "channels.telegram.dmPolicy", "disabled", "allowlist"],
  ["dmPolicy with no stored value", "channels.telegram.dmPolicy", undefined, "disabled"],
  // Never narrowing by this function
  ["a device list", "devices.revoked", ["a"], []],
  ["the vault lock", "vault.autoLock", 10, 5],
  ["the gateway LAN setting", "gateway.lan", { enabled: true }, { enabled: false }],
  ["identity links", "identityLinks", { a: ["b"] }, {}],
  ["owner allow list", "commands.ownerAllowFrom", ["1", "2"], ["1"]],
  ["the permission mode (an owner choice)", "permissions.mode", "auto", "manual"],
  ["an unknown permissions key", "permissions.somethingNew", true, false],
];

const MIXED: Row[] = [
  [
    "folder removed, another made rw",
    P,
    { folders: [rw("/a"), ro("/b")] },
    { folders: [rw("/b")] },
  ],
  [
    "folder removed, exec turned on",
    P,
    { folders: [rw("/a")], exec: { execHostEnabled: false } },
    { folders: [], exec: { execHostEnabled: true } },
  ],
  [
    "deny added, allow added",
    P,
    { allow: ["a"], deny: ["x"] },
    { allow: ["a", "b"], deny: ["x", "y"] },
  ],
  [
    "one connector cell down, one up",
    "permissions.connectors.gmail",
    { send: "ask", read: "ask" },
    { send: "deny", read: "allow" },
  ],
  [
    "one app lowered, one raised",
    "computerUse.apps",
    [
      { id: "com.a.b", name: "B", tier: "click" },
      { id: "com.c.d", name: "D", tier: "read" },
    ],
    [
      { id: "com.a.b", name: "B", tier: "off" },
      { id: "com.c.d", name: "D", tier: "click" },
    ],
  ],
  [
    "narrow one field, an unknown field changes",
    P,
    { folders: [rw("/a")], classifier: { model: "a" } },
    { folders: [], classifier: { model: "b" } },
  ],
];

const MALFORMED: Row[] = [
  ["policy is a string", P, { folders: [] }, "nothing"],
  ["policy is null", P, { folders: [] }, null],
  ["policy is an array", P, { folders: [] }, []],
  ["policy has an unknown key", P, { folders: [ro("/a")] }, { folders: [], bogus: true }],
  ["stored policy is invalid", P, "garbage", { folders: [] }],
  ["folders not an array", P, { folders: [ro("/a")] }, { folders: "none" }],
  ["folder entry is a string", P, { folders: [ro("/a")] }, { folders: ["/a"] }],
  ["stored folder is malformed", P, { folders: [{ path: 3, mode: "ro" }] }, { folders: [] }],
  ["allow holds a number", P, { allow: ["a"] }, { allow: [1] }],
  ["computer use off as a string", "computerUse.enabled", true, "false"],
  ["computer use off as 0", "computerUse.enabled", true, 0],
  ["computer use off as null", "computerUse.enabled", true, null],
  ["apps not an array", "computerUse.apps", [], "off"],
  ["app row has no tier", "computerUse.apps", [], [{ id: "com.a.b" }]],
  [
    "app tier is unknown",
    "computerUse.apps",
    [{ id: "com.a.b", name: "B", tier: "read" }],
    [{ id: "com.a.b", name: "B", tier: "super" }],
  ],
  [
    "the same app twice",
    "computerUse.apps",
    [{ id: "com.a.b", name: "B", tier: "read" }],
    [
      { id: "com.a.b", name: "B", tier: "off" },
      { id: "com.a.b", name: "B", tier: "interact" },
    ],
  ],
  ["matrix holds an unknown rule", "permissions.connectors.gmail", { send: "ask" }, { send: "x" }],
  ["matrix is an array", "permissions.connectors.gmail", { send: "ask" }, ["deny"]],
  ["matrix is null", "permissions.connectors.gmail", { send: "ask" }, null],
  ["stored matrix is malformed", "permissions.connectors.gmail", "ask", { send: "deny" }],
  ["lifted floors not a list", "permissions.liftedFloors.gmail", ["send"], "none"],
  ["allowFrom holds numbers", "channels.telegram.allowFrom", ["1"], [1]],
  ["allowFrom is a string", "channels.telegram.allowFrom", ["1"], "1"],
  ["dmPolicy is unknown", "channels.telegram.dmPolicy", "pairing", "locked"],
  ["dmPolicy is a number", "channels.telegram.dmPolicy", "pairing", 3],
  ["undefined next", "computerUse.enabled", true, undefined],
];

describe("isNarrowing", () => {
  it.each(NARROWING)("narrows: %s", (_n, key, stored, next) => {
    expect(isNarrowing(key, stored, next)).toBe(true);
  });

  it.each(WIDENING)("needs a card: %s", (_n, key, stored, next) => {
    expect(isNarrowing(key, stored, next)).toBe(false);
  });

  it.each(MIXED)("a mixed change needs a card: %s", (_n, key, stored, next) => {
    expect(isNarrowing(key, stored, next)).toBe(false);
  });

  it.each(MALFORMED)("a malformed value needs a card: %s", (_n, key, stored, next) => {
    expect(isNarrowing(key, stored, next)).toBe(false);
  });

  it("an unknown key never narrows", () => {
    expect(isNarrowing("totally.unknown", true, false)).toBe(false);
    expect(isNarrowing("", true, false)).toBe(false);
  });
});
