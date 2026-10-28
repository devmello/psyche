import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  installedSrtVersion,
  installSrt,
  launcherScript,
  SRT_PINS,
  SRT_VERSION,
  type SrtInstallDeps,
  type SrtPin,
  srtInstallDir,
  tarballUrl,
  unsafeTarEntry,
} from "../src/index.ts";

const sri = (b: Buffer) => `sha512-${createHash("sha512").update(b).digest("base64")}`;
const BODIES = {
  "@anthropic-ai/sandbox-runtime": Buffer.from("fake srt tarball"),
  zod: Buffer.from("fake zod tarball"),
};
const PINS: SrtPin[] = [
  {
    name: "@anthropic-ai/sandbox-runtime",
    version: "9.9.9",
    integrity: sri(BODIES["@anthropic-ai/sandbox-runtime"]),
  },
  { name: "zod", version: "1.0.0", integrity: sri(BODIES.zod) },
];

/** A fake npm registry: only the exact tarball URLs answer. */
function registry(tamper?: string) {
  const urls: string[] = [];
  const fetchFn = (async (url: string) => {
    urls.push(url);
    const pin = PINS.find((p) => tarballUrl(p) === url);
    if (!pin) return new Response("nope", { status: 404 });
    const body = BODIES[pin.name as keyof typeof BODIES];
    return new Response(pin.name === tamper ? Buffer.from("evil") : body);
  }) as unknown as typeof fetch;
  const extracted: string[] = [];
  const deps: SrtInstallDeps = {
    fetch: fetchFn,
    async extract(tarball, dest) {
      extracted.push(dest);
      await mkdir(join(dest, "dist"), { recursive: true });
      await writeFile(join(dest, "dist", "cli.js"), tarball);
    },
  };
  return { deps, urls, extracted };
}

let home: string;
afterEach(async () => {
  if (home) await rm(home, { recursive: true, force: true });
});
const newHome = async () => {
  home = await mkdtemp(join(tmpdir(), "psyche-srt-"));
  return home;
};

describe("pins", () => {
  it("name the package and every URL is the exact registry tarball", () => {
    expect(SRT_PINS[0]).toMatchObject({
      name: "@anthropic-ai/sandbox-runtime",
      version: SRT_VERSION,
    });
    expect(tarballUrl(SRT_PINS[0] as SrtPin)).toBe(
      `https://registry.npmjs.org/@anthropic-ai/sandbox-runtime/-/sandbox-runtime-${SRT_VERSION}.tgz`,
    );
    expect(tarballUrl({ name: "zod", version: "3.25.76", integrity: "" })).toBe(
      "https://registry.npmjs.org/zod/-/zod-3.25.76.tgz",
    );
    for (const p of SRT_PINS) expect(p.integrity).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
  });
});

describe("installSrt", () => {
  it("verifies, unpacks into <home>/tools/srt/<version> (0700) and writes a launcher", async () => {
    const h = await newHome();
    const { deps, urls } = registry();
    const r = await installSrt(deps, { home: h, nodePath: "/App/runtime/node", pins: PINS });
    expect(urls).toEqual(PINS.map(tarballUrl));
    expect(r.dir).toBe(srtInstallDir(h, "9.9.9"));
    expect(r.path).toBe(join(r.dir, "bin", "srt"));
    expect(((await stat(r.dir)).mode & 0o777).toString(8)).toBe("700");
    expect(((await stat(join(h, "tools"))).mode & 0o777).toString(8)).toBe("700");
    expect((await stat(r.path)).mode & 0o111).not.toBe(0);
    const launcher = await readFile(r.path, "utf8");
    expect(launcher).toContain("'/App/runtime/node'");
    expect(launcher).toContain(
      join(r.dir, "node_modules", "@anthropic-ai", "sandbox-runtime", "dist", "cli.js"),
    );
    expect(await readFile(join(r.dir, "node_modules", "zod", "dist", "cli.js"), "utf8")).toBe(
      "fake zod tarball",
    );
    expect(installedSrtVersion(h, r.path)).toBe("9.9.9");
  });

  it("fails closed on an integrity mismatch: nothing unpacked, nothing left behind", async () => {
    const h = await newHome();
    const { deps, extracted } = registry("zod");
    await expect(installSrt(deps, { home: h, nodePath: "/n", pins: PINS })).rejects.toMatchObject({
      code: "integrity_mismatch",
    });
    expect(extracted).toEqual([]);
    await expect(readdir(join(h, "tools", "srt"))).rejects.toThrow();
  });

  it("fails closed when the registry has no such tarball", async () => {
    const h = await newHome();
    const { deps } = registry();
    const pins = [{ name: "zod", version: "2.0.0", integrity: sri(BODIES.zod) }];
    await expect(installSrt(deps, { home: h, nodePath: "/n", pins })).rejects.toMatchObject({
      code: "download_failed",
    });
  });

  it("keeps an earlier install when a reinstall fails, and replaces it when it works", async () => {
    const h = await newHome();
    const ok = registry();
    await installSrt(ok.deps, { home: h, nodePath: "/old", pins: PINS });
    const bad = registry("zod");
    await expect(installSrt(bad.deps, { home: h, nodePath: "/n", pins: PINS })).rejects.toThrow();
    expect(await readFile(join(srtInstallDir(h, "9.9.9"), "bin", "srt"), "utf8")).toContain("/old");
    expect(await readdir(join(h, "tools", "srt"))).toEqual(["9.9.9"]);
    await installSrt(ok.deps, { home: h, nodePath: "/new", pins: PINS });
    expect(await readFile(join(srtInstallDir(h, "9.9.9"), "bin", "srt"), "utf8")).toContain("/new");
  });
});

describe("helpers", () => {
  it("recognises only a launcher inside the tools folder", () => {
    expect(installedSrtVersion("/h", "/h/tools/srt/0.0.81/bin/srt")).toBe("0.0.81");
    expect(installedSrtVersion("/h", "/opt/homebrew/bin/srt")).toBeNull();
    expect(installedSrtVersion("/h", "/h/tools/srt/0.0.81/evil")).toBeNull();
    expect(installedSrtVersion("/h", undefined)).toBeNull();
  });
  it("quotes paths in the launcher", () => {
    expect(launcherScript("/a b/it's/node", "/e.js")).toContain(
      `'/a b/it'\\''s/node' '/e.js' "$@"`,
    );
  });
  it("refuses links, absolute and parent paths in a tarball listing", () => {
    const line = (t: string, name: string) => `${t}rw-r--r--  0 0 0 10 Jan  1  1985 ${name}`;
    expect(unsafeTarEntry(line("-", "package/dist/cli.js"))).toBe(false);
    expect(unsafeTarEntry(line("d", "package/dist/"))).toBe(false);
    expect(unsafeTarEntry(line("l", "package/x -> /etc/passwd"))).toBe(true);
    expect(unsafeTarEntry(line("-", "/etc/passwd"))).toBe(true);
    expect(unsafeTarEntry(line("-", "package/../../x"))).toBe(true);
  });
});
