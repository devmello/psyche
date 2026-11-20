import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResolvedSecret } from "@psyche/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FsQuarantineWriter } from "../src/downloads/library.ts";
import { CdpBridgeDriver } from "../src/drivers/cdp.ts";
import { FileRecordingSink } from "../src/recording/recorder.ts";
import { SECURE_MASK } from "../src/snapshot/builder.ts";
import { MockDesktop } from "../src/testing/mock-desktop.ts";

describe("secret field values never reach the model (mock CDP page)", () => {
  let dir: string;
  let desktop: MockDesktop;
  let driver: CdpBridgeDriver;
  const SECRETS = ["482913", "7391", "551122", "hunter2-secret"];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "psyche-secure-fields-"));
    desktop = new MockDesktop({ quarantineDir: dir });
    driver = new CdpBridgeDriver(await desktop.connect(), {
      library: new FsQuarantineWriter(join(dir, "library")),
      downloadTimeoutMs: 5000,
      redact: (t) => t, // no vault redaction: the field classifier alone must hold
    });
  });
  afterAll(async () => {
    driver.dispose();
    desktop.disconnect();
    await rm(dir, { recursive: true, force: true });
  });

  it("hides OTP, CVC and one-time-code values, keeps the look-alikes", async () => {
    const a = desktop.browser.origin("a");
    const s = await driver.openSession({
      taskId: "task_codes",
      policy: { devPreview: true, readWritable: [a], readOnly: [] },
    });
    const t = await driver.openTab(s.id, desktop.browser.url("a/codes"));
    const snap = await driver.snapshot(t.id);
    for (const secret of SECRETS.slice(0, 3)) {
      expect(snap.text).not.toContain(secret);
      expect(JSON.stringify(snap.refs)).not.toContain(secret);
    }
    expect(snap.text).toContain(`value="${SECURE_MASK}"`);
    // Role and label stay.
    expect(snap.refs.find((r) => r.name.includes("Verification code"))?.role).toBe("textbox");
    expect(snap.refs.find((r) => r.name.includes("Card security code"))?.value).toBe(SECURE_MASK);
    // Look-alikes keep their values.
    expect(snap.text).toContain("first pet");
    expect(snap.text).toContain("LHR");
    expect(snap.secureFieldActive).toBe(true);
    // Page text and find never carry them either.
    const text = (await driver.readText(t.id)).text;
    for (const secret of SECRETS) expect(text).not.toContain(secret);
    const found = JSON.stringify(await driver.find(t.id, "code"));
    for (const secret of SECRETS) expect(found).not.toContain(secret);
    // The model gets no screenshot while such a field has a value.
    await expect(driver.screenshot(t.id)).rejects.toMatchObject({ code: "policy_denied" });
    await driver.closeSession(s.id);
  });

  it("the agent may still type an OTP the owner gave it, but not into a password or one-time-code field", async () => {
    const a = desktop.browser.origin("a");
    const s = await driver.openSession({
      taskId: "task_type_otp",
      policy: { devPreview: true, readWritable: [a], readOnly: [] },
    });
    const t = await driver.openTab(s.id, desktop.browser.url("a/codes"));
    const snap = await driver.snapshot(t.id);
    const ref = (name: string) => snap.refs.find((r) => r.name.includes(name))?.ref as string;
    await driver.type(t.id, ref("Verification code"), "123456");
    await expect(driver.type(t.id, ref("Code"), "123456")).rejects.toMatchObject({
      code: "policy_denied",
    });
    // press with a ref honours the same refusal
    await expect(driver.press(t.id, "a", { ref: ref("Code") })).rejects.toMatchObject({
      code: "policy_denied",
    });
    await driver.closeSession(s.id);
  });

  it("look-alike fields keep their values, link codes are masked and screenshots stay available", async () => {
    const a = desktop.browser.origin("a");
    const s = await driver.openSession({
      taskId: "task_lookalikes",
      policy: { devPreview: true, readWritable: [a], readOnly: [] },
    });
    const t = await driver.openTab(s.id, desktop.browser.url("a/lookalikes"));
    const snap = await driver.snapshot(t.id);
    expect(snap.text).toContain("PNR7Q2");
    expect(snap.text).toContain("560001");
    expect(snap.text).toContain("cvv help");
    expect(snap.text).not.toContain("909090");
    expect(snap.secureFieldActive).toBe(false);
    const shot = await driver.screenshot(t.id);
    expect([...shot.data.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    await driver.closeSession(s.id);
  });

  it("a value that appears between the check and the capture discards the screenshot", async () => {
    const a = desktop.browser.origin("a");
    const s = await driver.openSession({
      taskId: "task_toctou",
      policy: { devPreview: true, readWritable: [a], readOnly: [] },
    });
    const url = desktop.browser.url("a/login");
    const t = await driver.openTab(s.id, url);
    // The empty password field does not block the screenshot.
    const ok = await driver.screenshot(t.id);
    expect([...ok.data.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    // Autofill (or the owner) fills it while the PNG is being captured.
    const tab = [...desktop.browser.tabs.values()].find((x) => x.url === url);
    if (tab === undefined) throw new Error("mock tab not found");
    const send = tab.send.bind(tab);
    tab.send = (async (method: string, params?: Record<string, unknown>) => {
      if (method === "Page.captureScreenshot") tab.setFieldValue("password", SECRETS[3] as string);
      return send(method, params);
    }) as typeof tab.send;
    await expect(driver.screenshot(t.id)).rejects.toMatchObject({
      code: "policy_denied",
      details: { reason: "secure_field" },
    });
    tab.send = send;
    await driver.closeSession(s.id);
  });

  it("read_text skips a secret only the DOM can see, and masks card text on a page with no field", async () => {
    const a = desktop.browser.origin("a");
    const s = await driver.openSession({
      taskId: "task_read_dom",
      policy: { devPreview: true, readWritable: [a], readOnly: [] },
    });
    const t = await driver.openTab(s.id, desktop.browser.url("a/editable-code"));
    const text = (await driver.readText(t.id)).text;
    // A contenteditable is AX `generic`: only its DOM facts say it holds a code.
    expect(text).not.toContain("731");
    expect(text).toContain("bring 2 forms");
    const snap = await driver.snapshot(t.id);
    expect(snap.text).not.toContain("731");
    const t2 = await driver.openTab(s.id, desktop.browser.url("a/card-text"));
    const receipt = (await driver.readText(t2.id)).text;
    expect(receipt).not.toContain("4242");
    expect(receipt).toContain(`Paid with ${SECURE_MASK} on 12 May`);
    await driver.closeSession(s.id);
  });

  it("a filled password is absent from snapshot, text, screenshot error and the recording", async () => {
    const a = desktop.browser.origin("a");
    const sink = new FileRecordingSink(join(dir, "recordings"), "task_pw", {
      taskId: "task_pw",
      threadId: "thr_pw",
      minIntervalMs: 0,
    });
    const s = await driver.openSession({
      taskId: "task_pw",
      policy: { devPreview: true, readWritable: [a], readOnly: [] },
      recording: sink,
    });
    const t = await driver.openTab(s.id, desktop.browser.url("a/login"));
    const first = await driver.snapshot(t.id);
    const pass = first.refs.find((r) => r.name === "Password")?.ref as string;
    await driver.fillSecret(
      t.id,
      pass,
      new ResolvedSecret(SECRETS[3] as string, {
        credentialId: "c",
        target: { kind: "origin", value: a },
      }),
      a,
    );
    const snap = await driver.snapshot(t.id);
    const shot = await driver.screenshot(t.id).then(
      () => "image",
      (e: { message: string; details?: unknown }) => JSON.stringify(e),
    );
    const text = (await driver.readText(t.id)).text;
    expect(shot).not.toBe("image");
    for (const out of [snap.text, JSON.stringify(snap.refs), text, shot]) {
      expect(out).not.toContain(SECRETS[3]);
    }
    await driver.closeSession(s.id);
    for (const f of await readdir(sink.dir)) {
      expect(await readFile(join(sink.dir, f), "latin1")).not.toContain(SECRETS[3] as string);
    }
  });
});
