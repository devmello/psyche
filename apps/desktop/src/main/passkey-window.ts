import { BrowserWindow, session } from "electron";
import { PASSKEY_PAGE_HTML, PASSKEY_PAGE_PATH, type WebAuthnWindow } from "./passkey-host.ts";

/** Electron's reserved world is 999; this one is ours, so the page's own scripts can't reach it. */
const WORLD_ID = 1999;

/**
 * The hidden window `PasskeyHost` runs a WebAuthn ceremony in: a page of the Gateway's own origin
 * (so the platform authenticator sees the right site) that this process serves itself, so no
 * content, script or redirect from the Host is ever loaded. A partition of its own keeps it away
 * from the app's session; no preload and no Node reach it; every permission, popup, download and
 * navigation (redirects included) other than that one page is refused. The ceremony script runs
 * in an isolated world, out of reach of anything the page could have patched.
 */
export function createPasskeyWindow(origin: string): WebAuthnWindow {
  const here = new URL(origin).origin;
  const pageUrl = new URL(PASSKEY_PAGE_PATH, here).toString();
  const ses = session.fromPartition("psyche-webauthn");
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.on("will-download", (event) => event.preventDefault());
  // Nothing leaves this process: the one page is answered here, everything else is refused.
  ses.protocol.handle("https", (request) =>
    request.url === pageUrl
      ? new Response(PASSKEY_PAGE_HTML, { headers: { "content-type": "text/html; charset=utf-8" } })
      : new Response("", { status: 404 }),
  );
  ses.webRequest.onBeforeRequest((details, callback) =>
    callback({ cancel: details.url !== pageUrl }),
  );
  const win = new BrowserWindow({
    show: false,
    width: 480,
    height: 320,
    skipTaskbar: true,
    webPreferences: {
      session: ses,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
  const contents = win.webContents;
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  for (const ev of ["will-navigate", "will-redirect", "will-frame-navigate"] as const) {
    contents.on(ev, (event: { url: string; preventDefault(): void }) => {
      if (event.url !== pageUrl) event.preventDefault();
    });
  }
  return {
    load: (url) => contents.loadURL(url),
    currentUrl: () => contents.getURL(),
    // `true`: the call counts as a user gesture, which the platform authenticator requires.
    run: (script) =>
      contents.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code: script }], true) as Promise<unknown>,
    close: () => {
      if (!win.isDestroyed()) win.destroy();
    },
  };
}
