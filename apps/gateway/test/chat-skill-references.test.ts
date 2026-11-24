import type { LoadedSkill, Thread } from "@psyche/protocol";
import { extractSkillReferences } from "@psyche/skills";
import { afterEach, describe, expect, it } from "vitest";
import type { Call } from "../src/context.ts";
import { skillsNamedBy, skillTurn } from "../src/handlers/chat-skills.ts";
import { GatedAgentLoop, RecordingBroker } from "./agent.ts";
import {
  desktopClient,
  ik,
  newDeviceKey,
  startTestGateway,
  type TestClient,
  type TestGateway,
} from "./helpers.ts";

/**
 * A `$skill-name` the owner types starts the turn with that skill's text (`chat.send` →
 * `skillsNamedBy`). The Gateway test stubs the loader's `resolveReferences` with the same
 * `extractSkillReferences` parser over the enabled skills; the loader's own enabled/disabled rules
 * are tested in `packages/skills`.
 */

const BODY = "Sort today's mail into reply, read later and archive.";

const ENABLED: LoadedSkill[] = [
  {
    name: "inbox-triage",
    source: "bundled",
    trust: "bundled",
    body: BODY,
    description: "Sort the mail.",
    enabled: true,
  } as unknown as LoadedSkill,
];

let t: TestGateway;
const clients: TestClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await t?.cleanup();
});

/** The enabled skills only, read the way the loader's `resolveReferences` reads them. */
async function stubbedResolve(text: string): Promise<LoadedSkill[]> {
  const names = extractSkillReferences(
    text,
    ENABLED.map((s) => s.name),
  );
  return ENABLED.filter((s) => names.includes(s.name));
}

describe("skill references in chat.send", () => {
  it("a $name the owner types injects the enabled skill into that turn", async () => {
    const agent = new GatedAgentLoop();
    t = await startTestGateway({ agent, broker: new RecordingBroker({ armDelayMs: 0 }) });
    t.gateway.context.skillReferences.resolve = stubbedResolve;
    const client = await desktopClient(t.gateway, newDeviceKey(), "owner-mac-1");
    clients.push(client);
    const thread = (await client.call<{ thread: Thread }>("threads.create", { kind: "side" }, ik()))
      .thread;

    await client.request(
      "chat.send",
      { threadId: thread.id, content: "$inbox-triage triage today" },
      ik(),
    );
    await agent.started(1);
    const turn = agent.turns[0] as {
      input: { text: string };
      taintSources?: unknown;
    };
    // The skill's text comes ahead of the owner's words, which stay last and unchanged.
    expect(turn.input.text).toContain('The owner started the skill "inbox-triage"');
    expect(turn.input.text).toContain(BODY);
    expect(turn.input.text.endsWith("\n\n$inbox-triage triage today")).toBe(true);
    // A bundled skill is trusted: it does not taint the turn.
    expect(turn.taintSources).toBeUndefined();
  });

  it("a name that is not an enabled skill sends the text unchanged", async () => {
    const agent = new GatedAgentLoop();
    t = await startTestGateway({ agent, broker: new RecordingBroker({ armDelayMs: 0 }) });
    t.gateway.context.skillReferences.resolve = stubbedResolve;
    const client = await desktopClient(t.gateway, newDeviceKey(), "owner-mac-1");
    clients.push(client);

    // An unknown name, then a skill the owner has not enabled (not in the enabled set).
    for (const content of ["$no-such-skill hello", "$weekly-review hello"]) {
      const thread = (
        await client.call<{ thread: Thread }>("threads.create", { kind: "side" }, ik())
      ).thread;
      await client.request("chat.send", { threadId: thread.id, content }, ik());
    }
    await agent.started(2);
    // No skill text: each turn's text is exactly what the owner typed.
    const texts = (agent.turns as { input: { text: string } }[]).map((turn) => turn.input.text);
    expect(texts.sort()).toEqual(["$no-such-skill hello", "$weekly-review hello"]);
  });
});

describe("who triggers a skill reference", () => {
  const callAs = (role: "client" | "node") =>
    ({
      identity: { role },
      ctx: { skillReferences: { resolve: stubbedResolve } },
    }) as unknown as Call;

  it("an owner's plain message resolves its names", async () => {
    const got = await skillsNamedBy(callAs("client"), { content: "$inbox-triage now" });
    expect(got?.preamble).toContain(BODY);
  });

  it("a node's call, a widget click and a redo never inject a skill", async () => {
    const content = "$inbox-triage now";
    expect(await skillsNamedBy(callAs("node"), { content })).toBeUndefined();
    expect(
      await skillsNamedBy(callAs("client"), { content, fromWidget: { widgetId: "w1" } }),
    ).toBeUndefined();
    expect(
      await skillsNamedBy(callAs("client"), { content, redo: { messageId: "m1" } }),
    ).toBeUndefined();
  });

  it("a message without a $ never reads the loader", async () => {
    let reads = 0;
    const counting = {
      identity: { role: "client" },
      ctx: {
        skillReferences: {
          resolve: async () => {
            reads += 1;
            return [];
          },
        },
      },
    } as unknown as Call;
    expect(await skillsNamedBy(counting, { content: "plain words" })).toBeUndefined();
    expect(reads).toBe(0);
  });
});

describe("the text a named skill adds", () => {
  it("frames a third-party skill as its author's words and taints the turn", () => {
    const turn = skillTurn([
      {
        name: "digest",
        source: "home",
        trust: "unknown",
        body: "Do the digest.",
      } as unknown as LoadedSkill,
    ]);
    expect(turn?.preamble).toContain("(unknown publisher)");
    expect(turn?.preamble).toContain("Do the digest.");
    expect(turn?.taintSources).toEqual([{ sourceKind: "skill", origin: "digest" }]);
  });

  it("does not taint for a bundled skill, and adds nothing for no skills", () => {
    const turn = skillTurn(ENABLED);
    expect(turn?.taintSources).toEqual([]);
    expect(skillTurn([])).toBeUndefined();
  });
});
