import { describe, expect, it } from "vitest";
import { CTX, call, makeBroker } from "./helpers.ts";

const app = "org.gnome.TextEditor";
const typeCall = (machine?: string) =>
  call(
    "computer.act",
    "write",
    { kind: "app", value: app },
    {
      meta: { app, action: "type", ...(machine === undefined ? {} : { machine }) },
      params: { app, action: "type", text: "x" },
    },
  );

describe("the Host's app tiers and a call for a paired machine", () => {
  it.each(["off", "read", "interact"] as const)(
    "a machine call is not judged by the Host's %s tier",
    async (tier) => {
      const h = makeBroker({ policy: { apps: { [app]: tier } } });
      const d = await h.broker.decide(typeCall("DEVA"), CTX);
      expect(d.rule ?? "").not.toMatch(/^app_tier:(off|read)$/);
      expect(d.decision).not.toBe("deny");
    },
  );

  it("the Host's own call still is", async () => {
    const h = makeBroker({ policy: { apps: { [app]: "read" } } });
    const d = await h.broker.decide(typeCall(), CTX);
    expect(d.decision).toBe("deny");
    expect(d.rule).toBe("app_tier:read");
  });

  it("a machine call keeps the fixed caps", async () => {
    const h = makeBroker({ policy: { apps: {} } });
    const keepass = "org.keepassxc.KeePassXC";
    const d = await h.broker.decide(
      call(
        "computer.act",
        "write",
        { kind: "app", value: keepass },
        {
          meta: { app: keepass, action: "click", machine: "DEVA" },
          params: { app: keepass, action: "click" },
        },
      ),
      CTX,
    );
    expect(d.decision).toBe("deny");
  });
});
