import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  SandboxPc,
  type SandboxPcDeps,
  type SandboxPcState,
} from "../../src/main/sandbox-pc/sandbox-pc.ts";
import {
  assessServiceUpdate,
  compareVersions,
  fileSha256,
  installedServiceExe,
  parseServiceVersion,
  readServiceVersion,
  type ServiceVersion,
} from "../../src/main/sandbox-pc/service-version.ts";
import { serviceUpdateNotice } from "../../src/main/sandbox-pc/wire.ts";

const SID = "S-1-5-21-1111111111-2222222222-3333333333-1001";
const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "psy-svc-update-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("reading a service's version", () => {
  it("parses `psyche-vm-svc version`, treating a service from before the protocol field as 1", () => {
    expect(parseServiceVersion('{"version":"0.2.0","protocol":2,"elevated":false}\r\n')).toEqual({
      version: "0.2.0",
      protocol: 2,
    });
    expect(parseServiceVersion('{"version":"0.1.0","elevated":false}')).toEqual({
      version: "0.1.0",
      protocol: 1,
    });
    for (const bad of ["", "nope", '{"version":3}', '{"version":"1","protocol":0}', "{oops"])
      expect(parseServiceVersion(bad)).toBeNull();
  });

  it("orders dotted versions numerically", () => {
    expect(compareVersions("0.1.0", "0.1.0")).toBe(0);
    expect(compareVersions("0.1.0", "0.2.0")).toBe(-1);
    expect(compareVersions("0.10.0", "0.9.0")).toBe(1);
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
  });

  it("runs the exe and gives null when it cannot", async () => {
    const ok = await readServiceVersion(
      async () => ({ code: 0, stdout: '{"version":"0.3.0","protocol":1}', stderr: "" }),
      "x.exe",
    );
    expect(ok).toEqual({ version: "0.3.0", protocol: 1 });
    expect(
      await readServiceVersion(async () => ({ code: 1, stdout: "", stderr: "" }), "x.exe"),
    ).toBeNull();
    expect(
      await readServiceVersion(async () => {
        throw new Error("spawn failed");
      }, "x.exe"),
    ).toBeNull();
  });

  it("finds the installed copy where `install` puts it, and hashes files", async () => {
    expect(installedServiceExe(SID, { ProgramW6432: "C:\\Program Files" })).toBe(
      join("C:\\Program Files", "Psyche", "vm-service", SID, "psyche-vm-svc.exe"),
    );
    const f = join(tmp(), "a.exe");
    writeFileSync(f, "abc");
    expect(await fileSha256(f)).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(await fileSha256(join(tmp(), "missing.exe"))).toBeNull();
  });
});

describe("is the installed service older?", () => {
  const v = (version: string, protocol = 1): ServiceVersion => ({ version, protocol });
  const assess = (
    installed: ServiceVersion | null,
    bundled: ServiceVersion,
    hashes: [string | null, string | null] = ["a", "b"],
  ) =>
    assessServiceUpdate({
      bundled,
      installed,
      bundledHash: hashes[0],
      installedHash: hashes[1],
    });

  it("is current for the same file, or a newer installed one", () => {
    expect(assess(v("0.1.0"), v("0.1.0"), ["a", "a"]).kind).toBe("current");
    expect(assess(v("0.2.0"), v("0.1.0")).kind).toBe("current");
    expect(assess(v("0.1.0"), v("0.1.0"), [null, null]).kind).toBe("current");
  });

  it("is outdated for an older version, and for the same version but another file", () => {
    expect(assess(v("0.1.0"), v("0.2.0"))).toEqual({
      kind: "outdated",
      installed: "0.1.0",
      bundled: "0.2.0",
      compatible: true,
    });
    expect(assess(v("0.1.0"), v("0.1.0"), ["a", "b"]).kind).toBe("outdated");
  });

  it("calls it incompatible when the protocols differ", () => {
    expect(assess(v("0.1.0", 1), v("1.0.0", 2))).toMatchObject({
      kind: "outdated",
      compatible: false,
    });
  });

  it("offers a refresh when the installed copy is gone, and leaves one that only will not run", () => {
    expect(assess(null, v("0.1.0"), ["a", null])).toMatchObject({
      kind: "outdated",
      installed: "unknown",
      compatible: false,
    });
    expect(assess(null, v("0.1.0"), ["a", "b"]).kind).toBe("current");
  });
});

describe("the app's startup check and the one-click update", () => {
  function setup(o: {
    installed?: ServiceVersion | null;
    bundled?: ServiceVersion | null;
    installedHash?: string;
    probe?: "installed" | "notInstalled" | "unknown";
    elevated?: (
      args: readonly string[],
    ) => Awaited<ReturnType<NonNullable<SandboxPcDeps["runElevated"]>>>;
    requireSignature?: boolean;
    signature?: string;
  }) {
    const root = tmp();
    const bundledExe = join(root, "psyche-vm-svc.exe");
    writeFileSync(bundledExe, "MZ");
    const installedExe = join(root, "installed", "psyche-vm-svc.exe");
    mkdirSync(join(root, "installed"), { recursive: true });
    if (o.installed !== null) writeFileSync(installedExe, "MZ-old");
    let installedVersion: ServiceVersion | null =
      o.installed === undefined ? { version: "0.1.0", protocol: 1 } : o.installed;
    let installedHash = o.installedHash ?? "old";
    const elevated: string[][] = [];
    const states: SandboxPcState[] = [];
    const deps: SandboxPcDeps = {
      platform: "win32",
      ownerSid: () => SID,
      psycheHome: "C:\\Users\\me\\.psyche",
      imagesRoot: join(root, "vm-images"),
      serviceExe: bundledExe,
      requireSignature: o.requireSignature ?? false,
      ...(o.signature ? { signatureOf: async () => o.signature } : {}),
      probeService: async () => o.probe ?? "installed",
      runElevated: async (_e, args) => {
        elevated.push([...args]);
        const res = o.elevated?.(args) ?? { ok: true as const };
        if (res.ok) {
          // The install copied the bundled exe over the old one.
          installedVersion =
            o.bundled === undefined ? { version: "0.2.0", protocol: 1 } : o.bundled;
          installedHash = "new";
        }
        return res;
      },
      installedServiceExe: () => installedExe,
      serviceVersionOf: async (exe) =>
        exe === bundledExe
          ? o.bundled === undefined
            ? { version: "0.2.0", protocol: 1 }
            : o.bundled
          : installedVersion,
      fileHash: async (exe) => (exe === bundledExe ? "new" : installedHash),
      restrictFolder: async () => undefined,
      restartHelper: async () => undefined,
      imageSource: { kind: "http", baseUrl: "https://images.test/" },
      fetch: async () => new Response("nope", { status: 404 }),
      listDir: (d) => {
        try {
          return readdirSync(d);
        } catch {
          return [];
        }
      },
      onState: (s) => states.push(s),
    };
    // A guest image on disk so "ready" is reachable.
    mkdirSync(join(root, "vm-images", "1.0.0"), { recursive: true });
    writeFileSync(join(root, "vm-images", "1.0.0", "manifest.json"), "{}");
    return { pc: new SandboxPc(deps), elevated, states };
  }

  it("notices a newer bundled service at start, without elevating or touching the network", async () => {
    const { pc, elevated } = setup({});
    const s = await pc.check();
    expect(s.serviceUpdate).toEqual({ installed: "0.1.0", bundled: "0.2.0", compatible: true });
    expect(elevated).toEqual([]);
    expect(s.downloadBytes).toBeUndefined();
    expect(serviceUpdateNotice(s)).toMatchObject({
      title: "Update the sandbox PC service",
      route: "/settings/vm",
    });
  });

  it("says nothing when the service is current, not installed, or the check cannot tell", async () => {
    const current = await setup({
      installed: { version: "0.2.0", protocol: 1 },
      installedHash: "new",
    }).pc.check();
    expect(current.serviceUpdate).toBeUndefined();
    expect(serviceUpdateNotice(current)).toBeNull();
    expect((await setup({ probe: "notInstalled" }).pc.check()).serviceUpdate).toBeUndefined();
    expect((await setup({ bundled: null }).pc.check()).serviceUpdate).toBeUndefined();
    // sc.exe could not say: what was known stays.
    const { pc } = setup({});
    await pc.check();
    const unknown = setup({ probe: "unknown" });
    expect((await unknown.pc.check()).serviceUpdate).toBeUndefined();
  });

  it("flags a service whose protocol this build does not speak as needed, not optional", async () => {
    const s = await setup({ bundled: { version: "1.0.0", protocol: 2 } }).pc.check();
    expect(s.serviceUpdate).toMatchObject({ compatible: false });
    expect(serviceUpdateNotice(s)?.body).toContain("won't work until you update");
  });

  it("updates with the same constant elevated install, once, on request", async () => {
    const { pc, elevated, states } = setup({});
    await pc.check();
    expect(elevated).toEqual([]);
    const end = await pc.updateService();
    expect(elevated).toEqual([["install", "--owner-sid", SID, "--home", "C:\\Users\\me\\.psyche"]]);
    expect(end.serviceUpdate).toBeUndefined();
    expect(end).toMatchObject({ phase: "ready", serviceInstalled: true });
    expect(states.map((s) => s.phase)).toContain("updating");
  });

  it("changes nothing and keeps the offer when the prompt is dismissed", async () => {
    const { pc } = setup({
      elevated: () => ({ ok: false, cancelled: true, code: 1223, message: "dismissed" }),
    });
    await pc.check();
    const end = await pc.updateService();
    expect(end.phase).toBe("ready");
    expect(end.message).toContain("one administrator approval");
    expect(end.serviceUpdate).toMatchObject({ installed: "0.1.0" });
  });

  it("does not install an unsigned replacement in a packaged build", async () => {
    const { pc, elevated } = setup({ requireSignature: true, signature: "NotSigned" });
    await pc.check();
    const end = await pc.updateService();
    expect(elevated).toEqual([]);
    expect(end.message).toContain("not signed by Psyche");
  });

  it("has nothing to update when the sandbox PC is not turned on", async () => {
    const { pc, elevated } = setup({ probe: "notInstalled" });
    const end = await pc.updateService();
    expect(elevated).toEqual([]);
    expect(end).toMatchObject({ phase: "off", serviceInstalled: false });
  });
});
