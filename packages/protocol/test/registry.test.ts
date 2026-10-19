import { Kind } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import {
  ADMIN_SETTING_ROOTS,
  type ErrorCode,
  Events,
  isEventName,
  isMethodName,
  type MethodName,
  type MethodParams,
  type MethodResult,
  Methods,
  methodSpec,
  PsycheError,
  requiresIdempotencyKey,
  validateEventPayload,
  validateParams,
  validateResult,
} from "../src/index.ts";

const FAMILIES = [
  "threads",
  "chat",
  "tasks",
  "approvals",
  "grants",
  "memory",
  "library",
  "settings",
  "search",
  "notifications",
  "nodes",
  "devices",
  "connectors",
  "channels",
  "automations",
  "vault",
  "view",
  "browser",
  "sandbox",
  "events",
  "node",
] as const;

const REQUIRED_METHODS: MethodName[] = [
  "connect",
  "connect.verify",
  "threads.create",
  "threads.list",
  "threads.get",
  "threads.rename",
  "threads.archive",
  "threads.restore",
  "threads.delete",
  "threads.pin",
  "threads.fork",
  "chat.send",
  "chat.history",
  "chat.cancel",
  "chat.steer",
  "chat.followUp",
  "chat.export",
  "tasks.list",
  "tasks.get",
  "tasks.pause",
  "tasks.resume",
  "tasks.cancel",
  "tasks.retry",
  "tasks.actions",
  "approvals.list",
  "approvals.get",
  "approvals.answer",
  "grants.list",
  "grants.revoke",
  "memory.search",
  "memory.read",
  "memory.write",
  "memory.files.list",
  "memory.daily.list",
  "memory.claims.list",
  "memory.claims.confirm",
  "memory.explain",
  "memory.forget",
  "memory.remember",
  "memory.import",
  "memory.export",
  "memory.reset",
  "memory.status",
  "memory.pause",
  "memory.persona.get",
  "memory.persona.edit",
  "library.list",
  "library.get",
  "library.delete",
  "settings.get",
  "settings.set",
  "search.query",
  "notifications.list",
  "notifications.markRead",
  "notifications.resolve",
  "nodes.list",
  "nodes.capabilities",
  "nodes.invoke",
  "devices.list",
  "devices.approve",
  "devices.deny",
  "devices.revoke",
  "devices.pairing.list",
  "connectors.list",
  "connectors.get",
  "channels.list",
  "channels.get",
  "channels.configure",
  "channels.allowlist.update",
  "channels.pairing.list",
  "channels.pairing.approve",
  "channels.pairing.deny",
  "channels.identities.list",
  "channels.identities.upsert",
  "channels.identities.delete",
  "automations.list",
  "automations.create",
  "automations.update",
  "automations.delete",
  "automations.run",
  "vault.list",
  "vault.get",
  "view.open",
  "view.close",
  "view.focus",
  "view.layout",
  "browser.tabs",
  "browser.open",
  "browser.close",
  "browser.snapshot",
  "sandbox.list",
  "sandbox.status",
  "events.subscribe",
  "node.invoke",
  "node.event",
  "node.result",
  "questions.list",
  "questions.get",
  "questions.answer",
  "receipts.get",
  "receipts.list",
  "artifacts.get",
  "feed.list",
  "feed.feedback",
  "ideas.list",
  "ideas.accept",
  "ideas.dismiss",
  "goals.list",
  "goals.get",
  "goals.decide",
];

const REQUIRED_EVENTS = [
  "chat.delta",
  "chat.message",
  "chat.block",
  "run.updated",
  "tool_call.updated",
  "task.updated",
  "task.action",
  "approval.created",
  "approval.updated",
  "question.created",
  "receipt.created",
  "notification.created",
  "settings.changed",
  "question.updated",
  "feed.post",
  "idea.updated",
  "goal.updated",
  "thread.updated",
  "node.updated",
  "device.updated",
  "pairing.requested",
  "view.command",
  "memory.file.changed",
  "memory.job.updated",
  "persona.updated",
  "gateway.shutdown",
];

const isSchema = (v: unknown) => typeof v === "object" && v !== null && Kind in v;

function codeOf(fn: () => unknown): ErrorCode | undefined {
  try {
    fn();
  } catch (err) {
    if (err instanceof PsycheError) return err.code;
    throw err;
  }
  return undefined;
}

describe("method registry", () => {
  const names = Object.keys(Methods);

  it("has every M1 family and method", () => {
    for (const family of FAMILIES) {
      expect(
        names.some((n) => n.startsWith(`${family}.`)),
        family,
      ).toBe(true);
    }
    for (const method of REQUIRED_METHODS) expect(isMethodName(method), method).toBe(true);
  });

  it("gives every method params and result schemas, a scope and a description", () => {
    for (const name of names) {
      const spec = methodSpec(name);
      expect(isSchema(spec.params), `${name} params`).toBe(true);
      expect(isSchema(spec.result), `${name} result`).toBe(true);
      expect(spec.description.length, name).toBeGreaterThan(10);
      expect(typeof spec.sideEffecting).toBe("boolean");
    }
  });

  it("documents every side-effecting method as such", () => {
    const sideEffecting = names.filter((n) => methodSpec(n).sideEffecting);
    expect(sideEffecting).toEqual(
      expect.arrayContaining(["chat.send", "memory.write", "settings.set", "nodes.invoke"]),
    );
    for (const name of sideEffecting) {
      expect(methodSpec(name).description, name).toMatch(/Side-effecting/);
      expect(requiresIdempotencyKey(name)).toBe(true);
      expect(methodSpec(name).scope, name).not.toBe("operator.read");
    }
    expect(requiresIdempotencyKey("threads.list")).toBe(false);
    expect(requiresIdempotencyKey("nope")).toBe(false);
  });

  it("assigns scopes per security §10", () => {
    expect(methodSpec("connect").scope).toBe("none");
    expect(methodSpec("connect.verify").scope).toBe("none");
    for (const name of names) {
      const { scope } = methodSpec(name);
      if (name.startsWith("devices.")) expect(scope, name).toBe("operator.admin");
      if (name.startsWith("node.")) expect(scope, name).toBe("node");
      if (
        /\.(list|get|history|search|query|tabs|snapshot|status|capabilities|layout)$/.test(name)
      ) {
        expect(["operator.read", "operator.admin"], name).toContain(scope);
      }
      if (scope === "none") expect(name.startsWith("connect"), name).toBe(true);
    }
    expect(methodSpec("approvals.answer").scope).toBe("operator.approvals");
    expect(methodSpec("grants.revoke").scope).toBe("operator.admin");
    expect(methodSpec("settings.set").scope).toBe("operator.write");
    expect(methodSpec("nodes.invoke").scope).toBe("operator.write");
    expect(ADMIN_SETTING_ROOTS).toContain("permissions");
  });

  it("throws unknown_method for names outside the registry", () => {
    expect(isMethodName("toString")).toBe(false);
    expect(isMethodName(42)).toBe(false);
    expect(codeOf(() => methodSpec("threads.nope"))).toBe("unknown_method");
    expect(codeOf(() => validateParams("__proto__", {}))).toBe("unknown_method");
  });
});

describe("validateParams / validateResult", () => {
  it("returns valid params typed and treats absent params as {}", () => {
    const params: MethodParams<"chat.send"> = validateParams("chat.send", {
      threadId: "t1",
      content: "hello",
      mode: "steer",
    });
    expect(params.mode).toBe("steer");
    expect(validateParams("nodes.list", undefined)).toEqual({});
    expect(validateParams("settings.get", undefined)).toEqual({});
  });

  it("throws invalid_params with a readable message", () => {
    try {
      validateParams("threads.rename", { threadId: "t1", title: 7 });
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PsycheError);
      const e = err as PsycheError;
      expect(e.code).toBe("invalid_params");
      expect(e.message).toBe("invalid params for threads.rename: /title: Expected string");
      expect(e.details).toEqual({ method: "threads.rename", errors: ["/title: Expected string"] });
    }
    expect(codeOf(() => validateParams("chat.send", { threadId: "t1", content: "" }))).toBe(
      "invalid_params",
    );
    expect(
      codeOf(() => validateParams("chat.send", { threadId: "t1", content: "x", mode: "now" })),
    ).toBe("invalid_params");
    expect(
      codeOf(() => validateParams("devices.approve", { pairingRequestId: "p", scopes: [] })),
    ).toBe("invalid_params");
    expect(codeOf(() => validateParams("threads.list", null))).toBe("invalid_params");
  });

  it("rejects workspace paths that escape the workspace", () => {
    expect(validateParams("memory.read", { path: "memory/2026-10-18.md" })).toBeTruthy();
    for (const path of ["/etc/passwd", "../x", "memory/../../x", "a/..", "\\\\server\\share"]) {
      expect(
        codeOf(() => validateParams("memory.read", { path })),
        path,
      ).toBe("invalid_params");
    }
  });

  it("validates connect params including the Ed25519 key format", () => {
    const params = {
      protocolVersion: { min: 1, max: 1 },
      deviceId: "dev_1",
      publicKey: "A".repeat(43),
      role: "client",
      platform: "macos",
      deviceFamily: "desktop",
      name: "MacBook",
    };
    expect(validateParams("connect", params)).toEqual(params);
    expect(codeOf(() => validateParams("connect", { ...params, publicKey: "abc" }))).toBe(
      "invalid_params",
    );
    expect(codeOf(() => validateParams("connect", { ...params, role: "both" }))).toBe(
      "invalid_params",
    );
    expect(codeOf(() => validateParams("connect", { ...params, deviceFamily: "desk\ntop" }))).toBe(
      "invalid_params",
    );
  });

  it("validates results and throws internal for bad ones", () => {
    const result: MethodResult<"settings.set"> = validateResult("settings.set", {
      entry: { key: "appearance.theme", value: "dark", updatedAt: "2026-10-18T20:11:05Z" },
      stateVersion: 12,
    });
    expect(result.stateVersion).toBe(12);
    expect(
      validateResult("connect.verify", {
        phase: "pending",
        pairingRequestId: "p1",
        code: "ABCD2345",
      }),
    ).toBeTruthy();
    expect(codeOf(() => validateResult("connect.verify", { phase: "paired" }))).toBe("internal");
    expect(codeOf(() => validateResult("threads.delete", { ok: false }))).toBe("internal");
  });
});

describe("event registry", () => {
  it("has every M1 event with a payload schema", () => {
    for (const name of REQUIRED_EVENTS) expect(isEventName(name), name).toBe(true);
    for (const [name, spec] of Object.entries(Events)) {
      expect(isSchema(spec.payload), name).toBe(true);
      expect(spec.description.length).toBeGreaterThan(10);
    }
  });

  it("validates payloads", () => {
    expect(
      validateEventPayload("chat.delta", { threadId: "t", messageId: "m", delta: "Hel" }),
    ).toBeTruthy();
    expect(
      validateEventPayload("settings.changed", {
        entries: [
          { key: "appearance.theme", value: "dark", updatedAt: "2026-10-18T20:11:05.123Z" },
        ],
      }),
    ).toBeTruthy();
    expect(
      validateEventPayload("view.command", { command: "open", args: { pane: "browser" } }),
    ).toBeTruthy();
    expect(validateEventPayload("gateway.shutdown", { reason: "update" })).toEqual({
      reason: "update",
    });
  });

  it("rejects bad payloads and unknown events", () => {
    expect(codeOf(() => validateEventPayload("chat.delta", { messageId: "m", delta: "x" }))).toBe(
      "invalid_params",
    );
    expect(codeOf(() => validateEventPayload("view.command", { command: "eval", args: {} }))).toBe(
      "invalid_params",
    );
    expect(
      codeOf(() =>
        validateEventPayload("settings.changed", {
          entries: [{ key: "k", value: 1, updatedAt: "yesterday" }],
        }),
      ),
    ).toBe("invalid_params");
    expect(codeOf(() => validateEventPayload("chat.nope", {}))).toBe("invalid_params");
  });
});

describe("UI read and answer methods (S12)", () => {
  it("validates a question answer keyed by header", () => {
    const params = { inputRequestId: "ir1", answer: { SLOT: "Tue 2:30", NOTIFY: ["You", "Sam"] } };
    expect(validateParams("questions.answer", params)).toEqual(params);
    expect(requiresIdempotencyKey("questions.answer")).toBe(true);
    expect(
      codeOf(() =>
        validateParams("questions.answer", {
          inputRequestId: "ir1",
          answer: { TOOLONGHEADER1: "x" },
        }),
      ),
    ).toBe("invalid_params");
  });

  it("carries this surface's answer token only as an optional field", () => {
    expect(
      validateParams("ideas.dismiss", { ideaId: "i1", reason: "never_from_source" }),
    ).toBeTruthy();
    expect(codeOf(() => validateParams("ideas.dismiss", { ideaId: "i1", reason: "meh" }))).toBe(
      "invalid_params",
    );
    expect(
      codeOf(() => validateParams("goals.decide", { goalId: "g1", decision: "confirm" })),
    ).toBe(undefined);
    expect(codeOf(() => validateParams("feed.feedback", { postId: "p1", feedback: null }))).toBe(
      undefined,
    );
  });
});
