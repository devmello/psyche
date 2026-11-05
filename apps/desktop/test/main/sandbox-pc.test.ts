import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import {
  checkElevatedArg,
  ELEVATE_SCRIPT,
  ELEVATION_CANCELLED,
  runElevated,
} from "../../src/main/sandbox-pc/elevate.ts";
import {
  downloadImage,
  type GuestImageManifest,
  ImageError,
  imageSizes,
  installedImageVersion,
  parseManifest,
} from "../../src/main/sandbox-pc/image.ts";
import {
  SandboxPc,
  type SandboxPcDeps,
  type SandboxPcState,
  serviceNameFor,
} from "../../src/main/sandbox-pc/sandbox-pc.ts";
import { probeService, serviceExeFor } from "../../src/main/sandbox-pc/wire.ts";
import { removalNote, squirrelPlan, vmServiceExe } from "../../src/main/squirrel-events.ts";

const SID = "S-1-5-21-1111111111-2222222222-3333333333-1001";
const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "psy-sandbox-pc-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** A fake guest image: three small files, each served zstd-compressed. */
function fakeImage(corrupt?: string) {
  const content: Record<string, Buffer> = {
    vmlinuz: Buffer.from("kernel".repeat(100)),
    initrd: Buffer.from("initrd".repeat(100)),
    "rootfs.vhdx": Buffer.from("rootfs".repeat(5000)),
  };
  const wire: Record<string, Buffer> = {};
  const files = Object.entries(content).map(([name, data]) => {
    const z = zstdCompressSync(data);
    wire[`https://images.test/${name}.zst`] =
      name === corrupt ? Buffer.from(z.subarray(0, z.length - 1)) : z;
    return {
      name,
      url: `https://images.test/${name}.zst`,
      bytes: data.length,
      sha256: sha(data),
      compressed: { codec: "zstd", bytes: z.length, sha256: sha(z) },
    };
  });
  const manifest = {
    format: "psyche-windows-guest-image",
    formatVersion: 1,
    imageVersion: "2026.11.1",
    guestOS: "Debian 13",
    arch: "x64",
    files,
  };
  const text = JSON.stringify(manifest);
  const fetchFake: typeof fetch = async (input) => {
    const url = String(input);
    if (url === "https://images.test/manifest.json") return new Response(text);
    const body = wire[url];
    return body ? new Response(new Uint8Array(body)) : new Response("nope", { status: 404 });
  };
  return { manifest: manifest as GuestImageManifest, text, fetch: fetchFake, content };
}

describe("the guest image manifest", () => {
  it("accepts the published shape and sizes the download", () => {
    const f = fakeImage();
    const m = parseManifest(f.text);
    expect(m.files.map((x) => x.name)).toEqual(["vmlinuz", "initrd", "rootfs.vhdx"]);
    const s = imageSizes(m);
    expect(s.disk).toBe(600 + 600 + 30000);
    expect(s.download).toBeLessThan(s.disk);
  });

  it("refuses anything that could write elsewhere or fetch insecurely", () => {
    const base = JSON.parse(fakeImage().text);
    const bad = (patch: (m: typeof base) => void) => {
      const m = structuredClone(base);
      patch(m);
      expect(() => parseManifest(JSON.stringify(m))).toThrow(ImageError);
    };
    bad((m) => {
      m.files[0].name = "..\\evil.dll";
    });
    bad((m) => {
      m.files[0].url = "http://images.test/vmlinuz.zst";
    });
    bad((m) => {
      m.files[0].sha256 = "ABC";
    });
    bad((m) => {
      m.imageVersion = "..\\..\\Windows";
    });
    bad((m) => {
      m.files.pop();
    });
    bad((m) => {
      m.files.push(structuredClone(m.files[0]));
    });
    bad((m) => {
      m.format = "other";
    });
    expect(() => parseManifest("not json")).toThrow(ImageError);
  });
});

describe("downloading the guest image", () => {
  it("downloads, unpacks and verifies every file, writes the manifest last, reports progress", async () => {
    const f = fakeImage();
    const dir = join(tmp(), "2026.11.1");
    const seen: number[] = [];
    await downloadImage(parseManifest(f.text), f.text, {
      dir,
      fetch: f.fetch,
      freeBytes: () => 10 * 1024 ** 3,
      onProgress: (p) => seen.push(p.receivedBytes),
    });
    for (const [name, data] of Object.entries(f.content)) {
      expect(readFileSync(join(dir, name)).equals(data)).toBe(true);
      expect(existsSync(join(dir, `${name}.part`))).toBe(false);
    }
    expect(readFileSync(join(dir, "manifest.json"), "utf8")).toBe(f.text);
    expect(seen.at(-1)).toBe(imageSizes(parseManifest(f.text)).download);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(installedImageVersion(join(dir, ".."), readdirSync)).toBe("2026.11.1");
  });

  it("discards a file whose checksum does not match, and keeps no manifest", async () => {
    const f = fakeImage();
    const m = parseManifest(f.text);
    (m.files[1] as { sha256: string }).sha256 = "0".repeat(64);
    const dir = join(tmp(), "v");
    await expect(
      downloadImage(m, f.text, { dir, fetch: f.fetch, freeBytes: () => 10 * 1024 ** 3 }),
    ).rejects.toMatchObject({ reason: "digest_mismatch" });
    expect(existsSync(join(dir, "initrd"))).toBe(false);
    expect(existsSync(join(dir, "initrd.part"))).toBe(false);
    expect(existsSync(join(dir, "manifest.json"))).toBe(false);
  });

  it("fails on a truncated download and on a server error", async () => {
    const dir = tmp();
    const f = fakeImage("initrd");
    await expect(
      downloadImage(parseManifest(f.text), f.text, {
        dir,
        fetch: f.fetch,
        freeBytes: () => 10 * 1024 ** 3,
      }),
    ).rejects.toBeInstanceOf(ImageError);
    await expect(
      downloadImage(parseManifest(f.text), f.text, {
        dir: tmp(),
        fetch: async () => new Response("x", { status: 503 }),
        freeBytes: () => 10 * 1024 ** 3,
      }),
    ).rejects.toMatchObject({ reason: "download_failed" });
  });

  it("checks free space first and resumes with files already verified", async () => {
    const f = fakeImage();
    const m = parseManifest(f.text);
    await expect(
      downloadImage(m, f.text, { dir: tmp(), fetch: f.fetch, freeBytes: () => 1000 }),
    ).rejects.toMatchObject({ reason: "no_space" });
    const dir = join(tmp(), "v");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "vmlinuz"), f.content.vmlinuz as Buffer);
    let fetched = 0;
    await downloadImage(m, f.text, {
      dir,
      freeBytes: () => 10 * 1024 ** 3,
      fetch: (...a) => {
        fetched++;
        return f.fetch(...a);
      },
    });
    expect(fetched).toBe(2);
  });

  it("stops on cancel", async () => {
    const f = fakeImage();
    const ac = new AbortController();
    ac.abort();
    await expect(
      downloadImage(parseManifest(f.text), f.text, {
        dir: tmp(),
        fetch: f.fetch,
        signal: ac.signal,
        freeBytes: () => 10 * 1024 ** 3,
      }),
    ).rejects.toMatchObject({ reason: "cancelled" });
  });
});

describe("running one program elevated", () => {
  it("passes the program and arguments in the environment, never in the command", async () => {
    const calls: { file: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const res = await runElevated(
      "C:\\Program Files\\Psyche\\psyche-vm-svc.exe",
      ["install", "--owner-sid", SID, "--home", "C:\\Users\\me\\.psyche"],
      {
        systemRoot: "C:\\Windows",
        env: {},
        start: async (file, args, env) => {
          calls.push({ file, args, env });
          return 0;
        },
      },
    );
    expect(res).toEqual({ ok: true });
    const c = calls[0] as (typeof calls)[number];
    expect(c.file).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(c.args).toEqual(["-NoProfile", "-NonInteractive", "-Command", ELEVATE_SCRIPT]);
    // Nothing the caller passed appears in the command text.
    expect(ELEVATE_SCRIPT).not.toContain(SID);
    expect(ELEVATE_SCRIPT).not.toContain("psyche-vm-svc");
    expect(ELEVATE_SCRIPT).toContain("-Verb RunAs");
    expect(c.env.PSYCHE_ELEV_EXE).toBe("C:\\Program Files\\Psyche\\psyche-vm-svc.exe");
    expect(JSON.parse(c.env.PSYCHE_ELEV_ARGS as string)).toEqual([
      "install",
      "--owner-sid",
      SID,
      "--home",
      "C:\\Users\\me\\.psyche",
    ]);
  });

  it("tells a dismissed prompt from a failed install", async () => {
    const run = (code: number | null) =>
      runElevated("x.exe", ["install"], { start: async () => code });
    expect(await run(ELEVATION_CANCELLED)).toMatchObject({ ok: false, cancelled: true });
    expect(await run(2)).toMatchObject({ ok: false, cancelled: false, code: 2 });
    expect(await run(null)).toMatchObject({ ok: false, cancelled: false, code: null });
  });

  it("refuses arguments that cannot be quoted safely", () => {
    expect(() => checkElevatedArg('a" -Verb')).toThrow();
    expect(() => checkElevatedArg("C:\\dir\\")).toThrow();
    expect(() => checkElevatedArg("line\nbreak")).toThrow();
    expect(() => checkElevatedArg("")).toThrow();
    expect(checkElevatedArg("C:\\Users\\me\\.psyche")).toBe("C:\\Users\\me\\.psyche");
  });
});

describe("turning the sandbox PC on", () => {
  function setup(over: Partial<SandboxPcDeps> & { installed?: boolean } = {}) {
    const root = tmp();
    const exe = join(root, "psyche-vm-svc.exe");
    writeFileSync(exe, "MZ");
    const f = fakeImage();
    const states: SandboxPcState[] = [];
    const log: string[] = [];
    let installed = over.installed ?? false;
    const deps: SandboxPcDeps = {
      platform: "win32",
      ownerSid: () => SID,
      psycheHome: "C:\\Users\\me\\.psyche",
      imagesRoot: join(root, "vm-images"),
      serviceExe: exe,
      requireSignature: false,
      probeService: async () => (installed ? "installed" : "notInstalled"),
      runElevated: async (e, args) => {
        log.push(`elevated ${e === exe ? "svc" : e} ${args.join(" ")}`);
        installed = true;
        return { ok: true };
      },
      restrictFolder: async (dir, sid) => {
        mkdirSync(dir, { recursive: true });
        log.push(`acl ${sid}`);
      },
      restartHelper: async () => void log.push("restart helper"),
      manifestUrl: "https://images.test/manifest.json",
      fetch: f.fetch,
      listDir: (d) => (existsSync(d) ? readdirSync(d) : []),
      freeBytes: () => 10 * 1024 ** 3,
      onState: (s) => states.push(s),
      ...over,
    };
    return { pc: new SandboxPc(deps), states, log, exe };
  }

  it("is unsupported where there is no service to install", () => {
    expect(setup({ platform: "darwin" }).pc.getState()).toMatchObject({ phase: "unsupported" });
    expect(setup({ serviceExe: undefined }).pc.getState()).toMatchObject({
      phase: "unsupported",
      message: expect.stringContaining("no sandbox PC service"),
    });
  });

  it("installs the service with the account's SID and home, restarts the helper, downloads the image", async () => {
    const { pc, states, log, exe } = setup();
    const end = await pc.turnOn();
    expect(end).toMatchObject({
      phase: "ready",
      serviceInstalled: true,
      imageVersion: "2026.11.1",
    });
    expect(log).toEqual([
      `elevated svc install --owner-sid ${SID} --home C:\\Users\\me\\.psyche`,
      "restart helper",
      `acl ${SID}`,
    ]);
    expect(exe).toContain("psyche-vm-svc.exe");
    expect(states.map((s) => s.phase)).toContain("installing");
    expect(states.map((s) => s.phase)).toContain("restarting");
    const dl = states.filter((s) => s.phase === "downloading");
    expect(dl.length).toBeGreaterThan(0);
    expect(dl.at(-1)?.download?.receivedBytes).toBe(dl.at(-1)?.download?.totalBytes);
    expect(dl[0]?.downloadBytes).toBeGreaterThan(0);
    // Idempotent: a second turn-on needs no prompt and no download.
    log.length = 0;
    expect(await pc.turnOn()).toMatchObject({ phase: "ready" });
    expect(log).toEqual([]);
  });

  it("changes nothing when the administrator prompt is dismissed", async () => {
    const { pc, log } = setup({
      runElevated: async () => ({
        ok: false,
        cancelled: true,
        code: 1223,
        message: "The administrator prompt was dismissed",
      }),
    });
    const end = await pc.turnOn();
    expect(end).toMatchObject({ phase: "failed", serviceInstalled: false });
    expect(end.message).toContain("one administrator approval");
    expect(log).toEqual([]);
    expect(pc.getState().imageVersion).toBeNull();
  });

  it("does not install an unsigned service in a packaged build", async () => {
    const { pc, log } = setup({
      requireSignature: true,
      signatureOf: async () => "NotSigned",
    });
    expect(await pc.turnOn()).toMatchObject({ phase: "failed" });
    expect(log).toEqual([]);
  });

  it("reports a failed download and can be tried again", async () => {
    let up = false;
    const f = fakeImage();
    const { pc } = setup({
      installed: true,
      fetch: async (input, init) => {
        const url = String(input);
        if (!up && url.endsWith(".zst")) return new Response("x", { status: 500 });
        return f.fetch(input, init);
      },
    });
    expect(await pc.turnOn()).toMatchObject({ phase: "failed", serviceInstalled: true });
    up = true;
    expect(await pc.turnOn()).toMatchObject({ phase: "ready", imageVersion: "2026.11.1" });
  });

  it("refresh reads the install and the published size without installing anything", async () => {
    const { pc, log } = setup({ installed: true });
    const s = await pc.refresh();
    expect(s).toMatchObject({ phase: "off", serviceInstalled: true, imageVersion: null });
    expect(s.downloadBytes).toBeGreaterThan(0);
    expect(log).toEqual([]);
  });
});

describe("where the service is", () => {
  it("is next to the helper in the packaged resources, else the repo's Rust build", () => {
    expect(
      serviceExeFor({
        platform: "win32",
        packaged: true,
        resourcesPath: "C:\\P\\resources",
        appPath: "x",
        exists: () => false,
      }),
    ).toBe(join("C:\\P\\resources", "win-helper", "psyche-vm-svc.exe"));
    const desktop = join("D:\\repo", "apps", "desktop");
    const release = join(desktop, "..", "win-helper", "target", "release", "psyche-vm-svc.exe");
    expect(
      serviceExeFor({
        platform: "win32",
        packaged: false,
        resourcesPath: "x",
        appPath: desktop,
        exists: (p) => p === release,
      }),
    ).toBe(release);
    expect(
      serviceExeFor({
        platform: "darwin",
        packaged: true,
        resourcesPath: "/R",
        appPath: "/A",
        exists: () => true,
      }),
    ).toBeUndefined();
  });

  it("is installed unless sc.exe says it does not exist", async () => {
    const run = (code: number) => async () => ({ code, stdout: "", stderr: "" });
    expect(await probeService(run(0), serviceNameFor(SID), "C:\\Windows")).toBe("installed");
    expect(await probeService(run(1060), serviceNameFor(SID), "C:\\Windows")).toBe("notInstalled");
    expect(await probeService(run(5), serviceNameFor(SID), "C:\\Windows")).toBe("installed");
    expect(await probeService(run(1), serviceNameFor(SID), "C:\\Windows")).toBe("unknown");
  });
});

describe("uninstalling Psyche", () => {
  const paths = {
    exe: "C:\\Users\\me\\AppData\\Local\\Psyche\\app-0.3.0\\Psyche.exe",
    startMenu: "C:\\SM",
    desktop: "C:\\D",
    psycheHome: "C:\\Users\\me\\.psyche",
    pid: 1,
    gatewayTasks: [],
  };

  it("removes the sandbox PC's service, after the Gateway stops", () => {
    const plan = squirrelPlan("uninstall", { ...paths, ownerSid: SID });
    expect(plan[0]?.kind).toBe("stopGateway");
    expect(plan[1]).toEqual({
      kind: "removeSandboxPc",
      exe: vmServiceExe(paths.exe),
      sid: SID,
    });
    expect(vmServiceExe(paths.exe)).toBe(
      "C:\\Users\\me\\AppData\\Local\\Psyche\\app-0.3.0\\resources\\win-helper\\psyche-vm-svc.exe",
    );
    expect(squirrelPlan("uninstall", paths).some((a) => a.kind === "removeSandboxPc")).toBe(false);
    for (const e of ["install", "updated"] as const)
      expect(
        squirrelPlan(e, { ...paths, ownerSid: SID }).some((a) => a.kind === "removeSandboxPc"),
      ).toBe(false);
  });

  it("leaves the steps to do it by hand", () => {
    const note = removalNote(SID);
    expect(note).toContain(`sc.exe stop PsycheVM-${SID}`);
    expect(note).toContain(`sc.exe delete PsycheVM-${SID}`);
    expect(note).toContain("administrator");
  });
});
