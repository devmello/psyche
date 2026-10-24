import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
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
import { type ComposedGateway, composeGateway } from "@psyche/gateway/compose";
import { calls, MAIN, ScriptedModel, say, TASK_MARKER, UTILITY } from "./scripted-model.ts";

/**
 * INT-1 walking skeleton in the real desktop app (Playwright for Electron): the packaged renderer
 * with the UI kit's screens, against a composed Gateway (real packages) and the scripted model.
 * Build the app first: `pnpm --filter @psyche/desktop package`.
 */

const desktopDir = fileURLToPath(new URL("../../../apps/desktop/", import.meta.url));
const electronPath = createRequire(join(desktopDir, "package.json"))(
  "electron",
) as unknown as string;

const model = new ScriptedModel();
let dir: string;
let home: string;
let notes: string;
let composed: ComposedGateway;
let app: ElectronApplication;
let page: Page;

async function launch(): Promise<void> {
  app = await electron.launch({
    executablePath: electronPath,
    args: [desktopDir],
    env: {
      ...process.env,
      PSYCHE_HOME: home,
      PSYCHE_USER_DATA: join(dir, "userData"),
      PSYCHE_GATEWAY_ORIGIN: composed.gateway.origin,
      PSYCHE_GATEWAY_MODE: "external",
      PSYCHE_DISABLE_GLOBAL_SHORTCUTS: "1",
    },
  });
  page = await app.firstWindow();
}

/** What the owner does on an approval card: pick "Allow once", then press the approve button. */
async function allowOnce(): Promise<void> {
  const card = page
    .getByRole("group")
    .filter({ has: page.getByText("Allow once") })
    .last();
  await card.getByText("Allow once", { exact: true }).click();
  const approve = card.getByRole("button", { name: "Allow with scope" });
  await expect(approve).toBeEnabled(); // arms 400 ms after the card appears
  await approve.click();
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "psy-int1-e2e-")));
  home = join(dir, "h");
  const granted = join(dir, "granted");
  mkdirSync(granted, { recursive: true });
  notes = join(granted, "notes.md");
  writeFileSync(notes, "# Groceries\n- milk\n");
  composed = await composeGateway({
    env: {},
    logger: { log: () => {} },
    retentionIntervalMs: 0,
    config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
    model: { provider: model, model: MAIN, utilityModel: UTILITY },
    policy: { folders: [{ path: granted, mode: "rw" }] },
    taskPollMs: 50,
    compaction: { thresholdRatio: 0.000_001, keepRecentTurns: 1 },
  });
  await launch();
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  await composed?.stop("test");
  rmSync(dir, { recursive: true, force: true });
});

test("onboarding names the agent and writes the persona files", async () => {
  const onboarding = page.getByTestId("onboarding");
  await expect(onboarding).toBeVisible({ timeout: 20_000 });
  await page.getByLabel("Name", { exact: true }).fill("Flash");
  await page.getByLabel("Vibe or tagline").fill("Small errands, done.");
  for (let i = 0; i < 5; i += 1) await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: "Open the main chat" }).click();
  await expect(page.getByRole("textbox", { name: "Message Flash" })).toBeVisible({
    timeout: 20_000,
  });
  const identity = readFileSync(join(home, "workspace", "IDENTITY.md"), "utf8");
  expect(identity).toContain('name: "Flash"');
});

test("a turn streams, reads a granted file and asks to write it; Allow once writes with a receipt", async () => {
  model.chat.script([
    calls(
      [
        "c1",
        "update_plan",
        {
          items: [
            { text: "Read the grocery list", status: "in_progress" },
            { text: "Add eggs", status: "pending" },
            { text: "Ask which store", status: "pending" },
          ],
        },
      ],
      ["c2", "read_file", { path: notes }],
    ),
    calls(
      ["c3", "update_plan", { advance: true }],
      ["c4", "write_file", { path: notes, content: "# Groceries\n- milk\n- eggs\n" }],
    ),
    calls(
      ["c5", "update_plan", { advance: true }],
      [
        "c6",
        "ask_user",
        {
          questions: [
            {
              header: "Store",
              question: "Which store should I plan the trip for?",
              options: [{ label: "Corner shop (Recommended)" }, { label: "Supermarket" }],
              multiSelect: false,
            },
          ],
        },
      ],
    ),
    calls(
      ["c7", "update_plan", { advance: true }],
      [
        "c8",
        "wrap_up",
        {
          recap: "Eggs are on the list in notes.md.",
          ask: "Add anything else to the list?",
          actions: [{ label: "Add more", message: "Add bread too" }],
        },
      ],
    ),
    say("Added eggs and noted the corner shop."),
  ]);
  const composer = page.getByRole("textbox", { name: "Message Flash" });
  await composer.fill("Add eggs to my grocery list in notes.md");
  await composer.press("Enter");

  await expect(page.getByText("Allow once")).toBeVisible({ timeout: 20_000 });
  expect(readFileSync(notes, "utf8")).not.toContain("eggs");
  await allowOnce();
  await expect.poll(() => readFileSync(notes, "utf8")).toContain("- eggs");
  // The receipt line under the write: its summary and time. The receipt id (R1) is disclosure
  // level 2 since the calm chat column (e4f014f2), so the default view doesn't show it (#561).
  await expect(
    page.locator("p").filter({ hasText: /^Write notes\.md · \d{1,2}:\d{2}/ }),
  ).toBeVisible();
});

test("a question with chips resumes the turn; checklist and wrap-up update", async () => {
  // The recommended option comes first and preselected; "(Recommended)" shows as a badge.
  await page.getByRole("radio", { name: /^Corner shop/ }).check();
  await page.getByRole("button", { name: "Answer" }).click();
  await expect(page.getByLabel("Checklist, 3 of 3 done").last()).toBeVisible({ timeout: 20_000 });
  const wrap = page.getByLabel("Wrap-up").last();
  await expect(wrap).toContainText("Add anything else to the list?");
  await expect(wrap.getByRole("button", { name: "Add more" })).toBeVisible();
});

test("a delegated task keeps running after the window quits and shows in Activity on relaunch", async () => {
  model.chat.script([
    calls([
      "d1",
      "task.start",
      { title: "Corner shop hours", goal: `${TASK_MARKER}: find the corner shop's opening hours.` },
    ]),
    say("Started a background task for the shop hours."),
  ]);
  model.task.script([say("The corner shop opens at 7am and closes at 10pm.")]);
  const composer = page.getByRole("textbox", { name: "Message Flash" });
  await composer.fill("In the background, find the corner shop's hours");
  await composer.press("Enter");
  await expect(page.getByText("Allow once")).toBeVisible({ timeout: 20_000 });
  await allowOnce();
  // Quit the window; the Gateway (and its worker pool) keeps going.
  await app.close();
  await expect
    .poll(
      async () =>
        (await composed.tasks.list()).find((t) => t.title === "Corner shop hours")?.status,
      { timeout: 20_000 },
    )
    .toBe("done");
  await launch();
  await page.getByRole("button", { name: /^Open Flash's activity/ }).click();
  await expect(page.getByRole("list", { name: "Tasks" })).toContainText("Corner shop hours", {
    timeout: 20_000,
  });
});

test("Soul & Memory shows today's daily note, edits SOUL.md and exports everything", async () => {
  await page.getByRole("tab", { name: "Soul & Memory" }).click();
  // The daily note is named by its local date; the list labels it like "Oct 24" (the file's
  // YYYY-MM-DD read as a UTC date, #561).
  const today = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD in local time
  const label = new Date(`${today}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  await expect(page.getByRole("navigation", { name: "Daily notes" })).toContainText(label, {
    timeout: 20_000,
  });
  await page.getByRole("tab", { name: "SOUL.md" }).click();
  const editor = page.getByLabel("SOUL.md contents");
  await editor.press("End");
  await editor.press("ControlOrMeta+End");
  await editor.pressSequentially("\n- I keep grocery lists short.\n");
  await page.getByRole("button", { name: "Save" }).click();
  await expect
    .poll(() => readFileSync(join(home, "workspace", "SOUL.md"), "utf8"))
    .toContain("I keep grocery lists short.");
  await page.getByRole("button", { name: "Export everything" }).click();
  await expect(page.getByText(/^Exported .*\.zip\.$/)).toBeVisible({ timeout: 20_000 });
});
