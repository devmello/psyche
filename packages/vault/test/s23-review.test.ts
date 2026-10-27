/**
 * S23 adversarial review findings that touch credentials (docs/archive/reviews/design-*.md), as
 * passing tests against the real vault. Items owned by other sessions are `todo` with the owner.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSecretEnv, credentialFillBindingHash, strictCanonicalJSON } from "../src/index.ts";
import { approveFill, type Harness, makeHarness, PASSWORD_FIELD } from "./helpers.ts";

const SECRET = "s23-github-password-hunter2";
const GH = { kind: "origin" as const, value: "https://github.com" };
let h: Harness;
beforeEach(async () => {
  h = makeHarness();
  await h.vault.setup();
  await h.vault.add({
    kind: "login",
    name: "github-login",
    bindings: [{ origin: "https://github.com" }],
    secret: { username: "owner", password: SECRET },
  });
});
afterEach(() => h.cleanup());

describe("design-01: a site grant cannot type a password into a comment box", () => {
  it("refuses the textarea on the bound origin even with a live site grant; the login form still fills", async () => {
    const grant = await approveFill(h, {
      slug: "github-login",
      target: GH.value,
      selector: "ref_2",
      element: PASSWORD_FIELD,
      scope: "site",
    });
    const textarea = { tagName: "textarea", role: "textbox", frameOrigin: GH.value };
    await expect(
      h.vault.resolve("{{cred:github-login.password}}", GH, grant, {
        executor: "browser",
        element: textarea,
        selector: "ref_7",
      }),
    ).rejects.toMatchObject({ code: "policy_denied", details: { reason: "not_input:textarea" } });
    const contentEditable = { tagName: "div", contentEditable: true, frameOrigin: GH.value };
    await expect(
      h.vault.resolve("{{cred:github-login.password}}", GH, grant, {
        executor: "browser",
        element: contentEditable,
        selector: "ref_7",
      }),
    ).rejects.toMatchObject({ code: "policy_denied" });
    expect((await h.audit.list()).filter((e) => e.kind === "credential.filled")).toHaveLength(0);
    // Control: same grant, the approved password field posting to github.com.
    for (let i = 0; i < 2; i += 1) {
      (
        await h.vault.resolve("{{cred:github-login}}", GH, grant, {
          executor: "browser",
          element: PASSWORD_FIELD,
          selector: "ref_2",
        })
      ).dispose();
    }
    expect((await h.audit.list()).filter((e) => e.kind === "credential.filled")).toHaveLength(2);
  });

  it("a site grant's key includes the field class", async () => {
    const credential = (await h.vault.list())[0];
    if (credential === undefined) throw new Error("no item");
    const issued = await h.vault.requestFill({
      slug: "github-login",
      target: GH.value,
      executor: "browser",
      field: "username",
      selector: "ref_1",
      element: { tagName: "input", type: "email", autocomplete: "username", frameOrigin: GH.value },
      requestedBy: { runId: null, taskId: null, threadId: null },
      taint: true,
    });
    expect(issued.approval.grantKey).toBe(
      `credential_fill|${credential.id}|https://github.com|username|browser`,
    );
  });

  it("refuses a form that posts to another origin", async () => {
    const apr = await approveFill(h, {
      slug: "github-login",
      target: GH.value,
      selector: "ref_2",
      element: PASSWORD_FIELD,
    });
    await expect(
      h.vault.resolve("{{cred:github-login}}", GH, apr, {
        executor: "browser",
        element: { ...PASSWORD_FIELD, formActionOrigin: "https://collector.evil.test" },
        selector: "ref_2",
      }),
    ).rejects.toMatchObject({ details: { reason: "form_action_mismatch" } });
  });
});

describe("design-13: opaque origins and canonical JSON collisions", () => {
  it("never matches android:// or other opaque origins", async () => {
    await expect(
      h.vault.add({
        kind: "login",
        name: "bank app",
        bindings: [{ origin: "android://com.bank.app" }],
        secret: { password: "android-pw-123" },
      }),
    ).rejects.toMatchObject({ code: "invalid_params" });
    const apr = await approveFill(h, {
      slug: "github-login",
      target: GH.value,
      executor: "connector",
    });
    for (const value of ["foo://github.com", "null", "data:text/html,x", "file:///etc/passwd"]) {
      await expect(
        h.vault.resolve("{{cred:github-login}}", { kind: "origin", value }, apr),
      ).rejects.toMatchObject({
        details: { reason: "target_mismatch" },
      });
    }
  });

  it("binding-hash JSON refuses NaN, Infinity, Map and Date instead of colliding", () => {
    for (const v of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      1.5,
      new Map(),
      new Date(0),
      () => 1,
      1n,
    ]) {
      expect(() => strictCanonicalJSON({ v })).toThrow(TypeError);
    }
    expect(strictCanonicalJSON({ b: 1, a: ["x", null, true] })).toBe('{"a":["x",null,true],"b":1}');
    // No NFC folding: what is hashed is what is executed.
    const nfc = credentialFillBindingHash({
      itemId: "i",
      target: "https://café.example",
      field: "password",
      executor: "browser",
    });
    const nfd = credentialFillBindingHash({
      itemId: "i",
      target: "https://café.example",
      field: "password",
      executor: "browser",
    });
    expect(nfc).not.toBe(nfd);
  });
});

describe("design-15: sandbox secrets in encodings redact() used to miss", () => {
  it("masks hex, reversed, ROT13 and base32 echoes of an injected token", async () => {
    await h.vault.add({
      kind: "api_key",
      name: "gh-token",
      bindings: [{ host: "api.github.com" }],
      secret: { token: "ghp_FAKEtoken0123456789abcdef" },
    });
    const target = { kind: "origin" as const, value: "https://api.github.com" };
    const apr = await approveFill(h, {
      slug: "gh-token",
      target: target.value,
      executor: "sandbox",
      field: "token",
    });
    const env = await buildSecretEnv({
      broker: h.vault,
      target,
      entries: [{ name: "GH", placeholder: "{{cred:gh-token.token}}", approvalId: apr }],
    });
    const token = env.env.PSYCHE_SECRET_GH ?? "";
    env.dispose();
    h.vault.lock(); // values that left the vault stay tracked after lock
    const rot13 = token.replace(/[a-z]/gi, (c) =>
      String.fromCharCode(((c.toLowerCase().charCodeAt(0) - 97 + 13) % 26) + (c <= "Z" ? 65 : 97)),
    );
    const stdout = [
      Buffer.from(token).toString("hex"),
      [...token].reverse().join(""),
      rot13,
      `PSYCHE_SECRET_GH=${token}`,
    ].join("\n");
    const masked = h.vault.redact(stdout);
    expect(masked).not.toContain(token);
    expect(h.vault.containsSecret(masked)).toBe(false);
    expect(masked.split("\n").every((l) => l.includes("•••"))).toBe(true);
  });

  it.todo("secret-bearing commands run in a fresh PID namespace with nothing else alive (S21)");
});

describe("design-18: the page echoes the value back", () => {
  it("masks spaced, per-span, upper-cased, fullwidth and reversed-base64 echoes; the detector flags them", async () => {
    const apr = await approveFill(h, {
      slug: "github-login",
      target: GH.value,
      selector: "ref_2",
      element: PASSWORD_FIELD,
    });
    (
      await h.vault.resolve("{{cred:github-login}}", GH, apr, {
        executor: "browser",
        element: PASSWORD_FIELD,
        selector: "ref_2",
      })
    ).dispose();
    const echoes = [
      [...SECRET].join(" "),
      [...SECRET]
        .map((c) => `<span>${c}</span>`)
        .join("\n")
        .replace(/<\/?span>/g, ""),
      SECRET.toUpperCase(),
      SECRET.replace(/[!-~]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)),
      [...SECRET].join("​"),
      `#${Buffer.from([...SECRET].reverse().join("")).toString("base64")}`,
      `document.title = "${SECRET}"`,
    ];
    for (const echo of echoes) {
      expect(h.vault.containsSecret(echo), echo).toBe(true);
      const masked = h.vault.redact(`snapshot: ${echo} end`);
      expect(h.vault.containsSecret(masked), echo).toBe(false);
      expect(masked).toContain("•••");
    }
  });

  it.todo("post-fill: screenshots refused and snapshot hits abort the tool result (S08)");
});

describe("design-05: host vault release to a VM guest", () => {
  it.todo(
    "guest release requests ignore site grants, need vmAllowed, Touch ID each time and a rate limit (S06 M2, with S14 / S19)",
  );
});

describe("design-17: env injection inherits nothing", () => {
  it("the sandbox env holds only the approved secrets", async () => {
    process.env.PSYCHE_TEST_LEAK = "should-not-inherit";
    await h.vault.add({
      kind: "api_key",
      name: "k",
      bindings: [{ host: "api.example.test" }],
      secret: { token: "only-this-token-123" },
    });
    const target = { kind: "origin" as const, value: "https://api.example.test" };
    const apr = await approveFill(h, {
      slug: "k",
      target: target.value,
      executor: "sandbox",
      field: "token",
    });
    const env = await buildSecretEnv({
      broker: h.vault,
      target,
      entries: [{ name: "K", placeholder: "{{cred:k.token}}", approvalId: apr }],
    });
    expect(Object.keys(env.env)).toEqual(["PSYCHE_SECRET_K"]);
    env.dispose();
    delete process.env.PSYCHE_TEST_LEAK;
  });
});
