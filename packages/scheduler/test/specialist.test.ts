import { describe, expect, it } from "vitest";
import { createAutomationHandlers } from "../src/index.ts";
import { BASE, setup } from "./helpers.ts";

const T0 = Date.parse("2026-10-19T12:00:00Z");
const SHOPPER = {
  role: "shopper",
  budget: { tokens: 50_000, minutes: 15 },
  deliver: "inbox",
} as const;

describe("automations as specialists (specialists §4.10)", () => {
  it("stores the specialist, hands it to the launcher, and clears it with null", async () => {
    const { scheduler, launcher } = setup({ start: T0 });
    const h = createAutomationHandlers(scheduler);
    const { automation } = await h["automations.create"]({
      ...BASE,
      kind: "interval",
      schedule: "PT1H",
      specialist: SHOPPER,
    });
    expect(automation.specialist).toEqual(SHOPPER);
    expect((await scheduler.get(automation.id))?.specialist).toEqual(SHOPPER);
    await h["automations.run"]({ automationId: automation.id });
    await scheduler.idle();
    expect(launcher.requests[0]?.automation.specialist).toEqual(SHOPPER);
    // An unrelated update keeps it; null removes it.
    const renamed = await h["automations.update"]({ automationId: automation.id, title: "Prices" });
    expect(renamed.automation.specialist).toEqual(SHOPPER);
    const plain = await h["automations.update"]({ automationId: automation.id, specialist: null });
    expect(plain.automation.specialist).toBeUndefined();
  });

  it("refuses a specialist on watches and the heartbeat", async () => {
    const { scheduler } = setup({ start: T0 });
    await expect(
      scheduler.create({ ...BASE, kind: "heartbeat", schedule: "PT30M", specialist: SHOPPER }),
    ).rejects.toMatchObject({ code: "invalid_params" });
  });
});
