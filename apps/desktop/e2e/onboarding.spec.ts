import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
 * Onboarding layout (UI design §3.19, §4.1) in the packaged app: the wizard is a centered column
 * with a max width and gutters on every step; on the first step the preview card sits beside the
 * form at desktop widths and below it at phone widths. Measured with bounding boxes, so a stray
 * wrapper, a lost stylesheet or a zoomed renderer fails here; a screenshot of every step lands in
 * the Playwright output directory for eyeballing.
 */

const appDir = fileURLToPath(new URL("..", import.meta.url));

let dir: string;
let gw: MockGateway;
let app: ElectronApplication;
let page: Page;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function box(testId: string): Promise<Box> {
  const b = await page.getByTestId(testId).first().boundingBox();
  if (b === null) throw new Error(`${testId} has no box`);
  return b;
}

/** Resizes the main window; the phone width needs the 900 px minimum lifted for the test. */
async function setWindowSize(width: number, height: number): Promise<void> {
  await app.evaluate(
    ({ BaseWindow }, size) => {
      const win = BaseWindow.getAllWindows()[0];
      if (!win) throw new Error("no window");
      win.setMinimumSize(Math.min(size.width, 900), Math.min(size.height, 600));
      win.setSize(size.width, size.height);
    },
    { width, height },
  );
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
}

async function expectCentered(label: string, maxWidth: number): Promise<void> {
  const flow = await box("onboarding-flow");
  const viewport = await page.evaluate(() => window.innerWidth);
  const left = flow.x;
  const right = viewport - (flow.x + flow.width);
  expect(flow.width, `${label}: column width`).toBeLessThanOrEqual(maxWidth);
  expect(Math.abs(left - right), `${label}: gutters ${left} vs ${right}`).toBeLessThan(8);
  expect(flow.y, `${label}: top gutter`).toBeGreaterThanOrEqual(0);
  const heading = await page.getByRole("heading", { level: 2 }).first().boundingBox();
  expect(heading?.y ?? 0, `${label}: heading clears the top edge`).toBeGreaterThan(40);
}

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "psy-e2e-onb-"));
  const home = join(dir, "h");
  mkdirSync(join(home, "run"), { recursive: true });
  writeFileSync(join(home, "run", "handshake.secret"), "e2e-handshake-secret", { mode: 0o600 });
  gw = await new MockGateway({
    handshakeSecret: "e2e-handshake-secret",
    handlers: {
      // No `ui.onboarding.completedAt`: the composed app shows the wizard.
      "settings.get": () => ({ settings: {}, stateVersion: 1 }),
      "threads.list": () => ({ threads: [], nextCursor: null }),
    },
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

const STEPS = [
  "Meet your agent",
  "Permissions",
  "Connectors",
  "Model & provider",
  "Where Psyche works",
  "Done",
];

test("every step is a centered column with gutters at the default window size", async () => {
  const info = test.info();
  await setWindowSize(1440, 900);
  for (const [i, label] of STEPS.entries()) {
    await expect(page.getByRole("heading", { level: 2, name: new RegExp(label) })).toBeVisible();
    await expectCentered(label, 896);
    await page.screenshot({ path: info.outputPath(`step-${i + 1}-1440.png`) });
    if (i < STEPS.length - 1) await page.getByRole("button", { name: "Next" }).click();
  }
  for (let i = 0; i < STEPS.length - 1; i += 1) {
    await page.getByRole("button", { name: "Back" }).click();
  }
  await expect(page.getByRole("heading", { level: 2, name: /Meet your agent/ })).toBeVisible();
});

test("the preview card sits beside the form at desktop width and below it at a phone width", async () => {
  const info = test.info();
  const form = await box("onboarding-form");
  const preview = await box("onboarding-preview");
  const flow = await box("onboarding-flow");
  expect(preview.x, "preview to the right of the form").toBeGreaterThanOrEqual(form.x + form.width);
  expect(Math.abs(preview.y - form.y), "preview aligned with the form's top").toBeLessThan(8);
  expect(preview.x - (form.x + form.width), "no band between form and preview").toBeLessThan(48);
  expect(preview.x + preview.width, "preview inside the column").toBeLessThanOrEqual(
    flow.x + flow.width,
  );

  await setWindowSize(390, 800);
  for (const [i, label] of STEPS.entries()) {
    await expect(page.getByRole("heading", { level: 2, name: new RegExp(label) })).toBeVisible();
    await expectCentered(label, 390);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
      `${label}: no horizontal scroll`,
    ).toBeLessThanOrEqual(390);
    await page.screenshot({ path: info.outputPath(`step-${i + 1}-390.png`), fullPage: true });
    if (i === 0) {
      const narrowForm = await box("onboarding-form");
      const narrowPreview = await box("onboarding-preview");
      expect(narrowPreview.y, "preview below the form").toBeGreaterThanOrEqual(
        narrowForm.y + narrowForm.height,
      );
    }
    if (i < STEPS.length - 1) await page.getByRole("button", { name: "Next" }).click();
  }
  await setWindowSize(1440, 900);
});
