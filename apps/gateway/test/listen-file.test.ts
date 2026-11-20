import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startTestGateway, type TestGateway } from "./helpers.ts";

/**
 * B2 review r2: the Gateway records where it really listens (`run/listen.json`) so the CLI sends
 * the handshake secret only to that exact origin. It lives and dies with the secret.
 */

let t: TestGateway | null = null;
let home = "";

afterEach(async () => {
  await t?.cleanup();
  t = null;
  if (home) rmSync(home, { recursive: true, force: true });
  home = "";
});

const listenPath = (h: string) => join(h, "run", "listen.json");

describe("run/listen.json", () => {
  it("lists the bound origin (the real port), mode 0600, next to the secret", async () => {
    t = await startTestGateway({});
    const file = JSON.parse(readFileSync(listenPath(t.home), "utf8")) as { origins: string[] };
    expect(file.origins).toEqual([t.gateway.origin]);
    expect(new URL(file.origins[0] as string).port).toBe(String(t.gateway.port));
    if (process.platform !== "win32") {
      expect(statSync(listenPath(t.home)).mode & 0o777).toBe(0o600);
    }
  });

  it("is written before the secret (the CLI reads the secret first, listen.json second)", async () => {
    t = await startTestGateway({});
    const at = (name: string) => statSync(join(t?.home ?? "", "run", name), { bigint: true });
    expect(at("listen.json").mtimeNs <= at("handshake.secret").mtimeNs).toBe(true);
    expect(at("listen.json").birthtimeNs <= at("handshake.secret").birthtimeNs).toBe(true);
  });

  it("lists the address actually bound (127.0.0.1 or ::1 for gateway.host: localhost), which the CLI then uses as its default URL", async () => {
    t = await startTestGateway({ config: { host: "localhost" } });
    const file = JSON.parse(readFileSync(listenPath(t.home), "utf8")) as { origins: string[] };
    const url = new URL(file.origins[0] as string);
    // `localhost` resolves to one concrete loopback address; that address is what is listed.
    expect(["127.0.0.1", "[::1]"]).toContain(url.hostname);
    expect(url.port).toBe(String(t.gateway.port));
    expect(file.origins).toHaveLength(1);
  });

  it("is removed with the secret on a clean stop", async () => {
    t = await startTestGateway({});
    const dir = t.home;
    expect(existsSync(listenPath(dir))).toBe(true);
    await t.gateway.stop("test");
    expect(existsSync(listenPath(dir))).toBe(false);
    expect(existsSync(join(dir, "run", "handshake.secret"))).toBe(false);
    await t.cleanup().catch(() => undefined);
    t = null;
    rmSync(dir, { recursive: true, force: true });
  });

  it("a file left by a crash is replaced on start, and the secret is new every launch", async () => {
    home = mkdtempSync(join(tmpdir(), "psyche-gw-stale-"));
    mkdirSync(join(home, "run"), { recursive: true, mode: 0o700 });
    writeFileSync(listenPath(home), JSON.stringify({ origins: ["http://127.0.0.1:9"] }));
    writeFileSync(join(home, "run", "handshake.secret"), "stale-secret\n");
    t = await startTestGateway({ home });
    const file = JSON.parse(readFileSync(listenPath(home), "utf8")) as { origins: string[] };
    expect(file.origins).toEqual([t.gateway.origin]);
    const secret = readFileSync(join(home, "run", "handshake.secret"), "utf8").trim();
    expect(secret).toBe(t.gateway.handshakeSecret);
    // A stale secret is useless: this launch's secret is not the one the crash left.
    expect(secret).not.toBe("stale-secret");
  });
});
