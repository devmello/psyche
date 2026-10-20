import { ResolvedSecret } from "@psyche/protocol";
import { assertNoSecrets, clearSecrets, registerSecret } from "@psyche/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fail } from "../src/errors.ts";
import {
  type OnePasswordField,
  type OnePasswordRef,
  type OnePasswordSource,
  OpCliSource,
  OpConnectSource,
} from "../src/index.ts";
import { approveFill, type Harness, makeHarness, PASSWORD_FIELD } from "./helpers.ts";

const PW = "one-password-sourced-pw-31";
const SA_TOKEN = "ops_fake_service_account_token_0123456789";
const GH = { kind: "origin" as const, value: "https://github.com" };

/** Fake 1Password: items by `vault/item`, every read recorded (read-only by construction). */
class FakeOnePassword implements OnePasswordSource {
  readonly kind = "cli" as const;
  readonly reads: string[] = [];
  items = new Map<string, Partial<Record<OnePasswordField, string>>>([
    ["Work/GitHub", { username: "pat", password: PW, totp: "492039" }],
  ]);
  async unavailableReason() {
    return null;
  }
  async readField(ref: OnePasswordRef, field: OnePasswordField): Promise<string> {
    this.reads.push(`${ref.vault}/${ref.item}/${field}`);
    const value = this.items.get(`${ref.vault}/${ref.item}`)?.[field];
    if (value === undefined)
      return fail("not_found", "no such item or field", { reason: "op_not_found" });
    return value;
  }
}

let h: Harness;
let op: FakeOnePassword;
let id: string;
beforeEach(async () => {
  op = new FakeOnePassword();
  h = makeHarness({ overrides: { onePassword: op } });
  await h.vault.setup();
  registerSecret(PW, "pw");
  id = (
    await h.vault.linkOnePassword({
      kind: "login",
      name: "GitHub (1Password)",
      slug: "github",
      bindings: [{ origin: GH.value }],
      ref: { vault: "Work", item: "GitHub" },
      fields: ["username", "password", "totp"],
    })
  ).id;
});
afterEach(() => {
  h.cleanup();
  clearSecrets();
});

const fill = async (placeholder = "{{cred:github}}", element = PASSWORD_FIELD, field?: "totp") => {
  const apr = await approveFill(h, {
    slug: "github",
    target: GH.value,
    selector: "ref_7",
    element,
    ...(field ? { field } : {}),
  });
  return h.vault.resolve(placeholder, GH, apr, { executor: "browser", element, selector: "ref_7" });
};

describe("1Password as an external source (G10)", () => {
  it("links by reference only and maps onto {{cred:slug}}", async () => {
    expect(h.vault.backendOf(id)).toBe("1password");
    assertNoSecrets(await h.vault.list(), "metadata");
    assertNoSecrets(await h.audit.list(), "audit");
    expect(op.reads).toEqual([]);
    const handle = await fill();
    expect(handle.use((v) => v)).toBe(PW);
    expect(op.reads).toEqual(["Work/GitHub/password"]);
    expect(h.vault.redact(`log: ${PW}`)).toBe("log: •••");
  });

  it("reads nothing without a valid approval or for a field that is not linked", async () => {
    await expect(
      h.vault.resolve("{{cred:github}}", GH, "apr_bogus", {
        executor: "browser",
        element: PASSWORD_FIELD,
        selector: "ref_7",
      }),
    ).rejects.toMatchObject({
      code: "approval_required",
    });
    await expect(
      h.vault.resolve(
        "{{cred:github}}",
        { kind: "origin", value: "https://evil.example" },
        "apr_x",
        {
          executor: "browser",
          element: { ...PASSWORD_FIELD, frameOrigin: "https://evil.example" },
          selector: "ref_7",
        },
      ),
    ).rejects.toMatchObject({ details: { reason: "target_mismatch" } });
    const other = await h.vault.linkOnePassword({
      kind: "api_key",
      name: "API",
      bindings: [{ host: "api.example.com" }],
      ref: { vault: "Work", item: "API" },
    });
    const apr = await approveFill(h, {
      slug: other.slug,
      target: "https://api.example.com",
      executor: "connector",
      field: "username",
    });
    await expect(
      h.vault.resolve(
        `{{cred:${other.slug}.username}}`,
        { kind: "origin", value: "https://api.example.com" },
        apr,
      ),
    ).rejects.toMatchObject({
      code: "not_found",
    });
    expect(op.reads).toEqual([]);
  });

  it("returns 1Password's current TOTP code as is", async () => {
    const otp = { tagName: "input", autocomplete: "one-time-code", frameOrigin: GH.value };
    const handle = await fill("{{cred:github.totp}}", otp, "totp");
    expect(handle.use((v) => v)).toBe("492039");
    expect(op.reads).toEqual(["Work/GitHub/totp"]);
  });

  it("logs a failed use when the 1Password item is gone", async () => {
    op.items.clear();
    await expect(fill()).rejects.toMatchObject({ code: "not_found" });
    expect(h.vault.uses(id).map((u) => `${u.outcome}:${u.reason}`)).toEqual([
      "failed:external_unavailable",
    ]);
  });

  it("is read-only: no secret edits, no moves; delete only unlinks", async () => {
    await expect(
      h.vault.update(id, { secret: { password: "new-pw-123456" } }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await h.vault.update(id, { name: "GitHub (work, 1Password)" });
    await expect(h.vault.setBackend(id, "vault")).rejects.toMatchObject({ code: "forbidden" });
    expect(await h.vault.delete(id)).toBe(true);
    expect(op.items.size).toBe(1);
  });

  it("refuses references that could escape an op:// path or a Connect filter", async () => {
    for (const ref of [
      { vault: "Work/../Private", item: "x" },
      { vault: "Work", item: 'x" or title eq "y' },
      { vault: "Work", item: "x?attribute=otp" },
      { vault: "", item: "x" },
    ]) {
      await expect(
        h.vault.linkOnePassword({ kind: "login", name: "n", bindings: [], ref }),
      ).rejects.toMatchObject({ code: "invalid_params" });
    }
  });

  it("needs a configured source", async () => {
    const bare = makeHarness();
    await bare.vault.setup();
    await expect(
      bare.vault.linkOnePassword({
        kind: "login",
        name: "n",
        bindings: [],
        ref: { vault: "a", item: "b" },
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
    bare.cleanup();
  });
});

const token = async () =>
  new ResolvedSecret(SA_TOKEN, {
    credentialId: "cred_op",
    target: { kind: "account", value: "onepassword" },
  });

describe("OpCliSource", () => {
  it("runs op read with the token only in the child env, no shell", async () => {
    registerSecret(SA_TOKEN, "sa");
    const calls: { file: string; args: string[]; env: Record<string, string> }[] = [];
    const src = new OpCliSource({
      op: "/opt/homebrew/bin/op",
      token,
      run: async (file, args, env) => {
        calls.push({ file, args, env: { ...env } });
        return args[1]?.endsWith("attribute=otp") ? "123456" : PW;
      },
    });
    expect(await src.readField({ vault: "Work", item: "GitHub" }, "password")).toBe(PW);
    expect(await src.readField({ vault: "Work", item: "GitHub" }, "totp")).toBe("123456");
    expect(calls[0]).toEqual({
      file: "/opt/homebrew/bin/op",
      args: ["read", "op://Work/GitHub/password", "--no-newline"],
      env: {
        PATH: expect.any(String),
        HOME: expect.any(String),
        OP_SERVICE_ACCOUNT_TOKEN: SA_TOKEN,
      },
    });
    expect(calls[1]?.args[1]).toBe("op://Work/GitHub/one-time password?attribute=otp");
    expect(process.env.OP_SERVICE_ACCOUNT_TOKEN).toBeUndefined();
  });

  it("maps not-found and failures without echoing output or the token", async () => {
    registerSecret(SA_TOKEN, "sa");
    const notFound = new OpCliSource({
      op: "op",
      token,
      run: async () => {
        throw Object.assign(new Error(`"x" isn't an item ${SA_TOKEN}`), { notFound: true });
      },
    });
    await expect(notFound.readField({ vault: "V", item: "x" }, "password")).rejects.toMatchObject({
      code: "not_found",
    });
    const broken = new OpCliSource({
      op: "op",
      token,
      run: async () => {
        throw new Error(`boom ${SA_TOKEN}`);
      },
    });
    const err = await broken
      .readField({ vault: "V", item: "x" }, "password")
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "unavailable" });
    assertNoSecrets({ m: String(err), j: JSON.stringify(err) }, "op error");
  });
});

describe("OpConnectSource", () => {
  const VAULT_ID = "abcdefghijklmnopqrstuvwxyz";
  const ITEM_ID = "zyxwvutsrqponmlkjihgfedcba";
  function connect(routes: Record<string, { status?: number; body?: unknown }>) {
    const seen: { url: string; auth: string | null; redirect: RequestInit["redirect"] }[] = [];
    const fetchImpl = (async (input: URL | string, init: RequestInit = {}) => {
      const url = String(input);
      seen.push({
        url,
        auth: new Headers(init.headers).get("authorization"),
        redirect: init.redirect,
      });
      const r = routes[url.replace("http://127.0.0.1:8080", "")] ?? { status: 404 };
      return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
    }) as typeof fetch;
    return {
      src: new OpConnectSource({ baseUrl: "http://127.0.0.1:8080", token, fetchImpl }),
      seen,
    };
  }
  const q = (s: string) => encodeURIComponent(s);

  it("finds vault and item by name and reads fields by purpose", async () => {
    const { src, seen } = connect({
      [`/v1/vaults?filter=${q('name eq "Work"')}`]: { body: [{ id: VAULT_ID }] },
      [`/v1/vaults/${VAULT_ID}/items?filter=${q('title eq "GitHub"')}`]: {
        body: [{ id: ITEM_ID }],
      },
      [`/v1/vaults/${VAULT_ID}/items/${ITEM_ID}`]: {
        body: {
          fields: [
            { id: "username", purpose: "USERNAME", value: "pat" },
            { id: "password", purpose: "PASSWORD", value: PW },
            { id: "otp", type: "OTP", value: "otpauth://totp/x?secret=ABC", totp: "777111" },
          ],
        },
      },
    });
    expect(await src.readField({ vault: "Work", item: "GitHub" }, "password")).toBe(PW);
    expect(await src.readField({ vault: VAULT_ID, item: ITEM_ID }, "totp")).toBe("777111");
    expect(seen.every((s) => s.auth === `Bearer ${SA_TOKEN}` && s.redirect === "manual")).toBe(
      true,
    );
  });

  it("refuses non-loopback http, and reports missing or ambiguous items as not_found", async () => {
    expect(() => new OpConnectSource({ baseUrl: "http://connect.example.com", token })).toThrow(
      RangeError,
    );
    const { src } = connect({
      [`/v1/vaults?filter=${q('name eq "Work"')}`]: { body: [{ id: "a" }, { id: "b" }] },
    });
    await expect(
      src.readField({ vault: "Work", item: "GitHub" }, "password"),
    ).rejects.toMatchObject({ code: "not_found" });
    const { src: missing } = connect({});
    await expect(
      missing.readField({ vault: VAULT_ID, item: ITEM_ID }, "password"),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
