import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test,
} from "@playwright/test";
import { MockGateway } from "@psyche/web/testing";

/**
 * Smoke tests for the desktop shell against the mock Gateway: launch and connect, panes through
 * view.* and the keyboard, the browser tab lifecycle over the CDP bridge, Take control, and the
 * download quarantine toast. Network stays on 127.0.0.1 (fixture server + mock Gateway).
 */

const appDir = fileURLToPath(new URL("..", import.meta.url));
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
  createdAt: "2026-10-19T10:00:00.000Z",
  updatedAt: "2026-10-19T10:00:00.000Z",
  lastMessageAt: null,
};

let dir: string;
let home: string;
let gw: MockGateway;
let fixture: Server;
let fixtureOrigin: string;
let app: ElectronApplication;
let page: Page;

const composer = () => page.getByRole("textbox", { name: /^Message / });

function startFixture(): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.url === "/download") {
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-disposition": 'attachment; filename="invoice.txt"',
      });
      res.end("invoice 42\n");
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><title>Fixture ${req.url}</title><input id="q" aria-label="Query">`);
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "psy-e2e-"));
  home = join(dir, "h");
  mkdirSync(join(home, "run"), { recursive: true });
  const secret = "e2e-handshake-secret";
  writeFileSync(join(home, "run", "handshake.secret"), secret, { mode: 0o600 });
  gw = await new MockGateway({
    bridgeSocketPath: join(home, "run", "browser-bridge.sock"),
    handshakeSecret: secret,
    handlers: {
      "threads.list": () => ({
        threads: [
          { thread: MAIN_THREAD, activity: { running: 0, awaitingInput: 0, awaitingApproval: 0 } },
        ],
        nextCursor: null,
      }),
      "chat.history": () => ({ messages: [], nextCursor: null }),
      "chat.send": () => ({ messageId: "01JBXY6Q8Z0000000000000009", runId: null, queued: false }),
      "nodes.list": () => ({ nodes: [] }),
      // Onboarding is done on this Gateway (the composed app gates on this key).
      "settings.get": () => ({
        settings: {
          "ui.onboarding.completedAt": "2026-10-19T09:00:00.000Z",
          "appearance.zoom": 125,
        },
        stateVersion: 1,
      }),
      "settings.set": (params) => {
        const p = params as { key: string; value: unknown };
        return {
          entry: { key: p.key, value: p.value, updatedAt: "2026-10-19T10:00:00.000Z" },
          stateVersion: 2,
        };
      },
    },
  }).start();
  fixture = await startFixture();
  fixtureOrigin = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}`;
  app = await electron.launch({
    args: [appDir],
    env: {
      ...process.env,
      PSYCHE_HOME: home,
      PSYCHE_USER_DATA: join(dir, "userData"),
      PSYCHE_GATEWAY_ORIGIN: gw.origin,
      PSYCHE_GATEWAY_MODE: "external",
      PSYCHE_DISABLE_GLOBAL_SHORTCUTS: "1",
    },
  });
  page = await app.firstWindow();
  await page.waitForSelector('[data-testid="shell"]');
});

test.afterAll(async () => {
  await app?.close();
  await gw?.stop();
  fixture?.close();
  rmSync(dir, { recursive: true, force: true });
});

test("launches, pairs with the Gateway and loads the main chat", async () => {
  await expect.poll(() => gw.pairedCount()).toBe(1);
  await gw.waitForCall("threads.list");
  await expect(page.getByTestId("offline-banner")).toHaveCount(0);
  // The UI kit's composer (INT-1 mounts the kit's chat column in the shell).
  await expect(composer()).toBeEnabled();
  const connect = gw.connects.at(-1) ?? {};
  expect(connect.deviceFamily).toBe("desktop");
  expect(connect.handshakeSecret).toBe("e2e-handshake-secret");
});

test("sends a message through main with an idempotency key", async () => {
  await composer().fill("Book the dentist next week");
  await composer().press("Enter");
  const call = await gw.waitForCall("chat.send");
  expect(call.params).toMatchObject({
    threadId: MAIN_THREAD.id,
    content: "Book the dentist next week",
  });
  expect(call.idempotencyKey).toBeTruthy();
});

test("the agent opens and closes panes through view.* and the layout is reported", async () => {
  gw.emit("view.command", { command: "open", args: { pane: "tasks" } });
  await expect(page.getByTestId("pane-tab").filter({ hasText: "Tasks" })).toBeVisible();
  const report = await gw.waitForCall("view.report", (p) =>
    JSON.stringify(p).includes('"pane":"tasks"'),
  );
  expect(report).toBeTruthy();
  gw.emit("view.command", { command: "close", args: { pane: "tasks" } });
  await expect(page.getByTestId("pane-tab").filter({ hasText: "Tasks" })).toHaveCount(0);
});

test("keyboard shortcuts: palette, shortcut sheet, browser pane, close pane", async () => {
  await page.locator("body").click({ position: { x: 5, y: 300 } });
  await page.keyboard.press("Meta+K");
  await expect(page.getByTestId("palette")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("palette")).toHaveCount(0);
  await page.keyboard.press("Meta+/");
  await expect(page.getByTestId("shortcut-sheet")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Meta+Shift+B");
  await expect(page.getByTestId("browser-pane")).toBeVisible();
  await page.keyboard.press("Meta+\\");
  await expect(page.getByTestId("browser-pane")).toHaveCount(0);
});

test("browser tab lifecycle over the CDP bridge", async () => {
  const bridge = await gw.waitForBridge();
  expect(bridge.hello).toMatchObject({ protocolVersion: 1 });
  expect(bridge.hello).not.toHaveProperty("handshakeSecret");
  gw.emit("view.command", { command: "open", args: { pane: "browser" } });
  const opened = (await bridge.call("bridge.tab.open", {
    url: `${fixtureOrigin}/one`,
    taskId: "01JBXY6Q8Z0000000000000002",
    taskTitle: "Dentist booking",
  })) as { tab: { tabId: string; attached: boolean } };
  expect(opened.tab.attached).toBe(true);
  await bridge.waitForEvent("bridge.tab.created");
  await expect(page.getByTestId("browser-tab")).toHaveCount(1);
  await bridge.waitForEvent("bridge.tab.updated", (p) =>
    JSON.stringify(p).includes("Fixture /one"),
  );
  await expect(page.getByTestId("browser-tab")).toContainText("Fixture /one");

  // The desktop's own allowlist refuses main-world script and cookie access.
  await expect(
    bridge.call("bridge.cdp.send", {
      tabId: opened.tab.tabId,
      method: "Runtime.evaluate",
      params: { expression: "document.cookie" },
    }),
  ).rejects.toMatchObject({ code: "method_not_allowed" });
  await expect(
    bridge.call("bridge.cdp.send", { tabId: opened.tab.tabId, method: "Network.getAllCookies" }),
  ).rejects.toMatchObject({ code: "method_not_allowed" });
  const tree = (await bridge.call("bridge.cdp.send", {
    tabId: opened.tab.tabId,
    method: "Accessibility.getFullAXTree",
  })) as { result: { nodes: unknown[] } };
  expect(tree.result.nodes.length).toBeGreaterThan(0);

  const list = (await bridge.call("bridge.tabs.list", {})) as { tabs: { tabId: string }[] };
  expect(list.tabs.map((t) => t.tabId)).toContain(opened.tab.tabId);

  await bridge.call("bridge.tab.status", { tabId: opened.tab.tabId, text: "Typing in Query" });
  await expect(page.getByTestId("browser-status")).toHaveText("Typing in Query");

  await bridge.call("bridge.tab.close", { tabId: opened.tab.tabId });
  await bridge.waitForEvent(
    "bridge.tab.closed",
    (p) => (p as { tabId: string }).tabId === opened.tab.tabId,
  );
  await expect(page.getByTestId("browser-tab")).toHaveCount(0);
});

test("Take control pauses agent input and Return control resumes it", async () => {
  const bridge = await gw.waitForBridge();
  const { tab } = (await bridge.call("bridge.tab.open", { url: `${fixtureOrigin}/two` })) as {
    tab: { tabId: string };
  };
  await expect(page.getByTestId("take-control")).toBeVisible();
  await page.getByTestId("take-control").click();
  await bridge.waitForEvent("bridge.control.changed", (p) => {
    const e = p as { tabId: string; state: string; via?: string };
    return e.tabId === tab.tabId && e.state === "user" && e.via === "button";
  });
  await expect(page.getByTestId("browser-status")).toHaveText("Paused: you have control");
  await expect(
    bridge.call("bridge.cdp.send", {
      tabId: tab.tabId,
      method: "Input.insertText",
      params: { text: "x" },
    }),
  ).rejects.toMatchObject({ code: "user_in_control", retryable: true });

  await page.getByTestId("take-control").click();
  await bridge.waitForEvent("bridge.control.changed", (p) => {
    const e = p as { tabId: string; state: string };
    return e.tabId === tab.tabId && e.state === "agent";
  });
  await bridge.call("bridge.cdp.send", {
    tabId: tab.tabId,
    method: "Input.insertText",
    params: { text: "ok" },
  });
  await bridge.call("bridge.tab.close", { tabId: tab.tabId });
});

test("downloads land in quarantine and show a toast", async () => {
  const bridge = await gw.waitForBridge();
  const { tab } = (await bridge.call("bridge.tab.open", { url: `${fixtureOrigin}/three` })) as {
    tab: { tabId: string };
  };
  await bridge.waitForEvent("bridge.tab.updated", (p) =>
    JSON.stringify(p).includes("Fixture /three"),
  );
  await bridge.call("bridge.cdp.send", {
    tabId: tab.tabId,
    method: "Page.navigate",
    params: { url: `${fixtureOrigin}/download` },
  });
  const done = (await bridge.waitForEvent(
    "bridge.download",
    (p) => (p as { state: string }).state === "completed",
    15_000,
  )) as { quarantinePath: string; filename: string };
  expect(done.quarantinePath.startsWith(join(home, "library", "quarantine"))).toBe(true);
  expect(
    readdirSync(join(home, "library", "quarantine")).some((f) => f.endsWith("invoice.txt")),
  ).toBe(true);
  await expect(page.getByTestId("toasts")).toContainText(
    "Downloaded invoice.txt to Library → Downloads (quarantined)",
  );
});

test("Settings shares a folder through the native picker as a permissions.policy grant", async () => {
  const picked = join(dir, "Taxes");
  mkdirSync(picked);
  // Playwright cannot drive the OS folder chooser: stub it in the main process.
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [folder],
    })) as typeof dialog.showOpenDialog;
  }, picked);
  // Settings sits in the rail's bottom menu (the kit rail, #561).
  await page.getByTestId("rail").getByRole("button", { name: "Menu" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "File access" })
    .click();
  await page.getByRole("button", { name: "Choose a folder…" }).click();
  const call = await gw.waitForCall("settings.set", (p) =>
    JSON.stringify(p).includes('"permissions.policy"'),
  );
  // The grant names the real path (the broker matches real paths), read only by default.
  expect(call.params).toEqual({
    key: "permissions.policy",
    value: { folders: [{ path: realpathSync(picked), mode: "ro" }] },
  });
  await expect(page.getByTestId("settings-files")).toContainText(realpathSync(picked));
});

test("the stored appearance.zoom is applied on launch and View → Actual Size stores 100", async () => {
  const factor = () =>
    app.evaluate(({ BaseWindow }) => {
      const win = BaseWindow.getAllWindows().find((w) => w.getTitle() === "Psyche");
      const view = win?.contentView.children[0] as { webContents?: { getZoomFactor(): number } };
      return view?.webContents?.getZoomFactor() ?? -1;
    });
  await expect.poll(factor).toBeCloseTo(1.25, 2);
  await app.evaluate(({ Menu }) => {
    Menu.getApplicationMenu()?.getMenuItemById("zoom-reset")?.click();
  });
  const call = await gw.waitForCall("settings.set", (p) =>
    JSON.stringify(p).includes('"appearance.zoom"'),
  );
  expect(call.params).toEqual({ key: "appearance.zoom", value: 100 });
  await expect.poll(factor).toBeCloseTo(1, 2);
  // Another device changing the setting reaches this renderer through settings.changed.
  gw.emit("settings.changed", {
    entries: [{ key: "appearance.zoom", value: 150, updatedAt: "2026-10-19T10:00:00.000Z" }],
  });
  await expect.poll(factor).toBeCloseTo(1.5, 2);
});
