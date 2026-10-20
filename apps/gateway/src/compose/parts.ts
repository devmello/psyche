import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { type ComposedBrowser, composeBrowser } from "./browser.ts";
import { channelsSetupFromEnv, composeChannels } from "./channels.ts";
import { composeConnectors } from "./connectors.ts";
import { composeHelper } from "./helper.ts";
import { composeSandbox } from "./sandbox.ts";
import type { ComposedPart, ComposeServices } from "./services.ts";

type PartFactory = (services: ComposeServices) => Promise<ComposedPart> | ComposedPart;

/**
 * The INT-2 parts `psyched` mounts, from its environment:
 * - the browser bridge socket (`PSYCHE_BROWSER=off` skips it, e.g. on a server without a desktop);
 * - connectors, with Google's consent page opened in the owner's default browser on macOS. On a
 *   server the link goes to the owner as a notification instead, since the daemon has no screen;
 * - channels: WebChat, and Telegram when `PSYCHE_TELEGRAM_BOT_TOKEN_FILE` (a Compose secret) or
 *   `PSYCHE_TELEGRAM_BOT_TOKEN` and `PSYCHE_TELEGRAM_BOT_USERNAME` are set;
 * - the sandbox runner, announcing dev servers it forwards to the browser's dev preview;
 * - approvals on the Mac through a connected helper's notifications. No presence key is
 *   registered yet (the helper does not sign, S14 issue), so approvals that need Touch ID
 *   stay refused there; Approve / Deny works for the rest.
 */
export function partsFromEnv(env: NodeJS.ProcessEnv): PartFactory[] {
  const parts: PartFactory[] = [];
  /** Set when the browser part is composed (parts are composed in order). */
  let browser: ComposedBrowser | undefined;
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
        ...(devPorts.length === 0 ? {} : { devPreview: { ownerPorts: devPorts } }),
        ...(partition === "profile" || partition === "clean" || partition === "auto"
          ? { partition }
          : {}),
        ...(signedIn.length === 0 ? {} : { signedInOrigins: signedIn }),
      });
      return browser;
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
  parts.push((s) => composeHelper(s));
  // The sandbox runner (K1–K3). Servers an exec leaves listening are forwarded to host loopback
  // and announced to the browser's dev preview (I12); with the browser off there is nothing to
  // announce to, so nothing is forwarded. `PSYCHE_SANDBOX=off` skips the part. Composed after
  // the browser, so it stops first and its servers are reported stopped to a live registry.
  if (env.PSYCHE_SANDBOX !== "off") {
    parts.push((s) =>
      composeSandbox(s, browser === undefined ? {} : { devServers: browser.devServers }),
    );
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
