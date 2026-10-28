import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSetting, openDb } from "@psyche/db";
import {
  SRT_SETTING,
  type SrtDeps,
  type SrtInstallDeps,
  type SrtPin,
  tarballUrl,
} from "@psyche/sandbox";
import { afterEach, describe, expect, it } from "vitest";
import { execHostSrtSettings } from "../src/compose/exec-host.ts";
import { composeSandbox } from "../src/compose/sandbox.ts";
import type { ComposeServices } from "../src/compose/services.ts";
import { createSrtResolver } from "../src/compose/srt.ts";
import { methodPresence } from "../src/presence-gate.ts";

const BODY = Buffer.from("fake tarball");
const PINS: SrtPin[] = [
  {
    name: "@anthropic-ai/sandbox-runtime",
    version: "9.9.9",
    integrity: `sha512-${createHash("sha512").update(BODY).digest("base64")}`,
  },
];

/** A fake registry: serves `body` at the pinned tarball URL only. */
function registry(body: Buffer): SrtInstallDeps {
  return {
    fetch: (async (url: string) =>
      url === tarballUrl(PINS[0] as SrtPin)
        ? new Response(body)
        : new Response("", { status: 404 })) as unknown as typeof fetch,
    async extract(_t, dest) {
      await mkdir(join(dest, "dist"), { recursive: true });
      await writeFile(join(dest, "dist", "cli.js"), "//");
    },
  };
}

let home: string;
afterEach(async () => {
  if (home) await rm(home, { recursive: true, force: true });
});

async function setup(deps: SrtInstallDeps) {
  home = await mkdtemp(join(tmpdir(), "psyche-gw-srt-"));
  const db = openDb(":memory:");
  const events: unknown[] = [];
  const logs: { msg: string; fields?: Record<string, unknown> }[] = [];
  const services = {
    db,
    home,
    logger: {
      log: (_l: string, msg: string, fields?: Record<string, unknown>) =>
        logs.push({ msg, fields }),
    },
  } as unknown as ComposeServices;
  // Executable-ness comes from the disk (the launcher the installer wrote); no srt runs.
  const srtDeps: SrtDeps = {
    isExecutable: async (p) => (await import("node:fs")).existsSync(p),
    searchDirs: () => [],
    version: async () => "srt-fake",
  };
  const srt = createSrtResolver({ db }, {}, srtDeps);
  const part = composeSandbox(services, {
    exec: false,
    srt,
    srtInstall: { deps, nodePath: "/App/runtime/node", pins: PINS },
  });
  const call = {
    identity: { deviceId: "dev_1" },
    emit: (_e: string, p: unknown) => events.push(p),
  };
  const install = () => part.handlers?.["sandbox.installSrt"]?.run(call as never, {} as never);
  return { part, db, srt, events, logs, install };
}

describe("sandbox.installSrt", () => {
  it("fails closed on an integrity mismatch: no setting, no files, a warning logged", async () => {
    const t = await setup(registry(Buffer.from("tampered")));
    await expect(t.install()).rejects.toMatchObject({
      message: expect.stringContaining("integrity"),
    });
    expect(getSetting(t.db, SRT_SETTING)).toBeUndefined();
    expect((await t.srt.inspect()).available).toBe(false);
    expect(t.logs.map((l) => l.msg)).toContain("sandbox.srt.install.failed");
    await t.part.stop?.();
  });

  it("success writes exec.srtPath, logs a receipt, and the resolver then finds it", async () => {
    const t = await setup(registry(BODY));
    expect((await t.srt.inspect()).available).toBe(false);
    const r = (await t.install()) as {
      srt: { available: boolean; path: string; source: string };
      installer: { installedVersion: string };
    };
    const expected = join(home, "tools", "srt", "9.9.9", "bin", "srt");
    expect(getSetting(t.db, SRT_SETTING)?.value).toBe(expected);
    expect(t.events).toHaveLength(1);
    expect(r.srt).toMatchObject({ available: true, path: expected, source: "setting" });
    expect(r.installer.installedVersion).toBe("9.9.9");
    // The resolver is live: a fresh lookup (no PATH, no env) finds it.
    expect(await t.srt.resolve()).toEqual({ path: expected });
    const receipt = t.logs.find((l) => l.msg === "sandbox.srt.install.receipt");
    expect(receipt?.fields).toMatchObject({ path: expected, node: "/App/runtime/node" });
    expect(String(receipt?.fields?.tarballs)).toContain(
      "https://registry.npmjs.org/@anthropic-ai/sandbox-runtime/-/sandbox-runtime-9.9.9.tgz#sha512-",
    );
    // sandbox.setup then reports what is installed and that this Psyche pins another version.
    const setupRes = (await t.part.handlers?.["sandbox.setup"]?.run({} as never, {} as never)) as {
      installer: { installedVersion: string; updateAvailable: boolean };
    };
    expect(setupRes.installer).toMatchObject({ installedVersion: "9.9.9", updateAvailable: true });
    await t.part.stop?.();
  });
});

describe("presence and the srt deny profile", () => {
  it("the install needs fresh presence like any security change", () => {
    expect(methodPresence("sandbox.installSrt", {})?.action.summary).toMatch(/Install srt/);
  });

  it("sandboxed processes cannot write the tools folder, and may only read it", () => {
    const s = execHostSrtSettings({
      psycheHome: "/u/.psyche",
      userHome: "/u",
      scratch: "/tmp/s",
      writable: [],
      allowedDomains: [],
    }) as { filesystem: { denyWrite: string[]; denyRead: string[]; allowWrite: string[] } };
    // denyWrite on Psyche home covers tools/ beneath it; nothing re-allows it.
    expect(s.filesystem.denyWrite).toContain("/u/.psyche");
    expect(s.filesystem.allowWrite).not.toContain("/u/.psyche/tools");
    expect(s.filesystem.denyRead).not.toContain("/u/.psyche/tools");
  });
});
