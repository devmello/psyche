import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResolvedSecret } from "@psyche/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FsQuarantineWriter } from "../src/downloads/library.ts";
import { CdpBridgeDriver } from "../src/drivers/cdp.ts";
import { FileRecordingSink } from "../src/recording/recorder.ts";
import { SECURE_MASK } from "../src/snapshot/builder.ts";
import { type FieldFacts, isSecureField } from "../src/snapshot/secure-field.ts";
import { MockDesktop } from "../src/testing/mock-desktop.ts";

const input = (f: Omit<FieldFacts, "tag">): FieldFacts => ({ tag: "INPUT", ...f });

const MUST_HIDE: [string, FieldFacts][] = [
  ["type=password", input({ type: "password" })],
  ["type=PASSWORD (case)", input({ type: "PASSWORD" })],
  ["current-password", input({ type: "text", autocomplete: "current-password" })],
  ["new-password", input({ type: "text", autocomplete: "new-password" })],
  ["one-time-code on type=text", input({ type: "text", autocomplete: "one-time-code" })],
  ["cc-number", input({ autocomplete: "cc-number" })],
  ["cc-csc with a section token", input({ autocomplete: "section-pay cc-csc" })],
  ["cc-exp", input({ autocomplete: "cc-exp" })],
  ["cc-exp-month", input({ autocomplete: "cc-exp-month" })],
  ["cc-exp-year", input({ autocomplete: "cc-exp-year" })],
  ["name otp", input({ name: "otp" })],
  ["name totp_code", input({ name: "totp_code" })],
  ["id mfaCode camelCase", input({ id: "mfaCode" })],
  ["label Verification code", input({ label: "Verification code" })],
  ["placeholder One-time code", input({ placeholder: "One-time code" })],
  ["aria-label Two-factor code", input({ ariaLabel: "Two-factor code" })],
  ["name cvv", input({ name: "cvv" })],
  ["name cvc2 -> cvc", input({ name: "card-cvc" })],
  ["label Card security code", input({ label: "Card security code" })],
  ["label Card number", input({ label: "Card number" })],
  ["name cardnumber", input({ name: "cardnumber" })],
  ["revealed password: type=text name password", input({ type: "text", name: "password" })],
  ["revealed password: label Confirm password", input({ type: "text", label: "Confirm password" })],
  ["textarea named otp", { tag: "TEXTAREA", name: "otp" }],
  [
    "contenteditable labelled Verification code",
    { tag: "DIV", contentEditable: true, label: "Verification code" },
  ],
  [
    "contenteditable with one-time-code",
    { tag: "DIV", contentEditable: true, autocomplete: "one-time-code" },
  ],
];

const MUST_NOT_HIDE: [string, FieldFacts][] = [
  ["plain text field", input({ type: "text", name: "username", label: "Username" })],
  ["Password hint text field", input({ type: "text", name: "hint", label: "Password hint" })],
  ["name password_hint", input({ type: "text", name: "password_hint" })],
  [
    "Forgot password search",
    input({ type: "search", label: "Search help articles: forgot password" }),
  ],
  ["search box named pass", input({ type: "search", name: "pass", label: "Find a flight" })],
  ["boarding pass number", input({ type: "text", name: "boarding_pass", label: "Boarding pass" })],
  ["autocomplete username", input({ autocomplete: "username" })],
  ["autocomplete email", input({ autocomplete: "email" })],
  ["email Cc", input({ name: "cc", label: "Cc" })],
  ["library card number", input({ name: "library-card", label: "Library card number" })],
  ["card PIN", input({ name: "card_pin", label: "PIN" })],
  ["gift card message", input({ label: "Message on the card" })],
  ["otp-like word inside another", input({ name: "hotpot" })],
  ["checkbox named otp", input({ type: "checkbox", name: "otp" })],
  ["submit button named cvv", input({ type: "submit", name: "cvv" })],
  ["a paragraph", { tag: "P", label: "Verification code" }],
  ["a div that is not editable", { tag: "DIV", label: "Verification code" }],
  ["contenteditable body", { tag: "DIV", contentEditable: true, label: "Message body" }],
];

describe("isSecureField classifier", () => {
  it.each(MUST_HIDE)("hides: %s", (_n, f) => {
    expect(isSecureField(f)).toBe(true);
  });
  it.each(MUST_NOT_HIDE)("keeps visible: %s", (_n, f) => {
    expect(isSecureField(f)).toBe(false);
  });
});

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
