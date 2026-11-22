import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test,
} from "@playwright/test";
import { MockGateway } from "@psyche/web/testing";
import { mainWindowPage, stopTestHelpers } from "./helpers.ts";

/**
 * Windows-only behaviour of the desktop shell, against the mock Gateway: the overlay title bar, the
 * tray (closing the window keeps the app, a second launch brings the window back), quick entry on
 * its global shortcut, and Settings → Sandbox PC and About → Uninstall. Nothing here installs
 * anything, registers a scheduled task or touches the real `%USERPROFILE%\.psyche`: the Gateway
 * is the mock, `PSYCHE_HOME` and the profile live in a temp folder, and the Uninstall sheet is
 * opened but never confirmed (its plan is stubbed in the main process).
 */
test.skip(process.platform !== "win32", "Windows chrome, tray and installer behaviour");
test.describe.configure({ mode: "serial" });

const appDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const T0 = "2026-10-19T10:00:00.000Z";
const MAIN_THREAD = {
  id: "01JBXY6Q8Z0000000000000001",
  kind: "main",
  title: "Main chat",
  titleSource: "auto",
  parentThreadId: null,
  forkedFromMessageId: null,
  sessionKey: "owner:main",
  personaOverlay: null,
  permissionMode: "balanced",
  modelRef: null,
  pinned: false,
  archivedAt: null,
  expiresAt: null,
  activeWriterRunId: null,
  createdAt: T0,
  updatedAt: T0,
  lastMessageAt: null,
};

interface Launched {
  app: ElectronApplication;
  page: Page;
  gw: MockGateway;
  env: Record<string, string>;
  dir: string;
}

/** The app against a fresh mock Gateway and profile; `env` adds to the launch environment. */
async function launch(
  extraEnv: Record<string, string> = {},
  extraSettings: Record<string, unknown> = {},
): Promise<Launched> {
  const dir = mkdtempSync(join(tmpdir(), "psy-e2e-win-"));
  const home = join(dir, "h");
  mkdirSync(join(home, "run"), { recursive: true });
  writeFileSync(join(home, "run", "handshake.secret"), "e2e-handshake-secret");
  const gw = await new MockGateway({
    handshakeSecret: "e2e-handshake-secret",
    handlers: {
      "threads.list": () => ({
        threads: [
          { thread: MAIN_THREAD, activity: { running: 0, awaitingInput: 0, awaitingApproval: 0 } },
        ],
        nextCursor: null,
      }),
      "chat.history": () => ({ messages: [], nextCursor: null }),
      "nodes.list": () => ({ nodes: [] }),
      "settings.get": () => ({
        settings: { "ui.onboarding.completedAt": "2026-10-19T09:00:00.000Z", ...extraSettings },
        stateVersion: 1,
      }),
      "settings.set": (params) => {
        const p = params as { key: string; value: unknown };
        return { entry: { key: p.key, value: p.value, updatedAt: T0 }, stateVersion: 2 };
      },
    },
  }).start();
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PSYCHE_HOME: home,
    PSYCHE_USER_DATA: join(dir, "userData"),
    PSYCHE_GATEWAY_ORIGIN: gw.origin,
    PSYCHE_GATEWAY_MODE: "external",
    PSYCHE_DISABLE_GLOBAL_SHORTCUTS: "1",
    ...extraEnv,
  };
  if (extraEnv.PSYCHE_DISABLE_GLOBAL_SHORTCUTS === "") delete env.PSYCHE_DISABLE_GLOBAL_SHORTCUTS;
  const app = await electron.launch({ args: [appDir], env });
  const page = await mainWindowPage(app);
  await page.waitForSelector('[data-testid="shell"]');
  return { app, page, gw, env, dir };
}

async function shutdown(l: Launched | undefined): Promise<void> {
  if (!l) return;
  stopTestHelpers(appDir);
  await l.app.close().catch(() => undefined);
  await l.gw.stop().catch(() => undefined);
  rmSync(l.dir, { recursive: true, force: true });
}

/** Presses a chord system-wide (a global shortcut only hears the OS, not Playwright's keyboard). */
function pressGlobally(vks: number[]): void {
  const down = vks.map((k) => `[W.k]::keybd_event(${k},0,0,[UIntPtr]::Zero)`).join(";");
  const up = [...vks]
    .reverse()
    .map((k) => `[W.k]::keybd_event(${k},0,2,[UIntPtr]::Zero)`)
    .join(";");
  const script = [
    "Add-Type -Namespace W -Name k -MemberDefinition '[DllImport(\"user32.dll\")] public static extern void keybd_event(byte b, byte s, uint f, UIntPtr e);'",
    down,
    "Start-Sleep -Milliseconds 80",
    up,
  ].join(";");
  spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true,
  });
}

const VK_CONTROL = 0x11;
const VK_MENU = 0x12; // Alt
const VK_SPACE = 0x20;
const VK_SHIFT = 0x10;
const VK_F9 = 0x78;

const mainWindowVisible = (app: ElectronApplication) =>
  app.evaluate(
    ({ BaseWindow }) =>
      BaseWindow.getAllWindows()
        .find((w) => w.getTitle() === "Psyche")
        ?.isVisible() ?? false,
  );

test.describe("main window", () => {
  let l: Launched;
  test.beforeAll(async () => {
    l = await launch({ PSYCHE_E2E_UNINSTALL: "1" });
  });
  test.afterAll(async () => {
    await shutdown(l);
  });

  test("draws the overlay title bar and keeps clear of the caption buttons", async () => {
    const root = l.page.locator("html");
    await expect(root).toHaveAttribute("data-platform", "windows");
    await expect(root).toHaveAttribute("data-titlebar", "overlay");
    await expect(l.page.getByTestId("titlebar")).toHaveAttribute("data-frame", "overlay");
    const overlay = await l.page.evaluate(() => {
      const wco = (
        navigator as unknown as {
          windowControlsOverlay: { visible: boolean; getTitlebarAreaRect(): DOMRect };
        }
      ).windowControlsOverlay;
      const r = wco.getTitlebarAreaRect();
      return { visible: wco.visible, left: r.x + r.width, height: r.height };
    });
    expect(overlay.visible).toBe(true);
    expect(overlay.height).toBeGreaterThanOrEqual(32);
    // The chat's toolbar ends before the caption buttons start.
    const toolbar = l.page.getByTestId("chat-toolbar");
    await expect(toolbar).toBeVisible();
    const lastRight = await toolbar.evaluate((el) =>
      Math.max(
        ...Array.from(el.querySelectorAll("button, a, [role=button]"))
          .map((c) => c.getBoundingClientRect())
          .filter((b) => b.width > 0)
          .map((b) => b.right),
      ),
    );
    expect(lastRight).toBeLessThanOrEqual(overlay.left);
  });

  test("closing the window keeps the app running and a second launch brings it back", async () => {
    const process0 = l.app.process();
    await l.app.evaluate(({ BaseWindow }) =>
      BaseWindow.getAllWindows()
        .find((w) => w.getTitle() === "Psyche")
        ?.close(),
    );
    // Hidden, not destroyed: the app stays in the notification area with its Gateway client.
    await expect.poll(() => mainWindowVisible(l.app)).toBe(false);
    expect(process0.exitCode).toBeNull();
    expect(
      await l.app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().length),
    ).toBeGreaterThan(0);
    // Launching Psyche again (Start menu, jump list, a psyche:// link) goes to the running copy.
    const execPath = await l.app.evaluate(() => process.execPath);
    const second = spawn(execPath, [appDir], { env: l.env, stdio: "ignore", windowsHide: true });
    const exited = new Promise<number | null>((r) => second.once("exit", (code) => r(code)));
    await expect.poll(() => mainWindowVisible(l.app), { timeout: 20_000 }).toBe(true);
    // The second copy gives way.
    await Promise.race([exited, new Promise((r) => setTimeout(r, 15_000))]);
    if (second.exitCode === null) second.kill();
    expect(process0.exitCode).toBeNull();
    await expect(l.page.getByTestId("shell")).toBeVisible();
  });

  test("Settings → Sandbox PC shows the turn-on card", async () => {
    const settings = await openSettings(l);
    const nav = settings.getByRole("navigation", { name: "Settings sections" });
    await nav.getByRole("button", { name: "Permissions" }).click();
    await nav.getByRole("button", { name: "Sandbox PC", exact: true }).click();
    // The turn-on card, never the Mac's "VM mode". With the service bundled it offers the button;
    // without it (a partial build) it says why the PC isn't available instead.
    await expect(settings.getByText("VM mode")).toHaveCount(0);
    await expect(settings.getByRole("heading", { name: "Turn on the sandbox PC" })).toBeVisible();
    await expect(settings.getByText(/small private Linux PC/)).toBeVisible();
    await expect(
      settings
        .getByRole("button", { name: "Turn on the sandbox PC" })
        .or(settings.getByTestId("sandbox-pc-unsupported")),
    ).toBeVisible();
    // Opening the page starts nothing: no administrator prompt, no download.
    await expect(settings.getByText("Waiting for the administrator prompt…")).toHaveCount(0);
    await closeSettings(l);
  });

  test("Settings → About → Uninstall Psyche lists the Windows items (never confirmed)", async () => {
    // The real plan refuses a copy that was not installed by Squirrel; stub it with the shape of
    // a Squirrel install's plan, and make the uninstall itself refuse, so nothing can run.
    await l.app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("psyche:app:uninstall-plan");
      ipcMain.handle("psyche:app:uninstall-plan", () => ({
        ok: true,
        value: {
          stops: [
            {
              kind: "agent",
              label: "Stop and delete the scheduled task \\Psyche\\Gateway-S-1-5-21-1",
            },
            { kind: "helper", label: "Stop Psyche Helper" },
            { kind: "service", label: "Remove the sandbox PC service PsycheVM-S-1-5-21-1" },
          ],
          trash: [
            { kind: "agent", path: "C:\\x\\Gateway-S-1-5-21-1.xml", label: "Gateway task" },
            { kind: "cache", path: "C:\\x\\Psyche\\vm-images", label: "Sandbox PC image" },
            { kind: "app", path: "C:\\x\\Psyche", label: "The app" },
          ],
          confirmWord: "DELETE",
          agent: "ours",
          keychain: [],
          warnings: [],
          blockers: [],
        },
      }));
      ipcMain.removeHandler("psyche:app:uninstall");
      ipcMain.handle("psyche:app:uninstall", () => ({
        ok: false,
        error: { code: "forbidden", message: "the e2e never uninstalls" },
      }));
    });
    const settings = await openSettings(l);
    const nav = settings.getByRole("navigation", { name: "Settings sections" });
    await nav.getByRole("button", { name: "About" }).click();
    await settings.getByRole("button", { name: "Uninstall Psyche…" }).click();
    const sheet = settings.getByRole("dialog", { name: "Uninstall Psyche" });
    await expect(sheet).toBeVisible();
    // The Windows wording and items, not the Mac's Trash, LaunchAgent and Keychain.
    await expect(sheet).toContainText("Recycle Bin");
    await expect(sheet).toContainText("Moved to the Recycle Bin");
    await expect(sheet).toContainText("The Gateway scheduled task is stopped and deleted.");
    await expect(sheet).toContainText("The sandbox PC service is removed");
    await expect(sheet).toContainText("Gateway scheduled task");
    await expect(sheet).toContainText("The app (removed by Windows)");
    await expect(sheet).not.toContainText("LaunchAgent");
    await expect(sheet).not.toContainText("Keychain");
    await expect(sheet).not.toContainText("Touch ID");
    // Leave it: the final confirmation is never pressed.
    await sheet.getByRole("button", { name: "Cancel" }).click();
    await expect(sheet).toHaveCount(0);
    await closeSettings(l);
  });
});

test.describe("quick entry", () => {
  let l: Launched | undefined;
  test.afterEach(async () => {
    await shutdown(l);
    l = undefined;
  });

  const quickVisible = (x: Launched) =>
    x.app.evaluate(
      ({ BaseWindow }) =>
        BaseWindow.getAllWindows()
          .find((w) => w.getTitle() === "Quick entry")
          ?.isVisible() ?? false,
    );
  const isRegistered = (x: Launched, accelerator: string) =>
    x.app.evaluate(({ globalShortcut }, a) => globalShortcut.isRegistered(a), accelerator);

  /** Opens quick entry with the chord, checks the pop-up, and closes it with the chord again. */
  async function openAndClose(x: Launched, vks: number[]): Promise<void> {
    expect(await quickVisible(x)).toBe(false);
    const opened = x.app.waitForEvent("window");
    pressGlobally(vks);
    const quick = await opened;
    await quick.waitForSelector("body");
    expect(new URL(quick.url()).pathname).toBe("/quick");
    await expect.poll(() => quickVisible(x), { timeout: 10_000 }).toBe(true);
    pressGlobally(vks);
    await expect.poll(() => quickVisible(x), { timeout: 10_000 }).toBe(false);
    // The pop-up never needed the main window.
    await expect(x.page.getByTestId("shell")).toBeVisible();
  }

  test("Ctrl+Alt+Space opens it and the same chord closes it", async () => {
    // Global shortcuts on: this registers the real default chord for as long as the app runs.
    l = await launch({ PSYCHE_DISABLE_GLOBAL_SHORTCUTS: "" });
    const x = l;
    await expect
      .poll(() => isRegistered(x, "Control+Alt+Space"), { timeout: 5_000 })
      .toBe(true)
      .catch(() => undefined);
    test.skip(
      !(await isRegistered(x, "Control+Alt+Space")),
      "another app (an installed Psyche?) already owns Ctrl+Alt+Space",
    );
    await openAndClose(x, [VK_CONTROL, VK_MENU, VK_SPACE]);
  });

  test("the configured shortcut (quickEntry.shortcut) opens it and closes it", async () => {
    // Ctrl+Alt+Shift+F9: stored by the owner, so it replaces the default chord.
    l = await launch(
      { PSYCHE_DISABLE_GLOBAL_SHORTCUTS: "" },
      { "quickEntry.shortcut": "Control+Alt+Shift+F9" },
    );
    const x = l;
    await expect
      .poll(() => isRegistered(x, "Control+Alt+Shift+F9"), { timeout: 15_000 })
      .toBe(true);
    expect(await isRegistered(x, "Control+Alt+Space")).toBe(false);
    await openAndClose(x, [VK_CONTROL, VK_MENU, VK_SHIFT, VK_F9]);
  });
});

async function openSettings(l: Launched): Promise<Page> {
  await l.app.evaluate(({ BaseWindow }) => {
    BaseWindow.getAllWindows()
      .find((w) => w.getTitle() === "Psyche")
      ?.show();
  });
  await l.page
    .getByTestId("sidebar-footer")
    .getByRole("button", { name: "Settings and help" })
    .click();
  const [settings] = await Promise.all([
    l.app.waitForEvent("window"),
    l.page.getByRole("menuitem", { name: /^Settings/ }).click(),
  ]);
  await settings.waitForSelector('[data-testid="settings-window"]');
  return settings;
}

async function closeSettings(l: Launched): Promise<void> {
  await l.app.evaluate(({ BaseWindow }) =>
    BaseWindow.getAllWindows()
      .find((w) => w.getTitle() === "Settings")
      ?.close(),
  );
}
