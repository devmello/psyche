import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CapturedLogin,
  type FormSnapshot,
  LoginCapture,
} from "../../src/main/browser/login-capture.ts";
import {
  type CookieRecord,
  type CookieSession,
  cookieMatchesHost,
  promoteCookies,
} from "../../src/main/browser/promote-cookies.ts";
import { SignedInStore, signedInFile } from "../../src/main/browser/signed-in-sites.ts";
import { forgetSite, staySignedIn } from "../../src/main/browser/signin-flow.ts";
import { SignInPrompts, type VaultLoginItem } from "../../src/main/browser/signin-prompts.ts";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "psyche-signin-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function jar(
  initial: CookieRecord[] = [],
): CookieSession & { all: CookieRecord[]; flushed: number } {
  const state = { all: [...initial], flushed: 0 };
  return {
    get all() {
      return state.all;
    },
    get flushed() {
      return state.flushed;
    },
    cookies: {
      get: async () => [...state.all],
      set: async (d) => {
        const { url, ...rest } = d;
        const host = new URL(url).hostname;
        state.all = state.all.filter(
          (c) => !(c.name === d.name && c.domain === (d.domain ?? host)),
        );
        state.all.push({ ...rest, domain: d.domain ?? host });
      },
      remove: async (url, name) => {
        const host = new URL(url).hostname;
        state.all = state.all.filter(
          (c) => !(c.name === name && (c.domain === host || c.domain === `.${host}`)),
        );
      },
    },
    flushStorageData: () => {
      state.flushed += 1;
    },
  };
}

const cookie = (domain: string, name = "sid"): CookieRecord => ({
  name,
  value: `v-${domain}-${name}`,
  domain,
  path: "/",
  secure: true,
  httpOnly: true,
});

describe("cookie promotion", () => {
  it("matches cookie domains the way a browser sends them", () => {
    expect(cookieMatchesHost(".ucsc.edu", "login.ucsc.edu")).toBe(true);
    expect(cookieMatchesHost("login.ucsc.edu", "login.ucsc.edu")).toBe(true);
    expect(cookieMatchesHost("login.ucsc.edu", "ucsc.edu")).toBe(false);
    expect(cookieMatchesHost(".evilucsc.edu", "ucsc.edu")).toBe(false);
  });

  it("moves the site's and the SSO hosts' cookies, and nothing else", async () => {
    const clean = jar([
      cookie("canvas.ucsc.edu"),
      cookie(".login.ucsc.edu", "sso"),
      cookie("other.example", "tracker"),
    ]);
    const profile = jar();
    const r = await promoteCookies(clean, profile, ["canvas.ucsc.edu", "login.ucsc.edu"], 1000);
    expect(r.moved).toBe(2);
    expect(profile.all.map((c) => c.name).sort()).toEqual(["sid", "sso"]);
    expect(profile.flushed).toBe(1);
    // Session cookies get a lifetime so the profile keeps them across quits.
    expect(profile.all.every((c) => (c.expirationDate ?? 0) > 1000)).toBe(true);
    // The clean partition is left as it was.
    expect(clean.all).toHaveLength(3);
  });

  it("records the origin and every host in signedInOrigins", async () => {
    const clean = jar([cookie("canvas.ucsc.edu"), cookie("login.ucsc.edu", "sso")]);
    const profile = jar();
    const store = new SignedInStore(home, () => new Date("2026-10-28T00:00:00Z"));
    const site = await staySignedIn({
      from: clean,
      to: profile,
      store,
      origin: "https://canvas.ucsc.edu",
      hosts: ["login.ucsc.edu"],
    });
    expect(site.hosts).toEqual(["canvas.ucsc.edu", "login.ucsc.edu"]);
    expect(store.list().map((s) => s.origin)).toEqual(["https://canvas.ucsc.edu"]);
    expect(statSync(signedInFile(home)).mode & 0o777).toBe(0o600);
    // The file holds no cookie value.
    expect(readFileSync(signedInFile(home), "utf8")).not.toContain("v-canvas");
  });

  it("forget removes the entry and its hosts' cookies from the profile", async () => {
    const profile = jar([
      cookie("canvas.ucsc.edu"),
      cookie("login.ucsc.edu", "sso"),
      cookie("github.com", "gh"),
    ]);
    const store = new SignedInStore(home);
    store.add("https://canvas.ucsc.edu", ["canvas.ucsc.edu", "login.ucsc.edu"]);
    store.add("https://github.com", ["github.com"]);
    expect(await forgetSite({ profile, store, origin: "https://canvas.ucsc.edu" })).toBe(true);
    expect(profile.all.map((c) => c.name)).toEqual(["gh"]);
    expect(store.list().map((s) => s.origin)).toEqual(["https://github.com"]);
    expect(await forgetSite({ profile, store, origin: "https://nope.example" })).toBe(false);
  });
});

function snap(over: Partial<FormSnapshot>): FormSnapshot {
  return {
    url: "https://login.ucsc.edu/idp",
    username: "",
    password: "",
    passwordFieldPresent: true,
    ...over,
  };
}

function capture(opts: {
  control: () => "agent" | "user" | "paused";
  reads: FormSnapshot[];
  never?: string[];
}) {
  const logins: CapturedLogin[] = [];
  const reads = [...opts.reads];
  const c = new LoginCapture({
    read: async () => reads.shift() ?? null,
    control: opts.control,
    isNeverSave: (o) => opts.never?.includes(o) ?? false,
    onLogin: (l) => logins.push(l),
  });
  return { c, logins };
}

describe("login detection", () => {
  const typed = snap({ username: "pranav", password: "hunter2" });
  const done = snap({ url: "https://canvas.ucsc.edu/", passwordFieldPresent: false });

  it("reports a login after the owner's submit lands on a page without a password field", async () => {
    const { c, logins } = capture({ control: () => "user", reads: [typed, done] });
    await c.tick();
    c.navigated("https://canvas.ucsc.edu/");
    await c.tick();
    expect(logins).toEqual([
      {
        origin: "https://login.ucsc.edu",
        username: "pranav",
        password: "hunter2",
        finalUrl: "https://canvas.ucsc.edu/",
      },
    ]);
  });

  it("ignores everything while the agent controls the tab", async () => {
    let control: "agent" | "user" = "agent";
    const { c, logins } = capture({ control: () => control, reads: [typed, done] });
    await c.tick();
    expect(c.hasPending).toBe(false);
    c.navigated("https://canvas.ucsc.edu/");
    await c.tick();
    expect(logins).toEqual([]);
    control = "user";
  });

  it("drops a pending form when the agent takes the tab back", async () => {
    let control: "agent" | "user" = "user";
    const { c, logins } = capture({ control: () => control, reads: [typed, done] });
    await c.tick();
    expect(c.hasPending).toBe(true);
    control = "agent";
    await c.tick();
    expect(c.hasPending).toBe(false);
    control = "user";
    c.navigated("https://canvas.ucsc.edu/");
    await c.tick();
    expect(logins).toEqual([]);
  });

  it("does not capture over http or on a failed attempt", async () => {
    const http = capture({
      control: () => "user",
      reads: [snap({ url: "http://login.example/", username: "a", password: "b" })],
    });
    await http.c.tick();
    expect(http.c.hasPending).toBe(false);

    const failed = capture({
      control: () => "user",
      reads: [typed, snap({ username: "pranav", password: "" })],
    });
    await failed.c.tick();
    failed.c.navigated("https://login.ucsc.edu/idp?error=1");
    await failed.c.tick();
    expect(failed.logins).toEqual([]);
    expect(failed.c.hasPending).toBe(false);
  });

  it("reports the sign-in without the password for a never-save origin", async () => {
    const { c, logins } = capture({
      control: () => "user",
      reads: [typed, done],
      never: ["https://login.ucsc.edu"],
    });
    await c.tick();
    c.navigated("https://canvas.ucsc.edu/");
    await c.tick();
    expect(logins[0]?.password).toBeNull();
  });
});

const SECRET = "hunter2-very-secret";

describe("sign-in prompts", () => {
  function setup(vaultAdd: (i: VaultLoginItem) => Promise<void>) {
    const store = new SignedInStore(home);
    const stay = vi.fn(async () => {});
    const changed = vi.fn();
    const prompts = new SignInPrompts({ store, vaultAdd, stay, changed });
    return { store, stay, changed, prompts };
  }

  it("never puts the password in the views the renderer gets", () => {
    const { prompts } = setup(async () => {});
    prompts.offerSave("tab_1", "https://login.ucsc.edu", "pranav", SECRET);
    prompts.offerStay("tab_1", "https://canvas.ucsc.edu", ["login.ucsc.edu"]);
    expect(JSON.stringify(prompts.views())).not.toContain(SECRET);
    expect(prompts.views().map((v) => v.kind)).toEqual(["save_login", "stay_signed_in"]);
  });

  it("saves an origin-bound login straight to the vault", async () => {
    const added: VaultLoginItem[] = [];
    const { prompts } = setup(async (i) => void added.push(i));
    prompts.offerSave("tab_1", "https://login.ucsc.edu", "pranav", SECRET);
    const id = prompts.views()[0]?.id ?? "";
    await prompts.answer(id, "accept");
    expect(added).toEqual([
      {
        kind: "login",
        name: "login.ucsc.edu",
        bindings: [{ origin: "https://login.ucsc.edu" }],
        secret: { username: "pranav", password: SECRET },
      },
    ]);
    expect(prompts.views()).toEqual([]);
  });

  it("keeps the offer on a vault error and leaks no value in it", async () => {
    const { prompts } = setup(async () => {
      throw Object.assign(new Error(`failed for ${SECRET}`), { code: "vault_locked" });
    });
    prompts.offerSave("tab_1", "https://login.ucsc.edu", "pranav", SECRET);
    await prompts.answer(prompts.views()[0]?.id ?? "", "accept");
    const [v] = prompts.views();
    expect(v).toMatchObject({ kind: "save_login", error: "vault_locked" });
    expect(JSON.stringify(prompts.views())).not.toContain(SECRET);
  });

  it("Never for this site stops the offer, now and for later logins", async () => {
    const add = vi.fn(async () => {});
    const { prompts, store } = setup(add);
    prompts.offerSave("tab_1", "https://login.ucsc.edu", "pranav", SECRET);
    await prompts.answer(prompts.views()[0]?.id ?? "", "never");
    expect(add).not.toHaveBeenCalled();
    expect(store.isNeverSave("https://login.ucsc.edu")).toBe(true);
    prompts.offerSave("tab_2", "https://login.ucsc.edu", "pranav", SECRET);
    expect(prompts.views()).toEqual([]);
  });

  it("drops a closed tab's prompts and forgets their secret", async () => {
    const add = vi.fn(async () => {});
    const { prompts } = setup(add);
    prompts.offerSave("tab_1", "https://login.ucsc.edu", "pranav", SECRET);
    const id = prompts.views()[0]?.id ?? "";
    prompts.dropTab("tab_1");
    await prompts.answer(id, "accept");
    expect(add).not.toHaveBeenCalled();
  });

  it("stay signed in calls the move with the flow's hosts, and not for a known site", async () => {
    const { prompts, stay, store } = setup(async () => {});
    prompts.offerStay("tab_1", "https://canvas.ucsc.edu", ["login.ucsc.edu"]);
    await prompts.answer(prompts.views()[0]?.id ?? "", "accept");
    expect(stay).toHaveBeenCalledWith("tab_1", "https://canvas.ucsc.edu", ["login.ucsc.edu"]);
    store.add("https://canvas.ucsc.edu", []);
    prompts.offerStay("tab_2", "https://canvas.ucsc.edu", []);
    expect(prompts.views()).toEqual([]);
  });
});
