import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, makeHarness } from "./helpers.ts";

let h: Harness;
beforeEach(async () => {
  h = makeHarness();
  await h.vault.setup();
});
afterEach(() => h.cleanup());

const gmail = () =>
  h.vault.store({
    connectorId: "con_gmail",
    slug: "gmail-pat",
    name: "Gmail (pat@example.com)",
    bindings: [{ connector: "con_gmail" }, { host: "gmail.googleapis.com" }],
    tokens: {
      accessToken: "ya29.access-0001-abcdef",
      refreshToken: "1//refresh-0001-abcdef",
      scopes: ["gmail.readonly"],
    },
  });

describe("OAuth tokens (G13)", () => {
  it("stores connector-owned tokens readable only by the owner", async () => {
    const meta = await gmail();
    expect(meta).toMatchObject({ kind: "oauth_token", ownerConnectorId: "con_gmail" });
    expect((await h.vault.accessToken(meta.id, "con_gmail")).use((v) => v)).toBe(
      "ya29.access-0001-abcdef",
    );
    await expect(h.vault.accessToken(meta.id, "con_slack")).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(h.vault.update(meta.id, { secret: { token: "x-123456" } })).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(h.vault.delete(meta.id)).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      h.vault.add({ kind: "oauth_token", name: "x", bindings: [], secret: { token: "t-123456" } }),
    ).rejects.toMatchObject({ code: "invalid_params" });
    // Not through the agent's placeholder path either.
    await expect(
      h.vault.resolve("{{cred:gmail-pat}}", { kind: "account", value: "con_gmail" }, "apr_x"),
    ).rejects.toMatchObject({ code: "policy_denied", details: { reason: "connector_owned" } });
  });

  it("rotates atomically, including a rotated refresh token", async () => {
    const meta = await gmail();
    const events: string[] = [];
    h.vault.on("credential.updated", (e) => events.push(e.change));
    await h.vault.rotate(meta.id, "con_gmail", async (refresh) => {
      expect(refresh.use((v) => v)).toBe("1//refresh-0001-abcdef");
      return { accessToken: "ya29.access-0002-abcdef", refreshToken: "1//refresh-0002-abcdef" };
    });
    expect((await h.vault.accessToken(meta.id, "con_gmail")).use((v) => v)).toBe(
      "ya29.access-0002-abcdef",
    );
    await h.vault
      .rotate(meta.id, "con_gmail", async (refresh) => {
        expect(refresh.use((v) => v)).toBe("1//refresh-0002-abcdef");
        throw new Error("invalid_grant");
      })
      .catch(() => undefined);
    expect((await h.vault.accessToken(meta.id, "con_gmail")).use((v) => v)).toBe(
      "ya29.access-0002-abcdef",
    );
    expect(events).toContain("rotated");
    // Old values stay masked: they may already sit in logs of this process.
    expect(h.vault.redact("token ya29.access-0001-abcdef")).not.toContain("access-0001");
  });

  it("disconnect revokes, deletes and emits the invalidation event", async () => {
    const meta = await gmail();
    // A stand-in for pending Gmail-bound work held by the task engine.
    const pending = new Map([
      ["task_1", "con_gmail"],
      ["task_2", "con_slack"],
    ]);
    const invalidated: string[] = [];
    h.vault.onRevoked((e) => {
      for (const [task, connector] of pending)
        if (connector === e.connectorId) invalidated.push(task);
    });
    const changes: string[] = [];
    h.vault.on("credential.updated", (e) => changes.push(`${e.change}:${e.ownerConnectorId}`));
    await h.vault.revoke(meta.id, "con_gmail");
    expect(invalidated).toEqual(["task_1"]);
    expect(changes).toEqual(["revoked:con_gmail"]);
    expect(await h.vault.get(meta.id)).toBeUndefined();
    await expect(h.vault.accessToken(meta.id, "con_gmail")).rejects.toMatchObject({
      code: "not_found",
    });
    expect((await h.audit.list()).map((e) => e.kind)).toContain("credential.revoked");
  });

  it("a revoke during a refresh wins", async () => {
    const meta = await gmail();
    await expect(
      h.vault.rotate(meta.id, "con_gmail", async () => {
        await h.vault.revoke(meta.id, "con_gmail");
        return { accessToken: "ya29.access-0003-abcdef" };
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await h.vault.get(meta.id)).toBeUndefined();
  });
});
