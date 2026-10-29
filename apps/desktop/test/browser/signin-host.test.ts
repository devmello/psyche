import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Minimal Electron doubles: just what BrowserHost touches. */
const h = vi.hoisted(() => {
  class FakeWc {
    static next = 1;
    id = FakeWc.next++;
    url = "";
    title = "";
    zoom = 1;
    loading = false;
    audible = false;
    destroyed = false;
    attached = false;
    handlers = new Map<string, ((...a: unknown[]) => void)[]>();
    on(ev: string, fn: (...a: unknown[]) => void) {
      const list = this.handlers.get(ev) ?? [];
      list.push(fn);
      this.handlers.set(ev, list);
      return this;
    }
    once(ev: string, fn: (...a: unknown[]) => void) {
      return this.on(ev, fn);
    }
    emit(ev: string, ...a: unknown[]) {
      for (const fn of this.handlers.get(ev) ?? []) fn(...a);
    }
    debugger = {
      on: () => {},
      isAttached: () => this.attached,
      attach: () => {
        this.attached = true;
      },
      detach: () => {
        this.attached = false;
      },
      sendCommand: async () => ({}),
    };
    navigationHistory = { canGoBack: () => false, canGoForward: () => false };
    setWindowOpenHandler() {}
    getURL() {
      return this.url;
    }
    getTitle() {
      return this.title;
    }
    getZoomFactor() {
      return this.zoom;
    }
    setZoomFactor(z: number) {
      this.zoom = z;
    }
    isLoading() {
      return this.loading;
    }
    isCurrentlyAudible() {
      return this.audible;
    }
    isDestroyed() {
      return this.destroyed;
    }
    loadURL(url: string) {
      this.url = url;
      return Promise.resolve();
    }
    reads: string[] = [];
    executeJavaScriptInIsolatedWorld() {
      return Promise.resolve(this.reads.shift());
    }
    close() {
      this.destroyed = true;
      this.emit("destroyed");
    }
  }
  const views: { webContents: FakeWc; prefs: { partition?: string } }[] = [];
  class FakeView {
    webContents: FakeWc;
    prefs: { partition?: string };
    constructor(o: { webPreferences?: { partition?: string }; webContents?: FakeWc }) {
      this.webContents = o.webContents ?? new FakeWc();
      this.prefs = o.webPreferences ?? {};
      views.push(this);
    }
    setBounds() {}
    setVisible() {}
  }
  class FakeWindow {
    children = new Set<unknown>();
    contentView = {
      addChildView: (v: unknown) => this.children.add(v),
      removeChildView: (v: unknown) => this.children.delete(v),
    };
    isDestroyed() {
      return false;
    }
    isVisible() {
      return true;
    }
    isMinimized() {
      return false;
    }
    getContentBounds() {
      return { width: 800, height: 600 };
    }
    on() {}
    close() {}
    destroy() {}
    setFullScreen() {}
  }
  type Cookie = { name: string; value: string; domain?: string; path?: string };
  const sessions = new Map<string, ReturnType<typeof makeSession>>();
  function makeSession() {
    const jar: Cookie[] = [];
    return {
      jar,
      setPermissionRequestHandler() {},
      setPermissionCheckHandler() {},
      on() {},
      webRequest: { onHeadersReceived() {} },
      flushStorageData() {},
      cookies: {
        get: async () => [...jar],
        set: async (d: Cookie & { url: string; domain?: string }) => {
          jar.push({ name: d.name, value: d.value, domain: d.domain ?? new URL(d.url).hostname });
        },
        remove: async (url: string, name: string) => {
          const host = new URL(url).hostname;
          const i = jar.findIndex((c) => c.name === name && c.domain?.replace(/^\./, "") === host);
          if (i >= 0) jar.splice(i, 1);
        },
      },
    };
  }
  function sessionFor(partition: string) {
    let s = sessions.get(partition);
    if (!s) {
      s = makeSession();
      sessions.set(partition, s);
    }
    return s;
  }
  return { FakeWc, FakeView, FakeWindow, views, sessionFor };
});

vi.mock("electron", () => ({
  BaseWindow: h.FakeWindow,
  WebContentsView: h.FakeView,
  session: { fromPartition: (p: string) => h.sessionFor(p) },
}));

import { BrowserHost } from "../../src/main/browser/browser-host.ts";

const SECRET = "hunter2-very-secret";
let home: string;
let host: BrowserHost;
const added: unknown[] = [];

function tabOf(tabId: string) {
  const tabs = (
    host as unknown as {
      tabs: Map<string, { wc: InstanceType<typeof h.FakeWc>; partition: string; profile: string }>;
    }
  ).tabs;
  const t = tabs.get(tabId);
  if (!t) throw new Error("no tab");
  return t;
}
const poll = () => (host as unknown as { pollCaptures(): void }).pollCaptures();
const form = (o: Record<string, unknown>) => JSON.stringify(o);
async function settle() {
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "psyche-host-signin-"));
  added.length = 0;
  host = new BrowserHost({
    window: new h.FakeWindow() as never,
    psycheHome: home,
    userData: join(home, "userData"),
    captureEveryMs: 3_600_000,
    vaultAdd: async (item) => void added.push(item),
  });
});
afterEach(() => {
  host.dispose();
  rmSync(home, { recursive: true, force: true });
});

async function signInAsOwner() {
  const tab = await host.open({ url: "https://canvas.ucsc.edu/", profile: "clean", taskId: "t1" });
  const t = tabOf(tab.tabId);
  await host.setControl(tab.tabId, true);
  t.wc.reads.push(
    form({
      url: "https://login.ucsc.edu/idp",
      passwordFieldPresent: true,
      username: "pranav",
      password: SECRET,
    }),
  );
  poll();
  await settle();
  t.wc.url = "https://canvas.ucsc.edu/home";
  t.wc.emit("did-navigate", {}, "https://login.ucsc.edu/idp");
  t.wc.emit("did-navigate", {}, "https://canvas.ucsc.edu/home");
  t.wc.reads.push(
    form({
      url: "https://canvas.ucsc.edu/home",
      passwordFieldPresent: false,
      username: "",
      password: "",
    }),
  );
  poll();
  await settle();
  return { tab, t };
}

describe("BrowserHost sign-in prompts", () => {
  it("offers both prompts after the owner signs in, with the real origin and no password", async () => {
    const { tab } = await signInAsOwner();
    const prompts = host.getState().prompts ?? [];
    expect(prompts.map((p) => [p.kind, p.origin])).toEqual([
      ["stay_signed_in", "https://canvas.ucsc.edu"],
      ["save_login", "https://login.ucsc.edu"],
    ]);
    expect(prompts.every((p) => p.tabId === tab.tabId)).toBe(true);
    expect(JSON.stringify(host.getState())).not.toContain(SECRET);
  });

  it("offers nothing while the agent holds the tab", async () => {
    const tab = await host.open({ url: "https://canvas.ucsc.edu/", profile: "clean" });
    const t = tabOf(tab.tabId);
    t.wc.reads.push(
      form({
        url: "https://login.ucsc.edu/idp",
        passwordFieldPresent: true,
        username: "a",
        password: SECRET,
      }),
    );
    poll();
    await settle();
    t.wc.emit("did-navigate", {}, "https://canvas.ucsc.edu/home");
    t.wc.reads.push(form({ url: "https://canvas.ucsc.edu/home", passwordFieldPresent: false }));
    poll();
    await settle();
    expect(host.getState().prompts).toEqual([]);
  });

  it("Save sends the item to the vault; Never for this site stops later offers", async () => {
    await signInAsOwner();
    const save = host.getState().prompts?.find((p) => p.kind === "save_login");
    await host.answerPrompt(save?.id ?? "", "never");
    expect(added).toEqual([]);
    expect(host.getState().prompts?.map((p) => p.kind)).toEqual(["stay_signed_in"]);
    await signInAsOwner();
    expect(host.getState().prompts?.filter((p) => p.kind === "save_login")).toEqual([]);
  });

  it("Save puts an origin-bound login in the vault", async () => {
    await signInAsOwner();
    const save = host.getState().prompts?.find((p) => p.kind === "save_login");
    await host.answerPrompt(save?.id ?? "", "accept");
    expect(added).toEqual([
      {
        kind: "login",
        name: "login.ucsc.edu",
        bindings: [{ origin: "https://login.ucsc.edu" }],
        secret: { username: "pranav", password: SECRET },
      },
    ]);
  });

  it("Stay signed in moves the cookies and the tab to the profile, then Forget undoes it", async () => {
    const { tab } = await signInAsOwner();
    const clean = tabOf(tab.tabId).partition;
    h.sessionFor(clean).jar.push(
      { name: "sid", value: "1", domain: "canvas.ucsc.edu" },
      { name: "sso", value: "2", domain: ".login.ucsc.edu" },
      { name: "t", value: "3", domain: "tracker.example" },
    );
    const stay = host.getState().prompts?.find((p) => p.kind === "stay_signed_in");
    await host.answerPrompt(stay?.id ?? "", "accept");

    const profile = h.sessionFor("persist:agent-default").jar;
    expect(profile.map((c) => c.name).sort()).toEqual(["sid", "sso"]);
    expect(tabOf(tab.tabId).partition).toBe("persist:agent-default");
    expect(tabOf(tab.tabId).profile).toBe("logged-in");
    expect((await host.signedInSites()).map((s) => s.origin)).toEqual(["https://canvas.ucsc.edu"]);
    expect((await host.signedInSites())[0]?.hosts).toEqual(["canvas.ucsc.edu", "login.ucsc.edu"]);
    // The clean partition keeps its other cookies, untouched.
    expect(h.sessionFor(clean).jar).toHaveLength(3);

    expect(await host.forgetSignedInSite("https://canvas.ucsc.edu/")).toBe(true);
    expect(profile).toEqual([]);
    expect(await host.signedInSites()).toEqual([]);
  });
});
