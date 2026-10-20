import { PROTOCOL_VERSION } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { type AuditReport, auditExitCode, auditRules, parseSeverity } from "../src/audit.ts";
import { type Check, doctorChecks, doctorExitCode } from "../src/doctor.ts";
import type { Snapshot } from "../src/snapshot.ts";

const NOW = new Date("2026-10-19T12:00:00.000Z");
const GiB = 1024 ** 3;

/** A fully healthy snapshot: zero audit findings, only ok/skip doctor checks. */
function baseSnapshot(): Snapshot {
  return {
    home: "/home/me/.psyche",
    gatewayUrl: "http://127.0.0.1:7979",
    gatewayHost: "127.0.0.1",
    platform: "linux",
    probe: {
      reachable: true,
      healthy: true,
      version: { name: "psyched", version: "0.1.0", protocolVersion: PROTOCOL_VERSION },
    },
    config: {
      exists: true,
      config: { gateway: { host: "127.0.0.1", port: 7979 } },
      problems: [],
    },
    service: { kind: "systemd", installed: true, running: true, pid: 42 },
    connection: { paired: true, scopes: ["operator.read", "operator.admin"] },
    settings: { ok: true, value: { "sandbox.enabled": true, "telemetry.enabled": false } },
    channels: {
      ok: true,
      value: [
        {
          id: "tg",
          type: "telegram",
          dmPolicy: "pairing",
          ownerIds: ["1"],
          groupAllowFrom: ["g1"],
          requireMention: true,
        },
      ],
    },
    grants: {
      ok: true,
      value: [
        { id: "gr1", kind: "exec", scope: "always", expiresAt: "2026-11-01T00:00:00Z" },
        { id: "gr2", kind: "exec", scope: "once", expiresAt: null },
      ],
    },
    devices: {
      ok: true,
      value: [
        {
          id: "d1",
          name: "MacBook",
          scopes: ["operator.admin"],
          lastSeenAt: "2026-10-19T11:00:00Z",
          revokedAt: null,
        },
      ],
    },
    nodes: { ok: true, value: [] },
    sandbox: { ok: true, value: { backend: "docker", available: true } },
    vault: {
      ok: true,
      value: {
        state: "unlocked",
        slots: ["keychain", "key_file"],
        recoveryConfirmed: true,
        autoLockMinutes: 15,
        itemCount: 2,
      },
    },
    apiKeys: { ok: true, value: [{ name: "Anthropic", bindings: [] }] },
    skills: {
      ok: true,
      value: [{ name: "pdf", status: "active", trust: "bundled", enabled: true }],
    },
    localSandboxBackends: ["docker"],
    disk: { freeBytes: 100 * GiB, totalBytes: 500 * GiB },
    modeIssues: [],
    homeMode: "700",
    chromeDebugPort: false,
    realChrome: { ok: true, value: { enabled: true, attached: false, sessions: 0 } },
    localModel: false,
  };
}

function snap(over: Partial<Snapshot> = {}): Snapshot {
  return { ...baseSnapshot(), ...over };
}

const unavailable = { ok: false as const, reason: "unavailable", message: "x not available" };

function check(s: Snapshot, id: string): Check | undefined {
  return doctorChecks(s).find((c) => c.id === id);
}

function ids(r: AuditReport): string[] {
  return r.findings.map((f) => f.id);
}

function finding(s: Snapshot, id: string) {
  return auditRules(s, NOW).findings.filter((f) => f.id === id);
}

describe("baseSnapshot", () => {
  it("is healthy for doctor", () => {
    const checks = doctorChecks(baseSnapshot());
    expect(checks.filter((c) => c.status !== "ok" && c.status !== "skip")).toEqual([]);
    expect(doctorExitCode(checks, true)).toBe(0);
  });

  it("has zero audit findings and nothing unchecked", () => {
    const r = auditRules(baseSnapshot(), NOW);
    expect(r).toEqual({ findings: [], notChecked: [] });
    expect(auditExitCode(r, "info")).toBe(0);
  });
});

describe("doctor rules", () => {
  it("config problems → fail", () => {
    const s = snap({
      config: { exists: true, config: {}, problems: ["gateway.foo is not a known key"] },
    });
    expect(check(s, "config")).toMatchObject({ status: "fail" });
    expect(check(s, "config")?.message).toContain("gateway.foo");
  });

  it("no config.json → ok (defaults)", () => {
    const s = snap({ config: { exists: false, config: {}, problems: [] } });
    expect(check(s, "config")).toMatchObject({
      status: "ok",
      message: expect.stringMatching(/defaults/),
    });
  });

  it("unreachable Gateway → fail with a start hint", () => {
    const s = snap({
      probe: { reachable: false, healthy: false, version: null, error: "ECONNREFUSED" },
      connection: { paired: false, scopes: [] },
    });
    expect(check(s, "gateway")).toMatchObject({ status: "fail", hint: "psyche start" });
    expect(check(s, "gateway")?.message).toContain("ECONNREFUSED");
  });

  it("reachable but unhealthy → fail", () => {
    const s = snap({ probe: { reachable: true, healthy: false, version: null } });
    expect(check(s, "gateway")?.status).toBe("fail");
  });

  it("protocol mismatch → warn", () => {
    const s = snap({
      probe: { reachable: true, healthy: true, version: { protocolVersion: PROTOCOL_VERSION + 1 } },
    });
    expect(check(s, "protocol")?.status).toBe("warn");
    expect(check(baseSnapshot(), "protocol")).toBeUndefined();
  });

  it("non-loopback gateway.host → fail", () => {
    const s = snap({
      config: { exists: true, config: { gateway: { host: "0.0.0.0" } }, problems: [] },
    });
    expect(check(s, "bind")?.status).toBe("fail");
    expect(check(baseSnapshot(), "bind")?.status).toBe("ok");
  });

  it("pairing pending → warn; another connection error → fail", () => {
    const pending = snap({
      connection: { paired: false, scopes: [], error: { code: "pairing", message: "code AB12" } },
    });
    expect(check(pending, "auth")).toMatchObject({ status: "warn", message: "code AB12" });
    const other = snap({
      connection: { paired: false, scopes: [], error: { code: "unreachable", message: "x" } },
    });
    expect(check(other, "auth")?.status).toBe("fail");
    const offline = snap({ connection: { paired: false, scopes: [] } });
    expect(check(offline, "auth")?.status).toBe("skip");
  });

  it("trusted-proxy mode on → auth.proxy ok", () => {
    const s = snap({
      config: {
        exists: true,
        config: { gateway: { trustedProxy: { enabled: true, trustedProxies: ["100.64.0.0/10"] } } },
        problems: [],
      },
    });
    expect(check(s, "auth.proxy")?.status).toBe("ok");
  });

  it("sandbox unavailable → fail", () => {
    const s = snap({ sandbox: { ok: true, value: { backend: "docker", available: false } } });
    expect(check(s, "sandbox")).toMatchObject({ status: "fail" });
  });

  it("Gateway does not report a sandbox but a local runtime exists → ok", () => {
    const s = snap({ sandbox: unavailable, localSandboxBackends: ["podman"] });
    expect(check(s, "sandbox")).toMatchObject({ status: "ok" });
  });

  it("no sandbox anywhere → warn", () => {
    const s = snap({ sandbox: unavailable, localSandboxBackends: [] });
    expect(check(s, "sandbox")?.status).toBe("warn");
  });

  it("models: a vault key or a local model → ok", () => {
    expect(check(baseSnapshot(), "models")?.status).toBe("ok");
    const local = snap({ apiKeys: { ok: true, value: [] }, localModel: true });
    expect(check(local, "models")).toMatchObject({
      status: "ok",
      message: expect.stringMatching(/Ollama/),
    });
  });

  it("models: zero keys and no local model → warn", () => {
    const s = snap({ apiKeys: { ok: true, value: [] }, localModel: false });
    expect(check(s, "models")).toMatchObject({ status: "warn", hint: expect.any(String) });
  });

  it("models: the key query failed for any reason → skip", () => {
    for (const reason of ["unavailable", "forbidden", "not_connected", "error"]) {
      const s = snap({
        apiKeys: { ok: false, reason, message: reason },
        localModel: false,
        connection:
          reason === "not_connected" ? { paired: false, scopes: [] } : baseSnapshot().connection,
      });
      expect(check(s, "models")?.status, reason).toBe("skip");
    }
  });

  it("mac helper: offline or missing on darwin → warn; online → ok; unknown → skip", () => {
    const helper = (status: string) => ({
      ok: true as const,
      value: [{ id: "n1", kind: "mac-helper", status, capabilities: [{ name: "screen" }] }],
    });
    expect(check(snap({ platform: "darwin", nodes: helper("offline") }), "helper")?.status).toBe(
      "warn",
    );
    expect(
      check(snap({ platform: "darwin", nodes: { ok: true, value: [] } }), "helper")?.status,
    ).toBe("warn");
    expect(check(snap({ platform: "darwin", nodes: helper("online") }), "helper")?.status).toBe(
      "ok",
    );
    expect(check(snap({ platform: "darwin", nodes: unavailable }), "helper")?.status).toBe("skip");
    expect(check(snap({ platform: "linux", nodes: helper("offline") }), "helper")).toBeUndefined();
  });

  it("vault uninitialized → warn; recovery unconfirmed → warn", () => {
    const v = baseSnapshot().vault;
    if (!v.ok) throw new Error("base vault");
    const uninit = snap({ vault: { ok: true, value: { ...v.value, state: "uninitialized" } } });
    expect(check(uninit, "vault")).toMatchObject({ status: "warn", hint: "psyche onboard" });
    const unconfirmed = snap({
      vault: { ok: true, value: { ...v.value, recoveryConfirmed: false } },
    });
    expect(check(unconfirmed, "vault")?.status).toBe("warn");
  });

  it("disk: < 1 GiB → fail, < 5 GiB → warn", () => {
    const disk = (free: number) => snap({ disk: { freeBytes: free, totalBytes: 100 * GiB } });
    expect(check(disk(0.5 * GiB), "disk")?.status).toBe("fail");
    expect(check(disk(3 * GiB), "disk")?.status).toBe("warn");
    expect(check(disk(5 * GiB), "disk")?.status).toBe("ok");
    expect(check(snap({ disk: null }), "disk")).toBeUndefined();
  });

  it("home mode 755 → fail", () => {
    expect(check(snap({ homeMode: "755" }), "modes")).toMatchObject({
      status: "fail",
      hint: "chmod 700 /home/me/.psyche",
    });
  });

  it("sensitive file 644 → fail; other paths → warn", () => {
    const sensitive = snap({ modeIssues: [{ path: "vault/vault.db", mode: "644", kind: "file" }] });
    expect(check(sensitive, "modes")?.status).toBe("fail");
    expect(check(sensitive, "modes")?.message).toContain("vault/vault.db (644)");
    const other = snap({ modeIssues: [{ path: "library/a.txt", mode: "644", kind: "file" }] });
    expect(check(other, "modes")?.status).toBe("warn");
  });

  it("service not running with no healthy Gateway → warn", () => {
    const s = snap({
      service: { kind: "systemd", installed: true, running: false },
      probe: { reachable: false, healthy: false, version: null },
    });
    expect(check(s, "service")).toMatchObject({ status: "warn", hint: "psyche start" });
    const outside = snap({ service: { kind: "systemd", installed: true, running: false } });
    expect(check(outside, "service")?.status).toBe("ok");
  });

  it("doctorExitCode: fail → 1; warn → 1 only when strict", () => {
    const ok: Check[] = [{ id: "a", status: "ok", message: "" }];
    const warn: Check[] = [...ok, { id: "b", status: "warn", message: "" }];
    const fail: Check[] = [...ok, { id: "c", status: "fail", message: "" }];
    expect(doctorExitCode(ok, false)).toBe(0);
    expect(doctorExitCode(ok, true)).toBe(0);
    expect(doctorExitCode(warn, false)).toBe(0);
    expect(doctorExitCode(warn, true)).toBe(1);
    expect(doctorExitCode(fail, false)).toBe(1);
  });
});

describe("audit rules", () => {
  const withSettings = (value: Record<string, unknown>) =>
    snap({ settings: { ok: true, value: { "sandbox.enabled": true, ...value } } });
  const channel = (c: Record<string, unknown>) =>
    snap({
      channels: {
        ok: true,
        value: [{ id: "wa", type: "whatsapp", dmPolicy: "pairing", ...c }],
      },
    });

  it("bind.non_loopback_without_auth (critical), not when an auth mode is set", () => {
    const config = { exists: true, config: { gateway: { host: "0.0.0.0" } }, problems: [] };
    expect(finding(snap({ config }), "bind.non_loopback_without_auth")).toMatchObject([
      { severity: "critical" },
    ]);
    const authed = snap({
      config,
      settings: { ok: true, value: { "gateway.auth.mode": "tailscale" } },
    });
    expect(finding(authed, "bind.non_loopback_without_auth")).toEqual([]);
  });

  it("transport.plain_http", () => {
    const s = snap({ gatewayUrl: "http://192.168.1.5:7979", gatewayHost: "192.168.1.5" });
    expect(finding(s, "transport.plain_http")).toMatchObject([{ severity: "high" }]);
    const tls = snap({
      gatewayUrl: "https://psyche.tail1.ts.net",
      gatewayHost: "psyche.tail1.ts.net",
    });
    expect(finding(tls, "transport.plain_http")).toEqual([]);
  });

  it("proxy.no_cidrs", () => {
    const s = snap({
      config: {
        exists: true,
        config: { gateway: { trustedProxy: { enabled: true } } },
        problems: [],
      },
    });
    expect(finding(s, "proxy.no_cidrs")).toMatchObject([{ severity: "high" }]);
  });

  it("proxy.public_ingress_without_passkeys", () => {
    expect(
      finding(
        withSettings({ "gateway.allowPublicIngress": true }),
        "proxy.public_ingress_without_passkeys",
      ),
    ).toMatchObject([{ severity: "high" }]);
    expect(
      finding(
        withSettings({ "gateway.allowPublicIngress": true, "auth.passkeys.enabled": true }),
        "proxy.public_ingress_without_passkeys",
      ),
    ).toEqual([]);
  });

  it("channels.dm_open: critical without an owner, high with one", () => {
    expect(finding(channel({ dmPolicy: "open" }), "channels.dm_open")).toMatchObject([
      { severity: "critical" },
    ]);
    expect(finding(channel({ dmPolicy: "open", ownerIds: [] }), "channels.dm_open")).toMatchObject([
      { severity: "critical" },
    ]);
    expect(
      finding(channel({ dmPolicy: "open", ownerIds: ["me"] }), "channels.dm_open"),
    ).toMatchObject([{ severity: "high" }]);
  });

  it("channels.group_without_mention", () => {
    expect(
      finding(
        channel({ groupAllowFrom: ["g"], requireMention: false }),
        "channels.group_without_mention",
      ),
    ).toMatchObject([{ severity: "medium" }]);
    expect(
      finding(
        channel({ groupAllowFrom: [], requireMention: false }),
        "channels.group_without_mention",
      ),
    ).toEqual([]);
  });

  it("sandbox.disabled when the backend is unavailable", () => {
    const s = snap({ sandbox: { ok: true, value: { backend: "docker", available: false } } });
    expect(finding(s, "sandbox.disabled")).toMatchObject([{ severity: "high" }]);
  });

  it("sandbox.disabled when sandbox.enabled is false", () => {
    const s = snap({ settings: { ok: true, value: { "sandbox.enabled": false } } });
    expect(finding(s, "sandbox.disabled")).toMatchObject([
      { severity: "high", message: "sandbox.enabled is false" },
    ]);
  });

  it("exec_host.enabled (either key)", () => {
    expect(finding(withSettings({ "exec.host.enabled": true }), "exec_host.enabled")).toHaveLength(
      1,
    );
    expect(
      finding(withSettings({ exec_host: { enabled: true } }), "exec_host.enabled"),
    ).toHaveLength(1);
  });

  it("skills.unverified (changed, unreviewed or unknown trust)", () => {
    const s = snap({
      skills: {
        ok: true,
        value: [
          { name: "a", status: "unlocked", trust: "local", enabled: false },
          { name: "b", status: "active", trust: "unknown", enabled: true },
          { name: "c", status: "active", trust: "verified", enabled: true },
          { name: "d", status: "disabled", trust: "unknown", enabled: false },
        ],
      },
    });
    const f = finding(s, "skills.unverified");
    expect(f).toMatchObject([{ severity: "medium" }]);
    expect(f[0]?.message).toContain(
      "2 changed, unreviewed or unknown-trust skill(s): a (unlocked), b (unknown)",
    );
    const mismatch = snap({
      skills: {
        ok: true,
        value: [{ name: "e", status: "hash_mismatch", trust: "local", enabled: false }],
      },
    });
    expect(finding(mismatch, "skills.unverified")).toMatchObject([{ severity: "high" }]);
  });

  it("grants.standing_without_expiry: high for exec, medium for others, none with expiresAt", () => {
    const s = snap({
      grants: {
        ok: true,
        value: [
          { id: "g1", kind: "exec", scope: "always", expiresAt: null, useCount: 4 },
          { id: "g2", kind: "send_email", scope: "always" },
          { id: "g3", kind: "exec", scope: "always", expiresAt: "2026-12-01T00:00:00Z" },
          { id: "g4", kind: "purchase", scope: "thread" },
        ],
      },
    });
    const f = finding(s, "grants.standing_without_expiry");
    expect(f.map((x) => x.severity)).toEqual(["high", "medium"]);
    expect(f[0]?.message).toContain("g1");
    expect(f[0]?.message).toContain("4 uses");
    expect(f[1]?.message).toContain("g2");
  });

  it("telemetry.enabled (flat or nested)", () => {
    expect(finding(withSettings({ "telemetry.enabled": true }), "telemetry.enabled")).toHaveLength(
      1,
    );
    expect(
      finding(withSettings({ telemetry: { enabled: true } }), "telemetry.enabled"),
    ).toHaveLength(1);
    expect(finding(withSettings({ telemetry: true }), "telemetry.enabled")).toHaveLength(1);
  });

  it("logs.bodies", () => {
    expect(finding(withSettings({ "logging.bodies": true }), "logs.bodies")).toMatchObject([
      { severity: "medium" },
    ]);
    expect(finding(withSettings({ "logs.bodies": true }), "logs.bodies")).toHaveLength(1);
  });

  it("devices.stale_admin: admin unseen for 30+ days or never; not when revoked or non-admin", () => {
    const s = snap({
      devices: {
        ok: true,
        value: [
          {
            id: "old",
            name: "Old",
            scopes: ["operator.admin"],
            lastSeenAt: "2026-09-01T00:00:00Z",
          },
          { id: "never", name: "Never", scopes: ["operator.admin"], lastSeenAt: null },
          {
            id: "gone",
            name: "Gone",
            scopes: ["operator.admin"],
            lastSeenAt: "2026-01-01T00:00:00Z",
            revokedAt: "2026-02-01T00:00:00Z",
          },
          { id: "reader", name: "Reader", scopes: ["operator.read"], lastSeenAt: null },
          {
            id: "fresh",
            name: "Fresh",
            scopes: ["operator.admin"],
            lastSeenAt: "2026-10-01T00:00:00Z",
          },
        ],
      },
    });
    const f = finding(s, "devices.stale_admin");
    expect(f.map((x) => x.fix)).toEqual([
      "psyche devices revoke old",
      "psyche devices revoke never",
    ]);
    expect(f.every((x) => x.severity === "low")).toBe(true);
  });

  const vault = (v: Record<string, unknown>) => {
    const base = baseSnapshot().vault;
    if (!base.ok) throw new Error("base vault");
    return snap({ vault: { ok: true, value: { ...base.value, ...v } as typeof base.value } });
  };

  it("vault.key_file_only", () => {
    expect(finding(vault({ slots: ["key_file"] }), "vault.key_file_only")).toMatchObject([
      { severity: "medium" },
    ]);
    expect(finding(vault({ slots: ["key_file", "safe_storage"] }), "vault.key_file_only")).toEqual(
      [],
    );
  });

  it("vault.recovery_unconfirmed (not for an uninitialized vault)", () => {
    expect(finding(vault({ recoveryConfirmed: false }), "vault.recovery_unconfirmed")).toHaveLength(
      1,
    );
    expect(
      finding(
        vault({ recoveryConfirmed: false, state: "uninitialized" }),
        "vault.recovery_unconfirmed",
      ),
    ).toEqual([]);
  });

  it("vault.no_autolock", () => {
    expect(finding(vault({ autoLockMinutes: 0 }), "vault.no_autolock")).toMatchObject([
      { severity: "low" },
    ]);
  });

  it("files.home_mode", () => {
    expect(finding(snap({ homeMode: "755" }), "files.home_mode")).toMatchObject([
      { severity: "high" },
    ]);
  });

  it("files.sensitive_modes and files.modes", () => {
    const sensitive = snap({
      modeIssues: [
        { path: "state", mode: "755", kind: "dir" },
        { path: "library/a.txt", mode: "644", kind: "file" },
      ],
    });
    expect(ids(auditRules(sensitive, NOW))).toContain("files.sensitive_modes");
    expect(ids(auditRules(sensitive, NOW))).not.toContain("files.modes");
    const other = snap({ modeIssues: [{ path: "library/a.txt", mode: "644", kind: "file" }] });
    expect(finding(other, "files.modes")).toMatchObject([{ severity: "medium" }]);
    expect(finding(other, "files.sensitive_modes")).toEqual([]);
  });

  it("browser.chrome_debug_port", () => {
    expect(finding(snap({ chromeDebugPort: true }), "browser.chrome_debug_port")).toMatchObject([
      { severity: "high" },
    ]);
  });

  it("browser.real_chrome_attached while a task holds the owner's Chrome, nothing otherwise", () => {
    const attached = {
      ok: true as const,
      value: {
        enabled: true,
        attached: true,
        port: 53817,
        pid: 4242,
        since: "2026-10-20T09:00:00.000Z",
        sessions: 1,
        userDataDir: "/Users/o/.psyche/browser/real-chrome/default",
      },
    };
    const f = finding(snap({ realChrome: attached }), "browser.real_chrome_attached");
    expect(f).toMatchObject([{ severity: "medium" }]);
    expect(f[0]?.message).toContain("127.0.0.1:53817");
    expect(f[0]?.message).toContain("pid 4242");
    expect(f[0]?.message).toContain("/Users/o/.psyche/browser/real-chrome/default");
    expect(f[0]?.fix).toContain("15 minutes idle");
    // Off or idle: no finding.
    expect(auditRules(snap({}), NOW).findings).toEqual([]);
    // The fixed 9222 probe does not report the same port twice.
    const on9222 = snap({
      chromeDebugPort: true,
      realChrome: { ok: true, value: { ...attached.value, port: 9222 } },
    });
    expect(finding(on9222, "browser.chrome_debug_port")).toEqual([]);
    expect(finding(on9222, "browser.real_chrome_attached")).toHaveLength(1);
  });

  it("unavailable queries land in notChecked, never as passes", () => {
    const r = auditRules(
      snap({
        settings: unavailable,
        channels: unavailable,
        grants: unavailable,
        devices: unavailable,
        sandbox: unavailable,
        vault: unavailable,
        skills: unavailable,
        realChrome: unavailable,
      }),
      NOW,
    );
    expect(r.findings).toEqual([]);
    expect(r.notChecked.map((n) => n.rule).sort()).toEqual(
      [
        "browser.realChrome",
        "channels",
        "devices",
        "grants",
        "sandbox",
        "settings (telemetry, exec_host, logging)",
        "skills",
        "vault",
      ].sort(),
    );
    expect(r.notChecked.every((n) => n.reason === "x not available")).toBe(true);
  });

  it("findings are sorted by severity, most severe first", () => {
    const r = auditRules(
      snap({
        homeMode: "755",
        chromeDebugPort: true,
        settings: { ok: true, value: { "telemetry.enabled": true } },
        channels: { ok: true, value: [{ id: "c", type: "slack", dmPolicy: "open" }] },
        devices: { ok: true, value: [{ id: "d", name: "D", scopes: ["operator.admin"] }] },
      }),
      NOW,
    );
    const rank = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
    const ranks = r.findings.map((f) => rank[f.severity]);
    expect(ranks).toEqual([...ranks].sort((a, b) => b - a));
    expect(r.findings[0]?.id).toBe("channels.dm_open");
    expect(r.findings.at(-1)?.id).toBe("devices.stale_admin");
  });

  it("auditExitCode honours --fail-at", () => {
    const low: AuditReport = {
      findings: [{ id: "x", severity: "low", message: "", fix: "" }],
      notChecked: [],
    };
    expect(auditExitCode(low)).toBe(1);
    expect(auditExitCode(low, "low")).toBe(1);
    expect(auditExitCode(low, "medium")).toBe(0);
    expect(auditExitCode(low, "critical")).toBe(0);
    const high: AuditReport = {
      findings: [{ id: "y", severity: "high", message: "", fix: "" }],
      notChecked: [],
    };
    expect(auditExitCode(high, "high")).toBe(1);
    expect(auditExitCode(high, "critical")).toBe(0);
    expect(auditExitCode({ findings: [], notChecked: [] }, "info")).toBe(0);
  });

  it("parseSeverity", () => {
    expect(parseSeverity(undefined)).toBe("low");
    expect(parseSeverity("critical")).toBe("critical");
    expect(() => parseSeverity("severe")).toThrow(/severity must be one of/);
  });
});

describe("parseSeverity edge cases", () => {
  // Regression: `v in RANK` used to accept Object.prototype keys.
  it("rejects names inherited from Object.prototype", () => {
    expect(() => parseSeverity("constructor")).toThrow();
  });
});
