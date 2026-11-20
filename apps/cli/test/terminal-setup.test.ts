import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PsycheError } from "@psyche/protocol";
import { MockGateway } from "@psyche/web/testing";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.ts";
import { diskEncryptionOf } from "../src/commands/onboard.ts";
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
    expect(err(deps)).toContain("admin CLI connected from this Host itself");
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
