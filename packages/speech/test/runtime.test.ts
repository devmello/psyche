import { execFileSync } from "node:child_process";
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
import { afterEach, describe, expect, it } from "vitest";
import { createSpeechStack } from "../src/index.ts";
import { ModelManager, type ModelSpec } from "../src/models.ts";
import {
  tarExtract,
  WHISPER_RUNTIME_CATALOG,
  WhisperRuntime,
  type WhisperRuntimeSpec,
  whisperRuntimeFor,
  type ZipExtractor,
} from "../src/runtime.ts";
import { type WhisperDownloadEvent, WhisperInstaller } from "../src/whisper-setup.ts";

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});
const newHome = () => {
  const h = mkdtempSync(join(tmpdir(), "psyche-rt-"));
  homes.push(h);
  return h;
};

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const bytes = (s: string) => new TextEncoder().encode(s);

/** A fake release: the zip's bytes are opaque here; the extractor below "unpacks" `files`. */
function fakeRelease(files: Record<string, string>, zip = bytes("PK fake zip")) {
  const spec: WhisperRuntimeSpec = {
    id: "whisper-runtime-test-win-x64",
    engine: "whisper-runtime",
    file: "whisper-bin-test.zip",
    url: "https://example.test/whisper-bin-x64.zip",
    sha256: sha(zip),
    sizeBytes: zip.byteLength,
    license: "MIT",
    platform: "win32",
    arch: "x64",
    release: "test",
    dir: "whisper-test-win-x64",
    prefix: "Release/",
    server: "whisper-server.exe",
    members: Object.entries(files).map(([name, body]) => ({
      name,
      sizeBytes: bytes(body).byteLength,
      sha256: sha(body),
    })),
  };
  return { spec, zip };
}

/** A mock download server: URL → body; counts requests. */
function mockFetch(routes: Record<string, Uint8Array>) {
  const hits: string[] = [];
  const fn = (async (url: string | URL | Request) => {
    const u = String(url);
    hits.push(u);
    const body = routes[u];
    if (body === undefined) return new Response("nope", { status: 404 });
    return new Response(body as Uint8Array<ArrayBuffer>, { status: 200 });
  }) as typeof fetch;
  return { fn, hits };
}

function writingExtractor(files: Record<string, string>, seen: string[][] = []): ZipExtractor {
  return async (_zip, dest, members) => {
    seen.push(members);
    mkdirSync(join(dest, "Release"), { recursive: true });
    for (const m of members) {
      const name = m.replace(/^Release\//, "");
      const body = files[name];
      if (body !== undefined) writeFileSync(join(dest, "Release", name), body);
    }
  };
}

const FILES = { "whisper-server.exe": "server", "whisper.dll": "lib", "ggml.dll": "ggml" };

describe("the pinned whisper.cpp runtime catalog", () => {
  it("pins the Windows CPU builds of one release over https with hex SHA-256 per file", () => {
    expect(whisperRuntimeFor("win32", "x64")?.id).toBe("whisper-runtime-b5454-win-x64");
    expect(whisperRuntimeFor("win32", "arm64")?.id).toBe("whisper-runtime-b5454-win-arm64");
    expect(whisperRuntimeFor("darwin", "arm64")).toBeUndefined();
    expect(whisperRuntimeFor("linux", "x64")).toBeUndefined();
    for (const s of WHISPER_RUNTIME_CATALOG) {
      expect(s.url).toMatch(
        /^https:\/\/github\.com\/ggml-org\/whisper\.cpp\/releases\/download\/b5454\//,
      );
      expect(s.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(s.members.map((m) => m.name)).toContain("whisper-server.exe");
      expect(s.members.every((m) => /^[0-9a-f]{64}$/.test(m.sha256) && m.sizeBytes > 0)).toBe(true);
      // Under 10 MB to download, under 15 MB on disk.
      expect(s.sizeBytes).toBeLessThan(10_000_000);
      expect(s.members.reduce((n, m) => n + m.sizeBytes, 0)).toBeLessThan(15_000_000);
    }
  });
});

describe("runtime download and verification", { timeout: 30_000 }, () => {
  it("downloads the pinned zip, extracts only the named files, verifies each and drops the zip", async () => {
    const home = newHome();
    const { spec, zip } = fakeRelease(FILES);
    const server = mockFetch({ [spec.url]: zip });
    const seen: string[][] = [];
    const rt = new WhisperRuntime({
      home,
      spec,
      fetch: server.fn,
      extract: writingExtractor(FILES, seen),
    });
    expect(await rt.has()).toBe(false);
    expect(await rt.downloadBytes()).toBe(zip.byteLength);
    const path = await rt.ensure();
    expect(path).toBe(join(home, "speech", "bin", "whisper-test-win-x64", "whisper-server.exe"));
    expect(readFileSync(path, "utf8")).toBe("server");
    expect(seen).toEqual([
      ["Release/whisper-server.exe", "Release/whisper.dll", "Release/ggml.dll"],
    ]);
    expect(await rt.has()).toBe(true);
    expect(await rt.verify()).toBe(true);
    expect(readdirSync(join(home, "speech", "bin"))).toEqual(["whisper-test-win-x64"]);
    // Installed: no second download.
    await rt.ensure();
    expect(server.hits).toHaveLength(1);
  });

  it("refuses a zip whose hash does not match and leaves nothing behind", async () => {
    const home = newHome();
    const { spec } = fakeRelease(FILES);
    const server = mockFetch({ [spec.url]: bytes("PK fake zap") }); // same size, other bytes
    const rt = new WhisperRuntime({
      home,
      spec,
      fetch: server.fn,
      extract: writingExtractor(FILES),
    });
    await expect(rt.ensure()).rejects.toMatchObject({
      code: "invalid_params",
      message: expect.stringMatching(/checksum mismatch/),
    });
    expect(await rt.has()).toBe(false);
    expect(readdirSync(join(home, "speech", "bin"))).toEqual([]);
  });

  it("refuses a member whose hash does not match the pin", async () => {
    const home = newHome();
    const { spec, zip } = fakeRelease(FILES);
    const server = mockFetch({ [spec.url]: zip });
    const tampered = { ...FILES, "whisper.dll": "LIB" }; // same size, other bytes
    const rt = new WhisperRuntime({
      home,
      spec,
      fetch: server.fn,
      extract: writingExtractor(tampered),
    });
    await expect(rt.ensure()).rejects.toThrow(/checksum mismatch for whisper\.dll/);
    expect(await rt.has()).toBe(false);
    expect(readdirSync(join(home, "speech", "bin"))).toEqual([]);
  });

  it("refuses a member the archive does not have", async () => {
    const home = newHome();
    const { spec, zip } = fakeRelease(FILES);
    const rt = new WhisperRuntime({
      home,
      spec,
      fetch: mockFetch({ [spec.url]: zip }).fn,
      extract: writingExtractor({ "whisper-server.exe": "server" }),
    });
    await expect(rt.ensure()).rejects.toThrow(/checksum mismatch for whisper\.dll/);
  });

  it("only takes https downloads and pinned member names", () => {
    const { spec } = fakeRelease(FILES);
    expect(
      () => new WhisperRuntime({ home: newHome(), spec: { ...spec, url: "http://x/y.zip" } }),
    ).toThrow(/https/);
    expect(
      () =>
        new WhisperRuntime({
          home: newHome(),
          spec: { ...spec, members: [{ name: "../evil.dll", sizeBytes: 1, sha256: sha("x") }] },
        }),
    ).toThrow(/not pinned/);
  });

  it.skipIf(process.platform !== "win32")(
    "extracts the named members of a real zip with Windows' tar",
    async () => {
      const work = newHome();
      mkdirSync(join(work, "src", "Release"), { recursive: true });
      for (const [n, b] of Object.entries({ ...FILES, "extra.exe": "not wanted" })) {
        writeFileSync(join(work, "src", "Release", n), b);
      }
      const zip = join(work, "r.zip");
      execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          `Compress-Archive -Path '${join(work, "src", "Release")}' -DestinationPath '${zip}'`,
        ],
        { windowsHide: true },
      );
      const out = join(work, "out");
      mkdirSync(out);
      await tarExtract(zip, out, ["Release/whisper-server.exe", "Release/ggml.dll"]);
      expect(readdirSync(join(out, "Release")).sort()).toEqual(["ggml.dll", "whisper-server.exe"]);
    },
  );
});

describe("the owner's one-click whisper setup (runtime + model)", () => {
  const model = bytes("ggml model bytes, pretend this is 148 MB");
  const modelSpec: ModelSpec = {
    id: "whisper-test.en",
    engine: "whisper",
    file: "whisper/ggml-test.en.bin",
    url: "https://example.test/ggml-test.en.bin",
    sha256: sha(model),
    sizeBytes: model.byteLength,
    license: "MIT",
  };

  function setup(routes?: Record<string, Uint8Array>) {
    const home = newHome();
    const { spec, zip } = fakeRelease(FILES);
    const server = mockFetch(routes ?? { [spec.url]: zip, [modelSpec.url]: model });
    const runtime = new WhisperRuntime({
      home,
      spec,
      fetch: server.fn,
      extract: writingExtractor(FILES),
    });
    const models = new ModelManager({ home, catalog: [modelSpec], fetch: server.fn });
    const events: WhisperDownloadEvent[] = [];
    const installer = new WhisperInstaller({
      runtime,
      models,
      modelId: modelSpec.id,
      onEvent: (e) => events.push(e),
      progressEveryMs: 0,
    });
    return { home, spec, zip, server, installer, events, models };
  }

  it("says what a download costs, downloads both, verifies and reports progress", async () => {
    const { installer, events, zip, models } = setup();
    const before = await installer.status();
    expect(before).toMatchObject({
      state: "missing",
      downloadBytes: zip.byteLength + model.byteLength,
      model: { id: "whisper-test.en", present: false },
      runtime: { present: false, release: "test" },
      server: "stopped",
    });
    expect(await installer.download()).toEqual({ started: true });
    expect(await installer.download()).toEqual({ started: false });
    expect((await installer.status()).state).toBe("downloading");
    await installer.settled();
    const after = await installer.status();
    expect(after).toMatchObject({ state: "ready", downloadBytes: 0 });
    expect(await installer.ready()).toBe(true);
    expect(await models.verify(modelSpec.id)).toBe(true);
    expect(events[0]).toMatchObject({
      phase: "started",
      totalBytes: zip.byteLength + model.byteLength,
    });
    expect(events.at(-1)).toMatchObject({ phase: "finished", fraction: 1 });
    const fractions = events.map((e) => e.fraction);
    expect([...fractions].sort((a, b) => a - b)).toEqual(fractions);
    // Installed: nothing to start.
    expect(await installer.download()).toEqual({ started: false });
  });

  it("refuses a model with a bad hash and says why", async () => {
    const { installer, events, spec, zip } = setup();
    const bad = setup({
      [spec.url]: zip,
      [modelSpec.url]: bytes("ggml model bytes, pretend this is 148 MX"),
    });
    expect(installer).toBeDefined();
    await bad.installer.download();
    await bad.installer.settled();
    const st = await bad.installer.status();
    expect(st.state).toBe("error");
    expect(st.error).toMatch(/checksum mismatch for whisper-test\.en/);
    expect(st.model.present).toBe(false);
    expect(st.runtime.present).toBe(true);
    expect(bad.events.at(-1)).toMatchObject({ phase: "failed" });
    expect(existsSync(join(bad.home, "models", "whisper", "ggml-test.en.bin.part"))).toBe(false);
    expect(events).toEqual([]);
  });
});

describe("the speech stack per platform", () => {
  it("provisions whisper-server on Windows and keeps the CLI path elsewhere", async () => {
    const win = createSpeechStack({ home: newHome(), platform: "win32", arch: "x64" });
    expect(win.whisper?.runtime.spec.id).toBe("whisper-runtime-b5454-win-x64");
    expect((await win.whisper?.engine.capabilities())?.engine).toBe("whisper.cpp (whisper-server)");
    expect(win.selector.settings.stt.order[0]).toBe("whisper");
    expect((await win.whisper?.installer.status())?.downloadBytes).toBe(8_928_640 + 147_964_211);

    const mac = createSpeechStack({ home: newHome(), platform: "darwin", arch: "arm64" });
    expect(mac.whisper).toBeUndefined();
    expect(mac.selector.settings.stt.order).toEqual(["mac-node", "whisper", "web-speech"]);
  });
});
