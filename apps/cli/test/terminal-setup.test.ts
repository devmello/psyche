import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PsycheError } from "@psyche/protocol";
import { MockGateway } from "@psyche/web/testing";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.ts";
import { diskEncryptionOf } from "../src/commands/onboard.ts";
import { approvalWait, callWithApproval } from "../src/commands/util.ts";
import { Ctx, isOwnGatewayUrl } from "../src/context.ts";
import { HANDLERS } from "./fixtures.ts";
import { cleanupTempDirs, err, makeDeps, out, runJson, type TestDeps } from "./helpers.ts";

const ALL_SCOPES = ["operator.read", "operator.write", "operator.approvals", "operator.admin"];
const running: MockGateway[] = [];
let gw: MockGateway;
let lanSetting: unknown;

async function start(extra: Record<string, (params: unknown) => unknown> = {}) {
  lanSetting = undefined;
  gw = await new MockGateway({
    pair: { phase: "paired", scopes: ALL_SCOPES },
    handlers: {
      ...HANDLERS,
      "settings.get": () => ({
        settings: lanSetting === undefined ? {} : { "gateway.lan": lanSetting },
      }),
      "settings.set": (p: unknown) => {
        lanSetting = (p as { value: unknown }).value;
        return { entry: { key: "gateway.lan", value: lanSetting } };
      },
      "gateway.info": () => ({ lan: { enabled: true, origin: "https://lab-box.local:7777" } }),
      "devices.setupToken.create": (p: unknown) => ({
        link: "psyche-pair:v1:TESTLINK",
        version: (p as { via?: string }).via === "lan" ? 2 : 1,
        gatewayUrl: "https://lab-box.tail1234.ts.net",
        setupToken: {
          id: "tok1",
          expiresAt: "2026-10-19T12:10:00.000Z",
          scopes: (p as { scopes: string[] }).scopes,
        },
      }),
      ...extra,
    } as never,
  }).start();
  running.push(gw);
}

afterEach(async () => {
  for (const g of running.splice(0)) await g.stop();
  cleanupTempDirs();
});

const urlArgs = (deps: TestDeps) => ["--url", gw.origin, "--home", deps.home];
const callsTo = (m: string) => gw.calls.filter((c) => c.method === m);

describe("psyche devices link", () => {
  it("asks for the default scopes, prints the link and the single-use ten-minute terms", async () => {
    await start();
    const deps = makeDeps();
    expect(await run(["devices", "link", ...urlArgs(deps)], deps)).toBe(0);
    expect(callsTo("devices.setupToken.create")[0]?.params).toEqual({
      scopes: ["operator.read", "operator.write", "operator.approvals"],
    });
    expect(out(deps)).toContain("psyche-pair:v1:TESTLINK");
    expect(out(deps)).toContain("Single use");
  });

  it("--admin adds operator.admin and --lan asks for a v2 link", async () => {
    await start();
    const deps = makeDeps();
    const { code, json } = await runJson(
      ["devices", "link", "--admin", "--lan", ...urlArgs(deps)],
      deps,
    );
    expect(code).toBe(0);
    expect(callsTo("devices.setupToken.create")[0]?.params).toEqual({
      scopes: ["operator.read", "operator.write", "operator.approvals", "operator.admin"],
      via: "lan",
    });
    expect(json).toMatchObject({ version: 2 });
  });

  it("explains a refusal instead of showing a raw forbidden", async () => {
    await start({
      "devices.setupToken.create": () => {
        throw new PsycheError(
          "forbidden",
          "Only Psyche on the Host itself can make a pairing link",
        );
      },
    });
    const deps = makeDeps();
    expect(await run(["devices", "link", ...urlArgs(deps)], deps)).toBe(1);
    expect(err(deps)).toContain("admin CLI on the Host");
  });

  it("rejects an unknown scope before calling the Gateway", async () => {
    await start();
    const deps = makeDeps();
    expect(await run(["devices", "link", "--scopes", "root", ...urlArgs(deps)], deps)).toBe(2);
    expect(callsTo("devices.setupToken.create")).toHaveLength(0);
  });
});

describe("psyche lan on", () => {
  it("turns on one interface and keeps the stored port and ipv6 choice", async () => {
    await start();
    lanSetting = { enabled: false, interfaces: ["old0"], port: 9000, ipv6: true };
    const deps = makeDeps();
    expect(await run(["lan", "on", "--interface", "eth0", ...urlArgs(deps)], deps)).toBe(0);
    expect(lanSetting).toEqual({ enabled: true, interfaces: ["eth0"], port: 9000, ipv6: true });
    expect(out(deps)).toContain("https://lab-box.local:7777");
  });

  it("never sends a wildcard: no interface means the stored one, or the primary (empty)", async () => {
    await start();
    const deps = makeDeps();
    expect(await run(["lan", "on", ...urlArgs(deps)], deps)).toBe(0);
    expect(lanSetting).toEqual({ enabled: true, interfaces: [] });
  });
});

describe("psyche setup", () => {
  const lsblk = (encrypted: boolean) =>
    JSON.stringify({
      blockdevices: [
        encrypted
          ? { type: "crypt", mountpoint: "/", children: [{ type: "part", mountpoint: null }] }
          : { type: "part", mountpoint: "/", children: [{ type: "disk", mountpoint: null }] },
      ],
    });

  function setupDeps(opts: { encrypted: boolean; linger: string }) {
    return makeDeps({
      platform: "linux",
      extraEnv: { USER: "lab" },
      execScript: (cmd) => {
        if (cmd === "loginctl") return { stdout: opts.linger };
        if (cmd === "lsblk") return { stdout: lsblk(opts.encrypted) };
        return undefined;
      },
    });
  }
  const base = ["setup", "--yes", "--provider", "skip"];

  it("writes publicOrigin, hints Tailscale Serve, warns about linger and an unencrypted disk", async () => {
    await start();
    const deps = setupDeps({ encrypted: false, linger: "no\n" });
    const { code, json } = await runJson(
      [...base, "--public-origin", "https://lab-box.tail1234.ts.net/", ...urlArgs(deps)],
      deps,
    );
    expect(code).toBe(0);
    const config = JSON.parse(readFileSync(join(deps.home, "config.json"), "utf8"));
    expect(config.gateway.publicOrigin).toBe("https://lab-box.tail1234.ts.net");
    const steps = (json.steps as { step: string; status: string; detail?: string }[]).reduce(
      (m, s) => ({ ...m, [s.step]: s }),
      {} as Record<string, { status: string; detail?: string }>,
    );
    expect(steps.tailscale?.detail).toContain("tailscale serve --bg --https=443");
    expect(steps.linger).toMatchObject({ status: "pending" });
    expect(steps.linger?.detail).toContain("loginctl enable-linger lab");
    expect(steps.disk).toMatchObject({ status: "pending" });
    expect(steps.disk?.detail).toContain("not encrypted");
    expect(steps.lan).toMatchObject({ status: "skipped" });
    // setup never runs those commands itself
    expect(deps.execCalls.map((c) => c.cmd)).not.toContain("tailscale");
    expect(deps.execCalls.some((c) => c.args.includes("enable-linger"))).toBe(false);
  });

  it("reports linger and an encrypted disk as done, and turns LAN on with --lan", async () => {
    await start();
    const deps = setupDeps({ encrypted: true, linger: "yes\n" });
    const { code, json } = await runJson(
      [...base, "--lan", "--interface", "eth0", ...urlArgs(deps)],
      deps,
    );
    expect(code).toBe(0);
    const byStep = Object.fromEntries(
      (json.steps as { step: string; status: string }[]).map((s) => [s.step, s.status]),
    );
    expect(byStep).toMatchObject({ linger: "done", disk: "done", lan: "done" });
    expect(lanSetting).toMatchObject({ enabled: true, interfaces: ["eth0"] });
  });

  it("refuses a public origin that is not https or has a path, writing nothing", async () => {
    await start();
    for (const bad of ["http://lab-box:7777", "https://lab-box.example/app", "nonsense"]) {
      const deps = setupDeps({ encrypted: true, linger: "yes" });
      expect(await run([...base, "--public-origin", bad, ...urlArgs(deps)], deps)).toBe(2);
    }
  });
});

describe("approval cards (a plain tap on a paired device)", () => {
  let created: Record<string, unknown>[];
  let statuses: string[];

  /** The Gateway asks for a card on the first call and accepts the retry that carries its id. */
  async function startWithCard(method: string, ok: () => unknown) {
    created = [];
    statuses = [];
    await start({
      [method]: (p: unknown) => {
        const params = p as Record<string, unknown>;
        created.push(params);
        if (params.approvalId !== "card-1") {
          throw new PsycheError("approval_required", "needs your approval", {
            details: { approvalId: "card-1" },
          });
        }
        return ok();
      },
      "approvals.get": () => ({
        approval: { id: "card-1", status: statuses.shift() ?? "pending" },
      }),
    });
  }
  const fast = () => Object.assign(approvalWait, { timeoutMs: 400, firstPollMs: 5, maxPollMs: 10 });
  const linkOk = () => ({
    link: "psyche-pair:v1:AFTERCARD",
    version: 1,
    gatewayUrl: "https://lab-box.tail1234.ts.net",
    setupToken: { id: "t", expiresAt: "2026-10-19T12:10:00.000Z", scopes: ["operator.read"] },
  });

  afterEach(() =>
    Object.assign(approvalWait, { timeoutMs: 10 * 60_000, firstPollMs: 1000, maxPollMs: 5000 }),
  );

  it("devices link: says what to do, waits for the tap, then retries with the approvalId", async () => {
    fast();
    await startWithCard("devices.setupToken.create", linkOk);
    statuses = ["pending", "pending", "approved"];
    const deps = makeDeps();
    expect(await run(["devices", "link", ...urlArgs(deps)], deps)).toBe(0);
    expect(err(deps)).toContain("Approve this on your paired phone or desktop");
    expect(out(deps)).toContain("psyche-pair:v1:AFTERCARD");
    expect(created).toHaveLength(2);
    expect(created[0]?.approvalId).toBeUndefined();
    expect(created[1]).toMatchObject({ approvalId: "card-1", scopes: created[0]?.scopes });
    expect(callsTo("approvals.get")).toHaveLength(3);
  });

  it("lan on: the same flow for settings.set gateway.lan", async () => {
    fast();
    await startWithCard("settings.set", () => ({ entry: {} }));
    statuses = ["approved"];
    const deps = makeDeps();
    expect(await run(["lan", "on", "--interface", "eth0", ...urlArgs(deps)], deps)).toBe(0);
    expect(err(deps)).toContain("Approve this on your paired phone or desktop");
    expect(created.at(-1)).toMatchObject({ approvalId: "card-1", key: "gateway.lan" });
  });

  it.each(["denied", "expired", "invalidated"])(
    "a %s card ends non-zero and never retries",
    async (status) => {
      fast();
      await startWithCard("devices.setupToken.create", linkOk);
      statuses = ["pending", status];
      const deps = makeDeps();
      expect(await run(["devices", "link", ...urlArgs(deps)], deps)).toBe(1);
      expect(err(deps)).toContain(`The approval was ${status}`);
      expect(created).toHaveLength(1);
      expect(out(deps)).not.toContain("psyche-pair");
    },
  );

  it("times out when nobody taps, and changes nothing", async () => {
    fast();
    Object.assign(approvalWait, { timeoutMs: 60 });
    await startWithCard("devices.setupToken.create", linkOk);
    const deps = makeDeps();
    expect(await run(["devices", "link", ...urlArgs(deps)], deps)).toBe(1);
    expect(err(deps)).toContain("Timed out waiting for the approval");
    expect(created).toHaveLength(1);
  });

  it("is generic: any method that answers approval_required is waited for and retried", async () => {
    fast();
    created = [];
    statuses = ["approved"];
    await start({
      "devices.revoke": (p: unknown) => {
        const params = p as Record<string, unknown>;
        created.push(params);
        if (params.approvalId === undefined) {
          throw new PsycheError("approval_required", "x", { details: { approvalId: "card-1" } });
        }
        return { device: { id: "d" } };
      },
      "approvals.get": () => ({
        approval: { id: "card-1", status: statuses.shift() ?? "pending" },
      }),
    });
    const client = await new Ctx(makeDeps(), {
      json: false,
      url: gw.origin,
      insecure: false,
      timeoutMs: 5000,
    }).gateway();
    const said: string[] = [];
    await callWithApproval(client, "devices.revoke", { deviceId: "d" }, (t) => said.push(t));
    expect(created.map((c) => c.approvalId)).toEqual([undefined, "card-1"]);
    expect(said).toHaveLength(1);
    client.close();
  });
});

describe("presence_required explains the matching recovery command", () => {
  it.each([
    ["no_presence_verifier", "psyched presence reset"],
    ["state_untrusted", "psyched security reseal"],
  ])("%s", async (reason, command) => {
    await start({
      "devices.setupToken.create": () => {
        throw new PsycheError("presence_required", "nothing can verify", { details: { reason } });
      },
    });
    const deps = makeDeps();
    expect(await run(["devices", "link", ...urlArgs(deps)], deps)).toBe(1);
    expect(err(deps)).toContain(command);
    expect(err(deps)).not.toContain("Touch ID or a passkey first");
  });
});

describe("the Host secret", () => {
  const SECRET = "launch-secret";
  /** A home as a running Gateway leaves it: the secret and, unless `listen` is null, listen.json. */
  const homeWith = (listen: string[] | null) => {
    const deps = makeDeps();
    mkdirSync(join(deps.home, "run"), { recursive: true });
    writeFileSync(join(deps.home, "run", "handshake.secret"), `${SECRET}\n`);
    if (listen !== null) {
      writeFileSync(join(deps.home, "run", "listen.json"), JSON.stringify({ origins: listen }));
    }
    return deps;
  };
  const listDevices = (deps: TestDeps) => run(["devices", "list", ...urlArgs(deps)], deps);
  const sent = () => gw.connects.at(-1)?.handshakeSecret;

  it("is sent when the URL is exactly an origin the Gateway says it is bound to", async () => {
    await start();
    expect(await listDevices(homeWith([gw.origin]))).toBe(0);
    expect(gw.connects.at(-1)).toMatchObject({ deviceFamily: "cli", handshakeSecret: SECRET });
  });

  it("is not sent to a port the Gateway is not bound to (even a loopback one)", async () => {
    await start();
    const port = new URL(gw.origin).port;
    const other = `http://127.0.0.1:${Number(port) + 1}`;
    expect(await listDevices(homeWith([other]))).toBe(0);
    expect(sent()).toBeUndefined();
  });

  it("is not sent when listen.json is missing (no Gateway running here, or an old one)", async () => {
    await start();
    expect(await listDevices(homeWith(null))).toBe(0);
    expect(sent()).toBeUndefined();
  });

  it("is not sent for localhost, even when the Gateway is on 127.0.0.1 at that port", async () => {
    await start();
    const url = new URL(gw.origin);
    const deps = homeWith([gw.origin]);
    expect(
      await run(
        ["devices", "list", "--url", `http://localhost:${url.port}`, "--home", deps.home],
        deps,
      ),
    ).toBe(0);
    expect(sent()).toBeUndefined();
  });

  it("is not sent when the file lists a different host than the URL", async () => {
    await start();
    const deps = homeWith([`http://[::1]:${new URL(gw.origin).port}`]);
    expect(await listDevices(deps)).toBe(0);
    expect(sent()).toBeUndefined();
  });

  it("is not sent when listen.json is unreadable or malformed", async () => {
    await start();
    for (const bad of ["not json", JSON.stringify({ origins: "x" }), JSON.stringify({})]) {
      const deps = homeWith(null);
      writeFileSync(join(deps.home, "run", "listen.json"), bad);
      expect(await listDevices(deps)).toBe(0);
      expect(sent()).toBeUndefined();
    }
  });

  it("isOwnGatewayUrl: scheme, host and port must equal a listed origin exactly", () => {
    const deps = homeWith(["http://127.0.0.1:7979", "http://[::1]:8000"]);
    for (const [url, want] of [
      ["http://127.0.0.1:7979", true],
      ["http://[::1]:8000", true],
      ["http://[::1]:7979", false],
      ["http://127.0.0.1:8000", false],
      ["http://127.0.0.1:7980", false],
      ["http://localhost:7979", false],
      ["https://127.0.0.1:7979", false],
      ["http://gateway.example:7979", false],
      ["http://100.64.0.9:7979", false],
    ] as const) {
      expect([url, isOwnGatewayUrl(new URL(url), deps.home)]).toEqual([url, want]);
    }
  });
});

describe("the disk check", () => {
  it.each([
    ["luks root", { blockdevices: [{ type: "crypt", mountpoint: "/" }] }, "/home/a", "encrypted"],
    [
      "luks under lvm",
      { blockdevices: [{ type: "lvm", mountpoint: "/", children: [{ type: "crypt" }] }] },
      "/home/a",
      "encrypted",
    ],
    [
      "plain root",
      { blockdevices: [{ type: "part", mountpoint: "/" }] },
      "/home/a",
      "not_encrypted",
    ],
    [
      "encrypted /home on a plain root",
      {
        blockdevices: [
          { type: "part", mountpoint: "/" },
          { type: "crypt", mountpoint: "/home" },
        ],
      },
      "/home/a",
      "encrypted",
    ],
    ["no mounts", { blockdevices: [] }, "/home/a", "unknown"],
  ])("%s", (_n, tree, home, want) => {
    expect(diskEncryptionOf(JSON.stringify(tree), home)).toBe(want);
  });
  it("unparseable output is unknown", () => {
    expect(diskEncryptionOf("not json", "/home/a")).toBe("unknown");
  });
});
