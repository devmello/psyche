import { describe, expect, it } from "vitest";
import type { GatewayStatus } from "../../src/client/index.ts";
import { providerReady, saveProviderKey, verifySetup } from "../../src/compose/model-setup.ts";
import type { ShellPlatform } from "../../src/shell/platform.ts";

type Handler = (params: Record<string, unknown>, key?: string) => unknown;

function platformWith(
  handlers: Record<string, Handler>,
  phase: GatewayStatus["phase"] = "paired",
  desktop?: { scopes: string[] },
) {
  const calls: { method: string; params: unknown; key?: string }[] = [];
  const platform = {
    kind: "desktop",
    gateway: {
      getStatus: async () =>
        ({
          health: "ok",
          phase,
          attempt: 0,
          ...(desktop ? { scopes: desktop.scopes } : {}),
        }) as GatewayStatus,
      ...(desktop ? { deviceId: async () => "d1" } : {}),
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
      "models.probe",
    ]);
    const setKey = calls.find((c) => c.method === "models.setKey");
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
    expect(calls.map((c) => c.method)).toEqual([
      "vault.status",
      "vault.unlock",
      "models.setKey",
      "models.probe",
    ]);
  });

  it("reports a key the provider refuses right after storing it, keeping the recovery key (#504)", async () => {
    const { platform } = platformWith({
      "vault.status": () => ({ status: { state: "uninitialized" } }),
      "vault.setup": () => ({ recoveryKey: "AAAA-BBBB-CCCC", status: { state: "unlocked" } }),
      "models.setKey": () => ({ provider: { id: "anthropic", keyConfigured: true } }),
      "models.probe": () => ({
        provider: {
          probe: {
            state: "auth_failed",
            error: "the endpoint refused the key (HTTP 401: invalid x-api-key)",
          },
        },
      }),
    });
    expect(await saveProviderKey(platform, "anthropic", "sk-ant-x")).toEqual({
      keyRef: "model-anthropic",
      recoveryKey: "AAAA-BBBB-CCCC",
      refused: "the endpoint refused the key (HTTP 401: invalid x-api-key)",
    });
  });

  it("does not stop on an unreachable endpoint", async () => {
    const { platform } = platformWith({
      "vault.status": () => ({ status: { state: "unlocked" } }),
      "models.setKey": () => ({ provider: {} }),
      "models.probe": () => ({ provider: { probe: { state: "unreachable", error: "offline" } } }),
    });
    expect(await saveProviderKey(platform, "openai", "sk-x")).toEqual({ keyRef: "model-openai" });
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

  it("counts a signed-in Claude subscription (claude-code) as ready with no API key (#537)", async () => {
    let primary: string | undefined;
    const { platform } = platformWith({
      "models.list": () => ({
        providers: [
          { id: "anthropic", keyConfigured: false, local: false, probe: { state: "not_probed" } },
          { id: "claude-code", keyConfigured: false, local: false, probe: { state: "reachable" } },
        ],
        roles: primary ? { primary } : {},
      }),
      "models.setRole": (p) => {
        if (p.role === "primary") primary = String(p.ref);
        return { roles: {} };
      },
    });
    const checks = await verifySetup(
      platform,
      { model: { modelRef: "claude-code/sonnet", toolCheck: "untested" } } as never,
      { kind: "paired" },
    );
    expect(primary).toBe("claude-code/sonnet");
    expect(checks.at(-1)).toMatchObject({ id: "model", state: "ok" });
  });

  it("treats a CLI provider as ready only when its probe is reachable", () => {
    const cli = (id: string, state: string) => ({
      id,
      keyConfigured: false,
      local: false,
      probe: { state },
    });
    expect(providerReady(cli("claude-code", "reachable"))).toBe(true);
    expect(providerReady(cli("codex", "reachable"))).toBe(true);
    expect(providerReady(cli("claude-code", "auth_failed"))).toBe(false);
    expect(providerReady(cli("claude-code", "not_probed"))).toBe(false);
    // An API provider still needs a stored key, whatever its probe says.
    expect(providerReady(cli("anthropic", "reachable"))).toBe(false);
    expect(providerReady(undefined)).toBe(false);
  });

  it("on the desktop, says whether this Mac is the admin device", async () => {
    const admin = platformWith({}, "paired", { scopes: ["operator.write", "operator.admin"] });
    const notAdmin = platformWith({}, "paired", { scopes: ["operator.write"] });
    const none = { model: { modelRef: "", toolCheck: "untested" } } as never;
    expect(
      (await verifySetup(admin.platform, none, undefined)).find((c) => c.id === "admin"),
    ).toMatchObject({
      state: "ok",
      detail: "This Mac is the admin device.",
    });
    expect(
      (await verifySetup(notAdmin.platform, none, undefined)).find((c) => c.id === "admin")?.state,
    ).toBe("warn");
    const web = platformWith({});
    expect((await verifySetup(web.platform, none, undefined)).some((c) => c.id === "admin")).toBe(
      false,
    );
  });
});
