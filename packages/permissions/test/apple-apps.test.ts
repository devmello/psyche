import { describe, expect, it } from "vitest";
import {
  APPLE_APP_ACTIONS,
  appleAppAction,
  appleAppEffect,
  DEVICE_ONLY_KINDS,
  effectiveSideEffect,
  inferApprovalKind,
} from "../src/index.ts";
import { CTX, call, makeBroker } from "./helpers.ts";

/** J6: each Apple app adapter has an action matrix in Permissions. */
describe("Apple app action matrix (J6)", () => {
  it("covers every helper adapter capability with a connector key", () => {
    for (const [cap, row] of Object.entries(APPLE_APP_ACTIONS)) {
      expect(cap.startsWith(row.connector.slice("apple.".length))).toBe(true);
      expect(appleAppAction(`node.${cap}`)).toBe(row);
      // Reads default to allow, writes to ask; nothing here is device-only (security §3.7).
      expect(row.default).toBe(row.sideEffect === "read" ? "allow" : "ask");
      expect(DEVICE_ONLY_KINDS).not.toContain(row.kind);
    }
    expect(appleAppAction("calendar.list_events")).toBeUndefined(); // only node calls
    expect(appleAppAction("node.messages.send")).toBeUndefined(); // J7 is not here
  });

  it("reads are allowed and writes ask by default", async () => {
    const h = makeBroker();
    const list = await h.broker.decide(call("node.calendar.list_events", "read"), CTX);
    expect(list.decision).toBe("allow");
    const create = await h.broker.decide(call("node.calendar.create_event", "write"), CTX);
    expect(create).toMatchObject({ decision: "ask", approvalKind: "calendar_write" });
    const note = await h.broker.decide(call("node.notes.create", "write"), CTX);
    expect(note.decision).toBe("ask");
  });

  it("follows the owner's matrix entries", async () => {
    const h = makeBroker({
      policy: {
        connectors: {
          "apple.reminders": { create: "allow" },
          "apple.mail": { read: "deny" },
        },
      },
    });
    expect((await h.broker.decide(call("node.reminders.create", "write"), CTX)).decision).toBe(
      "allow",
    );
    expect(await h.broker.decide(call("node.mail.read", "read"), CTX)).toMatchObject({
      decision: "deny",
      rule: "connector:apple.mail/read",
    });
  });

  it("never sends mail without an approval card, even when the owner allowed it", async () => {
    expect(appleAppEffect("node.mail.send", "allow")).toBe("ask");
    expect(appleAppEffect("node.mail.send", "deny")).toBe("deny");
    const h = makeBroker({ policy: { connectors: { "apple.mail": { send: "allow" } } } });
    const send = await h.broker.decide(call("node.mail.send", "write"), CTX);
    expect(send).toMatchObject({ decision: "ask", approvalKind: "send_email" });
  });

  it("does not trust a node that under-declares a write", () => {
    expect(effectiveSideEffect("node.mail.send", "read")).toBe("write");
    expect(effectiveSideEffect("node.safari.open_url", "none")).toBe("write");
    expect(inferApprovalKind("node.safari.open_url")).toBe("new_origin");
    expect(inferApprovalKind("node.reminders.update")).toBe("connector_action");
  });
});
