import { describe, expect, it } from "vitest";
import { CTX, call, makeBroker } from "./helpers.ts";

/** The per-app tier check keys on the described computer-use action, not the tool name. */

const NOTES = "com.example.Notes";
const act = (app: string, action?: string, target = app) =>
  call(
    "computer.act",
    "write",
    { kind: "app", value: target },
    {
      kind: "computer_action",
      params: { app, action },
      ...(action === undefined ? {} : { meta: { app, action } }),
    },
  );

describe("computer-use action tiers", () => {
  const h = () => makeBroker({ policy: { apps: { [NOTES]: "click" } } });

  it("a click passes on a click-tier app and typing is denied there", async () => {
    const b = h().broker;
    const click = await b.decide(act(NOTES, "click"), CTX);
    expect(click).toMatchObject({ decision: "allow", rule: "app_tier:click" });
    const type = await b.decide(act(NOTES, "type"), CTX);
    expect(type).toMatchObject({ decision: "deny", rule: "app_tier:click" });
  });

  it("without an action the tool name decides, so computer.act needs interact", async () => {
    const d = await h().broker.decide(act(NOTES), CTX);
    expect(d).toMatchObject({ decision: "deny", rule: "app_tier:click" });
  });

  it("terminals and IDEs are capped at click: a click passes, typing is denied", async () => {
    const b = makeBroker({ policy: { apps: { "com.apple.Terminal": "interact" } } }).broker;
    expect((await b.decide(act("com.apple.Terminal", "click"), CTX)).decision).not.toBe("deny");
    expect(await b.decide(act("com.apple.Terminal", "type"), CTX)).toMatchObject({
      decision: "deny",
      rule: "app_tier:click",
    });
  });

  it("apps.open and apps.focus need click", async () => {
    const b = h().broker;
    for (const [tool, action] of [
      ["apps.open", "open_app"],
      ["apps.focus", "focus"],
    ] as const) {
      const d = await b.decide(
        call(
          tool,
          "write",
          { kind: "app", value: NOTES },
          { kind: "computer_action", meta: { app: NOTES, action } },
        ),
        CTX,
      );
      expect(d.decision, tool).not.toBe("deny");
    }
  });

  it("an action whose app differs from its target is denied", async () => {
    const d = await h().broker.decide(act(NOTES, "click", "com.apple.Terminal"), CTX);
    expect(d).toMatchObject({ decision: "deny", rule: "app_tier:mismatch" });
  });
});
