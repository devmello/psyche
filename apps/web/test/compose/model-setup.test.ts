import { describe, expect, it } from "vitest";
import type { GatewayStatus } from "../../src/client/index.ts";
import { saveProviderKey, verifySetup } from "../../src/compose/model-setup.ts";
import type { ShellPlatform } from "../../src/shell/platform.ts";

type Handler = (params: Record<string, unknown>, key?: string) => unknown;

function platformWith(handlers: Record<string, Handler>, phase: GatewayStatus["phase"] = "paired") {
  const calls: { method: string; params: unknown; key?: string }[] = [];
  const platform = {
    kind: "desktop",
    gateway: {
      getStatus: async () => ({ health: "ok", phase, attempt: 0 }) as GatewayStatus,
      onStatus: () => () => undefined,
      onEvent: () => () => undefined,
      onResync: () => () => undefined,
      call: async (method: string, params: unknown, opts?: { idempotencyKey?: string }) => {
        calls.push({
          method,
          params,
          ...(opts?.idempotencyKey ? { key: opts.idempotencyKey } : {}),
        });
        const h = handlers[method];
        if (!h) throw Object.assign(new Error(`no ${method}`), { code: "not_found" });
        return h(params as Record<string, unknown>, opts?.idempotencyKey);
      },
    },
  } as unknown as ShellPlatform;
  return { platform, calls };
}

const invalid = (m: string) => Object.assign(new Error(m), { code: "invalid_params" });

describe("onboarding model setup", () => {
  it("creates the vault with the Gateway's slot, then stores the key", async () => {
    const { platform, calls } = platformWith({
      "vault.status": () => ({ status: { state: "uninitialized" } }),
      "vault.setup": (p) => {
        if (p.slot !== "keychain") throw invalid("this Gateway's vault slot is keychain");
        return { recoveryKey: "AAAA-BBBB-CCCC", status: { state: "unlocked" } };
      },
      "models.setKey": () => ({ provider: { id: "anthropic", keyConfigured: true } }),
    });
    const saved = await saveProviderKey(platform, "anthropic", "sk-ant-x");
    expect(saved).toEqual({ keyRef: "model-anthropic", recoveryKey: "AAAA-BBBB-CCCC" });
    expect(calls.map((c) => c.method)).toEqual([
      "vault.status",
      "vault.setup",
      "vault.setup",
      "models.setKey",
    ]);
    const setKey = calls.at(-1);
    expect(setKey?.params).toEqual({ providerId: "anthropic", key: "sk-ant-x" });
    expect(setKey?.key).toBeTruthy();
  });

  it("unlocks an existing vault and shows no recovery key", async () => {
    const { platform, calls } = platformWith({
      "vault.status": () => ({ status: { state: "locked" } }),
      "vault.unlock": () => ({ status: { state: "unlocked" } }),
      "models.setKey": () => ({ provider: {} }),
    });
    expect(await saveProviderKey(platform, "openai", "sk-x")).toEqual({ keyRef: "model-openai" });
    expect(calls.map((c) => c.method)).toEqual(["vault.status", "vault.unlock", "models.setKey"]);
  });

  it("binds the model on Done and reports Gateway, helper and model", async () => {
    let primary: string | undefined;
    let utility: string | undefined;
    const { platform } = platformWith({
      "models.list": () => ({
        providers: [{ id: "anthropic", keyConfigured: true, local: false }],
        roles: { ...(primary ? { primary } : {}), ...(utility ? { utility } : {}) },
      }),
      "models.setRole": (p) => {
        if (p.role === "primary") primary = String(p.ref);
        else utility = String(p.ref);
        return { roles: {} };
      },
    });
    const result = {
      model: { modelRef: "anthropic/claude-sonnet-5-5", toolCheck: "passed" },
    } as never;
    const checks = await verifySetup(platform, result, { kind: "paired" });
    expect(checks.map((c) => [c.id, c.state])).toEqual([
      ["gateway", "ok"],
      ["helper", "ok"],
      ["model", "ok"],
    ]);
    expect(primary).toBe("anthropic/claude-sonnet-5-5");
    expect(utility).toBe("anthropic/claude-sonnet-5-5");
  });

  it("warns, without throwing, when the helper or the model is missing", async () => {
    const { platform } = platformWith({
      "models.list": () => ({
        providers: [{ id: "anthropic", keyConfigured: false, local: false }],
        roles: {},
      }),
      "models.setRole": () => ({ roles: {} }),
    });
    const checks = await verifySetup(
      platform,
      { model: { modelRef: "anthropic/claude-sonnet-5-5", toolCheck: "untested" } } as never,
      { kind: "offline" },
    );
    expect(checks.map((c) => [c.id, c.state])).toEqual([
      ["gateway", "ok"],
      ["helper", "warn"],
      ["model", "warn"],
    ]);
    expect(checks.at(-1)?.detail).toMatch(/no key yet/);
  });
});
