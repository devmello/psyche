import { appCap, TIER_RANK } from "@psyche/permissions";
import { isLoopbackHost } from "./paths.ts";
import { type Snapshot, setting } from "./snapshot.ts";
import { CLI_VERSION } from "./version.ts";

/**
 * `psyche security audit` (security §10, architecture §14): misconfigurations, not bugs. Each
 * rule is pure over the snapshot. A rule whose data the Gateway could not provide is listed in
 * `notChecked`, never silently passed.
 */

export type Severity = "critical" | "high" | "medium" | "low" | "info";

export interface Finding {
  id: string;
  severity: Severity;
  message: string;
  fix: string;
}

export interface AuditReport {
  findings: Finding[];
  notChecked: { rule: string; reason: string }[];
}

const RANK: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
const DAY = 86_400_000;
const RISKY_GRANTS = new Set([
  "exec",
  "exec_host",
  "purchase",
  "credential_fill",
  "computer_action",
]);

export function auditRules(s: Snapshot, now: Date): AuditReport {
  const findings: Finding[] = [];
  const notChecked: AuditReport["notChecked"] = [];
  const add = (f: Finding) => findings.push(f);
  const skip = (rule: string, q: { ok: boolean; message?: string }) => {
    if (!q.ok) notChecked.push({ rule, reason: q.message ?? "unavailable" });
  };

  // Bind and proxy (security §10).
  const gw = (s.config.config.gateway ?? {}) as Record<string, unknown>;
  const tp = (gw.trustedProxy ?? {}) as Record<string, unknown>;
  const host = typeof gw.host === "string" ? gw.host : "127.0.0.1";
  const authMode = setting(s, "gateway.auth.mode") ?? setting(s, "gateway.authMode");
  if (!isLoopbackHost(host) && !authMode) {
    add({
      id: "bind.non_loopback_without_auth",
      severity: "critical",
      message: `gateway.host is ${host} with no auth mode`,
      fix: "Bind 127.0.0.1 and put Tailscale Serve or Cloudflare Access in front",
    });
  }
  if (!isLoopbackHost(s.gatewayHost) && s.gatewayUrl.startsWith("http:")) {
    add({
      id: "transport.plain_http",
      severity: "high",
      message: `the CLI reaches the Gateway over plain http at ${s.gatewayUrl}`,
      fix: "Use https through the proxy or an SSH tunnel to 127.0.0.1",
    });
  }
  if (tp.enabled === true && !(Array.isArray(tp.trustedProxies) && tp.trustedProxies.length > 0)) {
    add({
      id: "proxy.no_cidrs",
      severity: "high",
      message: "trusted-proxy mode without trustedProxies CIDRs",
      fix: "psyche config set gateway.trustedProxy.trustedProxies '[\"100.64.0.0/10\"]'",
    });
  }
  if (
    setting(s, "gateway.allowPublicIngress") === true &&
    setting(s, "auth.passkeys.enabled") !== true
  ) {
    add({
      id: "proxy.public_ingress_without_passkeys",
      severity: "high",
      message: "public ingress is allowed but passkeys are not required",
      fix: "Enable passkeys or set gateway.allowPublicIngress false",
    });
  }

  // Channels: open DMs, groups without mention gating.
  skip("channels", s.channels);
  if (s.channels.ok) {
    for (const c of s.channels.value) {
      if (c.dmPolicy === "open") {
        add({
          id: "channels.dm_open",
          severity: c.ownerIds?.length ? "high" : "critical",
          message: `${c.type} channel ${c.id} accepts DMs from anyone (dmPolicy: open)${c.ownerIds?.length ? "" : " and has no owner"}`,
          fix: `Set dmPolicy to pairing or allowlist for ${c.id}`,
        });
      }
      if ((c.groupAllowFrom?.length ?? 0) > 0 && c.requireMention === false) {
        add({
          id: "channels.group_without_mention",
          severity: "medium",
          message: `${c.type} channel ${c.id} answers every group message`,
          fix: "Require a mention in groups",
        });
      }
    }
  }

  // Sandbox and host execution.
  if (s.sandbox.ok && !s.sandbox.value.available) {
    add({
      id: "sandbox.disabled",
      severity: "high",
      message: `sandbox backend ${s.sandbox.value.backend} unavailable`,
      fix: "Install a container runtime; never enable exec_host as a workaround",
    });
  } else if (setting(s, "sandbox.enabled") === false) {
    add({
      id: "sandbox.disabled",
      severity: "high",
      message: "sandbox.enabled is false",
      fix: "psyche config set sandbox.enabled true",
    });
  } else if (!s.sandbox.ok) {
    skip("sandbox", s.sandbox);
  }
  if (setting(s, "exec.host.enabled") === true || setting(s, "exec_host.enabled") === true) {
    add({
      id: "exec_host.enabled",
      severity: "high",
      message: "exec_host is enabled: the agent can run commands on the host",
      fix: "Disable exec_host; use the sandbox",
    });
  }

  // Skills.
  if (s.skills.ok) {
    // Changed since approval, never reviewed, or enabled with unknown provenance (security §11).
    const bad = s.skills.value.filter(
      (k) =>
        ["hash_mismatch", "unlocked", "blocked"].includes(k.status) ||
        (k.enabled && k.trust === "unknown"),
    );
    if (bad.length) {
      add({
        id: "skills.unverified",
        severity: bad.some((k) => k.status === "hash_mismatch") ? "high" : "medium",
        message: `${bad.length} changed, unreviewed or unknown-trust skill(s): ${bad
          .slice(0, 5)
          .map((k) => `${k.name} (${k.status === "active" ? k.trust : k.status})`)
          .join(", ")}`,
        fix: "psyche skills verify --strict; remove or re-approve what you do not recognise",
      });
    }
  } else skip("skills", s.skills);

  // Standing grants.
  if (s.grants.ok) {
    for (const g of s.grants.value) {
      if (g.scope === "always" && !g.expiresAt) {
        add({
          id: "grants.standing_without_expiry",
          severity: RISKY_GRANTS.has(g.kind) ? "high" : "medium",
          message: `standing ${g.kind} grant ${g.id} never expires (${g.useCount ?? 0} uses)`,
          fix: "Revoke it in Settings › Permissions, or re-grant with an expiry",
        });
      }
    }
  } else skip("grants", s.grants);

  // Telemetry and logging (security §14: none by default).
  const telemetry = setting(s, "telemetry.enabled") ?? setting(s, "telemetry");
  if (
    telemetry === true ||
    (typeof telemetry === "object" &&
      telemetry !== null &&
      (telemetry as Record<string, unknown>).enabled === true)
  ) {
    add({
      id: "telemetry.enabled",
      severity: "medium",
      message: "telemetry is enabled",
      fix: "psyche config set telemetry.enabled false",
    });
  }
  if (setting(s, "logging.bodies") === true || setting(s, "logs.bodies") === true) {
    add({
      id: "logs.bodies",
      severity: "medium",
      message: "logs include message bodies",
      fix: "psyche config set logging.bodies false",
    });
  }
  if (!s.settings.ok) skip("settings (telemetry, exec_host, logging)", s.settings);

  // Devices.
  if (s.devices.ok) {
    const admins = s.devices.value.filter(
      (d) => !d.revokedAt && d.scopes.includes("operator.admin"),
    );
    for (const d of admins) {
      const seen = d.lastSeenAt ? Date.parse(d.lastSeenAt) : Number.NaN;
      if (!Number.isFinite(seen) || now.getTime() - seen > 30 * DAY) {
        add({
          id: "devices.stale_admin",
          severity: "low",
          message: `admin device ${d.name} (${d.id}) not seen for 30+ days`,
          fix: `psyche devices revoke ${d.id}`,
        });
      }
    }
    // First admin without a terminal (devices.bootstrapAdmin): there must be one, made once.
    if (admins.length === 0) {
      add({
        id: "devices.no_admin",
        severity: "medium",
        message: "no paired device has operator.admin, so security settings cannot be changed",
        fix: "Open Psyche on this Mac (it becomes the admin device), or: psyched devices grant <id> <scopes>",
      });
    }
  } else skip("devices", s.devices);
  if (s.adminBootstraps?.ok && s.adminBootstraps.value.length > 1) {
    add({
      id: "devices.bootstrap_repeated",
      severity: "high",
      message: `the first-admin bootstrap ran ${s.adminBootstraps.value.length} times (${s.adminBootstraps.value.map((b) => b.deviceId).join(", ")}); it may run only once`,
      fix: "Review the admin devices in Settings → Devices and revoke the ones you do not recognise",
    });
  } else if (s.adminBootstraps && !s.adminBootstraps.ok)
    skip("devices.bootstrap", s.adminBootstraps);

  // Vault.
  if (s.vault.ok) {
    const v = s.vault.value;
    if (
      v.slots.includes("key_file") &&
      !v.slots.includes("keychain") &&
      !v.slots.includes("safe_storage")
    ) {
      add({
        id: "vault.key_file_only",
        severity: "medium",
        message: "the vault key is wrapped only by a key file (basic_text equivalent)",
        fix: "Use the system keychain where available",
      });
    }
    if (v.state !== "uninitialized" && !v.recoveryConfirmed) {
      add({
        id: "vault.recovery_unconfirmed",
        severity: "low",
        message: "vault recovery key not confirmed",
        fix: "Confirm it in Settings › Vault",
      });
    }
    if (v.autoLockMinutes === 0) {
      add({
        id: "vault.no_autolock",
        severity: "low",
        message: "vault auto-lock is off",
        fix: "Set an auto-lock period",
      });
    }
  } else skip("vault", s.vault);

  // File modes.
  if (s.homeMode && s.homeMode !== "700") {
    add({
      id: "files.home_mode",
      severity: "high",
      message: `${s.home} is mode ${s.homeMode}`,
      fix: `chmod 700 ${s.home}`,
    });
  }
  const sensitive = s.modeIssues.filter((i) => /^(vault|state|audit|cli)(\/|$)/.test(i.path));
  if (sensitive.length) {
    add({
      id: "files.sensitive_modes",
      severity: "high",
      message: `${sensitive.length} vault/state/audit path(s) readable by others`,
      fix: `chmod -R go-rwx ${s.home}`,
    });
  } else if (s.modeIssues.length) {
    add({
      id: "files.modes",
      severity: "medium",
      message: `${s.modeIssues.length} path(s) readable by others`,
      fix: `chmod -R go-rwx ${s.home}`,
    });
  }

  // Real-Chrome mode (I13; security §6): the owner's own Chrome profile on a loopback DevTools
  // port while a task holds it. Any local process that finds the port can drive that profile.
  const rc = s.realChrome.ok ? s.realChrome.value : null;
  if (rc?.attached) {
    add({
      id: "browser.real_chrome_attached",
      severity: "medium",
      message: `real-Chrome mode is attached: your Chrome profile ${rc.userDataDir ?? "(unknown dir)"} is open on DevTools port 127.0.0.1:${rc.port ?? "?"} (pid ${rc.pid ?? "?"}, ${rc.sessions} task(s)${rc.since ? `, since ${rc.since}` : ""}); any local process can drive it until it closes`,
      fix: "It closes when the last task releases it or after 15 minutes idle; stop the task, or turn the mode off (PSYCHE_REAL_CHROME unset)",
    });
  } else if (!s.realChrome.ok) {
    skip("browser.realChrome", s.realChrome);
  }

  // A real Chrome with a debugging port on this machine (any local process can drive it). The
  // Gateway's own real-Chrome port is reported above, not twice.
  if (s.chromeDebugPort && !(rc?.attached && rc.port === 9222)) {
    add({
      id: "browser.chrome_debug_port",
      severity: "high",
      message: "a browser exposes a DevTools endpoint on 127.0.0.1:9222",
      fix: "Quit the browser started with --remote-debugging-port",
    });
  }

  // Egress proxy (security §5.2, K4): sandboxes with network reach only their allowlist through it.
  if (s.sandbox.ok && s.sandbox.value.available && s.sandbox.value.egress === false) {
    add({
      id: "sandbox.egress_off",
      severity: "high",
      message:
        "the sandbox runs without its egress proxy: `network: proxy` sandboxes have nothing enforcing their allowlist",
      fix: "Update the Gateway; the egress proxy is part of every sandbox it composes",
    });
  }

  // MCP servers (security §11): isolation and network reach.
  const mcpServers = s.mcp.ok
    ? s.mcp.value.servers
    : mcpServersFromSettings(setting(s, "mcp.servers"));
  if (s.mcp.ok) {
    const refused = s.mcp.value.servers.filter(
      (x) => x.transport === "stdio" && x.trust !== "bundled",
    );
    if (s.mcp.value.launcher === "none" && refused.length) {
      add({
        id: "mcp.no_launcher",
        severity: "low",
        message: `${refused.length} stdio MCP server(s) are refused: no sandbox launcher (srt or a container) is configured: ${refused.map((x) => x.id).join(", ")}`,
        fix: "Install srt (Settings → Connectors → Set up sandbox), set PSYCHE_SRT_PATH, or PSYCHE_MCP_LAUNCHER=container with a sandbox backend; they never run unsandboxed",
      });
    }
  } else if (mcpServers.length) {
    skip("mcp (launcher)", s.mcp);
  }
  const unknownNet = mcpServers.filter((x) => x.trust === "unknown" && x.network);
  if (unknownNet.length) {
    add({
      id: "mcp.unknown_with_network",
      severity: "medium",
      message: `${unknownNet.length} MCP server(s) of unknown trust reach the network: ${unknownNet.map((x) => x.id).join(", ")}`,
      fix: "Review them, narrow their allowed domains, or remove them (Settings › Connectors › MCP)",
    });
  }

  // Computer use (feature F6; security §12): owner tiers above the fixed caps on banking,
  // password-manager, browser and terminal apps. The caps still apply; the setting is misleading.
  const cuApps = setting(s, "computerUse.apps");
  if (setting(s, "computerUse.enabled") === true && Array.isArray(cuApps)) {
    const over = (cuApps as { id?: unknown; tier?: unknown }[]).filter((a) => {
      if (typeof a?.id !== "string" || typeof a.tier !== "string" || !(a.tier in TIER_RANK))
        return false;
      return TIER_RANK[a.tier as keyof typeof TIER_RANK] > TIER_RANK[appCap(a.id).cap];
    });
    if (over.length) {
      add({
        id: "computer_use.sensitive_override",
        severity: "medium",
        message: `computer-use tiers above the fixed caps for: ${over.map((a) => `${String(a.id)} (${String(a.tier)}, capped at ${appCap(String(a.id)).cap})`).join(", ")}`,
        fix: "Lower them in Settings › Computer use; password managers, banking and system settings always stay off",
      });
    }
  }

  // Real-Chrome mode (I13): consent is per task, with presence; a standing grant must not exist.
  if (rc?.enabled) {
    add({
      id: "browser.real_chrome_enabled",
      severity: "low",
      message:
        "real-Chrome mode is on: tasks may ask to drive your own Chrome profile (each time, with Touch ID or a passkey)",
      fix: "Turn it off in Settings › Browser when you do not need it",
    });
  }
  if (s.grants.ok) {
    const standing = s.grants.value.filter(
      (g) => g.grantKey?.startsWith("real_chrome|") && g.scope !== "once",
    );
    if (standing.length) {
      add({
        id: "browser.real_chrome_standing_grant",
        severity: "high",
        message: `${standing.length} standing real-Chrome grant(s): consent should be asked every time`,
        fix: "Revoke them in Settings › Permissions and report it",
      });
    }
  }

  // Backups (feature U4; security §14): encrypted, and recent.
  if (s.backups.ok) {
    const plain = s.backups.value.filter((b) => !b.encrypted);
    if (plain.length) {
      add({
        id: "backups.unencrypted",
        severity: "medium",
        message: `${plain.length} unencrypted backup(s) in $PSYCHE_HOME/backups hold the vault database and transcripts: ${plain
          .map((b) => b.file)
          .slice(0, 3)
          .join(", ")}`,
        fix: "Delete them and make an encrypted one (psyche backup create)",
      });
    }
    const latest = s.backups.value.reduce<number>(
      (t, b) => Math.max(t, Date.parse(b.createdAt) || 0),
      0,
    );
    if (now.getTime() - latest > 7 * DAY) {
      add({
        id: "backups.stale",
        severity: "low",
        message: latest
          ? `the newest backup is ${Math.floor((now.getTime() - latest) / DAY)} days old`
          : "no backup in $PSYCHE_HOME/backups",
        fix: "psyche backup create (or schedule it: docs/guides/backup-restore.md)",
      });
    }
  } else skip("backups", s.backups);

  // Update manifest verification (security §11), from the desktop's last check.
  if (s.updater.ok) {
    const u = s.updater.value;
    if (u.state === "refused") {
      add({
        id: "updates.refused",
        severity: "high",
        message: `the last update was refused (${u.code ?? "?"}): ${u.reason ?? "verification failed"}`,
        fix: "Do not install updates from elsewhere; download the release from GitHub and check SHA256SUMS, and report it",
      });
    } else if (u.state === "no_keys") {
      add({
        id: "updates.no_release_key",
        severity: "low",
        message: "auto-update is off: this build embeds no release key to verify update manifests",
        fix: "Install a release build; until then update by hand (docs/guides/upgrade.md)",
      });
    }
  } else if (s.platform === "darwin") {
    skip("updates (manifest verification)", s.updater);
  }

  // Device tokens (security §10 "token age").
  if (s.devices.ok) {
    for (const d of s.devices.value) {
      const paired = d.pairedAt ? Date.parse(d.pairedAt) : Number.NaN;
      if (!d.revokedAt && Number.isFinite(paired) && now.getTime() - paired > 365 * DAY) {
        add({
          id: "devices.old_token",
          severity: "low",
          message: `${d.name} (${d.id}) was paired over a year ago`,
          fix: `Re-pair it, or revoke it if unused: psyche devices revoke ${d.id}`,
        });
      }
    }
  }

  // Version (security §10 "outdated version"; no phone-home, so only CLI vs Gateway).
  const gwVersion = s.probe.version?.version;
  if (gwVersion && CLI_VERSION !== "0.0.0" && gwVersion !== "0.0.0" && gwVersion !== CLI_VERSION) {
    add({
      id: "version.mismatch",
      severity: "low",
      message: `the Gateway is ${gwVersion}, this CLI ${CLI_VERSION}`,
      fix: "Upgrade the older one (docs/guides/upgrade.md)",
    });
  }

  // Named in security §10 but with no data source yet: listed, never passed.
  for (const rule of [
    "tls pins (mobile clients)",
    "vm shares",
    "chat surfaces for device-only kinds",
  ]) {
    notChecked.push({ rule, reason: "no data source yet" });
  }

  findings.sort((a, b) => RANK[b.severity] - RANK[a.severity]);
  return { findings, notChecked };
}

/** Exit 1 when anything at `failAt` or above was found. */
export function auditExitCode(report: AuditReport, failAt: Severity = "low"): number {
  return report.findings.some((f) => RANK[f.severity] >= RANK[failAt]) ? 1 : 0;
}

export function parseSeverity(s: string | undefined): Severity {
  const v = (s ?? "low") as Severity;
  if (!Object.hasOwn(RANK, v))
    throw new Error(`severity must be one of ${Object.keys(RANK).join(", ")}`);
  return v;
}

/** `mcp.servers` setting entries → the fields the audit needs (when `mcp.status` is unavailable). */
function mcpServersFromSettings(value: unknown): { id: string; trust: string; network: boolean }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((c) => {
    const x = c as {
      id?: unknown;
      trust?: unknown;
      transport?: { kind?: unknown };
      sandbox?: { allowedDomains?: unknown };
    };
    if (typeof x?.id !== "string") return [];
    const domains = x.sandbox?.allowedDomains;
    return [
      {
        id: x.id,
        trust: typeof x.trust === "string" ? x.trust : "unknown",
        network: x.transport?.kind === "http" || (Array.isArray(domains) && domains.length > 0),
      },
    ];
  });
}
