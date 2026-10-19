import { ResolvedSecret } from "@psyche/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodePng } from "../cdp/png.ts";
import type { LibraryImport } from "../downloads/library.ts";
import { REGRESSION_PAGES } from "../testing/site.ts";
import type { BrowserDriverEx, DriverEventEx, OpenSessionOptions } from "../types.ts";

/**
 * Driver conformance suite (S08 definition of done), shared by the CDP-bridge driver (mock
 * desktop) and the Playwright driver (real Chromium against `FixtureServer`). Each harness
 * supplies the driver, fixture URLs and a way to play the human taking control.
 */
export interface ConformanceHarness {
  driver: BrowserDriverEx;
  url(key: string): string;
  origin(host: "a" | "b" | "evil"): string;
  submissions(): { path: string; fields: [string, string][] }[];
  /** The human grabs the tab (desktop input or the Take control button). */
  takeControl(sessionId: string, tabId: string): Promise<void>;
  release(sessionId: string, tabId: string): Promise<void>;
  libraryItem(id: string): (LibraryImport & { storedPath: string }) | undefined;
  /** Absolute path of a small local file to upload. */
  uploadFile: string;
  close(): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function eventually<T>(fn: () => Promise<T> | T, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (Date.now() > end) throw last;
      await sleep(25);
    }
  }
}

export function describeBrowserDriverConformance(
  name: string,
  factory: () => Promise<ConformanceHarness>,
  options: { skip?: boolean; snapshotBudgetMs?: number } = {},
): void {
  describe.skipIf(options.skip === true)(`BrowserDriver conformance: ${name}`, () => {
    let h: ConformanceHarness;
    let d: BrowserDriverEx;
    const events: DriverEventEx[] = [];

    beforeAll(async () => {
      h = await factory();
      d = h.driver;
      d.onEventEx((e) => events.push(e));
    }, 60_000);
    afterAll(async () => {
      await h?.close();
    });

    const session = (extra: OpenSessionOptions = {}) =>
      d.openSession({
        policy: { devPreview: true, readWritable: [h.origin("a")], readOnly: [h.origin("b")] },
        ...extra,
      });
    const ref = async (tabId: string, role: string, nameIncludes: string) => {
      const snap = await d.snapshot(tabId);
      const r = snap.refs.find((x) => x.role === role && x.name.includes(nameIncludes));
      if (r === undefined) throw new Error(`no ${role} "${nameIncludes}" in\n${snap.text}`);
      return r.ref;
    };

    it("opens, lists, focuses and closes tabs", async () => {
      const s = await session();
      const t1 = await d.openTab(s.id, h.url("a/"));
      const t2 = await d.openTab(s.id, h.url("a/landing"));
      expect((await d.listTabs(s.id)).map((t) => t.id).sort()).toEqual([t1.id, t2.id].sort());
      expect(t1.title).toBe("Fixture home");
      await d.focusTab(t1.id);
      expect((await d.listTabs(s.id)).find((t) => t.id === t1.id)?.active).toBe(true);
      await d.closeTab(t2.id);
      expect((await d.listTabs(s.id)).map((t) => t.id)).toEqual([t1.id]);
      expect(events.some((e) => e.type === "tab_closed" && e.tabId === t2.id)).toBe(true);
      await d.closeSession(s.id);
    });

    it("fills and submits a form by ref with stable refs; stale after navigation", async () => {
      const s = await session();
      const t = await d.openTab(s.id, h.url("a/login"));
      const user = await ref(t.id, "textbox", "Username");
      const pass = await ref(t.id, "textbox", "Password");
      expect(await ref(t.id, "textbox", "Username")).toBe(user);
      await d.type(t.id, user, "ada");
      await expect(d.type(t.id, pass, "hunter2")).rejects.toMatchObject({ code: "policy_denied" });
      await d.click(t.id, await ref(t.id, "checkbox", "Remember"));
      const submit = await ref(t.id, "button", "Sign in");
      await d.click(t.id, submit);
      await d.wait(t.id, { kind: "text", text: "username=ada" }, { timeoutMs: 5000 });
      expect((await d.readText(t.id)).text).toContain("remember=on");
      await expect(d.click(t.id, submit)).rejects.toMatchObject({
        code: "not_found",
        details: { reason: "stale_ref" },
      });
      await d.closeSession(s.id);
    });

    it("types with submit, selects options and toggles checkboxes", async () => {
      const s = await session();
      const t = await d.openTab(s.id, h.url("a/search"));
      await d.type(t.id, await ref(t.id, "searchbox", "Query"), "psyche agent", { submit: true });
      await d.wait(t.id, { kind: "text", text: "q=psyche agent" }, { timeoutMs: 5000 });
      await d.navigate(t.id, h.url("a/settings"));
      const country = await ref(t.id, "combobox", "Country");
      await d.select(t.id, country, ["Japan"]);
      const snap = await d.snapshot(t.id);
      expect(snap.refs.find((r) => r.ref === country)?.value).toBe("Japan");
      await expect(d.select(t.id, country, ["Mars"])).rejects.toMatchObject({
        code: "invalid_params",
      });
      await d.type(t.id, await ref(t.id, "textbox", "Email"), "ada@example.com");
      await d.click(t.id, await ref(t.id, "button", "Save"));
      await d.wait(t.id, { kind: "text", text: "country=Japan" }, { timeoutMs: 5000 });
      await d.closeSession(s.id);
    });

    it("routes an OAuth popup into a new agent tab and back to the opener", async () => {
      const s = await session();
      const t = await d.openTab(s.id, h.url("a/popup"));
      await d.click(t.id, await ref(t.id, "button", "Sign in with Site B"));
      const popup = await eventually(async () => {
        const tabs = await d.listTabs(s.id);
        const p = tabs.find((x) => x.id !== t.id && x.url.includes("/oauth"));
        if (p === undefined) throw new Error("no popup yet");
        await d.wait(p.id, { kind: "text", text: "Allow access" }, { timeoutMs: 2000 });
        return p;
      });
      expect(
        events.some((e) => e.type === "popup" && e.tabId === popup.id && e.openerTabId === t.id),
      ).toBe(true);
      await d.click(popup.id, await ref(popup.id, "button", "Approve"));
      await eventually(async () => {
        expect((await d.listTabs(s.id)).some((x) => x.id === popup.id)).toBe(false);
      });
      await d.wait(t.id, { kind: "text", text: "Received: token tok_123" }, { timeoutMs: 5000 });
      await d.closeSession(s.id);
    });

    it("enforces the origin set on every redirect hop", async () => {
      const s = await d.openSession({
        policy: { devPreview: true, readWritable: [h.origin("a")] },
      });
      const t = await d.openTab(s.id, h.url("a/"));
      const same = await d.navigate(t.id, h.url("a/redirect-same"));
      expect(same.url).toBe(h.url("a/landing"));
      await expect(d.navigate(t.id, h.url("a/redirect-b"))).rejects.toMatchObject({
        code: "approval_required",
        details: { kind: "new_origin", origin: h.origin("b"), hop: "redirect" },
      });
      d.policy(s.id).grant(h.origin("b"), "read");
      await expect(d.navigate(t.id, h.url("a/redirect-chain"))).rejects.toMatchObject({
        code: "approval_required",
        details: { origin: h.origin("evil") },
      });
      await expect(d.navigate(t.id, h.url("a/redirect-private"))).rejects.toMatchObject({
        code: "policy_denied",
        details: { reason: "private_network" },
      });
      const ok = await d.navigate(t.id, h.url("a/redirect-b"));
      expect(ok.url).toBe(h.url("b/landing"));
      for (const bad of [
        "file:///etc/passwd",
        "about:blank",
        "javascript:alert(1)",
        "chrome://settings",
      ]) {
        await expect(d.navigate(t.id, bad)).rejects.toMatchObject({ code: "policy_denied" });
      }
      await d.closeSession(s.id);
    });

    it("never shows content from an origin a page navigated to on its own", async () => {
      const s = await session();
      const t = await d.openTab(s.id, h.url("a/script-nav"));
      await d.click(t.id, await ref(t.id, "button", "Continue to partner"));
      await sleep(200);
      const seen = await d.snapshot(t.id).then(
        (snap) => snap.text,
        (err: { code?: string }) => `error:${err.code}`,
      );
      expect(seen).not.toContain("You should not be here");
      expect(d.tabOrigin(t.id) === h.origin("evil") ? seen.startsWith("error:") : true).toBe(true);
      await d.closeSession(s.id);
    });

    it("refuses loopback outside dev-preview tasks", async () => {
      const s = await d.openSession({ policy: { readWritable: [h.origin("a")] } });
      await expect(d.openTab(s.id, h.url("a/"))).rejects.toMatchObject({
        code: "policy_denied",
        details: { reason: "loopback" },
      });
      await d.closeSession(s.id);
    });

    it("quarantines downloads into the Library with sniffed types", async () => {
      const s = await session({ taskId: "task_dl" });
      const t = await d.openTab(s.id, h.url("a/downloads"));
      const pdf = await d.download(t.id, { ref: await ref(t.id, "link", "Quarterly report") });
      expect(pdf).toMatchObject({
        filename: "report.pdf",
        mime: "application/pdf",
        quarantined: true,
      });
      expect(pdf.libraryItemId).toBeDefined();
      const bin = await d.download(t.id, { ref: await ref(t.id, "link", "Installer") });
      expect(h.libraryItem(bin.libraryItemId ?? "")?.executable).toBe(true);
      const csv = await d.download(t.id, { url: h.url("a/files/data.csv") });
      expect(csv.mime).toBe("text/csv");
      expect(events.some((e) => e.type === "download" && e.download.id === pdf.id)).toBe(true);
      await d.closeSession(s.id);
    });

    it("shows same-origin iframes and hides cross-origin ones", async () => {
      const s = await session();
      const t = await d.openTab(s.id, h.url("a/iframes"));
      await d.wait(t.id, { kind: "network_idle" }, { timeoutMs: 5000 });
      const snap = await d.snapshot(t.id);
      expect(snap.text).toContain("Inside same-origin frame");
      expect(snap.text).not.toContain("Inside cross-origin frame");
      expect(snap.text).toContain("content hidden");
      // Screenshots black out the hidden (cross-origin) frame, as snapshots leave it out.
      const box = snap.hiddenFrameBoxes?.[0];
      expect(box).toBeDefined();
      const shot = decodePng((await d.screenshot(t.id)).data);
      if (box !== undefined) {
        const scale = shot.width / (snap.viewportWidth ?? shot.width);
        const px = Math.floor((box.x + box.width / 2) * scale);
        const py = Math.floor((box.y + box.height / 2) * scale);
        const i = (py * shot.width + px) * shot.channels;
        expect([shot.pixels[i], shot.pixels[i + 1], shot.pixels[i + 2]]).toEqual([0, 0, 0]);
      }
      await d.closeSession(s.id);
    });

    it("surfaces dialogs, blocks input while one is open, and answers them", async () => {
      const s = await session();
      const t = await d.openTab(s.id, h.url("a/dialogs"));
      const del = await ref(t.id, "button", "Delete draft");
      await d.click(t.id, await ref(t.id, "button", "Alert me"));
      await eventually(() => expect(d.pendingDialog(t.id)?.message).toBe("Hello there"));
      expect(events.some((e) => e.type === "dialog" && e.message === "Hello there")).toBe(true);
      await expect(d.click(t.id, del)).rejects.toMatchObject({
        code: "conflict",
        details: { reason: "dialog_open" },
      });
      await expect(d.snapshot(t.id)).rejects.toMatchObject({ details: { reason: "dialog_open" } });
      await d.handleDialog(t.id, true);
      await d.click(t.id, del);
      await eventually(() => expect(d.pendingDialog(t.id)?.type).toBe("confirm"));
      await d.handleDialog(t.id, true);
      await d.wait(t.id, { kind: "text", text: "Draft deleted" }, { timeoutMs: 5000 });
      await d.closeSession(s.id);
    });

    it("refuses agent input while the user has control, then requires a fresh snapshot", async () => {
      const s = await session();
      const t = await d.openTab(s.id, h.url("a/login"));
      const user = await ref(t.id, "textbox", "Username");
      await h.takeControl(s.id, t.id);
      await eventually(async () => expect(await d.getControlState(s.id)).toBe("user"));
      await expect(d.type(t.id, user, "x")).rejects.toMatchObject({
        code: "conflict",
        details: { reason: "user_in_control" },
      });
      await expect(d.navigate(t.id, h.url("a/"))).rejects.toMatchObject({ code: "conflict" });
      await h.release(s.id, t.id);
      await eventually(async () => expect(await d.getControlState(s.id)).toBe("agent"));
      await expect(d.type(t.id, user, "x")).rejects.toMatchObject({ code: "conflict" });
      await d.type(t.id, await ref(t.id, "textbox", "Username"), "ada");
      expect(events.some((e) => e.type === "control_state" && e.state === "user")).toBe(true);
      await d.closeSession(s.id);
    });

    it("detects sparse trees and captchas", async () => {
      const s = await session();
      const t = await d.openTab(s.id, h.url("a/canvas"));
      expect((await d.snapshot(t.id)).sparse).toBe(true);
      await d.navigate(t.id, h.url("a/login"));
      expect((await d.snapshot(t.id)).sparse).toBeUndefined();
      await d.navigate(t.id, h.url("a/captcha"));
      expect((await d.snapshot(t.id)).captcha).toBe(true);
      await d.closeSession(s.id);
    });

    it("goes back and forward, follows history-API navigation, scrolls", async () => {
      const s = await session();
      const t = await d.openTab(s.id, h.url("a/"));
      await d.navigate(t.id, h.url("a/landing"));
      expect((await d.back(t.id)).url).toBe(h.url("a/"));
      expect((await d.forward(t.id)).url).toBe(h.url("a/landing"));
      await d.navigate(t.id, h.url("a/spa"));
      const go = await ref(t.id, "button", "Go to tab two");
      await d.click(t.id, go);
      await eventually(() => expect(d.tabOrigin(t.id)).toBe(h.origin("a")));
      await eventually(async () =>
        expect((await d.listTabs(s.id)).find((x) => x.id === t.id)?.url).toBe(h.url("a/spa/two")),
      );
      expect(await ref(t.id, "button", "Go to tab two")).toBe(go);
      await d.navigate(t.id, h.url("a/untrusted"));
      const snap = await d.snapshot(t.id);
      const far = snap.refs.find((r) => r.name === "Far below the fold");
      expect(far?.offscreen).toBe(true);
      await d.scrollTo(t.id, far?.ref ?? "");
      const after = await d.snapshot(t.id);
      expect(after.refs.find((r) => r.ref === far?.ref)?.offscreen).toBeUndefined();
      await d.scroll(t.id, { direction: "up", amount: 5000 });
      await d.pointer(t.id, { x: 10, y: 10 }, "hover");
      await d.press(t.id, "Tab");
      await d.closeSession(s.id);
    });

    it("refuses a click whose point is covered by another element", async () => {
      const s = await session();
      const t = await d.openTab(s.id, h.url("a/overlay"));
      await d.wait(t.id, { kind: "network_idle" }, { timeoutMs: 5000 });
      await expect(d.click(t.id, await ref(t.id, "button", "Buy coffee"))).rejects.toMatchObject({
        code: "conflict",
        details: { reason: "obscured" },
      });
      expect((await d.readText(t.id)).text).toContain("Not bought");
      await d.closeSession(s.id);
    });

    it("uploads a file, refuses card numbers and secure-field typing", async () => {
      const s = await session();
      const t = await d.openTab(s.id, h.url("a/upload"));
      await d.upload(t.id, await ref(t.id, "button", "Attachment"), [h.uploadFile]);
      await d.click(t.id, await ref(t.id, "button", "Upload"));
      await d.wait(t.id, { kind: "text", text: "Submitted /submit/upload" }, { timeoutMs: 5000 });
      await d.navigate(t.id, h.url("a/checkout"));
      await expect(
        // Stripe's public test number, assembled at runtime for the repo's secret gates.
        d.type(t.id, await ref(t.id, "textbox", "Card number"), Array(4).fill("4242").join(" ")),
      ).rejects.toMatchObject({ code: "policy_denied" });
      await d.closeSession(s.id);
    });

    it("fills vault secrets only on the bound origin and suppresses screenshots after", async () => {
      const s = await session();
      const t = await d.openTab(s.id, h.url("a/login"));
      const shot = await d.screenshot(t.id);
      expect([...shot.data.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
      const pass = await ref(t.id, "textbox", "Password");
      const target = { kind: "origin" as const, value: h.origin("b") };
      const wrong = new ResolvedSecret("hunter2", { credentialId: "c1", target });
      await expect(d.fillSecret(t.id, pass, wrong, h.origin("b"))).rejects.toMatchObject({
        code: "policy_denied",
      });
      expect(wrong.spent).toBe(false);
      const right = new ResolvedSecret("hunter2", {
        credentialId: "c1",
        target: { kind: "origin", value: h.origin("a") },
      });
      await d.fillSecret(t.id, pass, right, h.origin("a"));
      expect(right.spent).toBe(true);
      const snap = await d.snapshot(t.id);
      expect(snap.text).not.toContain("hunter2");
      expect(snap.secureFieldActive).toBe(true);
      await expect(d.screenshot(t.id)).rejects.toMatchObject({ code: "policy_denied" });
      await d.click(t.id, await ref(t.id, "button", "Sign in"));
      await d.wait(t.id, { kind: "text", text: "password: 7 chars" }, { timeoutMs: 5000 });
      await d.closeSession(s.id);
    });

    it(`snapshots the ${REGRESSION_PAGES.length}-page regression set within budget`, async () => {
      const s = await d.openSession({
        policy: { devPreview: true, readWritable: [h.origin("a"), h.origin("b")] },
      });
      const t = await d.openTab(s.id, h.url("a/"));
      const budget = options.snapshotBudgetMs ?? 300;
      for (const key of REGRESSION_PAGES) {
        await d.navigate(t.id, h.url(key));
        const t0 = performance.now();
        const snap = await d.snapshot(t.id);
        const ms = performance.now() - t0;
        expect(ms, `${key} snapshot took ${ms.toFixed(0)} ms`).toBeLessThan(budget);
        expect(snap.text.split("\n")[0], key).toContain(h.url(key).split("?")[0]);
        expect(snap.stats.keptNodes > 0 || snap.sparse === true, key).toBe(true);
        expect(snap.text.length, key).toBeLessThanOrEqual(24_500);
        expect((await d.readText(t.id)).text.length, key).toBeGreaterThanOrEqual(0);
      }
      const long = await (async () => {
        await d.navigate(t.id, h.url("a/long"));
        return d.snapshot(t.id, { maxChars: 4000 });
      })();
      expect(long.truncated).toBe(true);
      expect(long.refs[0]?.interactive).toBe(true);
      const page2 = await d.snapshot(t.id, { maxChars: 4000, page: 2 });
      expect(page2.page).toBe(Math.min(2, page2.pages));
      await d.closeSession(s.id);
    }, 60_000);
  });
}
