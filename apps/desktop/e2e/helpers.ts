import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";

/**
 * Windows: stops the host helper that the app under test started from this repo's Rust build
 * (`apps/win-helper/target`). The app launches it detached, but it inherits the pipes Playwright
 * reads the app's output from, so `app.close()` would wait for the helper to exit, which it never
 * does by itself. Only processes running from this checkout's build are touched (never an
 * installed Psyche's helper). Call before `app.close()`.
 */
export function stopTestHelpers(appDir: string): void {
  if (process.platform !== "win32") return;
  const target = resolve(appDir, "..", "win-helper", "target").replaceAll("'", "''");
  spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Get-CimInstance Win32_Process -Filter "Name='psyche-helper.exe'" | Where-Object { $_.ExecutablePath -like '${target}\\*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`,
    ],
    { windowsHide: true },
  );
}

/** Routes of the small windows (panel.html): the screen-ask panel, its overlay, the dictation HUD. */
const PANEL_ROUTES = ["/screen-ask", "/screen-ask-region", "/dictation-hud"];

const isPanel = (p: Page): boolean => {
  try {
    return PANEL_ROUTES.includes(new URL(p.url()).pathname);
  } catch {
    return false;
  }
};

/**
 * The main window's page. `app.firstWindow()` is whichever window opened first, and on Windows
 * the hidden screen-ask panel is warmed before the main window's page exists, so pick by route.
 */
export async function mainWindowPage(app: ElectronApplication, timeoutMs = 30_000): Promise<Page> {
  await app.firstWindow();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = app
      .windows()
      .find((p) => !isPanel(p) && p.url() !== "" && p.url() !== "about:blank");
    if (found) return found;
    if (Date.now() > deadline) throw new Error("the main window never opened");
    await new Promise((r) => setTimeout(r, 50));
  }
}
