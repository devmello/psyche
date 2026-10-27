import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { handleHttp } from "../src/http.ts";
import { ASAR_WEB_DIR, AsarWebRoot, asarHashFromInfoPlist, packagedAsar } from "../src/web-asar.ts";

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** Writes an asar in Electron's layout (pickled header, per-file SHA-256) and returns its header hash. */
function writeAsar(path: string, files: Record<string, string>): string {
  const root: Record<string, unknown> = { files: {} };
  const blobs: Buffer[] = [];
  let offset = 0;
  for (const [rel, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    const parts = rel.split("/");
    let dir = root as { files: Record<string, unknown> };
    for (const p of parts.slice(0, -1)) {
      dir.files[p] ??= { files: {} };
      dir = dir.files[p] as { files: Record<string, unknown> };
    }
    dir.files[parts.at(-1) as string] = {
      size: data.length,
      offset: String(offset),
      integrity: { algorithm: "SHA256", hash: sha(data), blockSize: 4194304, blocks: [sha(data)] },
    };
    blobs.push(data);
    offset += data.length;
  }
  const json = JSON.stringify(root);
  const str = Buffer.from(json);
  const padded = Math.ceil(str.length / 4) * 4;
  const header = Buffer.alloc(8 + padded);
  header.writeUInt32LE(4 + padded, 0);
  header.writeUInt32LE(str.length, 4);
  str.copy(header, 8);
  const size = Buffer.alloc(8);
  size.writeUInt32LE(4, 0);
  size.writeUInt32LE(header.length, 4);
  writeFileSync(path, Buffer.concat([size, header, ...blobs]));
  return sha(json);
}

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A miniature Psyche.app: Contents/Info.plist, Resources/app.asar, Resources/psyched/app. */
function app(files: Record<string, string>, plistHash?: string) {
  const base = mkdtempSync(join(tmpdir(), "psyche-asar-"));
  dirs.push(base);
  const contents = join(base, "Psyche.app/Contents");
  mkdirSync(join(contents, "Resources/psyched/app"), { recursive: true });
  const asar = join(contents, "Resources/app.asar");
  const hash = writeAsar(asar, files);
  writeFileSync(
    join(contents, "Info.plist"),
    `<plist><dict><key>ElectronAsarIntegrity</key><dict><key>Resources/app.asar</key><dict><key>algorithm</key><string>SHA256</string><key>hash</key><string>${plistHash ?? hash}</string></dict></dict></dict></plist>`,
  );
  return { asar, assetsRoot: join(contents, "Resources/psyched/app") };
}

const WEB = {
  [`${ASAR_WEB_DIR}/web.html`]: "<html>web client</html>",
  [`${ASAR_WEB_DIR}/index.html`]: "<html>desktop window</html>",
  [`${ASAR_WEB_DIR}/assets/app-1.js`]: "console.log(1)",
  "package.json": "{}",
};

describe("web client from app.asar", () => {
  it("finds the app's asar from the Gateway bundle and reads the plist hash", () => {
    const { asar, assetsRoot } = app(WEB);
    expect(packagedAsar(assetsRoot)).toBe(asar);
    expect(packagedAsar(join(assetsRoot, "nowhere"))).toBeNull();
    const plist = readFileSync(join(asar, "../../Info.plist"), "utf8");
    expect(asarHashFromInfoPlist(plist)).toMatch(/^[0-9a-f]{64}$/);
    expect(asarHashFromInfoPlist("<plist/>")).toBeUndefined();
  });

  it("serves verified files below the renderer folder only", () => {
    const web = AsarWebRoot.open(app(WEB).asar);
    expect(web.read("web.html")?.toString()).toBe("<html>web client</html>");
    expect(web.read("assets/app-1.js")?.toString()).toBe("console.log(1)");
    expect(web.has("../../../package.json")).toBe(false);
    expect(web.has("assets")).toBe(false);
    expect(web.read("missing.js")).toBeNull();
  });

  it("refuses an archive whose header does not match Info.plist", () => {
    const { asar } = app(WEB, "0".repeat(64));
    expect(() => AsarWebRoot.open(asar)).toThrow(/integrity/);
  });

  it("refuses a file whose bytes were changed after packaging", () => {
    const { asar } = app(WEB);
    const bytes = readFileSync(asar);
    const at = bytes.indexOf("console.log(1)");
    bytes.write("console.log(2)", at);
    writeFileSync(asar, bytes);
    const web = AsarWebRoot.open(asar);
    expect(web.read("assets/app-1.js")).toBeNull();
    expect(web.read("web.html")?.toString()).toBe("<html>web client</html>");
  });
});

describe("handleHttp with the asar web client", () => {
  let server: Server | undefined;
  afterAll(() => server?.close());

  it("serves web.html for routes and .html requests, assets as they are", async () => {
    const { asar } = app(WEB);
    server = createServer((req, res) =>
      handleHttp(req, res, { webRoot: join(asar, "no-such-dir"), webAsar: asar, version: "t" }),
    );
    await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const get = async (p: string) => {
      const r = await fetch(`http://127.0.0.1:${port}${p}`);
      return {
        status: r.status,
        body: await r.text(),
        csp: r.headers.get("content-security-policy"),
      };
    };
    expect((await get("/")).body).toBe("<html>web client</html>");
    expect((await get("/chat/t1")).body).toBe("<html>web client</html>");
    expect((await get("/index.html")).body).toBe("<html>web client</html>");
    const js = await get("/assets/app-1.js");
    expect(js.body).toBe("console.log(1)");
    expect(js.csp).toContain("default-src");
    expect((await get("/%2e%2e/%2e%2e/package.json")).body).toBe("<html>web client</html>");
  });
});
