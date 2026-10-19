import { validateEventPayload, validateParams, validateResult } from "@psyche/protocol";
import { assertNoSecrets, clearSecrets, registerSecret } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createVaultHandlers } from "../src/index.ts";
import { makeHarness } from "./helpers.ts";

afterEach(() => clearSecrets());

describe("vault.* handlers and events", () => {
  it("serve every vault method with protocol-valid results that carry no values", async () => {
    const h = makeHarness();
    const handlers = createVaultHandlers(h.vault);
    const events: [string, unknown][] = [];
    for (const name of ["vault.locked", "vault.unlocked", "credential.updated"] as const) {
      h.vault.on(name, (p) => events.push([name, p]));
    }
    const pw = "handler-secret-pw-0001";
    registerSecret(pw, "pw");
    const call = async <M extends keyof typeof handlers>(m: M, params: unknown) => {
      const p = validateParams(m, params);
      const result = await (handlers[m] as (p: unknown) => Promise<unknown>)(p);
      validateResult(m, result);
      return result as Awaited<ReturnType<(typeof handlers)[M]>>;
    };
    expect((await call("vault.status", {})).status.state).toBe("uninitialized");
    await expect(call("vault.setup", { slot: "safe_storage" })).rejects.toMatchObject({
      code: "invalid_params",
    });
    const { recoveryKey } = await call("vault.setup", { slot: "keychain" });
    registerSecret(recoveryKey, "recovery");
    await call("vault.confirmRecovery", { lastGroup: recoveryKey.split("-").at(-1) });
    const { credential } = await call("vault.add", {
      kind: "login",
      name: "Site",
      bindings: [{ origin: "https://site.example" }],
      secret: { username: "pat", password: pw },
    });
    await call("vault.update", { credentialId: credential.id, name: "Site 2" });
    const imported = await call("vault.import", {
      format: "chrome",
      csv: "name,url,username,password\nx,https://x.example,u,imported-pw-0002\n",
    });
    expect(imported.imported).toHaveLength(1);
    expect((await call("vault.list", {})).credentials).toHaveLength(2);
    expect((await call("vault.list", { kind: "note" })).credentials).toHaveLength(0);
    await call("vault.get", { credentialId: credential.id });
    expect((await call("vault.uses", { credentialId: credential.id })).uses).toEqual([]);
    await call("vault.lock", {});
    await call("vault.unlock", { reason: "UI" });
    await call("vault.unlock", { reason: "UI", recoveryKey });
    expect((await call("vault.delete", { credentialId: credential.id })).deleted).toBe(true);
    await expect(call("vault.get", { credentialId: credential.id })).rejects.toMatchObject({
      code: "not_found",
    });
    for (const [name, payload] of events) validateEventPayload(name, payload);
    expect(events.map(([n]) => n)).toEqual(
      expect.arrayContaining(["vault.unlocked", "vault.locked", "credential.updated"]),
    );
    assertNoSecrets(events, "vault events");
    assertNoSecrets(await h.audit.list(), "audit");
    h.cleanup();
  });
});
