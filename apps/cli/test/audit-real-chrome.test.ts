import { MockGateway } from "@psyche/web/testing";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.ts";
import { cleanupTempDirs, makeDeps, out, runJson } from "./helpers.ts";

/**
 * Issue #169: `psyche security audit` asks the Gateway for its real-Chrome status
 * (`browser.realChrome.status`) and flags the owner's Chrome while it is attached, naming the
 * DevTools port, PID and profile dir; nothing when the mode is idle or off.
 */

const ADMIN = ["operator.read", "operator.write", "operator.approvals", "operator.admin"];
let gw: MockGateway | undefined;

afterEach(async () => {
  await gw?.stop();
  gw = undefined;
  cleanupTempDirs();
});

async function audit(status: unknown) {
  gw = await new MockGateway({
    pair: { phase: "paired", scopes: ADMIN },
    handlers: { "browser.realChrome.status": () => status },
  }).start();
  const url = gw.origin;
  const deps = makeDeps();
  const res = await runJson(["security", "audit", "--url", url, "--home", deps.home], deps);
  const h = makeDeps();
  await run(["security", "audit", "--url", url, "--home", h.home], h);
  return { ...res, human: out(h) };
}

type Finding = { id: string; severity: string; message: string };

describe("security audit: real-Chrome mode (#169)", () => {
  it("flags the attached Chrome with its port, PID and profile dir", async () => {
    const { json, human } = await audit({
      enabled: true,
      attached: true,
      port: 53817,
      pid: 4242,
      since: "2026-10-20T09:00:00.000Z",
      sessions: 1,
      userDataDir: "/home/o/.psyche/browser/real-chrome/default",
    });
    const f = (json.findings as Finding[]).find((x) => x.id === "browser.real_chrome_attached");
    expect(f).toMatchObject({ severity: "medium" });
    expect(f?.message).toContain("127.0.0.1:53817");
    expect(f?.message).toContain("pid 4242");
    expect(f?.message).toContain("/home/o/.psyche/browser/real-chrome/default");
    expect(human).toContain("browser.real_chrome_attached");
    expect(gw?.calls.some((c) => c.method === "browser.realChrome.status")).toBe(true);
  });

  it("reports nothing while the mode is idle or off", async () => {
    for (const status of [
      { enabled: true, attached: false, sessions: 0 },
      { enabled: false, attached: false, sessions: 0 },
    ]) {
      const { json } = await audit(status);
      expect((json.findings as Finding[]).map((x) => x.id)).not.toContain(
        "browser.real_chrome_attached",
      );
      await gw?.stop();
      gw = undefined;
    }
  });

  it("lists it as not checked on a Gateway without the method", async () => {
    gw = await new MockGateway({ pair: { phase: "paired", scopes: ADMIN } }).start();
    const deps = makeDeps();
    const { json } = await runJson(
      ["security", "audit", "--url", gw.origin, "--home", deps.home],
      deps,
    );
    const rules = (json.notChecked as { rule: string }[]).map((n) => n.rule);
    expect(rules).toContain("browser.realChrome");
  });
});
