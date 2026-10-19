import { PROTOCOL_VERSION } from "@psyche/protocol";
import { bytes } from "./output.ts";
import { isLoopbackHost } from "./paths.ts";
import { type Snapshot, setting } from "./snapshot.ts";

/** One `psyche doctor` check (architecture §14; feature A10 "done when"). */
export interface Check {
  id: string;
  status: "ok" | "warn" | "fail" | "skip";
  message: string;
  hint?: string;
}

const SENSITIVE = /^(vault|state|audit|cli)(\/|$)/;

/** Pure: snapshot → checks. Order is the order printed. */
export function doctorChecks(s: Snapshot): Check[] {
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);

  // Config validity.
  if (s.config.problems.length) {
    add({
      id: "config",
      status: "fail",
      message: `config.json: ${s.config.problems.join("; ")}`,
      hint: "Fix it with `psyche config set` or edit $PSYCHE_HOME/config.json",
    });
  } else {
    add({
      id: "config",
      status: "ok",
      message: s.config.exists ? "config.json is valid" : "no config.json (defaults)",
    });
  }

  // Gateway reachability and version.
  if (!s.probe.reachable) {
    add({
      id: "gateway",
      status: "fail",
      message: `Gateway not reachable at ${s.gatewayUrl}${s.probe.error ? ` (${s.probe.error})` : ""}`,
      hint: "psyche start",
    });
  } else if (!s.probe.healthy) {
    add({
      id: "gateway",
      status: "fail",
      message: `Gateway at ${s.gatewayUrl} answers but /healthz is not ok`,
    });
  } else {
    add({ id: "gateway", status: "ok", message: `Gateway healthy at ${s.gatewayUrl}` });
    const pv = s.probe.version?.protocolVersion;
    if (pv !== undefined && pv !== PROTOCOL_VERSION) {
      add({
        id: "protocol",
        status: "warn",
        message: `Gateway speaks protocol ${pv}, this CLI ${PROTOCOL_VERSION}`,
        hint: "Update the CLI or the Gateway",
      });
    }
  }

  // Bind address.
  const host =
    s.config.config.gateway && typeof s.config.config.gateway === "object"
      ? (s.config.config.gateway as Record<string, unknown>).host
      : undefined;
  if (typeof host === "string" && !isLoopbackHost(host)) {
    add({
      id: "bind",
      status: "fail",
      message: `gateway.host is ${host}; the Gateway binds loopback only and will refuse to start`,
      hint: "psyche config set gateway.host 127.0.0.1, and use Tailscale Serve or Cloudflare Access for remote access",
    });
  } else {
    add({
      id: "bind",
      status: "ok",
      message: `binds ${typeof host === "string" ? host : "127.0.0.1"} (loopback)`,
    });
  }

  // Auth: this CLI's pairing, trusted-proxy mode.
  if (s.connection.paired) {
    add({ id: "auth", status: "ok", message: `CLI paired with ${s.connection.scopes.join(", ")}` });
  } else if (s.connection.error) {
    const pending = s.connection.error.code === "pairing";
    add({ id: "auth", status: pending ? "warn" : "fail", message: s.connection.error.message });
  } else if (s.probe.reachable) {
    add({ id: "auth", status: "skip", message: "not connected" });
  }
  const tp =
    setting(s, "gateway.trustedProxy.enabled") ??
    (s.config.config.gateway as Record<string, Record<string, unknown>> | undefined)?.trustedProxy
      ?.enabled;
  if (tp === true)
    add({
      id: "auth.proxy",
      status: "ok",
      message: "trusted-proxy mode on (identity headers unlock passkey login only)",
    });

  // Sandbox backend.
  if (s.sandbox.ok) {
    add(
      s.sandbox.value.available
        ? { id: "sandbox", status: "ok", message: `sandbox backend ${s.sandbox.value.backend}` }
        : {
            id: "sandbox",
            status: "fail",
            message: `sandbox backend ${s.sandbox.value.backend} is not available; code execution is off`,
            hint: "Install Apple container (macOS 26+), Colima/Docker or Podman",
          },
    );
  } else if (s.localSandboxBackends.length) {
    add({
      id: "sandbox",
      status: "ok",
      message: `local backends: ${s.localSandboxBackends.join(", ")} (Gateway did not report its own)`,
    });
  } else {
    add({
      id: "sandbox",
      status: "warn",
      message: "no container runtime found (container, docker, podman)",
      hint: "Install one; Psyche never falls back to the host shell",
    });
  }

  // Models.
  const keys = s.apiKeys.ok ? s.apiKeys.value.length : 0;
  if (keys > 0 || s.localModel) {
    const parts = [
      keys ? `${keys} provider key(s) in the vault` : "",
      s.localModel ? "local Ollama answers on 127.0.0.1:11434" : "",
    ].filter(Boolean);
    add({ id: "models", status: "ok", message: parts.join("; ") });
  } else if (!s.apiKeys.ok) {
    add({
      id: "models",
      status: "skip",
      message: `provider keys unknown (${s.apiKeys.message}); no local model server on 127.0.0.1:11434`,
    });
  } else {
    add({
      id: "models",
      status: "warn",
      message: "no model provider: no API key in the vault and no local model server",
      hint: "psyche vault add Anthropic --kind api_key --bind https://api.anthropic.com",
    });
  }

  // Permissions from the mac helper.
  if (s.platform === "darwin") {
    if (!s.nodes.ok) {
      add({
        id: "helper",
        status: "skip",
        message: `mac helper status unknown (${s.nodes.message})`,
      });
    } else {
      const helper = s.nodes.value.find((n) => n.kind === "mac-helper");
      add(
        helper && helper.status === "online"
          ? {
              id: "helper",
              status: "ok",
              message: `mac helper online with ${helper.capabilities.length} capabilities`,
            }
          : {
              id: "helper",
              status: "warn",
              message: helper
                ? `mac helper is ${helper.status}`
                : "mac helper not connected (computer use, notifications and Keychain unavailable)",
              hint: "Open the Psyche app and grant its permissions in Settings › Permissions",
            },
      );
    }
  }

  // Vault.
  if (s.vault.ok) {
    const v = s.vault.value;
    if (v.state === "uninitialized")
      add({ id: "vault", status: "warn", message: "vault not set up", hint: "psyche onboard" });
    else if (!v.recoveryConfirmed)
      add({
        id: "vault",
        status: "warn",
        message: "recovery key not confirmed; restoring a backup elsewhere needs it",
      });
    else add({ id: "vault", status: "ok", message: `vault ${v.state}, ${v.itemCount} item(s)` });
  }

  // Disk.
  if (s.disk) {
    const free = s.disk.freeBytes;
    const status = free < 1 << 30 ? "fail" : free < 5 * (1 << 30) ? "warn" : "ok";
    add({ id: "disk", status, message: `${bytes(free)} free on the volume holding ${s.home}` });
  }

  // File modes.
  const sensitive = s.modeIssues.filter((i) => SENSITIVE.test(i.path));
  if (s.homeMode && s.homeMode !== "700") {
    add({
      id: "modes",
      status: "fail",
      message: `${s.home} is mode ${s.homeMode}, want 700`,
      hint: `chmod 700 ${s.home}`,
    });
  } else if (sensitive.length) {
    add({
      id: "modes",
      status: "fail",
      message: `${sensitive.length} sensitive path(s) readable by others: ${sensitive
        .slice(0, 3)
        .map((i) => `${i.path} (${i.mode})`)
        .join(", ")}`,
      hint: `chmod -R go-rwx ${s.home}`,
    });
  } else if (s.modeIssues.length) {
    add({
      id: "modes",
      status: "warn",
      message: `${s.modeIssues.length} path(s) under ${s.home} readable by others`,
      hint: `chmod -R go-rwx ${s.home}`,
    });
  } else if (s.homeMode) {
    add({ id: "modes", status: "ok", message: "file modes 0700/0600" });
  }

  // Service.
  if (s.service && s.service.kind !== "none") {
    add(
      s.service.running
        ? { id: "service", status: "ok", message: `${s.service.kind} service running` }
        : {
            id: "service",
            status: s.probe.healthy ? "ok" : "warn",
            message: `${s.service.kind} service not running${s.probe.healthy ? " (a Gateway is running outside it)" : ""}`,
            ...(s.probe.healthy ? {} : { hint: "psyche start" }),
          },
    );
  }
  return checks;
}

export function doctorExitCode(checks: readonly Check[], strict: boolean): number {
  if (checks.some((c) => c.status === "fail")) return 1;
  if (strict && checks.some((c) => c.status === "warn")) return 1;
  return 0;
}
