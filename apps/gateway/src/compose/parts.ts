import { lstatSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PsycheError } from "@psyche/protocol";
import { isNamedPipePath } from "@psyche/protocol/platform";
import { type GoogleClientConfig, googleClientFrom, readConfigFile } from "../config.ts";
import { openExternalUrl } from "../platform.ts";
import { composeBackup } from "./backup.ts";
import { type ComposedBrowser, composeBrowser } from "./browser.ts";
import {
  readDetectedDomains,
  readSignedInOrigins,
  resolveBrowserAgentSettings,
} from "./browser-agent-settings.ts";
import { serverBrowserSetupFor } from "./browser-server.ts";
import { channelsSetupFromEnv, composeChannels } from "./channels.ts";
import { composeCoding } from "./coding.ts";
import { composeConnectors } from "./connectors.ts";
import { usesSandboxPc } from "./guest-sandbox.ts";
import { hostGraphicalSession } from "./headless-host.ts";
import { composeHelper } from "./helper.ts";
import { composeMcp } from "./mcp.ts";
import { composeMemoryGit } from "./memory-git.ts";
import { composePasswordPresence } from "./password-presence.ts";
import { type ComposedSandbox, composeSandboxIfAvailable, type SandboxSetup } from "./sandbox.ts";
import type { ComposedPart, ComposeServices } from "./services.ts";
import { createSrtResolver, type SrtResolver } from "./srt.ts";
import { composeStorage } from "./storage.ts";
import { type ComposedVm, composeVm } from "./vm.ts";

type PartFactory = (services: ComposeServices) => Promise<ComposedPart> | ComposedPart;

/**
 * The INT-2 parts `psyched` mounts, from its environment:
 * - the browser bridge socket (`PSYCHE_BROWSER=off` skips it, e.g. on a server without a desktop);
 * - connectors, with Google's consent page opened in the owner's default browser on macOS. On a
 *   server the link goes to the owner as a notification instead, since the daemon has no screen.
 *   Google needs the owner's OAuth client (`connectors.google` in `config.json`, or
 *   `PSYCHE_GOOGLE_CLIENT_ID` / `PSYCHE_GOOGLE_CLIENT_SECRET`; `googleClientSetup`);
 * - channels: WebChat, and Telegram when `PSYCHE_TELEGRAM_BOT_TOKEN_FILE` (a Compose secret) or
 *   `PSYCHE_TELEGRAM_BOT_TOKEN` and `PSYCHE_TELEGRAM_BOT_USERNAME` are set, and SMS (Twilio) when
 *   the `PSYCHE_SMS_*` variables are (`smsSetupFromEnv`);
 * - backups and the log viewer (`backup.*`, `logs.tail`); `PSYCHE_BACKUP_IDENTITY_FILE` lets
 *   `backup.verify` open recipient-encrypted archives;
 * - approvals on the Mac through a connected helper's notifications. Approvals that need
 *   presence raise the helper's one owner sheet (Touch ID or the Mac password) and are signed
 *   by the helper's device key; Approve / Deny works for the rest;
 * - VM mode (`PSYCHE_VM=off` skips it): the sandbox Mac's status as `vm.updated`, and Tasks
 *   whose workspace is `vm` running their commands in the guest;
 * - the sandbox's `exec` tool, only when a container backend is found or VM mode is on
 *   (`PSYCHE_SANDBOX=off` skips it); servers it leaves listening reach the browser's preview;
 * - the coding helper (V10, `code.*`; `PSYCHE_CODING=off` skips it): repositories in granted
 *   folders, `code.run` in the sandbox part's runner when there is one, host git without hooks;
 * - the MCP host (`mcp.servers` in settings; `PSYCHE_MCP=off` skips it): stdio servers under
 *   `srt` (`PSYCHE_SRT_PATH`, the `exec.srtPath` setting, or found on this Mac; looked up at each
 *   launch), or each in its own sandbox container with
 *   `PSYCHE_MCP_LAUNCHER=container` (needs the sandbox part; network only through its egress
 *   proxy and the server's allowlist); without either only HTTP servers run.
 */
/**
 * The Google OAuth client (docs/guides/connectors-google.md): `connectors.google` in
 * `config.json`, with `PSYCHE_GOOGLE_CLIENT_ID` / `PSYCHE_GOOGLE_CLIENT_SECRET` taking precedence.
 * The secret is only ever a `{{cred:slug}}` placeholder; a raw one stops the Gateway at boot.
 */
export function googleClientSetup(
  env: NodeJS.ProcessEnv,
  file: GoogleClientConfig | undefined,
): GoogleClientConfig {
  const fromEnv = googleClientFrom(
    {
      ...(env.PSYCHE_GOOGLE_CLIENT_ID ? { clientId: env.PSYCHE_GOOGLE_CLIENT_ID } : {}),
      ...(env.PSYCHE_GOOGLE_CLIENT_SECRET ? { clientSecret: env.PSYCHE_GOOGLE_CLIENT_SECRET } : {}),
    },
    "PSYCHE_GOOGLE_CLIENT_*",
  );
  return { ...(file ?? {}), ...fromEnv };
}

/**
 * Where the browser bridge listens: `PSYCHE_BROWSER_BRIDGE_SOCKET` when set, else the default
 * `$PSYCHE_HOME/run/browser-bridge.sock`. The desktop shell reads the same variable (its
 * `main.ts`), so both ends agree; without this a deep `$PSYCHE_HOME` could not be worked around.
 */
export function bridgeSocketSetup(env: NodeJS.ProcessEnv): { socketPath?: string } {
  const path = env.PSYCHE_BROWSER_BRIDGE_SOCKET?.trim();
  if (!path) return {};
  checkBridgeSocketDir(path);
  return { socketPath: path };
}

/**
 * Refuses, while the Gateway is still composing (before it says "listening"), a bridge socket in
 * a directory the bridge would later refuse: a shared one such as `/tmp`, a symlink, or one owned
 * by someone else. A missing directory is fine: the bridge creates it private (0700).
 */
function checkBridgeSocketDir(socketPath: string): void {
  if (isNamedPipePath(socketPath)) return;
  const dir = dirname(socketPath);
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(dir);
  } catch {
    return;
  }
  const uid = process.getuid?.();
  if (info.isSymbolicLink() || !info.isDirectory() || (uid !== undefined && info.uid !== uid)) {
    throw new PsycheError(
      "invalid_params",
      `PSYCHE_BROWSER_BRIDGE_SOCKET=${socketPath}: ${dir} is not a private directory of yours; use a path in a directory you own (or unset it)`,
    );
  }
}

export { readDetectedDomains, readSignedInOrigins };

export function partsFromEnv(
  env: NodeJS.ProcessEnv,
  /** Test seam: runner options for the sandbox part (a fake CLI driver and detection). */
  overrides: { sandboxRunner?: SandboxSetup["runner"] } = {},
): PartFactory[] {
  const parts: PartFactory[] = [];
  let browser: ComposedBrowser | undefined;
  let sandbox: ComposedSandbox | undefined;
  let vm: ComposedVm | undefined;
  // One `srt` lookup for every part that runs host commands under it (MCP, sandbox status).
  let srt: SrtResolver | undefined;
  const srtFor = (s: ComposeServices) => {
    // The Gateway composes one (`services.srt`); a part list built without it makes its own.
    srt ??= s.srt ?? createSrtResolver(s, env);
    return srt;
  };
  if (env.PSYCHE_BROWSER !== "off") {
    // Logged out by default (I15). The sign-in mode, the signed-in sites and the dev-preview ports
    // come from Settings → Browser, or from the PSYCHE_BROWSER_PARTITION,
    // PSYCHE_BROWSER_SIGNED_IN_ORIGINS and PSYCHE_DEV_PREVIEW_PORTS env vars when those are set
    // (a development override). Each is read on every use, so a change applies at once.
    parts.push((s) => {
      browser = composeBrowser(s, {
        record: env.PSYCHE_BROWSER_RECORD === "1",
        ...bridgeSocketSetup(env),
        // A headless Linux Host (B3): headless Chromium, decided by the service env's
        // `PSYCHE_BROWSER_DRIVER` or B0's logind answer. Off on every other platform.
        server: serverBrowserSetupFor(process.platform, env, hostGraphicalSession()),
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
        ownerDevPorts: () => resolveBrowserAgentSettings(s.db, env).devPreviewPorts.value,
        partition: () => resolveBrowserAgentSettings(s.db, env).partition.value,
        // Read on every new session: Settings → Browser and "Stay signed in" change the list
        // while the Gateway runs (desktop writes `browser/signed-in.json`).
        signedInOrigins: () => [
          ...new Set([
            ...resolveBrowserAgentSettings(s.db, env).signedInOrigins.value,
            ...readSignedInOrigins(s.home),
          ]),
        ],
        detectedDomains: () => readDetectedDomains(s.home),
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
        srt: srtFor(s),
        ...(overrides.sandboxRunner === undefined ? {} : { runner: overrides.sandboxRunner }),
        ...(browser === undefined ? {} : { devServers: browser.devServers }),
        ...(vm === undefined ? {} : { vm }),
      });
      if ("runner" in part) sandbox = part as ComposedSandbox;
      return part;
    });
  }
  if (env.PSYCHE_CODING !== "off") {
    // After the sandbox part: `code.run` needs its container runner (VM mode alone has none).
    parts.push(async (s) => {
      const containers = (await sandbox?.runner.backends().catch(() => []))?.length ?? 0;
      return composeCoding(
        s,
        sandbox === undefined || containers === 0
          ? {}
          : { runner: sandbox.runner, track: sandbox.track },
      );
    });
  }
  // Checked at boot: a raw client secret in the environment stops psyched here.
  googleClientSetup(env, undefined);
  parts.push((s) =>
    composeConnectors(s, {
      openBrowser: (url) => openConsent(s, url),
      google: googleClientSetup(
        env,
        readConfigFile(join(s.home, "config.json")).connectors?.google,
      ),
    }),
  );
  // Read (and validated) at boot, so a bad token file stops psyched instead of a silent channel.
  const channels = channelsSetupFromEnv(env, (path) => readFileSync(path, "utf8"));
  parts.push((s) => composeChannels(s, channels));
  // Touch ID answers verify against the Mac helper's own device key (nothing to register); a
  // Windows helper's Windows Hello key is registered with devices.presenceKey.*.
  parts.push((s) => composeHelper(s));
  // Linux: the owner's password through polkit (linux design §9). Inert elsewhere.
  parts.push((s) => composePasswordPresence(s));
  parts.push((s) =>
    composeBackup(s, {
      ...(env.PSYCHE_BACKUP_IDENTITY_FILE ? { identityFile: env.PSYCHE_BACKUP_IDENTITY_FILE } : {}),
    }),
  );
  parts.push((s) => composeStorage(s));
  // Git backup of the workspace (`memory.gitSync.*`); the owner's own repository and credentials.
  parts.push((s) => composeMemoryGit(s));
  if (env.PSYCHE_MCP !== "off") {
    parts.push((s) => {
      const runner = sandbox?.runner;
      const egress = sandbox?.egress;
      // srt first (Seatbelt, no VM): found at each launch, so installing it or choosing it in
      // Settings needs no restart. `PSYCHE_MCP_LAUNCHER=container` asks for containers instead.
      // On Windows, where srt cannot run, the sandbox PC's guest is the launcher (VM mode).
      const container = env.PSYCHE_MCP_LAUNCHER === "container";
      const guest = vm;
      return composeMcp(s, {
        // The sandbox part's runner (not disposed by the MCP part) and its egress allowlists.
        ...(container && runner !== undefined && egress !== undefined
          ? {
              container: {
                ensureSandbox: (scope, options) => runner.ensureSandbox(scope, options),
                openStdio: (id, options) => runner.openStdio(id, options),
              },
              egressAllowlist: (scope, hosts) => egress.egressAllowlist(scope, hosts),
            }
          : usesSandboxPc() && guest !== undefined
            ? {
                vm: {
                  ready: () => guest.runner.canIsolate(),
                  ensureSandbox: (scope) => guest.runner.ensureSandbox(scope),
                  openStdio: (id, options) => guest.runner.openStdio(id, options),
                },
              }
            : { srt: srtFor(s) }),
      });
    });
  }
  return parts;
}

function openConsent(services: ComposeServices, url: URL): void {
  if (url.protocol !== "https:") return;
  // macOS `open`, Windows `rundll32 url.dll,FileProtocolHandler` (no shell): the owner's browser
  // on the computer running psyched, where the loopback redirect lands.
  if (openExternalUrl(url)) return;
  // The link holds the PKCE challenge and state, never a secret; the loopback redirect only
  // completes on the machine running psyched.
  void services.notifier
    .notify({
      kind: "system",
      route: "/settings/connectors",
      message: {
        titleKey: "notice.connector.consent.title",
        bodyKey: "notice.connector.consent.body",
        params: { url: url.href },
      },
      title: "Finish connecting Google",
      body: `Open this link on the computer running Psyche to grant access: ${url.href}`,
      dedupeKey: `connector:consent:${url.searchParams.get("state") ?? ""}`,
    })
    .catch(() => undefined);
}
