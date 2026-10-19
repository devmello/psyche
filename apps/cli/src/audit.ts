import { isLoopbackHost } from "./paths.ts";
import { type Snapshot, setting } from "./snapshot.ts";

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
  } else skip("devices", s.devices);

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

  // A real Chrome with a debugging port on this machine (any local process can drive it).
  if (s.chromeDebugPort) {
    add({
      id: "browser.chrome_debug_port",
      severity: "high",
      message: "a browser exposes a DevTools endpoint on 127.0.0.1:9222",
      fix: "Quit the browser started with --remote-debugging-port",
    });
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
