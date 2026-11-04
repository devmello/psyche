import { BrowserWindow, session } from "electron";
import type { WebAuthnWindow } from "./passkey-host.ts";

/**
 * The hidden window `PasskeyHost` runs a WebAuthn ceremony in: a page of the Gateway's own origin
 * (so the platform authenticator sees the right site), with nothing of this app in it. A
 * partition of its own keeps it away from the app's session, no preload and no Node reach it,
 * every permission and popup is refused, and it cannot navigate off the Gateway's origin.
 */
export function createPasskeyWindow(origin: string): WebAuthnWindow {
  const ses = session.fromPartition("psyche-webauthn");
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
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
  const here = new URL(origin).origin;
  const contents = win.webContents;
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== here) event.preventDefault();
  });
  return {
    load: (url) => contents.loadURL(url),
    // `true`: the call counts as a user gesture, which the platform authenticator requires.
    run: (script) => contents.executeJavaScript(script, true) as Promise<unknown>,
    close: () => {
      if (!win.isDestroyed()) win.destroy();
    },
  };
}
