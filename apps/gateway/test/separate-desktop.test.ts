import { PsycheError } from "@psyche/protocol";
import type { DesktopContainers, DesktopShare } from "@psyche/sandbox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  asksInSeparateDesktop,
  assertSeparateDesktopClipboard,
  fillSeparateDesktopCredential,
  SEPARATE_DESKTOP_ID,
  SeparateDesktop,
  type SeparateDesktopState,
  separateDesktopFolderEnv,
} from "../src/compose/separate-desktop.ts";
import { GuestSockets } from "../src/nodes/guest-sockets.ts";
import { FakeNode, type FakeNodeHandler } from "./fake-node.ts";
import { newDeviceKey, startTestGateway, type TestGateway } from "./helpers.ts";

let t: TestGateway | null = null;
const nodes: FakeNode[] = [];
let guests: GuestSockets | null = null;

afterEach(async () => {
  for (const n of nodes.splice(0)) await n.close().catch(() => undefined);
  guests?.closeAll();
  guests = null;
  await t?.cleanup();
  t = null;
});

const CAPS: FakeNodeHandler[] = [
  {
    capability: { name: "computer.ax_tree", sideEffect: "read", streaming: false },
    run: () => ({ ok: 1 }),
  },
];

/** A container engine that "starts" by having the helper inside connect with the token. */
function fakeEngine(opts: { pairs?: boolean } = {}) {
  const log: string[] = [];
  const started: { shares: readonly DesktopShare[]; memory?: string; token: string }[] = [];
  const egress: { scope: unknown; closed: boolean }[] = [];
  const engine = {
    log,
    started,
    egress,
    requireBackend: async () => ({
      kind: "podman",
      cli: "/usr/bin/podman",
      version: "4.9.3",
      rootless: true,
    }),
    reconcile: async () => [],
    async start(req: {
      socketPath: string;
      token: string;
      shares?: readonly DesktopShare[];
      memory?: string;
    }) {
      log.push("start");
      started.push({
        shares: req.shares ?? [],
        ...(req.memory === undefined ? {} : { memory: req.memory }),
        token: req.token,
      });
      if (opts.pairs !== false) {
        const n = await FakeNode.connect(req.socketPath, {
          origin: t?.gateway.origin ?? "",
          handlers: CAPS,
          key: newDeviceKey(),
          deviceId: `guest-${Math.random().toString(36).slice(2)}`,
          deviceFamily: "linux-helper",
          secret: req.token,
        });
        nodes.push(n);
      }
      return {
        container: "psyche-desktop-main",
        startMs: 1,
        backend: await engine.requireBackend(),
      };
    },
    async stop() {
      log.push("stop");
    },
    async reset() {
      log.push("reset");
    },
    async openEgress(_id: string, scope: unknown) {
      const e = { scope, closed: false };
      egress.push(e);
      log.push("egress");
      return { close: () => void (e.closed = true) };
    },
  };
  return engine;
}

async function setup(opts: { pairs?: boolean; unsaved?: string[]; memory?: string } = {}) {
  t = await startTestGateway();
  guests = new GuestSockets({ ctx: t.gateway.context, home: t.home });
  const engine = fakeEngine(opts.pairs === undefined ? {} : { pairs: opts.pairs });
  const states: SeparateDesktopState[] = [];
  const allow: { scope: unknown; domains: readonly string[] }[] = [];
  const sd = new SeparateDesktop({
    desktop: engine as unknown as DesktopContainers,
    guests,
    home: t.home,
    ...(opts.memory === undefined ? {} : { memory: () => opts.memory }),
    report: (s) => states.push(s),
    egress: {
      tunnel: { handle: () => undefined },
      allowlist: (scope, domains) => void allow.push({ scope, domains }),
    },
    ...(opts.unsaved === undefined ? {} : { unsaved: async () => opts.unsaved ?? [] }),
    pairTimeoutMs: 600,
  });
  return { sd, engine, states, allow, g: t.gateway };
}

const share = (name: string, readOnly = true): DesktopShare => ({
  source: `/data/${name}`,
  name,
  readOnly,
});

describe("routing to the separate desktop", () => {
  it("only the separate_desktop surface, only the guest of this container", async () => {
    const { sd, g } = await setup();
    expect(() => sd.clientFor("direct")).toThrow(/not a separate desktop call/);
    expect(() => sd.clientFor("virtual_screen")).toThrow(/not a separate desktop call/);
    expect(() => sd.clientFor(undefined)).toThrow(/not a separate desktop call/);
    // Not running: unavailable, and never the Host's helper or any other node.
    await FakeNode.connectRemote(g, { handlers: CAPS, deviceFamily: "vm-guest" }).then((n) =>
      nodes.push(n),
    );
    try {
      sd.clientFor("separate_desktop");
      throw new Error("should refuse");
    } catch (e) {
      expect((e as PsycheError).code).toBe("unavailable");
      expect((e as PsycheError).details).toMatchObject({ reason: "separate_desktop_not_running" });
    }
    await sd.use("t1");
    const client = sd.clientFor("separate_desktop");
    expect(await client.invoke("computer.ax_tree", {})).toMatchObject({ ok: true });
  });
});

describe("the desktop's lifecycle", () => {
  it("starts on first use with the default memory, no shares and no internet", async () => {
    const { sd, engine, states } = await setup();
    await sd.use("t1");
    expect(engine.log).toEqual(["start"]);
    expect(engine.started[0]).toMatchObject({ shares: [], memory: "2g" });
    expect(engine.egress).toEqual([]);
    expect(states.map((s) => s.phase)).toEqual(["starting", "running"]);
    expect(states.at(-1)).toMatchObject({
      engine: "podman",
      rootless: true,
      shares: [],
      internet: false,
    });
  });

  it("uses the memory setting", async () => {
    const ok = await setup({ memory: "3g" });
    await ok.sd.use("t1");
    expect(ok.engine.started[0]?.memory).toBe("3g");
  });

  it("a bad memory value fails the start and leaves nothing running", async () => {
    const { sd, engine, states } = await setup({ memory: "64g" });
    await expect(sd.use("t1")).rejects.toThrow(/memory/);
    expect(engine.log).toContain("stop");
    expect(guests?.isOpen(SEPARATE_DESKTOP_ID)).toBe(false);
    expect(states.at(-1)?.phase).toBe("failed");
  });

  it("stops when the last task ends and nothing is watching: container gone, socket closed", async () => {
    const { sd, engine, states } = await setup();
    await sd.use("t1");
    await sd.release("t1");
    expect(engine.log).toEqual(["start", "stop"]);
    expect(guests?.isOpen(SEPARATE_DESKTOP_ID)).toBe(false);
    expect(() => sd.clientFor("separate_desktop")).toThrow();
    expect(states.at(-1)?.phase).toBe("off");
  });

  it("stays up while another task or a watch view holds it", async () => {
    const { sd, engine } = await setup();
    await sd.use("t1");
    await sd.use("t2");
    await sd.release("t1");
    expect(engine.log).toEqual(["start"]);
    await sd.watching(true);
    await sd.release("t2");
    expect(engine.log).toEqual(["start"]);
    await sd.watching(false);
    expect(engine.log).toEqual(["start", "stop"]);
  });

  it("does not stop on unsaved changes, and says which apps; force stops anyway", async () => {
    const { sd, engine } = await setup({ unsaved: ["libreoffice-writer"] });
    await sd.use("t1");
    await expect(sd.release("t1")).rejects.toMatchObject({
      code: "conflict",
      details: { reason: "unsaved_changes", apps: ["libreoffice-writer"] },
    });
    expect(engine.log).toEqual(["start"]);
    await sd.use("t1");
    await sd.release("t1", { force: true });
    expect(engine.log).toEqual(["start", "stop"]);
  });

  it("fails closed when the helper never pairs: the container is removed and the socket closed", async () => {
    const { sd, engine, states } = await setup({ pairs: false });
    await expect(sd.use("t1")).rejects.toMatchObject({ details: { reason: "guest_not_paired" } });
    expect(engine.log).toEqual(["start", "stop"]);
    expect(guests?.isOpen(SEPARATE_DESKTOP_ID)).toBe(false);
    expect(states.at(-1)?.phase).toBe("failed");
  });

  it("reset removes the container and its workspace", async () => {
    const { sd, engine } = await setup();
    await sd.use("t1");
    await sd.reset();
    expect(engine.log).toEqual(["start", "stop", "reset"]);
    expect(guests?.isOpen(SEPARATE_DESKTOP_ID)).toBe(false);
  });

  it("each start gets a new token", async () => {
    const { sd, engine } = await setup();
    await sd.use("t1");
    await sd.release("t1");
    await sd.use("t2");
    expect(engine.started).toHaveLength(2);
    expect(engine.started[0]?.token).not.toBe(engine.started[1]?.token);
  });
});

describe("shares and the internet", () => {
  it("a different share set restarts the desktop only when no other task holds it", async () => {
    const { sd, engine } = await setup();
    await sd.use("t1", { shares: [share("a")] });
    expect(engine.started[0]?.shares.map((s) => s.name)).toEqual(["a"]);
    await sd.use("t1", { shares: [share("a"), share("b", false)] });
    expect(engine.started).toHaveLength(2);
    expect(engine.started[1]?.shares.map((s) => s.name)).toEqual(["a", "b"]);
    await expect(sd.use("t2", { shares: [share("c")] })).rejects.toMatchObject({
      code: "conflict",
      details: { reason: "separate_desktop_busy" },
    });
    expect(engine.started).toHaveLength(2);
    expect(sd.ready).toBe(true);
  });

  it("internet is the task's tunnel with the task's allowlist, and ends with the task", async () => {
    const { sd, engine, allow, states } = await setup();
    await sd.use("t1", { internet: { allow: ["example.com"] } });
    expect(allow).toEqual([{ scope: { kind: "task", id: "t1" }, domains: ["example.com"] }]);
    expect(engine.egress).toHaveLength(1);
    expect(states.at(-1)?.internet).toBe(true);
    await sd.release("t1");
    expect(engine.egress[0]?.closed).toBe(true);
  });

  it("a task that did not ask for internet gets none", async () => {
    const { sd, engine, allow } = await setup();
    await sd.use("t1");
    expect(engine.egress).toEqual([]);
    expect(allow).toEqual([]);
  });
});

describe("what never reaches the container", () => {
  it("the Linux extras are protected roots", () => {
    const env = separateDesktopFolderEnv("/home/o/.psyche");
    for (const p of ["/proc", "/sys", "/etc", "/run", "/var/lib"]) {
      expect(env.protectedRoots).toContain(p);
    }
  });

  it("file-local words do not ask there; words that reach outside do", () => {
    for (const ok of [
      "Delete",
      "Move to Trash",
      "Remove file",
      "Empty trash",
      "Clear history",
      "Erase",
      "Discard changes",
    ]) {
      expect(asksInSeparateDesktop(ok), ok).toBe(false);
    }
    for (const ask of [
      "Send",
      "Submit order",
      "Purchase",
      "Buy now",
      "Pay",
      "Transfer funds",
      "Delete and send",
      "Unsubscribe",
      "Sign out",
    ]) {
      expect(asksInSeparateDesktop(ask), ask).toBe(true);
    }
    expect(asksInSeparateDesktop(undefined)).toBe(false);
  });

  it("only the owner's paste goes into the desktop; nothing comes out", () => {
    expect(() => assertSeparateDesktopClipboard("paste_into")).not.toThrow();
    expect(() => assertSeparateDesktopClipboard("to_host")).toThrow(/no clipboard/);
    expect(() => assertSeparateDesktopClipboard("from_host")).toThrow(/no clipboard/);
  });

  it("a credential is read only after the approval, typed once, and not kept", async () => {
    const read = vi.fn(async () => "s3cret");
    const type = vi.fn(async () => undefined);
    expect(await fillSeparateDesktopCredential({ approve: async () => false, read, type })).toBe(
      false,
    );
    expect(read).not.toHaveBeenCalled();
    expect(type).not.toHaveBeenCalled();
    expect(await fillSeparateDesktopCredential({ approve: async () => true, read, type })).toBe(
      true,
    );
    expect(type).toHaveBeenCalledTimes(1);
    expect(type).toHaveBeenCalledWith("s3cret");
  });
});
