import { NOTIFICATION_LISTEN_ACTION, type NotifyInput } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { createDeliverer } from "../src/delivery.ts";

/** Listen on the spoken brief and check-ins (voice-mode-2026 §4.9). */
describe("Listen on delivered briefings and check-ins", () => {
  const sent: NotifyInput[] = [];
  const deliverer = createDeliverer({
    notifier: {
      notify: async (n: NotifyInput) => {
        sent.push(n);
        return { id: `ntf_${sent.length}` };
      },
    } as never,
  });
  const run = { id: "run_1", threadId: "thr_1" } as never;
  const automation = (kind: string) =>
    ({ id: `aut_${kind}`, kind, title: `A ${kind}`, delivery: {} }) as never;
  const listen = [{ id: NOTIFICATION_LISTEN_ACTION, label: "Listen" }];

  it("offers Listen on the brief and heartbeat check-ins, and nowhere else", async () => {
    await deliverer.deliver(automation("briefing"), run, { summary: "Three meetings." } as never);
    await deliverer.deliver(automation("heartbeat"), run, { summary: "All quiet." } as never);
    await deliverer.deliver(automation("reminder"), run, { summary: "Call Sam." } as never);
    expect(sent.map((n) => [n.kind, n.actions])).toEqual([
      ["briefing", listen],
      ["proactive", listen],
      ["reminder", undefined],
    ]);
    expect(sent[0]?.route).toBe("/threads/thr_1");
  });
});
