import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeCredentialBroker } from "@psyche/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  authorityOf,
  type BotAuthConfig,
  botAuthDirectory,
  createBotAuthSigner,
  validSignatureAgent,
} from "../src/botauth/signer.ts";
import { verifyBotAuth } from "../src/botauth/verify.ts";
import { checkCdpCommand } from "../src/bridge/allowlist.ts";
import { FsQuarantineWriter } from "../src/downloads/library.ts";
import { CdpBridgeDriver } from "../src/drivers/cdp.ts";
import { MOCK_REQUEST_HEADERS } from "../src/testing/mock-browser.ts";
import { MockDesktop } from "../src/testing/mock-desktop.ts";

/** Web Bot Auth (I14): signatures a site can verify, only where they belong. */
const AGENT = "https://agent.psyche.example/.well-known/http-message-signatures-directory";

describe("Web Bot Auth signer (I14)", () => {
  it("signs @authority and Signature-Agent so the directory's key verifies them", async () => {
    const creds = new FakeCredentialBroker();
    const key = await creds.rotateBotAuthKey();
    const signer = createBotAuthSigner({
      key: () => creds.botAuthKey(),
      config: () => ({ enabled: true, signatureAgent: AGENT, origins: ["https://shop.example"] }),
      now: () => 1_800_000_000_000,
      nonce: () => "bm9uY2U=",
    });
    const headers = await signer.sign("https://shop.example/cart?x=1", "profile");
    expect(headers?.map((h) => h.name)).toEqual([
      "Signature-Agent",
      "Signature-Input",
      "Signature",
    ]);
    const h = Object.fromEntries((headers ?? []).map((x) => [x.name, x.value]));
    expect(h["Signature-Agent"]).toBe(`"${AGENT}"`);
    expect(h["Signature-Input"]).toBe(
      `sig1=("@authority" "signature-agent");created=1800000000;keyid="${key.keyId}";alg="ed25519";expires=1800000060;nonce="bm9uY2U=";tag="web-bot-auth"`,
    );
    const dir = botAuthDirectory(await creds.botAuthKey());
    expect(dir).toEqual({ keys: [key.publicJwk] });
    expect(verifyBotAuth(h, "shop.example", dir, 1_800_000_030)).toMatchObject({
      ok: true,
      keyId: key.keyId,
    });
    // Another site, a changed agent, or too late: refused.
    expect(verifyBotAuth(h, "evil.example", dir, 1_800_000_030)).toMatchObject({ ok: false });
    expect(
      verifyBotAuth(
        { ...h, "Signature-Agent": '"https://evil.example/dir"' },
        "shop.example",
        dir,
        1_800_000_030,
      ),
    ).toMatchObject({ ok: false, reason: "bad_signature" });
    expect(verifyBotAuth(h, "shop.example", dir, 1_800_000_061)).toMatchObject({
      ok: false,
      reason: "expired",
    });
    expect(authorityOf("https://Shop.Example:443/a")).toBe("shop.example");
    expect(authorityOf("http://site-a.localhost:4000/")).toBe("site-a.localhost:4000");
  });

  it("is opt-in and never signs a logged-out tab", async () => {
    const creds = new FakeCredentialBroker();
    const cfg: BotAuthConfig = {
      enabled: true,
      signatureAgent: AGENT,
      origins: ["https://shop.example"],
    };
    const signer = createBotAuthSigner({ key: () => creds.botAuthKey(), config: () => cfg });
    const url = "https://shop.example/";
    // No key yet.
    expect(await signer.sign(url, "profile")).toBeUndefined();
    await creds.rotateBotAuthKey();
    expect(await signer.sign(url, "profile")).toBeDefined();
    expect(await signer.sign(url, "clean")).toBeUndefined();
    expect(await signer.sign("https://other.example/", "profile")).toBeUndefined();
    cfg.enabled = false;
    expect(await signer.sign(url, "profile")).toBeUndefined();
    cfg.enabled = true;
    for (const bad of [
      undefined,
      "",
      "http://agent.example/dir",
      "ftp://x/",
      "https://u:p@x.example/",
    ]) {
      expect(validSignatureAgent(bad), String(bad)).toBeUndefined();
      cfg.signatureAgent = bad;
      expect(await signer.sign(url, "profile")).toBeUndefined();
    }
    expect(validSignatureAgent("http://127.0.0.1:7979/.well-known/x")).toBeDefined();
    // A site that asks gets signatures from then on.
    cfg.signatureAgent = AGENT;
    expect(await signer.sign("https://asks.example/", "profile")).toBeUndefined();
    signer.noteAcceptSignature("https://asks.example");
    expect(await signer.sign("https://asks.example/page", "profile")).toBeDefined();
    expect(signer.advertised()).toEqual(["https://asks.example"]);
  });

  it("lets only signature headers through the CDP allowlist, never credentials", () => {
    const ok = (headers: unknown) =>
      checkCdpCommand("Fetch.continueRequest", { requestId: "1", headers }).ok;
    expect(ok([{ name: "Signature", value: "sig1=:AA==:" }])).toBe(true);
    expect(ok([{ name: "Cookie", value: "a=1" }])).toBe(false);
    expect(ok([{ name: "Authorization", value: "Bearer x" }])).toBe(false);
    expect(ok([{ name: "Host", value: "evil.example" }])).toBe(false);
    expect(ok([{ name: "X-A", value: "a\r\nb" }])).toBe(false);
    expect(checkCdpCommand("Fetch.continueRequest", { requestId: "1", url: "https://x/" }).ok).toBe(
      false,
    );
  });
});

describe("Web Bot Auth through the bridge driver (I14)", () => {
  let dir: string;
  let desktop: MockDesktop;
  let driver: CdpBridgeDriver;
  const creds = new FakeCredentialBroker();
  const cfg: BotAuthConfig = { enabled: true, signatureAgent: AGENT, origins: [] };
  const signer = createBotAuthSigner({ key: () => creds.botAuthKey(), config: () => cfg });

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "psyche-s08-wba-"));
    desktop = new MockDesktop({ quarantineDir: dir });
    driver = new CdpBridgeDriver(await desktop.connect(), {
      library: new FsQuarantineWriter(join(dir, "lib")),
      botAuth: signer,
    });
    await creds.rotateBotAuthKey();
  });
  afterAll(async () => {
    driver.dispose();
    desktop.disconnect();
    await rm(dir, { recursive: true, force: true });
  });

  /** The fixture origin's verdict on the request that loaded `url`. */
  const siteSees = async (url: string) => {
    const sent = [...desktop.browser.tabs.values()]
      .map((t) => t.requestHeaders.get(url))
      .find((h) => h !== undefined);
    const verdict = verifyBotAuth(
      sent ?? {},
      authorityOf(url),
      botAuthDirectory(await creds.botAuthKey()),
    );
    return { sent: sent ?? {}, verdict };
  };

  it("signs a site after it asks, keeps the browser's own headers, and only in the profile", async () => {
    const policy = {
      devPreview: true,
      readWritable: [desktop.browser.origin("a"), desktop.browser.origin("b")],
    };
    const s = await driver.openSession({ policy, partition: "profile" });
    const url = desktop.browser.url("b/signed");
    const t = await driver.openTab(s.id, url);
    // First visit: unsigned, but the response asked for signatures.
    expect((await siteSees(url)).verdict).toMatchObject({ ok: false, reason: "unsigned" });
    expect(signer.advertised()).toEqual([desktop.browser.origin("b")]);
    await driver.navigate(t.id, url);
    const second = await siteSees(url);
    expect(second.verdict).toMatchObject({ ok: true, keyId: (await creds.botAuthKey())?.keyId });
    // The desktop merged the signature into the real request: nothing of the browser's lost.
    for (const [k, v] of Object.entries(MOCK_REQUEST_HEADERS)) expect(second.sent[k]).toBe(v);
    // Another origin that did not ask stays unsigned.
    const other = desktop.browser.url("a/");
    await driver.navigate(t.id, other);
    expect((await siteSees(other)).verdict).toMatchObject({ ok: false, reason: "unsigned" });
    await driver.closeSession(s.id);

    // A logged-out task never signs, even for a site that asked.
    const clean = await driver.openSession({ policy, partition: "clean" });
    const c = await driver.openTab(clean.id, desktop.browser.url("b/"));
    expect((await siteSees(desktop.browser.url("b/"))).verdict).toMatchObject({
      ok: false,
      reason: "unsigned",
    });
    await driver.navigate(c.id, url);
    expect(desktop.browser.tabs.get(c.id)?.requestHeaders.get(url)?.Signature).toBeUndefined();
    await driver.closeSession(clean.id);
  });

  it("signs owner-listed origins from the first request, and a rotated key takes over", async () => {
    cfg.origins = [desktop.browser.origin("a")];
    const s = await driver.openSession({
      policy: { devPreview: true, readWritable: [desktop.browser.origin("a")] },
      partition: "profile",
    });
    const url = desktop.browser.url("a/login");
    const t = await driver.openTab(s.id, url);
    const before = (await creds.botAuthKey())?.keyId;
    expect((await siteSees(url)).verdict).toMatchObject({ ok: true, keyId: before });
    const rotated = await creds.rotateBotAuthKey();
    await driver.navigate(t.id, url);
    expect((await siteSees(url)).verdict).toMatchObject({ ok: true, keyId: rotated.keyId });
    // Switched off: unsigned again.
    cfg.enabled = false;
    await driver.navigate(t.id, desktop.browser.url("a/"));
    expect((await siteSees(desktop.browser.url("a/"))).verdict).toMatchObject({ ok: false });
    cfg.enabled = true;
    await driver.closeSession(s.id);
  });
});
