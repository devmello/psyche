import { execFile } from "node:child_process";
import { composeBrowser } from "./browser.ts";
import { composeConnectors } from "./connectors.ts";
import type { ComposedPart, ComposeServices } from "./services.ts";

type PartFactory = (services: ComposeServices) => Promise<ComposedPart> | ComposedPart;

/**
 * The INT-2 parts `psyched` mounts, from its environment:
 * - the browser bridge socket (`PSYCHE_BROWSER=off` skips it, e.g. on a server without a desktop);
 * - connectors, with Google's consent page opened in the owner's default browser on macOS. On a
 *   server the link goes to the owner as a notification instead, since the daemon has no screen.
 */
export function partsFromEnv(env: NodeJS.ProcessEnv): PartFactory[] {
  const parts: PartFactory[] = [];
  if (env.PSYCHE_BROWSER !== "off") {
    parts.push((s) => composeBrowser(s, { record: env.PSYCHE_BROWSER_RECORD === "1" }));
  }
  parts.push((s) =>
    composeConnectors(s, {
      openBrowser: (url) => openConsent(s, url),
    }),
  );
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
