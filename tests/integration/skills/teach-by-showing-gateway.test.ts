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

describe("recordings are saved only from the Psyche desktop app on this Mac", () => {
  it("the desktop shell saves a draft that remembers its device, and the client cannot name another", async () => {
    const r = await c.call<{ draft: SkillDraft }>(
      "skills.drafts.fromRecording",
      { title: "Export the weekly billing report", steps, device: "dev_somebody_else" },
      true,
    );
    expect(r.draft).toMatchObject({
      origin: "recording",
      status: "open",
      tainted: true,
      recordedOn: sk.deviceId,
    });
    expect(r.draft.text).not.toContain("token=abc");
    const { skills } = await c.call<{ skills: { name: string }[] }>("skills.list");
    expect(skills.some((s) => s.name === r.draft.name)).toBe(false);
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
  });

  it("a Mac-app recording becomes a tainted draft of the same kind, and a security prompt is refused", async () => {
    const app = { bundleId: "com.apple.mail", name: "Mail" };
    const r = await c.call<{ draft: SkillDraft }>(
      "skills.drafts.fromRecording",
      {
        title: "Send the weekly note",
        steps: [
          { id: "a1", kind: "app_click", app, role: "button", name: "New Message" },
          {
            id: "a2",
            kind: "app_type",
            app,
            role: "textbox",
            name: "Subject",
            input: { name: "subject" },
          },
          {
            id: "a3",
            kind: "app_menu",
            app,
            role: "menuitem",
            name: "Export",
            path: ["File", "Export"],
          },
        ],
      },
      true,
    );
    expect(r.draft).toMatchObject({
      origin: "recording",
      recordedIn: "mac_app",
      status: "open",
      tainted: true,
      recordedOn: sk.deviceId,
    });
    expect(r.draft.text).toContain("computer.check_target");
    const err = await rejection(
      c.call(
        "skills.drafts.fromRecording",
        {
          title: "x",
          steps: [
            {
              id: "a1",
              kind: "app_click",
              app: { bundleId: "com.apple.SecurityAgent", name: "SecurityAgent" },
              role: "button",
              name: "Allow",
            },
          ],
        },
        true,
      ),
    );
    expect(err.code).toBe("invalid_params");
    expect(err.message).toContain("never recorded");
  });

  it("accepting runs the replay check; this Gateway has no browser tools, so it refuses", async () => {
    const open = await c.call<{ drafts: SkillDraft[] }>("skills.drafts.list", { status: "open" });
    const draft = open.drafts.find(
      (d) => d.origin === "recording" && d.recordedIn === "browser",
    ) as SkillDraft;
    const err = await rejection(c.call("skills.drafts.accept", { draftId: draft.id }, true));
    expect(err.code).toBe("policy_denied");
    expect(err.message).toContain("tools no longer available");
  });

  it("is an admin setting too: a device without operator.admin is refused", async () => {
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
