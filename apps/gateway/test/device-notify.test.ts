import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setSetting } from "@psyche/db";
import { FakeClock, FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { silentLogger } from "../src/log.ts";
import { adminClient, type TestClient } from "./helpers.ts";

/**
 * The `device:<deviceId>` notification surface (remote Gateway design §4.2, R2): a remote client
 * that registered gets `notification.device` events for what the Host would put on its own OS,
 * with quiet hours and interruption levels applied, and never an action button.
 */

let home = "";
let composed: ComposedGateway | null = null;
const clients: TestClient[] = [];
const clock = new FakeClock();

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

async function setup(): Promise<ComposedGateway> {
  home = mkdtempSync(join(tmpdir(), "psyche-device-notify-"));
  composed = await composeGateway({
    env: {},
    logger: silentLogger,
    retentionIntervalMs: 0,
    background: false,
    clock,
    config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
    model: { provider: new FakeModelProvider(), model: "fake/model" },
  });
  return composed;
}

async function client(c: ComposedGateway): Promise<TestClient> {
  const t = await adminClient(c.gateway);
  clients.push(t);
  return t;
}

const toasts = (c: TestClient) => c.eventsNamed("notification.device");
const settle = () => new Promise((r) => setTimeout(r, 60));

/** Quiet hours that cover the fake clock's now, in the system's zone. */
function quietNow(c: ComposedGateway): void {
  const at = (ms: number) => {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };
  setSetting(c.db, "notifications.quietHours.enabled", true);
  setSetting(c.db, "notifications.quietHours.start", at(clock.now() - 3_600_000));
  setSetting(c.db, "notifications.quietHours.end", at(clock.now() + 3_600_000));
}

describe("device notifications over the Gateway", () => {
  it("reach a registered client only, with no action buttons", async () => {
    const c = await setup();
    setSetting(c.db, "notifications.quietHours.enabled", false);
    const on = await client(c);
    const off = await client(c);
    expect(await on.call("notifications.device.register", { enabled: true })).toEqual({
      enabled: true,
    });
    await c.notifier.notify({
      kind: "approval",
      title: "Buy a flight",
      body: "$412",
      approvalId: "apr_1",
      route: "/agent/approvals",
      actions: [{ id: "approve", label: "Approve", authenticationRequired: true }],
    });
    const hit = await on.waitForEvent((e) => e.event === "notification.device");
    expect(hit.payload).toMatchObject({
      kind: "approval",
      title: "Buy a flight",
      body: "$412",
      route: "/agent/approvals",
      interruption: "timeSensitive",
    });
    expect(Object.keys(hit.payload as object)).not.toContain("actions");
    expect(JSON.stringify(hit.payload)).not.toContain("Approve");
    await settle();
    expect(toasts(off)).toHaveLength(0);
  });

  it("stop after the client turns them off or disconnects", async () => {
    const c = await setup();
    setSetting(c.db, "notifications.quietHours.enabled", false);
    const a = await client(c);
    await a.call("notifications.device.register", { enabled: true });
    await a.call("notifications.device.register", { enabled: false });
    await c.notifier.notify({ kind: "task_done", title: "Done", body: "" });
    await settle();
    expect(toasts(a)).toHaveLength(0);

    await a.call("notifications.device.register", { enabled: true });
    a.close();
    await settle();
    await c.notifier.notify({ kind: "task_done", title: "Done again", body: "", taskId: "t2" });
    await settle();
    expect(toasts(a)).toHaveLength(0);
  });

  it("defer a passive toast during quiet hours, and let an approval through", async () => {
    const c = await setup();
    quietNow(c);
    const a = await client(c);
    await a.call("notifications.device.register", { enabled: true });

    await c.notifier.notify({ kind: "reminder", title: "Stretch", body: "" });
    await settle();
    expect(toasts(a)).toHaveLength(0);

    await c.notifier.notify({ kind: "approval", title: "Buy", body: "", approvalId: "apr_2" });
    const hit = await a.waitForEvent((e) => e.event === "notification.device");
    expect((hit.payload as { title: string }).title).toBe("Buy");

    // Two hours on, quiet hours are over and the deferred toast goes out.
    clock.advance(2 * 3_600_000 + 60_000);
    await c.notifier.flushDue();
    await a.waitForEvent(
      (e) =>
        e.event === "notification.device" && (e.payload as { title: string }).title === "Stretch",
    );
  });
});
