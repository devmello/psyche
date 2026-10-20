import type { BrowserDriver } from "@psyche/protocol";
import { FakeBrowserDriver } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import { createBrowserProvider } from "../src/capabilities/browser.ts";
import type { CapabilityEntry, CapabilityProvider } from "../src/capabilities/types.ts";
import { createInvocationContext } from "../src/invocation.ts";

const SITE = {
  pages: {
    "https://example.test/": {
      title: "Home",
      text: "Welcome home",
      elements: [
        { role: "link", name: "About", href: "/about" },
        { role: "textbox", name: "Search" },
      ],
    },
    "https://example.test/about": { title: "About", text: "About us" },
  },
};

function setup(): { provider: CapabilityProvider; fake: FakeBrowserDriver } {
  const fake = FakeBrowserDriver.site(SITE);
  const provider = createBrowserProvider({
    home: "/nonexistent",
    enabled: true,
    driverFactory: async () => fake as BrowserDriver,
  });
  return { provider, fake };
}

async function call(provider: CapabilityProvider, name: string, params: unknown) {
  const e: CapabilityEntry | undefined = (await provider.entries()).find(
    (x) => x.manifest.name === name,
  );
  if (!e) throw new Error(`no entry ${name}`);
  return e.handler(
    params,
    createInvocationContext({ invocationId: `inv_${name}`, capability: name }),
  );
}

describe("browser provider", () => {
  it("declares conservative side effects", async () => {
    const { provider } = setup();
    const byName = new Map((await provider.entries()).map((e) => [e.manifest.name, e.manifest]));
    expect(byName.get("browser.navigate")).toMatchObject({
      sideEffect: "read",
      targetKind: "origin",
    });
    expect(byName.get("browser.open_tab")).toMatchObject({
      sideEffect: "read",
      targetKind: "origin",
    });
    for (const n of ["browser.click", "browser.type", "browser.select"]) {
      expect(byName.get(n)?.sideEffect).toBe("write");
    }
    expect(byName.has("browser.fill_credential")).toBe(false);
    expect(byName.get("browser.wait")?.sideEffect).toBe("none");
  });

  it("runs open_session → open_tab → navigate → snapshot → click", async () => {
    const { provider, fake } = setup();
    const s = await call(provider, "browser.open_session", { partition: "clean" });
    expect(s.ok).toBe(true);
    const sessionId = (s as { result: { sessionId: string } }).result.sessionId;

    const t = await call(provider, "browser.open_tab", { sessionId });
    const tabId = (t as { result: { tab: { id: string } } }).result.tab.id;

    const nav = await call(provider, "browser.navigate", { tabId, url: "https://example.test/" });
    expect(nav).toMatchObject({
      ok: true,
      result: { url: "https://example.test/", title: "Home" },
    });
    expect(nav.receipt).toBeUndefined();

    const snap = await call(provider, "browser.snapshot", { tabId });
    expect(snap).toMatchObject({
      ok: true,
      result: {
        refs: [
          { ref: "ref_1", name: "About" },
          { ref: "ref_2", name: "Search" },
        ],
      },
    });

    const click = await call(provider, "browser.click", { tabId, ref: "ref_1" });
    expect(click.ok).toBe(true);
    expect(click.receipt).toMatchObject({
      kind: "browser.click",
      outcome: "ok",
      payload: { tabId, ref: "ref_1" },
      externalRefs: { invocationId: "inv_browser.click" },
    });
    expect(fake.actions.at(-1)).toMatchObject({ action: "click", ref: "ref_1" });

    const text = await call(provider, "browser.read_text", { tabId });
    expect(text).toMatchObject({ ok: true, result: { text: "About us" } });

    const shot = await call(provider, "browser.screenshot", { tabId });
    expect(shot).toMatchObject({ ok: true, result: { mime: "image/png" } });
    expect(Buffer.from((shot as { result: { data: string } }).result.data, "base64")[1]).toBe(0x50);

    await provider.dispose?.();
    expect(await fake.listTabs(sessionId)).toEqual([]);
  });

  it("type receipt never includes the typed text", async () => {
    const { provider } = setup();
    const s = await call(provider, "browser.open_session", {});
    const sessionId = (s as { result: { sessionId: string } }).result.sessionId;
    const t = await call(provider, "browser.open_tab", { sessionId, url: "https://example.test/" });
    const tabId = (t as { result: { tab: { id: string } } }).result.tab.id;
    const secret = "hunter2-very-private";
    const out = await call(provider, "browser.type", { tabId, ref: "ref_2", text: secret });
    expect(out.ok).toBe(true);
    expect(out.receipt).toMatchObject({ kind: "browser.type", payload: { tabId, ref: "ref_2" } });
    expect(JSON.stringify(out.receipt)).not.toContain(secret);
  });

  it("maps driver errors to payloads with a failed receipt for writes", async () => {
    const { provider } = setup();
    const out = await call(provider, "browser.click", { tabId: "tab_missing", ref: "ref_1" });
    expect(out).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(out.receipt?.outcome).toBe("failed");
    const bad = await call(provider, "browser.navigate", { tabId: 3 });
    expect(bad).toMatchObject({ ok: false, error: { code: "invalid_params" } });
  });

  it("offers nothing when disabled", async () => {
    const provider = createBrowserProvider({
      home: "/nonexistent",
      enabled: false,
      driverFactory: async () => new FakeBrowserDriver(),
    });
    expect(await provider.entries()).toEqual([]);
    expect(await provider.status?.()).toMatchObject({ browser: "unavailable", reason: "disabled" });
  });
});
