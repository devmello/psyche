import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { composeBackup } from "./backup.ts";
import { type ComposedBrowser, composeBrowser } from "./browser.ts";
import { channelsSetupFromEnv, composeChannels } from "./channels.ts";
import { composeConnectors } from "./connectors.ts";
import { composeHelper } from "./helper.ts";
import { composeMcp } from "./mcp.ts";
import { type ComposedSandbox, composeSandboxIfAvailable } from "./sandbox.ts";
import type { ComposedPart, ComposeServices } from "./services.ts";
import { type ComposedVm, composeVm } from "./vm.ts";

type PartFactory = (services: ComposeServices) => Promise<ComposedPart> | ComposedPart;

/**
 * The INT-2 parts `psyched` mounts, from its environment:
 * - the browser bridge socket (`PSYCHE_BROWSER=off` skips it, e.g. on a server without a desktop);
 * - connectors, with Google's consent page opened in the owner's default browser on macOS. On a
 *   server the link goes to the owner as a notification instead, since the daemon has no screen;
 * - channels: WebChat, and Telegram when `PSYCHE_TELEGRAM_BOT_TOKEN_FILE` (a Compose secret) or
 *   `PSYCHE_TELEGRAM_BOT_TOKEN` and `PSYCHE_TELEGRAM_BOT_USERNAME` are set;
 * - backups and the log viewer (`backup.*`, `logs.tail`); `PSYCHE_BACKUP_IDENTITY_FILE` lets
 *   `backup.verify` open recipient-encrypted archives;
 * - approvals on the Mac through a connected helper's notifications. No presence key is
 *   registered yet (the helper does not sign, S14 issue), so approvals that need Touch ID
 *   stay refused there; Approve / Deny works for the rest;
 * - VM mode (`PSYCHE_VM=off` skips it): the sandbox Mac's status as `vm.updated`, and Tasks
 *   whose workspace is `vm` running their commands in the guest;
 * - the sandbox's `exec` tool, only when a container backend is found or VM mode is on
 *   (`PSYCHE_SANDBOX=off` skips it); servers it leaves listening reach the browser's preview;
 * - the MCP host (`mcp.servers` in settings; `PSYCHE_MCP=off` skips it): stdio servers under
 *   `srt` at `PSYCHE_SRT_PATH`, or each in its own sandbox container with
 *   `PSYCHE_MCP_LAUNCHER=container` (needs the sandbox part; network only through its egress
 *   proxy and the server's allowlist); without either only HTTP servers run.
 */
export function partsFromEnv(env: NodeJS.ProcessEnv): PartFactory[] {
  const parts: PartFactory[] = [];
  let browser: ComposedBrowser | undefined;
  let sandbox: ComposedSandbox | undefined;
  let vm: ComposedVm | undefined;
  if (env.PSYCHE_BROWSER !== "off") {
    // Logged out by default (I15). `PSYCHE_BROWSER_PARTITION=profile|clean|auto` and the
    // comma-separated `PSYCHE_BROWSER_SIGNED_IN_ORIGINS` (used by `auto`) stand in until
    // Settings → Browser (S11) holds them.
    const partition = env.PSYCHE_BROWSER_PARTITION;
    const signedIn = (env.PSYCHE_BROWSER_SIGNED_IN_ORIGINS ?? "")
      .split(",")
      .map((o) => o.trim())
      .filter((o) => o !== "");
    // Dev preview (I12): the loopback ports the owner allowlists, until Settings → Browser
    // and the sandbox's own server registrations exist.
    const devPorts = (env.PSYCHE_DEV_PREVIEW_PORTS ?? "")
      .split(",")
      .map((p) => Number.parseInt(p.trim(), 10))
      .filter((p) => Number.isInteger(p) && p > 0 && p < 65_536);
    parts.push((s) => {
      browser = composeBrowser(s, {
        record: env.PSYCHE_BROWSER_RECORD === "1",
        // Real-Chrome mode (I13) is off unless the owner turns it on; each task still asks.
        ...(env.PSYCHE_REAL_CHROME === "1"
          ? {
              realChrome: {
                enabled: true,
                ...(env.PSYCHE_REAL_CHROME_PROFILE === undefined
                  ? {}
                  : { profile: env.PSYCHE_REAL_CHROME_PROFILE }),
              },
            }
          : {}),
        ...(devPorts.length === 0 ? {} : { devPreview: { ownerPorts: devPorts } }),
        ...(partition === "profile" || partition === "clean" || partition === "auto"
          ? { partition }
          : {}),
        ...(signedIn.length === 0 ? {} : { signedInOrigins: signedIn }),
      });
      return browser;
    });
  }
  if (env.PSYCHE_VM !== "off") {
    // VM mode (L1–L5): idle until the owner turns it on (`vm.enabled`) and a helper reports.
    parts.push((s) => {
      vm = composeVm(s);
      return vm;
    });
  }
  if (env.PSYCHE_SANDBOX !== "off") {
    // Parts compose in order, so the browser (when mounted) exists by now.
    parts.push(async (s) => {
      const part = await composeSandboxIfAvailable(s, {
        ...(browser === undefined ? {} : { devServers: browser.devServers }),
        ...(vm === undefined ? {} : { vm }),
      });
      if ("runner" in part) sandbox = part as ComposedSandbox;
      return part;
    });
  }
  parts.push((s) =>
    composeConnectors(s, {
      openBrowser: (url) => openConsent(s, url),
    }),
  );
  // Read (and validated) at boot, so a bad token file stops psyched instead of a silent channel.
  const channels = channelsSetupFromEnv(env, (path) => readFileSync(path, "utf8"));
  parts.push((s) => composeChannels(s, channels));
  // Touch ID answers verify against keys the owner registers (devices.presenceKey.*, #253).
  parts.push((s) => composeHelper(s));
  parts.push((s) =>
    composeBackup(s, {
      ...(env.PSYCHE_BACKUP_IDENTITY_FILE ? { identityFile: env.PSYCHE_BACKUP_IDENTITY_FILE } : {}),
    }),
  );
  if (env.PSYCHE_MCP !== "off") {
    parts.push((s) => {
      const runner = sandbox?.runner;
      const egress = sandbox?.egress;
      return composeMcp(s, {
        // The sandbox part's runner (not disposed by the MCP part) and its egress allowlists.
        ...(env.PSYCHE_MCP_LAUNCHER === "container" && runner !== undefined && egress !== undefined
          ? {
              container: {
                ensureSandbox: (scope, options) => runner.ensureSandbox(scope, options),
                openStdio: (id, options) => runner.openStdio(id, options),
              },
              egressAllowlist: (scope, hosts) => egress.egressAllowlist(scope, hosts),
            }
          : env.PSYCHE_SRT_PATH
            ? { srtPath: env.PSYCHE_SRT_PATH }
            : {}),
      });
    });
  }
  return parts;
}

function openConsent(services: ComposeServices, url: URL): void {
  if (url.protocol !== "https:") return;
  if (process.platform === "darwin") {
    execFile("open", [url.href], () => undefined);
    return;
  }
  // The link holds the PKCE challenge and state, never a secret; the loopback redirect only
  // completes on the machine running psyched.
  void services.notifier
    .notify({
      kind: "system",
      route: "/settings/connectors",
      title: "Finish connecting Google",
      body: `Open this link on the computer running Psyche to grant access: ${url.href}`,
      dedupeKey: `connector:consent:${url.searchParams.get("state") ?? ""}`,
    })
    .catch(() => undefined);
}
