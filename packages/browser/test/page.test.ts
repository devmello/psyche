import { describe, expect, it } from "vitest";
import { PageController } from "../src/cdp/page.ts";
import { OriginPolicy } from "../src/origin/policy.ts";
import { MockBrowser } from "../src/testing/mock-browser.ts";
import type { DriverEventEx } from "../src/types.ts";

async function setup(policyOpts: ConstructorParameters<typeof OriginPolicy>[0] = {}) {
  const browser = new MockBrowser();
  const tab = browser.openTab();
  const policy = new OriginPolicy({
    devPreview: true,
    readWritable: [browser.origin("a")],
    ...policyOpts,
  });
  const events: DriverEventEx[] = [];
  let user = false;
  const page = new PageController({
    tabId: tab.id,
    target: tab,
    policy: () => policy,
    assertAgent: () => {
      if (user) throw Object.assign(new Error("user"), { code: "conflict" });
    },
    userInControl: () => user,
    emit: (e) => events.push(e),
  });
  await page.init();
  return { browser, tab, page, policy, events, setUser: (v: boolean) => (user = v) };
}

describe("PageController over the mock CDP page", () => {
  it("navigates, snapshots and fills a login form by ref", async () => {
    const { browser, tab, page } = await setup();
    const nav = await page.navigate(browser.url("a/login"));
    expect(nav).toMatchObject({ title: "Sign in", status: 200 });
    const snap = await page.snapshot();
    expect(snap.text).toContain('textbox "Username"');
    const user = snap.refs.find((r) => r.name === "Username");
    const pass = snap.refs.find((r) => r.name === "Password");
    const submit = snap.refs.find((r) => r.role === "button" && r.name === "Sign in");
    expect(user && pass && submit).toBeTruthy();
    if (!user || !pass || !submit) return;
    expect(user.box).toEqual({ x: 20, y: expect.any(Number), width: 300, height: 30 });
    await page.type(user.ref, "ada");
    expect(tab.fieldValue("username")).toBe("ada");
    await expect(page.type(pass.ref, "hunter2")).rejects.toMatchObject({ code: "policy_denied" });
    const again = await page.snapshot();
    expect(again.refs.find((r) => r.name === "Username")?.ref).toBe(user.ref);
    await page.pointer({ ref: submit.ref }, "click");
    await page.wait({ kind: "text", text: "username=ada" }, { timeoutMs: 2000 });
    expect(browser.submissions.at(-1)?.path).toBe("/submit/login");
    await expect(page.pointer({ ref: submit.ref }, "click")).rejects.toMatchObject({
      code: "not_found",
      details: { reason: "stale_ref" },
    });
  });

  it("asks before a new origin and blocks redirects out of the set", async () => {
    const { browser, page } = await setup();
    await expect(page.navigate(browser.url("b/landing"))).rejects.toMatchObject({
      code: "approval_required",
      details: { kind: "new_origin", origin: browser.origin("b") },
    });
    await expect(page.navigate(browser.url("a/redirect-b"))).rejects.toMatchObject({
      code: "approval_required",
      details: { hop: "redirect" },
    });
    await expect(page.navigate(browser.url("a/redirect-private"))).rejects.toMatchObject({
      code: "policy_denied",
      details: { reason: "private_network" },
    });
    await expect(page.navigate("file:///etc/passwd")).rejects.toMatchObject({
      code: "policy_denied",
    });
  });

  it("hides cross-origin frames and reads same-origin ones", async () => {
    const { browser, page } = await setup();
    await page.navigate(browser.url("a/iframes"));
    const snap = await page.snapshot();
    expect(snap.text).toContain("Inside same-origin frame");
    expect(snap.text).not.toContain("Inside cross-origin frame");
    expect(snap.text).toContain(`cross-origin ${browser.origin("b")}`);
  });

  it("flags sparse trees and captchas", async () => {
    const { browser, page } = await setup();
    await page.navigate(browser.url("a/canvas"));
    expect((await page.snapshot()).sparse).toBe(true);
    await page.navigate(browser.url("a/captcha"));
    expect((await page.snapshot()).captcha).toBe(true);
  });
});
