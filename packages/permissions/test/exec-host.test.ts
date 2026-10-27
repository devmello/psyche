import { describe, expect, it } from "vitest";
import { approve, CTX, call, DEVICE, makeBroker, path } from "./helpers.ts";

/**
 * `exec_host` (security §5.4) and missing permissions (§3.13): off by default, every call asks on
 * the Mac, `always` binds exact argv + cwd + env + binary hash for 30 days, a tainted turn gets
 * `once` only whatever grants exist, the cwd must be inside a granted folder, and `UNSANDBOXED`
 * applies to one approved run. Denials the owner could lift name what is missing.
 */

const H = (s: string) => `sha256:${Buffer.from(s).toString("hex").padEnd(64, "0").slice(0, 64)}`;
const ON = { exec: { execHostEnabled: true }, folders: [{ path: "/work", mode: "rw" as const }] };

function host(argv: string[], over: Record<string, unknown> = {}) {
  return call("exec_host", "write", undefined, {
    params: { argv, cwd: "/work/app" },
    binding: {
      argv,
      cwd: "/work/app",
      env: {},
      executable: "/bin/ls",
      executableSha256: H("ls"),
      network: "none",
      ...over,
    },
  });
}

describe("exec_host", () => {
  it("is off by default, and the denial names the capability to request", async () => {
    const h = makeBroker({ policy: { folders: ON.folders } });
    const d = await h.broker.decide(host(["ls"]), CTX);
    expect(d).toMatchObject({ decision: "deny", rule: "exec_host:disabled" });
    expect(d.missing).toEqual({ need: "capability", capability: "exec_host" });
  });

  it("refuses a cwd outside every granted folder and names the folder", async () => {
    const h = makeBroker({ policy: { exec: { execHostEnabled: true } } });
    const d = await h.broker.decide(host(["ls"]), CTX);
    expect(d).toMatchObject({ decision: "deny", rule: "folder:not_granted" });
    expect(d.missing).toEqual({ need: "folder", path: "/work/app", access: "read_write" });
  });

  it("asks every call, device-only with presence, offering once or always", async () => {
    const h = makeBroker({ policy: ON });
    const d = await h.broker.decide(host(["ls"]), CTX);
    expect(d.decision).toBe("ask");
    expect(d.sideEffect).toBe("destructive");
    expect(d.scopesOffered).toEqual(["once", "always"]);
    const { approval } = await approve(h, host(["ls"]), CTX, "once");
    expect(approval.deviceOnly).toBe(true);
    expect(approval.requiresAuthentication).toBe(true);
    // `once` covers nothing after it: the same command asks again.
    expect((await h.broker.decide(host(["ls"]), CTX)).decision).toBe("ask");
  });

  it("binds always to the exact argv, cwd, env and binary hash for 30 days", async () => {
    const h = makeBroker({ policy: ON });
    await approve(h, host(["ls", "-la"]), CTX, "always");
    expect((await h.broker.decide(host(["ls", "-la"]), CTX)).decision).toBe("allow");
    expect((await h.broker.decide(host(["ls", "-R"]), CTX)).decision).toBe("ask");
    expect(
      (await h.broker.decide(host(["ls", "-la"], { executableSha256: H("evil") }), CTX)).decision,
    ).toBe("ask");
    expect((await h.broker.decide(host(["ls", "-la"], { env: { CI: "1" } }), CTX)).decision).toBe(
      "ask",
    );
    h.clock.advance(29 * 86_400_000);
    expect((await h.broker.decide(host(["ls", "-la"]), CTX)).decision).toBe("allow");
    h.clock.advance(2 * 86_400_000);
    expect((await h.broker.decide(host(["ls", "-la"]), CTX)).decision).toBe("ask");
  });

  it("gives a tainted turn once only, even over an always grant", async () => {
    const h = makeBroker({ policy: ON });
    await approve(h, host(["ls", "-la"]), CTX, "always");
    const tainted = { ...CTX, taint: true };
    const d = await h.broker.decide(host(["ls", "-la"]), tainted);
    expect(d.decision).toBe("ask");
    expect(d.scopesOffered).toEqual(["once"]);
    const fresh = await h.broker.decide(host(["ls", "-1"]), tainted);
    expect(fresh.scopesOffered).toEqual(["once"]);
  });

  it("records UNSANDBOXED on a once approval and refuses it with always", async () => {
    const h = makeBroker({ policy: ON });
    const issue = async () => {
      const d = await h.broker.decide(host(["ls"]), CTX);
      return h.broker.requestApproval({
        kind: "exec_host",
        summary: "run ls",
        details: {},
        bindingHash: d.bindingHash as string,
        grantKey: d.grantKey as string,
        requestedBy: { runId: CTX.runId, taskId: null, threadId: CTX.threadId },
        sideEffect: "destructive",
        surfaces: ["desktop"],
        taint: false,
      });
    };
    const a = await issue();
    h.clock.advance(500);
    await expect(
      h.broker.answer({
        approvalId: a.approval.id,
        answerToken: a.answerTokens.desktop ?? "",
        decision: "approve",
        scope: "always",
        unsandboxed: "UNSANDBOXED",
        decidedBy: DEVICE,
      }),
    ).rejects.toThrow(/UNSANDBOXED/);
    const b = await issue();
    h.clock.advance(500);
    const done = await h.broker.answer({
      approvalId: b.approval.id,
      answerToken: b.answerTokens.desktop ?? "",
      decision: "approve",
      scope: "once",
      unsandboxed: "UNSANDBOXED",
      decidedBy: DEVICE,
    });
    expect(done.details.unsandboxed).toBe(true);
  });
});

describe("missing permissions", () => {
  it("a file read outside the grants names a read folder; a write on read-only names read_write", async () => {
    const h = makeBroker({ policy: { folders: [{ path: "/docs", mode: "ro" }] } });
    const read = await h.broker.decide(call("read_file", "read", path("/elsewhere/a.txt")), CTX);
    expect(read.missing).toEqual({ need: "folder", path: "/elsewhere/a.txt", access: "read" });
    const write = await h.broker.decide(call("write_file", "write", path("/docs/a.txt")), CTX);
    expect(write).toMatchObject({ rule: "folder:read_only" });
    expect(write.missing).toEqual({ need: "folder", path: "/docs/a.txt", access: "read_write" });
  });

  it("a connector group set to deny names the group", async () => {
    const h = makeBroker({ policy: { connectors: { "apple.mail": { "mail.send": "deny" } } } });
    const d = await h.broker.decide(
      call("node.mail.send", "write", { kind: "recipient", value: "a@b.c" }),
      CTX,
    );
    expect(d.decision).toBe("deny");
    expect(d.missing).toMatchObject({ need: "connector_action", connector: "apple.mail" });
  });

  it("names nothing for denials the owner cannot lift by request", async () => {
    const h = makeBroker({
      policy: { deny: ["write_file"], folders: [{ path: "/w", mode: "rw" }] },
    });
    const d = await h.broker.decide(call("write_file", "write", path("/w/a")), CTX);
    expect(d.decision).toBe("deny");
    expect(d.missing).toBeUndefined();
  });

  it("permission requests are device-only, once only, and need presence only to turn on", async () => {
    const h = makeBroker();
    const req = (sideEffect: "write" | "none") =>
      h.broker.requestApproval({
        kind: "permission_request",
        summary: "Turn on",
        details: { need: { need: "capability", capability: "exec_host" } },
        bindingHash: H(sideEffect),
        grantKey: "permission_request|capability",
        requestedBy: { runId: CTX.runId, taskId: null, threadId: CTX.threadId },
        sideEffect,
        surfaces: ["desktop"],
        scopesOffered: ["once", "always"],
        taint: false,
      });
    const on = await req("write");
    expect(on.approval).toMatchObject({
      deviceOnly: true,
      requiresAuthentication: true,
      scopesOffered: ["once"],
      surfaces: ["desktop"],
    });
    const check = await req("none");
    expect(check.approval.requiresAuthentication).toBe(false);
  });
});
