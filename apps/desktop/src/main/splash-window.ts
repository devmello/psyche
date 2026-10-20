import { existsSync, readFileSync } from "node:fs";
import { BrowserWindow, nativeTheme } from "electron";
import type { SplashStatus, SplashView } from "./splash.ts";

/** The Psyche mark (packages/ui brand.tsx) when the app icon file isn't in this build. */
const MARK_SVG =
  '<svg width="56" height="56" viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="14" fill="none" stroke="currentColor" stroke-width="2.5"/><path d="M16 6v20M9 11c0 5 3 8 7 8s7-3 7-8" fill="none" stroke="currentColor" stroke-width="2.5"/></svg>';

/** The app icon as a data URL, or null (packaged builds keep only the .icns in the bundle). */
export function iconDataUrl(path: string | undefined): string | null {
  if (!path || !existsSync(path)) return null;
  try {
    return `data:image/png;base64,${readFileSync(path).toString("base64")}`;
  } catch {
    return null;
  }
}

/**
 * The splash page: the icon (or the mark), the wordmark, one status line in a polite live region,
 * a thin indeterminate bar (still under reduced motion), and on failure the reason with Show logs
 * and Retry. Type and spacing follow docs/ui-audit.md (system font, 13 px status, 20 px title,
 * an 8 px grid); colours follow the system's light or dark appearance.
 */
export function splashHtml(icon: string | null): string {
  const art = icon ? `<img src="${icon}" width="64" height="64" alt="" />` : MARK_SVG;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:" />
<title>Psyche</title>
<style>
  :root { color-scheme: light dark; --bg: #fbfbfb; --fg: #1c1c1c; --muted: #646464; --track: #e3e3e3; --accent: #5b5bd6; --on-accent: #ffffff; --danger: #c62a2f; }
  @media (prefers-color-scheme: dark) { :root { --bg: #161616; --fg: #ededed; --muted: #a8a8a8; --track: #2e2e2e; --accent: #9b9ef0; --on-accent: #161616; --danger: #ff8a8a; } }
  html, body { margin: 0; height: 100%; background: var(--bg); color: var(--fg); }
  body { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 24px; box-sizing: border-box;
    font: 13px/18px -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif; -webkit-user-select: none; user-select: none; -webkit-app-region: drag; text-align: center; }
  .art { color: var(--fg); margin-bottom: 8px; }
  .art img { display: block; border-radius: 14px; }
  h1 { margin: 0; font-size: 20px; line-height: 26px; font-weight: 600; letter-spacing: -0.01em; }
  #status { margin: 0; color: var(--muted); min-height: 18px; }
  .bar { position: relative; width: 120px; height: 2px; margin-top: 8px; border-radius: 1px; background: var(--track); overflow: hidden; }
  .bar::after { content: ""; position: absolute; inset: 0 auto 0 0; width: 40%; border-radius: 1px; background: var(--accent); animation: slide 1.4s ease-in-out infinite; }
  @keyframes slide { from { transform: translateX(-100%); } to { transform: translateX(250%); } }
  @media (prefers-reduced-motion: reduce) { .bar::after { animation: none; width: 100%; opacity: 0.6; } }
  #error { display: none; flex-direction: column; align-items: center; gap: 8px; }
  #reason { margin: 0; color: var(--danger); max-width: 300px; overflow-wrap: anywhere; }
  .actions { display: flex; gap: 8px; -webkit-app-region: no-drag; }
  button { font: inherit; padding: 4px 12px; border-radius: 6px; border: 1px solid var(--track); background: transparent; color: var(--fg); cursor: pointer; }
  button.primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  body[data-tone="error"] .bar, body[data-tone="ready"] .bar { visibility: hidden; }
  body[data-tone="error"] #error { display: flex; }
</style>
</head>
<body data-tone="progress">
  <div class="art">${art}</div>
  <h1>Psyche</h1>
  <p id="status" role="status" aria-live="polite">Starting the Gateway…</p>
  <div class="bar" aria-hidden="true"></div>
  <div id="error">
    <p id="reason"></p>
    <div class="actions">
      <button type="button" id="logs" hidden>Show logs</button>
      <button type="button" id="retry" class="primary">Retry</button>
    </div>
  </div>
<script>
  let n = 0;
  const act = (name) => { location.hash = name + "-" + ++n; };
  document.getElementById("logs").addEventListener("click", () => act("logs"));
  document.getElementById("retry").addEventListener("click", () => act("retry"));
  window.render = (s) => {
    document.body.dataset.tone = s.tone;
    document.getElementById("status").textContent = s.text;
    document.getElementById("reason").textContent = s.tone === "error" ? s.reason : "";
    document.getElementById("logs").hidden = !(s.tone === "error" && s.canShowLogs);
  };
</script>
</body>
</html>`;
}

/** The splash as an Electron window: frameless, centred, not resizable, never takes focus first. */
export function openSplashWindow(o: { iconPath?: string; devTools?: boolean }): SplashView {
  const dark = nativeTheme.shouldUseDarkColors;
  const win = new BrowserWindow({
    width: 360,
    height: 240,
    center: true,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // Above the main window, which shows (and takes focus) right after; it closes or hands over
    // within seconds.
    alwaysOnTop: true,
    show: false,
    // Input stays with the main window; the splash takes focus only to offer Retry.
    focusable: false,
    backgroundColor: dark ? "#161616" : "#fbfbfb",
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      devTools: o.devTools ?? false,
      spellcheck: false,
    },
  });
  let loaded = false;
  let pending: SplashStatus | null = null;
  let actionCb: ((a: "retry" | "logs") => void) | null = null;
  const push = (s: SplashStatus) => {
    if (win.isDestroyed()) return;
    void win.webContents
      .executeJavaScript(`window.render(${JSON.stringify(s)})`, true)
      .catch(() => undefined);
  };
  win.once("ready-to-show", () => {
    if (!win.isDestroyed()) win.showInactive();
  });
  win.webContents.once("did-finish-load", () => {
    loaded = true;
    if (pending) push(pending);
  });
  // The page reports Retry / Show logs by changing its hash; it has no preload or IPC.
  win.webContents.on("did-navigate-in-page", (_event, url) => {
    const hash = new URL(url).hash.slice(1);
    if (hash.startsWith("retry-")) actionCb?.("retry");
    else if (hash.startsWith("logs-")) actionCb?.("logs");
  });
  void win.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(splashHtml(iconDataUrl(o.iconPath)))}`,
  );
  return {
    render(status) {
      if (win.isDestroyed()) return;
      win.setFocusable(status.tone === "error");
      pending = status;
      if (loaded) push(status);
    },
    close() {
      if (!win.isDestroyed()) win.destroy();
    },
    onAction(cb) {
      actionCb = cb;
    },
  };
}
