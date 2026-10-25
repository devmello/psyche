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
import { MockGateway as KitGateway } from "@psyche/ui/testing";
import { MockGateway } from "@psyche/web/testing";
import { createFixtureWorld } from "../../../packages/ui/src/fixtures/index.ts";

/**
 * Window layout (docs/06 §3.1, §3.19, §4.1; redesign-2026 §4, §5.1, §5.11) in the packaged
 * desktop app and the web client: the main window draws a 52 px drag bar under the macOS traffic
 * lights and nothing else may sit there; onboarding is a centred, vertically balanced column with
 * Back / Next at its bottom on every step; one 248 px sidebar (destinations, threads, persona)
 * sits beside the content column, both starting below the bar; the chat column is centred;
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

/** Side chats for the sidebar: title, last line and time (docs/06 §2.2). */
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const side = (n: number, title: string, line: string, minutes: number) => ({
  thread: {
    ...MAIN_THREAD,
    id: `01JBXY6Q8Z00000000000000S${n}`,
    kind: "side",
    title,
    sessionKey: `owner:side:${n}`,
    updatedAt: ago(minutes),
    lastMessageAt: ago(minutes),
  },
  activity: { running: n === 1 ? 1 : 0, awaitingInput: 0, awaitingApproval: 0 },
  lastMessage: { role: n === 2 ? "user" : "agent", text: line, at: ago(minutes) },
});
const THREADS = [
  {
    thread: MAIN_THREAD,
    activity: { running: 0, awaitingInput: 0, awaitingApproval: 0 },
    lastMessage: { role: "user", text: "The 11:00 one, please.", at: ago(1) },
  },
  side(1, "Lisbon trip", "Flights on the 14th are cheapest; I'm watching the fare.", 35),
  side(2, "Taxes 2025", "Find my 1099 forms in Documents", 60 * 26),
  side(3, "Birthday dinner for Sam", "Three places have a table for six on Saturday.", 60 * 24 * 9),
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

/**
 * The rail screens and the agent sheet read the UI kit's fixture world (feed, ideas, goals,
 * library, inbox, tasks, approvals, automations, memory, search), so their captures show real
 * content; the thread list and the conversation stay this spec's own.
 */
const kit = new KitGateway(createFixtureWorld());
const FIXTURE_METHODS = [
  "feed.list",
  "ideas.list",
  "goals.list",
  "goals.get",
  "library.list",
  "notifications.list",
  "tasks.list",
  "tasks.get",
  "tasks.actions",
  "approvals.list",
  "grants.list",
  "questions.list",
  "automations.list",
  "search.query",
  "memory.list",
  "memory.search",
] as const;
function fixtureHandlers(): Record<string, (params: unknown) => unknown> {
  return Object.fromEntries(
    FIXTURE_METHODS.map((m) => [
      m,
      (params: unknown) => kit.request(m as never, (params ?? {}) as never),
    ]),
  );
}

function handlers() {
  return {
    ...fixtureHandlers(),
    "settings.get": () => ({
      settings: onboarded ? { [ONBOARDED]: T0 } : {},
      stateVersion: 1,
    }),
    "threads.list": () => ({ threads: THREADS, nextCursor: null }),
    // Like the Gateway, threads.get carries the row's last line too.
    "threads.get": () => THREADS[0],
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
  // One 560 px column plus its 24 px gutters (docs/design/redesign-2026.md §5.9).
  expect(flow.width, `${label}: column max width`).toBeLessThanOrEqual(608);
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
      // CI's display is shorter than 900 px; macOS would clamp the window to it (#561).
      PSYCHE_E2E_ANY_WINDOW_SIZE: "1",
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
      await expect(page.getByRole("heading", { level: 1, name: new RegExp(label) })).toBeVisible();
      const tag = `${label} ${width}x${height}`;
      await expectOnboardingLayout(page, tag, bar.y + bar.height);
      expect(await intruders(page, lights), `${tag}: under the traffic lights`).toEqual([]);
      if (i === 0) {
        const form = await box(page, "onboarding-form");
        const preview = await box(page, "onboarding-preview");
        // One column: the 160 px avatar sits above the tile grid and the name (§5.9).
        expect(preview.y + preview.height, "preview above the form").toBeLessThanOrEqual(
          form.y + 1,
        );
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
    await expect(
      page.getByTestId("conversation-column").getByText("The 11:00 one, please."),
    ).toBeVisible();
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
    // One sidebar (redesign §5.1): no rail and no separate thread-list column.
    await expect(page.getByRole("navigation", { name: "Sidebar" })).toHaveCount(1);
    await expect(page.locator("nav.rail, .threads-slot, aside.threads")).toHaveCount(0);
    const sidebar = await box(page, "sidebar");
    expect(sidebar.x, `${tag}: sidebar at the start edge`).toBeLessThanOrEqual(1);
    expect(sidebar.width, `${tag}: sidebar width`).toBeGreaterThanOrEqual(220);
    expect(sidebar.width, `${tag}: sidebar width`).toBeLessThanOrEqual(320);
    // The sidebar and the content column start on the same line, and the agent header is the
    // content column's first row.
    const content = await box(page, "content");
    const agentHeader = await page.getByTestId("kit-chat").locator("header").first().boundingBox();
    expect(Math.abs(sidebar.y - content.y), `${tag}: sidebar and content tops`).toBeLessThanOrEqual(
      1,
    );
    expect(content.x, `${tag}: content beside the sidebar`).toBeGreaterThanOrEqual(
      sidebar.x + sidebar.width - 1,
    );
    expect(agentHeader).toBeTruthy();
    if (agentHeader) {
      expect(Math.abs(agentHeader.y - content.y), `${tag}: header at the top`).toBeLessThanOrEqual(
        1,
      );
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
    // A short conversation sits just above the composer: no empty band in between.
    const last = await page.getByTestId("kit-chat").getByRole("article").last().boundingBox();
    if (last && composer) {
      expect(
        composer.y - (last.y + last.height),
        `${tag}: gap above the composer`,
      ).toBeLessThanOrEqual(72);
    }
    // Thread rows: 28 px source-list rows with title and time; the last line is the tooltip and
    // the filter (revealed from the Threads header) narrows on it (§2.2, redesign §5.1).
    const list = page.getByTestId("thread-group");
    const rows = list.getByTestId("thread-row");
    await expect(rows).toHaveCount(4);
    await expect(rows.first()).toContainText("Main chat");
    await expect(rows.filter({ hasText: "Lisbon trip" })).toHaveAttribute(
      "title",
      /Flights on the 14th are cheapest/,
    );
    await expect(rows.filter({ hasText: "Taxes 2025" })).toHaveAttribute(
      "title",
      /^You: Find my 1099 forms/,
    );
    for (const row of await rows.all()) {
      const b = await row.boundingBox();
      if (b) {
        expect(Math.round(b.height), `${tag}: 28 px rows`).toBe(28);
        expect(b.x + b.width, `${tag}: row inside the sidebar`).toBeLessThanOrEqual(
          sidebar.x + sidebar.width + 1,
        );
      }
    }
    await expectNoSidewaysScroll(page, tag);
    await shot(page, `main-${width}x${height}`);
    if (width === 1440) {
      await list.getByRole("button", { name: "Filter" }).click();
      await page.getByRole("searchbox", { name: "Filter threads" }).fill("cheapest");
      await expect(rows).toHaveCount(1);
      await expect(rows.first()).toContainText("Lisbon trip");
      await shot(page, `main-search-${width}x${height}`);
      await page.getByRole("searchbox", { name: "Filter threads" }).press("Escape");
      await expect(rows).toHaveCount(4);
    }

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

test("rail screens, inbox and agent sheet at 1440x900: kit chrome, no sideways scroll", async () => {
  if (!onboarded) {
    onboarded = true;
    await page.reload();
  }
  await page.waitForSelector('[data-testid="kit-chat"]');
  await setWindowSize(1440, 900);
  const lights = await trafficLights();
  // The sidebar's destinations (redesign §5.1): six rows, Chat current while a thread is open.
  const rail = page.getByRole("list", { name: "Destinations" });
  await expect(rail.getByRole("button")).toHaveCount(6);
  await expect(rail.getByRole("button", { name: /^Chat/ })).toHaveAttribute("aria-current", "true");
  // The Threads group: its header with the filter and new-side-chat buttons.
  const group = page.getByTestId("thread-group");
  await expect(group.getByRole("heading", { name: "Threads" })).toBeVisible();
  await expect(group.getByRole("button", { name: "New side chat" })).toBeVisible();
  for (const [label, id] of [
    ["Search", "search"],
    ["Feed", "feed"],
    ["Ideas", "ideas"],
    ["Goals", "goals"],
    ["Library", "library"],
  ] as const) {
    await rail.getByRole("button", { name: new RegExp(`^${label}`) }).click();
    await expect(page.getByTestId(`screen-${id}`)).toBeVisible();
    await expect(rail.getByRole("button", { name: new RegExp(`^${label}`) })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(page.getByText("This screen arrives with the UI kit.")).toHaveCount(0);
    await page.waitForTimeout(300);
    expect(await intruders(page, lights), `${label}: under the traffic lights`).toEqual([]);
    await expectNoSidewaysScroll(page, label);
    await shot(page, `screen-${id}-1440x900`);
  }
  await rail.getByRole("button", { name: /^Chat/ }).click();
  await page.getByRole("button", { name: /^Notifications/ }).click();
  await expect(page.getByTestId("screen-inbox")).toBeVisible();
  await page.waitForTimeout(300);
  await expectNoSidewaysScroll(page, "Inbox");
  await shot(page, "screen-inbox-1440x900");

  await rail.getByRole("button", { name: /^Chat/ }).click();
  await page.getByRole("button", { name: /activity, approvals, upcoming and memory/ }).click();
  for (const [tab, id] of [
    ["Activity", "activity"],
    ["Approvals", "approvals"],
    ["Upcoming", "upcoming"],
    ["Soul & Memory", "soul"],
  ] as const) {
    await page.getByRole("tab", { name: new RegExp(`^${tab}`) }).click();
    await page.waitForTimeout(400);
    await shot(page, `sheet-${id}-1440x900`);
  }
  await page.keyboard.press("Escape");
});

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
    // The web can't ask macOS, so its onboarding may leave Permissions out (#554).
    const progress = await p.getByRole("navigation", { name: "Onboarding progress" }).textContent();
    const webSteps = progress?.includes("Permissions")
      ? STEPS
      : STEPS.filter((s) => s !== "Permissions");
    for (const [i, label] of webSteps.entries()) {
      await expect(p.getByRole("heading", { level: 1, name: new RegExp(label) })).toBeVisible();
      await expectOnboardingLayout(p, `web ${label}`, 0);
      if (i === 0) {
        const form = await box(p, "onboarding-form");
        const preview = await box(p, "onboarding-preview");
        expect(preview.y + preview.height, "preview above the form").toBeLessThanOrEqual(
          form.y + 1,
        );
      }
      await shot(p, `web-onboarding-${i + 1}-390`);
      if (i < webSteps.length - 1) await p.getByRole("button", { name: "Next" }).click();
    }
    webOnboarded = true;
    await p.reload();
    await p.waitForSelector('[data-testid="kit-chat"]');
    await expect(
      p.getByTestId("conversation-column").getByText("The 11:00 one, please."),
    ).toBeVisible();
    await expect(p.getByTestId("titlebar")).toHaveCount(0);
    await expect(p.getByTestId("shell")).toHaveAttribute("data-compact", "true");
    // Compact (redesign §5.11): the top bar and the tab bar, no sidebar.
    await expect(p.getByTestId("compact-top-bar")).toBeVisible();
    await expect(p.getByTestId("tab-bar").getByRole("button")).toHaveCount(5);
    await expect(p.getByRole("navigation", { name: "Sidebar" })).toHaveCount(0);
    await expectNoSidewaysScroll(p, "web main");
    await shot(p, "web-main-390");
  } finally {
    await host.close();
    await web.stop();
  }
});
