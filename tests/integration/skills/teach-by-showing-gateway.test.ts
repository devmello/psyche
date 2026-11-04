import { updateDevice } from "@psyche/db";
import type {
  BrowserTeachStep,
  CallOptions,
  ModelCapabilities,
  ModelEvent,
  ModelProvider,
  SkillDraft,
} from "@psyche/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Client, type Skeleton, startSkeleton } from "../walking-skeleton/harness.ts";

/**
 * Teach by showing over the real Gateway (docs/design/teach-by-showing-2026.md §4): the owner's
 * reviewed steps become a skill draft through `skills.drafts.fromRecording`, admin only; the
 * draft is never installed by itself, and what the review screen must not send is refused.
 */

const steps: BrowserTeachStep[] = [
  { id: "s1", kind: "navigate", url: "https://billing.example.com/reports?token=abc" },
  { id: "s2", kind: "type", role: "textbox", name: "From", input: { name: "from_date" } },
  { id: "s3", kind: "click", role: "button", name: "Export" },
];

/** The Gateway needs a model to compose; nothing here talks to it. */
class IdleModel implements ModelProvider {
  readonly id = "fake";
  stream(_req: unknown, _opts?: CallOptions): AsyncIterable<ModelEvent> {
    return (async function* () {
      yield { type: "text_delta", text: "Done." };
      yield {
        type: "usage",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 },
      };
      yield { type: "finish", reason: "stop" };
    })();
  }
  async capabilities(): Promise<ModelCapabilities> {
    return {
      toolCalling: true,
      vision: false,
      reasoning: false,
      embeddings: false,
      contextWindow: 200_000,
    };
  }
}

async function rejection(p: Promise<unknown>): Promise<{ code: string; message?: string }> {
  try {
    await p;
  } catch (e) {
    return e as { code: string; message?: string };
  }
  throw new Error("expected the call to fail");
}

let sk: Skeleton;
let c: Client;
let draft: SkillDraft;

beforeAll(async () => {
  sk = await startSkeleton({ model: { provider: new IdleModel(), model: "fake/main" } });
  updateDevice(sk.composed.gateway.context.db, sk.deviceId, {
    scopes: ["operator.read", "operator.write", "operator.approvals", "operator.admin"],
  });
  sk.client.stop();
  c = await sk.connect();
});
afterAll(async () => {
  await sk?.stop();
});

describe("a recording becomes a skill draft over the Gateway", () => {
  it("makes an open, tainted draft that holds no query string and no value", async () => {
    const r = await c.call<{ draft: SkillDraft }>(
      "skills.drafts.fromRecording",
      { title: "Export the weekly billing report", steps },
      true,
    );
    draft = r.draft;
    expect(draft).toMatchObject({
      origin: "recording",
      status: "open",
      tainted: true,
      name: "export-weekly-billing-report",
    });
    expect(draft.text).toContain("## Recorded steps (reference, untrusted page text)");
    expect(draft.text).not.toContain("token=abc");
    const { skills } = await c.call<{ skills: { name: string }[] }>("skills.list");
    expect(skills.some((s) => s.name === draft.name)).toBe(false);
    const open = await c.call<{ drafts: SkillDraft[] }>("skills.drafts.list", { status: "open" });
    expect(open.drafts.map((d) => d.id)).toContain(draft.id);
  });

  it("refuses a value on a sensitive step, or one the owner did not keep", async () => {
    for (const bad of [
      {
        id: "s1",
        kind: "type",
        role: "textbox",
        name: "Password",
        sensitive: true,
        value: "hunter2",
      },
      { id: "s1", kind: "type", role: "textbox", name: "Note", value: "private" },
    ]) {
      const err = await rejection(
        c.call("skills.drafts.fromRecording", { title: "x", steps: [bad] }, true),
      );
      expect(err.code).toBe("invalid_params");
    }
    // Not even a protocol-valid list: no steps.
    expect(
      (await rejection(c.call("skills.drafts.fromRecording", { title: "x", steps: [] }, true)))
        .code,
    ).toBe("invalid_params");
  });

  it("accepting replays the draft against today's tools; this Gateway has no browser, so it refuses", async () => {
    const err = await rejection(c.call("skills.drafts.accept", { draftId: draft.id }, true));
    expect(err.code).toBe("policy_denied");
    expect(err.message).toContain("tools no longer available");
    // Still a draft, still not installed.
    const open = await c.call<{ drafts: SkillDraft[] }>("skills.drafts.list", { status: "open" });
    expect(open.drafts.find((d) => d.id === draft.id)?.status).toBe("open");
  });

  it("is an admin setting: a device without operator.admin is refused", async () => {
    updateDevice(sk.composed.gateway.context.db, sk.deviceId, {
      scopes: ["operator.read", "operator.write"],
    });
    const weak = await sk.connect();
    const err = await rejection(
      weak.call("skills.drafts.fromRecording", { title: "x", steps }, true),
    );
    expect(err.code).toBe("forbidden");
  });
});
