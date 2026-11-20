import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  ComputerMachineRef,
  Events,
  encodePairingLink,
  encodePairingLinkV2,
  formatMachineLink,
  MACHINE_LINK_PREFIX,
  MachineInfo,
  MachineLinkError,
  type MachineLinkPayload,
  Methods,
  NodeKind,
  PairingRequest,
  parseMachineLink,
  parsePairingLink,
  parsePairingLinkAny,
  Receipt,
  RunStep,
  SetupTokenInfo,
  setupTokenScopesFor,
  validateParams,
} from "../src/index.ts";
import {
  isLinuxPackagedHelperPath,
  LINUX_MACHINE_HELPER_PATH,
  LINUX_PACKAGED_HELPER_PATH,
  LINUX_PACKAGED_HELPER_PATHS,
} from "../src/platform.ts";

const TOKEN = `pst_${Buffer.alloc(32, 7).toString("base64url")}`;
const KEY = Buffer.alloc(32, 3).toString("base64url");
const PIN = Buffer.alloc(32, 9).toString("base64url");

const SERVE: MachineLinkPayload = {
  gatewayUrl: "https://studio-mac.tail1234.ts.net",
  gatewayKey: KEY,
  setupToken: TOKEN,
  hostName: "Studio Mac",
};
const LAN: MachineLinkPayload = {
  gatewayUrl: "https://studio-mac.local:7979",
  gatewayKey: KEY,
  certPin: PIN,
  setupToken: TOKEN,
  hostName: "Studio Mac",
};

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const link = (value: unknown) => `${MACHINE_LINK_PREFIX}${b64(value)}`;
const problem = (text: string): string | undefined => {
  try {
    parseMachineLink(text);
  } catch (err) {
    return err instanceof MachineLinkError
      ? `${err.problem}${err.field ? `:${err.field}` : ""}`
      : "other";
  }
  return undefined;
};

describe("psyche-machine:v1 links", () => {
  it("round-trips a Tailscale link (no certPin) and a LAN link (with certPin)", () => {
    const serve = formatMachineLink(SERVE);
    expect(serve.startsWith("psyche-machine:v1:")).toBe(true);
    expect(serve.slice(MACHINE_LINK_PREFIX.length)).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(parseMachineLink(serve)).toEqual(SERVE);
    expect(parseMachineLink(`  ${formatMachineLink(LAN)}\n`)).toEqual(LAN);
    expect(
      JSON.parse(Buffer.from(serve.slice(MACHINE_LINK_PREFIX.length), "base64url").toString()),
    ).toEqual(SERVE);
  });

  it("matches the scheme without regard to case, nothing else", () => {
    const text = formatMachineLink(SERVE).replace("psyche-machine:", "Psyche-Machine:");
    expect(parseMachineLink(text)).toEqual(SERVE);
    expect(problem(text.replace(":v1:", ":V1:"))).toBe("unsupported_version");
  });

  it("is a different scheme from psyche-pair: neither parser takes the other's link", () => {
    const pair = encodePairingLink({
      gatewayUrl: SERVE.gatewayUrl,
      gatewayFingerprint: `sha256:${"ab".repeat(32)}`,
      setupToken: TOKEN,
      hostName: "Studio Mac",
    });
    const pairLan = encodePairingLinkV2({
      gatewayUrl: LAN.gatewayUrl,
      gatewayKey: KEY,
      certPin: PIN,
      setupToken: TOKEN,
      hostName: "Studio Mac",
    });
    expect(problem(pair)).toBe("not_a_machine_link");
    expect(problem(pairLan)).toBe("not_a_machine_link");
    expect(() => parsePairingLink(formatMachineLink(SERVE))).toThrow(/not_a_pairing_link/);
    expect(() => parsePairingLinkAny(formatMachineLink(LAN))).toThrow(/not_a_pairing_link/);
  });

  it.each([
    ["not a link", "hello", "not_a_machine_link"],
    ["empty", "", "not_a_machine_link"],
    ["another version", `psyche-machine:v2:${b64(SERVE)}`, "unsupported_version"],
    ["no version", "psyche-machine:abc", "malformed"],
    ["bad base64", "psyche-machine:v1:***", "malformed"],
    ["not json", `psyche-machine:v1:${Buffer.from("nope").toString("base64url")}`, "malformed"],
    ["an array", link([SERVE]), "malformed"],
    ["null", link(null), "malformed"],
    ["too long", `${MACHINE_LINK_PREFIX}${"A".repeat(2100)}`, "malformed"],
    ["an extra field", link({ ...SERVE, scopes: ["operator.admin"] }), "extra_fields:scopes"],
    ["an extra field (pair v1 name)", link({ ...SERVE, gatewayFingerprint: "x" }), "extra_fields"],
    ["a missing url", link({ ...SERVE, gatewayUrl: undefined }), "bad_field:gatewayUrl"],
    ["a missing key", link({ ...SERVE, gatewayKey: undefined }), "bad_field:gatewayKey"],
    ["a missing token", link({ ...SERVE, setupToken: undefined }), "bad_field:setupToken"],
    ["a missing name", link({ ...SERVE, hostName: undefined }), "bad_field:hostName"],
    ["a numeric token", link({ ...SERVE, setupToken: 5 }), "bad_field:setupToken"],
    ["a non-string certPin", link({ ...SERVE, certPin: 5 }), "bad_field:certPin"],
    ["a null certPin", link({ ...SERVE, certPin: null }), "bad_field:certPin"],
    ["http", link({ ...SERVE, gatewayUrl: "http://studio-mac.ts.net" }), "bad_field:gatewayUrl"],
    ["a loopback url", link({ ...SERVE, gatewayUrl: "https://localhost" }), "bad_field:gatewayUrl"],
    ["a path", link({ ...SERVE, gatewayUrl: "https://a.ts.net/x" }), "bad_field:gatewayUrl"],
    ["a query", link({ ...SERVE, gatewayUrl: "https://a.ts.net/?x=1" }), "bad_field:gatewayUrl"],
    ["credentials", link({ ...SERVE, gatewayUrl: "https://u:p@a.ts.net" }), "bad_field:gatewayUrl"],
    ["a short key", link({ ...SERVE, gatewayKey: "abc" }), "bad_field:gatewayKey"],
    ["a 33-byte key", link({ ...SERVE, gatewayKey: `${KEY}A` }), "bad_field:gatewayKey"],
    ["a padded key", link({ ...SERVE, gatewayKey: `${KEY}=` }), "bad_field:gatewayKey"],
    ["a short token", link({ ...SERVE, setupToken: "pst_abc" }), "bad_field:setupToken"],
    ["a bad token prefix", link({ ...SERVE, setupToken: `xxx_${TOKEN.slice(4)}` }), "bad_field"],
    ["a blank name", link({ ...SERVE, hostName: "   " }), "bad_field:hostName"],
    ["an invisible-only name", link({ ...SERVE, hostName: "​⁣" }), "bad_field:hostName"],
    ["a control name", link({ ...SERVE, hostName: "a\nb" }), "bad_field:hostName"],
    ["a long name", link({ ...SERVE, hostName: "x".repeat(65) }), "bad_field:hostName"],
    ["a short certPin", link({ ...LAN, certPin: "abc" }), "bad_field:certPin"],
    // A certPin means the Gateway is on the local network: a public address cannot carry one,
    ["a certPin on a public url", link({ ...SERVE, certPin: PIN }), "bad_field:gatewayUrl"],
    // and a LAN address cannot go without it (its certificate is self-signed).
    ["a LAN url without certPin", link({ ...SERVE, gatewayUrl: LAN.gatewayUrl }), "bad_field"],
    ["a global IP with certPin", link({ ...LAN, gatewayUrl: "https://8.8.8.8" }), "bad_field"],
    ["a loopback with certPin", link({ ...LAN, gatewayUrl: "https://127.0.0.1" }), "bad_field"],
  ])("refuses %s", (_name, text, expected) => {
    expect(problem(text as string)).toMatch(new RegExp(`^${expected as string}`));
  });

  it("refuses to format what it would refuse to parse", () => {
    expect(() => formatMachineLink({ ...SERVE, gatewayKey: "nope" })).toThrow(MachineLinkError);
    expect(() => formatMachineLink({ ...SERVE, certPin: PIN })).toThrow(MachineLinkError);
    expect(() => formatMachineLink({ ...LAN, certPin: "nope" })).toThrow(MachineLinkError);
    expect(() => formatMachineLink({ ...SERVE, hostName: "" })).toThrow(MachineLinkError);
  });

  it("drops invisible characters from the shown name", () => {
    const text = link({ ...SERVE, hostName: "Studio⁠ Mac" });
    expect(parseMachineLink(text).hostName).toBe("Studio Mac");
  });

  it("ignores fields on the payload object that are not link fields when formatting", () => {
    const sneaky = { ...SERVE, scopes: ["operator.admin"] } as MachineLinkPayload;
    expect(parseMachineLink(formatMachineLink(sneaky))).toEqual(SERVE);
  });
});

describe("setup token purpose", () => {
  it("a machine token gets exactly [node] and takes no scopes", () => {
    expect(setupTokenScopesFor("machine", undefined)).toEqual({ ok: true, scopes: ["node"] });
    expect(setupTokenScopesFor("machine", [])).toEqual({ ok: true, scopes: ["node"] });
    expect(setupTokenScopesFor("machine", ["operator.admin"])).toEqual({
      ok: false,
      reason: "scopes_not_allowed",
    });
    expect(setupTokenScopesFor("machine", ["node"])).toEqual({
      ok: false,
      reason: "scopes_not_allowed",
    });
  });

  it("a device token (also when the purpose is absent) needs scopes and never gets node", () => {
    for (const purpose of ["device", undefined] as const) {
      expect(setupTokenScopesFor(purpose, ["operator.read", "operator.read"])).toEqual({
        ok: true,
        scopes: ["operator.read"],
      });
      expect(setupTokenScopesFor(purpose, undefined)).toEqual({
        ok: false,
        reason: "scopes_required",
      });
      expect(setupTokenScopesFor(purpose, [])).toEqual({ ok: false, reason: "scopes_required" });
      expect(setupTokenScopesFor(purpose, ["operator.read", "node"])).toEqual({
        ok: false,
        reason: "node_scope_not_allowed",
      });
    }
  });

  it("the wire schema stays compatible: scopes alone still validates, purpose is optional", () => {
    expect(() =>
      validateParams("devices.setupToken.create", { scopes: ["operator.read"] }),
    ).not.toThrow();
    expect(() =>
      validateParams("devices.setupToken.create", { purpose: "machine", via: "lan" }),
    ).not.toThrow();
    expect(() => validateParams("devices.setupToken.create", { purpose: "root" })).toThrow();
    // node is still not a scope a caller can ask for.
    expect(() => validateParams("devices.setupToken.create", { scopes: ["node"] })).toThrow();
  });

  it("an old token row (no purpose) and a machine row both fit SetupTokenInfo", () => {
    const row = {
      id: "stk_1",
      scopes: ["operator.read"],
      createdAt: "2026-11-19T00:00:00.000Z",
      expiresAt: "2026-11-19T00:10:00.000Z",
      usedAt: null,
      usedByDeviceId: null,
      revokedAt: null,
      status: "live",
    };
    const info = Methods["devices.setupToken.list"].result.properties.setupTokens.items;
    expect(Value.Check(info, row)).toBe(true);
    expect(Value.Check(info, { ...row, scopes: ["node"], purpose: "machine" })).toBe(true);
    expect(Value.Check(info, { ...row, scopes: ["root"] })).toBe(false);
    expect(Value.Check(SetupTokenInfo, row)).toBe(true);
  });
});

describe("machine schemas", () => {
  const ID = "dev_abc";
  const info = {
    id: "mch_1",
    deviceId: ID,
    name: "lab-box",
    platform: "linux",
    status: "online",
    display: "headless",
    surfaces: ["virtual_screen"],
    exec: { enabled: true, contained: true },
    files: { roots: [{ path: "/home/dev", mode: "rw" }] },
    account: "own",
    policyOwner: "root",
    passwordlessSudo: false,
    helperVersion: "1.0.0",
    lastSeenAt: "2026-11-19T00:00:00.000Z",
  };

  it("registers machines.list and machines.rename with the right scopes", () => {
    expect(Methods["machines.list"].scope).toBe("operator.read");
    expect(Methods["machines.rename"].scope).toBe("operator.admin");
    expect(Methods["machines.rename"].sideEffecting).toBe(true);
    expect(Value.Check(MachineInfo, info)).toBe(true);
    expect(Value.Check(MachineInfo, { ...info, account: "root" })).toBe(false);
    expect(Value.Check(MachineInfo, { ...info, display: null, helperVersion: null })).toBe(true);
    expect(Value.Check(Methods["machines.rename"].params, { id: "mch_1", name: "" })).toBe(false);
    expect(
      Value.Check(Events["machines.changed"].payload, { machine: info, change: "added" }),
    ).toBe(true);
    expect(Value.Check(Events["machines.changed"].payload, { machine: info, change: "x" })).toBe(
      false,
    );
  });

  it("adds machine as a node kind, and only as a value of the existing enum", () => {
    expect(Value.Check(NodeKind, "machine")).toBe(true);
    for (const old of ["mac-helper", "win-helper", "host-helper", "guest", "remote"])
      expect(Value.Check(NodeKind, old)).toBe(true);
    expect(NodeKind.description).toMatch(/owner/);
  });

  it("carries a machine reference on approvals, receipts and steps only as an optional field", () => {
    const ref = { deviceId: ID, name: "lab-box" };
    expect(Value.Check(ComputerMachineRef, ref)).toBe(true);
    expect(Value.Check(ComputerMachineRef, { ...ref, name: "" })).toBe(false);
    for (const schema of [Receipt, RunStep]) {
      expect(Object.keys(schema.properties)).toContain("machine");
      expect(schema.required ?? []).not.toContain("machine");
    }
    const approval = Methods["approvals.list"].result.properties.approvals.items;
    expect(Object.keys(approval.properties)).toContain("machine");
    expect(approval.required ?? []).not.toContain("machine");
    expect(PairingRequest.required ?? []).not.toContain("purpose");
  });
});

describe("packaged helper paths", () => {
  it("lists the desktop and server paths, keeps the old constant, never includes a machine", () => {
    expect(LINUX_PACKAGED_HELPER_PATHS).toEqual([
      LINUX_PACKAGED_HELPER_PATH,
      "/usr/lib/psyche-server/psyche-helper",
    ]);
    expect(isLinuxPackagedHelperPath("/usr/lib/psyche-server/psyche-helper")).toBe(true);
    expect(isLinuxPackagedHelperPath(LINUX_PACKAGED_HELPER_PATH)).toBe(true);
    expect(LINUX_MACHINE_HELPER_PATH).toBe("/usr/lib/psyche-helper/psyche-helper");
    expect(isLinuxPackagedHelperPath(LINUX_MACHINE_HELPER_PATH)).toBe(false);
    expect(isLinuxPackagedHelperPath("/usr/lib/psyche-server/psyche-helper/")).toBe(false);
    expect(isLinuxPackagedHelperPath("/tmp/psyche-helper")).toBe(false);
  });
});
