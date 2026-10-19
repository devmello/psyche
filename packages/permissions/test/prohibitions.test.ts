import { describe, expect, it } from "vitest";
import { createLocalProjectVerifier, type LocalProjectVerifier } from "../src/index.ts";
import { CTX, call, makeBroker, origin, path } from "./helpers.ts";

// Secret-shaped strings are built at runtime so scripts/ci/secret-grep.sh never matches them.
const j = (...p: string[]) => p.join("");

/** Security §3.9 / §3.10, feature F11: one test per hard prohibition. All are non-configurable. */
describe("hard prohibitions", () => {
  const permissive = {
    allow: ["*"],
    folders: [{ path: "/Users/o/Projects", mode: "rw" as const }],
  };

  async function decide(
    c: Parameters<typeof call>,
    extra: Parameters<typeof call>[3] = {},
    opts = {},
  ) {
    const { broker } = makeBroker({ policy: permissive, psycheHome: "/Users/o/.psyche", ...opts });
    return broker.decide(call(c[0], c[1], c[2], extra), { ...CTX, permissionMode: "auto" });
  }

  it("never types into a password field, even with an allow-all policy", async () => {
    const d = await decide(["browser.type", "write", origin("https://github.com")], {
      params: { ref: "ref_3", text: "hunter2" },
      meta: { field: { type: "password" } },
    });
    expect(d).toMatchObject({ decision: "deny", rule: "prohibition:password_typing" });
  });

  it("refuses a model-visible secret even if the owner pasted it", async () => {
    const d = await decide(["http.request", "write", origin("https://api.example.com")], {
      params: { headers: { "x-api-key": j("sk-", "ant-", "q".repeat(30)) } },
    });
    expect(d).toMatchObject({ decision: "deny", rule: "prohibition:visible_secret" });
  });

  it("rejects placeholders outside fill-capable tools (security §4.5)", async () => {
    const d = await decide(
      ["email.send", "destructive", { kind: "recipient", value: "a@example.org" }],
      {
        params: { body: "my password is {{cred:github-login.password}}" },
      },
    );
    expect(d).toMatchObject({ decision: "deny", rule: "prohibition:placeholder_outside_fill" });
  });

  it("allows placeholders in an exec env value", async () => {
    const d = await decide(["exec", "write"], {
      params: { argv: ["gh", "auth", "status"], env: { GH_TOKEN: "{{cred:gh.token}}" } },
    });
    expect(d.rule).not.toBe("prohibition:placeholder_outside_fill");
  });

  it("never solves a CAPTCHA", async () => {
    for (const extra of [
      { meta: { captcha: true } },
      { meta: { field: { name: "g-recaptcha-response" } } },
    ]) {
      const d = await decide(["browser.click", "write", origin("https://shop.example.com")], extra);
      expect(d).toMatchObject({ decision: "deny", rule: "prohibition:captcha" });
    }
    const d = await decide(["captcha.solve", "write"]);
    expect(d.rule).toBe("prohibition:captcha");
  });

  it("never enters a card number, bank account or government id", async () => {
    const cases: [string, string][] = [
      ["4242 4242 4242 4242", "prohibition:card_entry"],
      ["DE89370400440532013000", "prohibition:bank_account_entry"],
      ["123-45-6789", "prohibition:government_id_entry"],
    ];
    for (const [text, rule] of cases) {
      const d = await decide(["browser.type", "write", origin("https://shop.example.com")], {
        params: { ref: "ref_1", text },
      });
      expect(d, text).toMatchObject({ decision: "deny", rule });
    }
  });

  it("never moves money or trades", async () => {
    for (const tool of [
      "bank.transfer",
      "broker.trade",
      "crypto.swap",
      "venmo.pay",
      "mcp__wallet__withdraw",
    ]) {
      const d = await decide([tool, "financial"]);
      expect(d, tool).toMatchObject({ decision: "deny", rule: "prohibition:financial_transfer" });
    }
  });

  it("permanent deletion asks once with a typed confirmation word, never allows", async () => {
    const h = makeBroker({ policy: permissive });
    const c = call("drive.delete_permanently", "destructive", origin("https://drive.example.com"));
    const d = await h.broker.decide(c, CTX);
    expect(d).toMatchObject({
      decision: "ask",
      rule: "prohibition:permanent_delete",
      typedConfirmation: "DELETE",
    });
    expect(d.scopesOffered).toEqual(["once"]);
    const issued = await h.broker.requestApproval({
      kind: d.approvalKind ?? "connector_action",
      summary: "Delete permanently",
      details: {},
      bindingHash: d.bindingHash ?? "",
      grantKey: d.grantKey ?? "",
      requestedBy: { runId: CTX.runId, taskId: CTX.taskId ?? null, threadId: CTX.threadId },
      sideEffect: "destructive",
      surfaces: ["desktop"],
      taint: false,
    });
    expect(issued.approval.details.confirmationWord).toBe("DELETE");
    h.clock.advance(500);
    const answer = (typedConfirmation?: string) =>
      h.broker.answer({
        approvalId: issued.approval.id,
        answerToken: issued.answerTokens.desktop ?? "",
        decision: "approve",
        decidedBy: { deviceId: "dev_mac" },
        ...(typedConfirmation === undefined ? {} : { typedConfirmation }),
      });
    await expect(answer()).rejects.toMatchObject({ code: "invalid_params" });
    await expect(answer("delete")).rejects.toMatchObject({ code: "invalid_params" });
    expect((await answer("DELETE")).status).toBe("approved");
  });

  it("a confirmation word inside the call's own arguments is refused", async () => {
    const d = await decide(["mail.purge", "destructive"], { params: { confirmation: "DELETE" } });
    expect(d).toMatchObject({ decision: "deny", rule: "prohibition:self_confirmed_delete" });
  });

  it("exec_host rm is a permanent deletion", async () => {
    const { broker } = makeBroker({ policy: { ...permissive, exec: { execHostEnabled: true } } });
    const d = await broker.decide(
      call("exec_host", "destructive", undefined, {
        binding: {
          argv: ["/bin/rm", "-rf", "build"],
          cwd: "/Users/o/Projects/app",
          executable: "/bin/rm",
          executableSha256: `sha256:${"a".repeat(64)}`,
        },
      }),
      CTX,
    );
    expect(d.rule).toBe("prohibition:permanent_delete");
  });

  it("never follows instructions found in content", async () => {
    const { broker } = makeBroker({ policy: permissive });
    const d = await broker.decide(call("calendar.create", "write"), {
      ...CTX,
      initiator: "content",
    });
    expect(d).toMatchObject({ decision: "deny", rule: "prohibition:instruction_from_content" });
  });

  it("third-party account creation always asks, even with an allow rule", async () => {
    const d = await decide(["browser.signup", "write", origin("https://shop.example.com")]);
    expect(d).toMatchObject({ decision: "ask", rule: "prohibition:account_creation" });
    const d2 = await decide(["browser.submit", "destructive", origin("https://shop.example.com")], {
      meta: { accountCreation: true },
    });
    expect(d2.rule).toBe("prohibition:account_creation");
  });

  it("no tool edits settings, grants, pairing or Psyche's own state", async () => {
    for (const tool of [
      "settings.set",
      "grants.revoke",
      "devices.pair",
      "pairing.approve",
      "policy.update",
      "approvals.answer",
    ]) {
      expect((await decide([tool, "write"])).rule, tool).toBe("prohibition:control_plane");
    }
    for (const p of [
      "/Users/o/.psyche/config.json",
      "/Users/o/.psyche/state/psyche.sqlite",
      "/Users/o/.psyche/audit/2026-10.jsonl",
    ]) {
      const d = await decide(["write_file", "write", path(p)]);
      expect(d, p).toMatchObject({ decision: "deny", rule: "prohibition:psyche_state" });
    }
    const vault = await decide(["read_file", "read", path("/Users/o/.psyche/vault/vault.db")]);
    expect(vault.rule).toBe("prohibition:psyche_state");
  });

  it("never reads Safari, Passwords or keychain credentials", async () => {
    for (const p of [
      "/Users/o/Library/Keychains/login.keychain-db",
      "/Users/o/Library/Safari/Bookmarks.plist",
      "/Users/o/Library/Containers/com.apple.Safari/Data",
    ]) {
      const d = await decide(["read_file", "read", path(p)]);
      expect(d, p).toMatchObject({ decision: "deny", rule: "prohibition:system_credentials" });
    }
  });

  it("refuses dangerous interpreter variables in an exec env (design-14 #5)", async () => {
    const d = await decide(["exec", "write"], {
      params: { argv: ["python3", "x.py"], env: { PYTHONSTARTUP: "/workspace/x.py" } },
    });
    expect(d).toMatchObject({ decision: "deny", rule: "prohibition:dangerous_env" });
    const ok = await decide(["exec", "write"], {
      params: { argv: ["python3"], env: { LANG: "C" } },
    });
    expect(ok.rule).not.toBe("prohibition:dangerous_env");
  });

  it("a tainted turn cannot write the protected memory files", async () => {
    const { broker } = makeBroker({ policy: permissive });
    const d = await broker.decide(call("memory", "write", path("/workspace/MEMORY.md")), {
      ...CTX,
      taint: true,
    });
    expect(d).toMatchObject({ decision: "deny", rule: "prohibition:untrusted_memory_promotion" });
    const clean = await broker.decide(call("memory", "write", path("/workspace/MEMORY.md")), CTX);
    expect(clean).toMatchObject({ decision: "ask", rule: "memory:protected_path" });
  });

  it("refuses non-canonical URLs (userinfo, opaque schemes)", async () => {
    for (const u of [
      "http://localhost.evil.test@127.0.0.1:3000/",
      "android://com.bank.app",
      "file:///etc/passwd",
      "javascript:alert(1)",
    ]) {
      const d = await decide(["browser.navigate", "read", origin(u)]);
      expect(d, u).toMatchObject({ decision: "deny", rule: "prohibition:invalid_target" });
    }
  });
});

describe("localhost test-credential exception (security §3.10, S23 design-03)", () => {
  const probes = (
    over: Partial<Parameters<typeof createLocalProjectVerifier>[0]> = {},
  ): LocalProjectVerifier =>
    createLocalProjectVerifier({
      resolve: async (host) => (host === "app.test" ? ["203.0.113.5"] : ["127.0.0.1"]),
      listenerPid: async (port) => ({ 5173: 4242, 3000: 999 })[port],
      spawnedByPsyche: async (pid) => pid === 4242,
      psychePorts: [7979, 9333],
      ...over,
    });

  async function decideOn(
    url: string,
    extra: Parameters<typeof call>[3] = {},
    localProject = probes(),
  ) {
    const { broker } = makeBroker({ policy: { allow: ["*"] }, localProject });
    return broker.decide(call("browser.javascript", "write", origin(url), extra), CTX);
  }

  it("1: the Gateway's own origin is never the owner's project", async () => {
    const d = await decideOn("http://127.0.0.1:7979/");
    expect(d).toMatchObject({ decision: "deny", rule: "prohibition:gateway_origin" });
  });

  it("2: a .test name that resolves off-box is refused", async () => {
    const d = await decideOn("http://app.test/login", { meta: { testCredential: true } });
    expect(d.rule).toBe("prohibition:loopback_not_owned");
    expect(d.reason).toContain("resolved_non_loopback");
  });

  it("3: a listener Psyche did not spawn is not the owner's project", async () => {
    const d = await decideOn("http://localhost:3000/");
    expect(d.reason).toContain("listener_not_spawned_by_psyche");
    expect(d.decision).toBe("deny");
  });

  it("4: Psyche's own dev server accepts seeded test values and published test cards", async () => {
    const d = await decideOn("http://localhost:5173/checkout", {
      params: { text: "4242424242424242" },
      meta: { testCredential: true },
    });
    expect(d.decision).toBe("allow");
    const real = await decideOn("http://localhost:5173/checkout", {
      params: { text: "4012 8888 8888 1881" },
    });
    expect(real.rule).toBe("prohibition:card_entry");
  });

  it("5: trailing dots are canonicalized; nip.io is not loopback", async () => {
    expect((await decideOn("http://localhost.:3000/")).reason).toContain(
      "listener_not_spawned_by_psyche",
    );
    const nip = await decideOn("http://127.0.0.1.nip.io/", { meta: { testCredential: true } });
    expect(nip.rule).toBe("prohibition:test_credential_scope");
  });

  it("by default no loopback origin qualifies (fail closed)", async () => {
    const { broker } = makeBroker({ policy: { allow: ["*"] } });
    const d = await broker.decide(
      call("browser.click", "write", origin("http://localhost:5173/")),
      CTX,
    );
    expect(d).toMatchObject({ decision: "deny", rule: "prohibition:loopback_not_owned" });
  });

  it("well-known local services are refused even when spawned by Psyche", async () => {
    const v = probes({ listenerPid: async () => 4242 });
    expect((await decideOn("http://127.0.0.1:11434/", {}, v)).reason).toContain(
      "local_service_port",
    );
    expect((await decideOn("http://127.0.0.1:9333/", {}, v)).reason).toContain("psyche_port");
  });
});
