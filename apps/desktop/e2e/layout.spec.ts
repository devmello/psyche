import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
 * Window layout (docs/06 §3.1, §3.19, §4.1) in the packaged desktop app and the web client:
 * the main window draws a 52 px drag bar under the macOS traffic lights and nothing else may sit
 * there; onboarding is a centred, vertically balanced column with Back / Next at its bottom on
 * every step; the main window's headers line up below the bar and the chat column is centred;
 * nothing scrolls sideways. Screenshots of every view land in `e2e/__screenshots__/`.
 *
 * The web part serves `apps/web/dist` (build it first: `pnpm --filter @psyche/web build`) from
 * the mock Gateway and opens it in a plain Electron window with no preload, i.e. the real web
 * host at phone width.
 */

const appDir = fileURLToPath(new URL("..", import.meta.url));
const shotsDir = fileURLToPath(new URL("./__screenshots__/", import.meta.url));
const webDist = fileURLToPath(new URL("../../web/dist/", import.meta.url));
const webHost = fileURLToPath(new URL("./web-host.cjs", import.meta.url));

const ONBOARDED = "ui.onboarding.completedAt";
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
  lastMessageAt: T0,
};
const message = (id: string, seq: number, role: "user" | "agent", md: string) => ({
  id,
  threadId: MAIN_THREAD.id,
  seq,
  role,
  blocks: [{ type: "text", md }],
  providerNative: null,
  provenance: role === "user" ? "owner" : "agent",
  replyToMessageId: null,
  channelRef: null,
  runId: null,
  createdAt: T0,
});
const CONVERSATION = [
  message("01JBXY6Q8Z00000000000000M1", 1, "user", "Book the dentist next week"),
  message(
    "01JBXY6Q8Z00000000000000M2",
    2,
    "agent",
    "Three slots work with your Tuesday block: 9:30, 11:00 and 14:30. I'll hold the earliest unless you pick another.",
  ),
  message("01JBXY6Q8Z00000000000000M3", 3, "user", "The 11:00 one, please."),
];

const STEPS = [
  "Meet your agent",
  "Permissions",
  "Connectors",
  "Model & provider",
  "Where .* works",
  "Done",
];

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

let dir: string;
let gw: MockGateway;
let app: ElectronApplication;
let page: Page;
let onboarded = false;

function handlers() {
  return {
    "settings.get": () => ({
      settings: onboarded ? { [ONBOARDED]: T0 } : {},
      stateVersion: 1,
    }),
    "threads.list": () => ({
      threads: [
        { thread: MAIN_THREAD, activity: { running: 0, awaitingInput: 0, awaitingApproval: 0 } },
      ],
      nextCursor: null,
    }),
    "threads.get": () => ({
      thread: MAIN_THREAD,
      activity: { running: 0, awaitingInput: 0, awaitingApproval: 0 },
    }),
    "chat.history": () => ({ messages: CONVERSATION, nextCursor: null }),
    "memory.read": () => ({ content: '---\nname: "Wren"\ncreature: "moth"\n---\n', etag: "e1" }),
  };
}

async function shot(p: Page, name: string): Promise<void> {
  mkdirSync(shotsDir, { recursive: true });
  await p.screenshot({ path: join(shotsDir, `${name}.png`) });
}

async function box(p: Page, testId: string): Promise<Box> {
  const b = await p.getByTestId(testId).first().boundingBox();
  if (b === null) throw new Error(`${testId} has no box`);
  return b;
}

async function setWindowSize(width: number, height: number): Promise<void> {
  await app.evaluate(
    ({ BaseWindow }, size) => {
      const win = BaseWindow.getAllWindows().find((w) => w.getTitle() === "Psyche");
      if (!win) throw new Error("no main window");
      win.setContentSize(size.width, size.height);
    },
    { width, height },
  );
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
  await expect.poll(() => page.evaluate(() => window.innerHeight)).toBe(height);
}

/** The traffic-light buttons: the window's button position and the three 12 px buttons. */
async function trafficLights(): Promise<Box> {
  const p = await app.evaluate(({ BaseWindow }) =>
    BaseWindow.getAllWindows()
      .find((w) => w.getTitle() === "Psyche")
      ?.getWindowButtonPosition(),
  );
  if (!p) throw new Error("no traffic-light position");
  return { x: p.x - 2, y: p.y - 2, width: 56, height: 18 };
}

/** Text and controls whose box intersects `rect`; the bar's own background does not count. */
async function intruders(p: Page, rect: Box): Promise<string[]> {
  return p.evaluate((r) => {
    const hits: string[] = [];
    const overlaps = (b: DOMRect) =>
      b.width > 0 &&
      b.height > 0 &&
      b.left < r.x + r.width &&
      b.right > r.x &&
      b.top < r.y + r.height &&
      b.bottom > r.y;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
      if (!n.textContent?.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const b of Array.from(range.getClientRects())) {
        if (overlaps(b)) hits.push(`text "${n.textContent.trim().slice(0, 40)}"`);
      }
    }
    for (const el of Array.from(
      document.querySelectorAll("button, a, input, textarea, select, img, svg, [role=button]"),
    )) {
      if (overlaps(el.getBoundingClientRect())) hits.push(`<${el.tagName.toLowerCase()}>`);
    }
    return hits;
  }, rect);
}

async function expectNoSidewaysScroll(p: Page, label: string): Promise<void> {
  const { scroll, inner } = await p.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    inner: window.innerWidth,
  }));
  expect(scroll, `${label}: horizontal scroll`).toBeLessThanOrEqual(inner);
}

/** Onboarding checks shared by desktop and web; `barBottom` is 0 without a title bar. */
async function expectOnboardingLayout(p: Page, label: string, barBottom: number): Promise<void> {
  const viewport = await p.evaluate(() => window.innerWidth);
  const flow = await box(p, "onboarding-flow");
  const scroll = await box(p, "onboarding-scroll");
  const nav = await box(p, "onboarding-nav");
  expect(flow.width, `${label}: column max width`).toBeLessThanOrEqual(896);
  expect(
    Math.abs(flow.x + flow.width / 2 - viewport / 2),
    `${label}: column centred horizontally`,
  ).toBeLessThanOrEqual(8);
  expect(scroll.y, `${label}: content starts below the title bar`).toBeGreaterThanOrEqual(
    barBottom - 1,
  );
  expect(nav.y + nav.height, `${label}: Back / Next at the column's bottom`).toBeLessThanOrEqual(
    flow.y + flow.height + 1,
  );
  expect(nav.y + nav.height, `${label}: Back / Next close to the bottom`).toBeGreaterThan(
    flow.y + flow.height - 80,
  );
  if (flow.height < scroll.height) {
    const top = flow.y - scroll.y;
    const bottom = scroll.y + scroll.height - (flow.y + flow.height);
    expect(Math.abs(top - bottom), `${label}: balanced ${top} / ${bottom}`).toBeLessThanOrEqual(16);
  }
  await expectNoSidewaysScroll(p, label);
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "psy-e2e-layout-"));
  const home = join(dir, "h");
  mkdirSync(join(home, "run"), { recursive: true });
  writeFileSync(join(home, "run", "handshake.secret"), "e2e-handshake-secret", { mode: 0o600 });
  gw = await new MockGateway({
    handshakeSecret: "e2e-handshake-secret",
    handlers: handlers(),
  }).start();
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
  await page.waitForSelector('[data-testid="onboarding"]');
});

test.afterAll(async () => {
  await app?.close();
  await gw?.stop();
  rmSync(dir, { recursive: true, force: true });
});

for (const [width, height] of [
  [1440, 900],
  [1280, 800],
] as const) {
  test(`onboarding at ${width}x${height}: title bar, centred balanced column, every step`, async () => {
    await setWindowSize(width, height);
    // Start from the first step.
    while (await page.getByRole("button", { name: "Back" }).isEnabled()) {
      await page.getByRole("button", { name: "Back" }).click();
    }
    const bar = await box(page, "titlebar");
    expect(bar.height).toBe(52);
    const lights = await trafficLights();
    expect(lights.y + lights.height, "traffic lights inside the bar").toBeLessThanOrEqual(52);
    for (const [i, label] of STEPS.entries()) {
      await expect(page.getByRole("heading", { level: 2, name: new RegExp(label) })).toBeVisible();
      const tag = `${label} ${width}x${height}`;
      await expectOnboardingLayout(page, tag, bar.y + bar.height);
      expect(await intruders(page, lights), `${tag}: under the traffic lights`).toEqual([]);
      if (i === 0) {
        const form = await box(page, "onboarding-form");
        const preview = await box(page, "onboarding-preview");
        expect(preview.x, "preview beside the form").toBeGreaterThanOrEqual(form.x + form.width);
        expect(Math.abs(preview.y - form.y), "preview top-aligned with the form").toBeLessThan(8);
      }
      await shot(page, `onboarding-${i + 1}-${width}x${height}`);
      if (i < STEPS.length - 1) await page.getByRole("button", { name: "Next" }).click();
    }
  });
}

for (const [width, height] of [
  [1440, 900],
  [1280, 800],
] as const) {
  test(`main window at ${width}x${height}: bar, aligned headers, centred chat`, async () => {
    if (!onboarded) {
      onboarded = true;
      await page.reload();
    }
    await page.waitForSelector('[data-testid="kit-chat"]');
    await setWindowSize(width, height);
    await expect(page.getByText("The 11:00 one, please.")).toBeVisible();
    const tag = `main ${width}x${height}`;
    const bar = await box(page, "titlebar");
    expect(bar.height).toBe(52);
    await expect(page.getByTestId("titlebar")).toContainText("Main chat");
    const shell = await box(page, "shell");
    expect(shell.y, `${tag}: shell below the bar`).toBeGreaterThanOrEqual(bar.y + bar.height - 1);
    expect(
      await intruders(page, await trafficLights()),
      `${tag}: under the traffic lights`,
    ).toEqual([]);
    // Sidebar and chat headers end on the same line.
    const threadsHeader = await page.locator(".threads-header").boundingBox();
    const agentHeader = await page.getByTestId("kit-chat").locator("header").first().boundingBox();
    expect(threadsHeader && agentHeader).toBeTruthy();
    if (threadsHeader && agentHeader) {
      expect(Math.abs(threadsHeader.y - agentHeader.y), `${tag}: header tops`).toBeLessThanOrEqual(
        1,
      );
      expect(
        Math.abs(threadsHeader.y + threadsHeader.height - (agentHeader.y + agentHeader.height)),
        `${tag}: header bottoms`,
      ).toBeLessThanOrEqual(1);
    }
    // The composer and messages share a centred column inside the chat area.
    const chat = await box(page, "kit-chat");
    const composer = await page.getByRole("textbox", { name: "Message Wren" }).boundingBox();
    expect(composer).toBeTruthy();
    if (composer) {
      const column = await page
        .getByRole("textbox", { name: "Message Wren" })
        .locator("xpath=ancestor::div[contains(@class,'mx-auto')][1]")
        .boundingBox();
      const c = column ?? composer;
      expect(
        Math.abs(c.x + c.width / 2 - (chat.x + chat.width / 2)),
        `${tag}: chat column centred`,
      ).toBeLessThanOrEqual(8);
    }
    await expectNoSidewaysScroll(page, tag);
    await shot(page, `main-${width}x${height}`);

    // With a pane open, its header lines up with the chat header too.
    gw.emit("view.command", { command: "open", args: { pane: "tasks" } });
    await expect(page.getByTestId("pane-tab").filter({ hasText: "Tasks" })).toBeVisible();
    const paneHeader = await page.getByTestId("pane-group").locator("header").first().boundingBox();
    if (paneHeader && agentHeader) {
      expect(
        Math.abs(paneHeader.y + paneHeader.height - (agentHeader.y + agentHeader.height)),
        `${tag}: pane header bottom`,
      ).toBeLessThanOrEqual(1);
    }
    await expectNoSidewaysScroll(page, `${tag} with a pane`);
    await shot(page, `main-pane-${width}x${height}`);
    gw.emit("view.command", { command: "close", args: { pane: "tasks" } });
    await expect(page.getByTestId("pane-tab").filter({ hasText: "Tasks" })).toHaveCount(0);
  });
}

test("web client at 390 px: no title bar, every onboarding step, main chat", async () => {
  test.skip(!existsSync(join(webDist, "index.html")), "build apps/web first");
  let webOnboarded = false;
  const web = await new MockGateway({
    webRoot: webDist,
    handlers: {
      ...handlers(),
      "settings.get": () => ({
        settings: webOnboarded ? { [ONBOARDED]: T0 } : {},
        stateVersion: 1,
      }),
    },
  }).start();
  const host = await electron.launch({
    args: [webHost],
    env: { ...process.env, PSYCHE_WEB_URL: `${web.origin}/chat` },
  });
  try {
    const p = await host.firstWindow();
    await p.waitForSelector('[data-testid="onboarding"]');
    expect(await p.evaluate(() => window.innerWidth)).toBe(390);
    await expect(p.getByTestId("titlebar")).toHaveCount(0);
    for (const [i, label] of STEPS.entries()) {
      await expect(p.getByRole("heading", { level: 2, name: new RegExp(label) })).toBeVisible();
      await expectOnboardingLayout(p, `web ${label}`, 0);
      if (i === 0) {
        const form = await box(p, "onboarding-form");
        const preview = await box(p, "onboarding-preview");
        expect(preview.y, "preview below the form").toBeGreaterThanOrEqual(form.y + form.height);
      }
      await shot(p, `web-onboarding-${i + 1}-390`);
      if (i < STEPS.length - 1) await p.getByRole("button", { name: "Next" }).click();
    }
    webOnboarded = true;
    await p.reload();
    await p.waitForSelector('[data-testid="kit-chat"]');
    await expect(p.getByText("The 11:00 one, please.")).toBeVisible();
    await expect(p.getByTestId("titlebar")).toHaveCount(0);
    await expect(p.getByTestId("shell")).toHaveAttribute("data-compact", "true");
    await expectNoSidewaysScroll(p, "web main");
    await shot(p, "web-main-390");
  } finally {
    await host.close();
    await web.stop();
  }
});
