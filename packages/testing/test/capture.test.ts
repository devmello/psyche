import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readCaptures, scanRepo } from "../src/cli/check-secrets.ts";
import {
  assertNoModelVisibleLeaks,
  captureModelVisible,
  clearSecrets,
  drainCaptures,
  fixtureSecret,
  fixtureSecrets,
  loadSecretRegistry,
  ModelVisibleLeakError,
  peekCaptures,
  registerSecret,
  resolveSample,
  scanCaptures,
} from "../src/index.ts";

// These tests leak on purpose; keep them out of a CI capture directory.
const ciCaptureDir = process.env.PSYCHE_CAPTURE_DIR;
beforeEach(() => {
  delete process.env.PSYCHE_CAPTURE_DIR;
});
afterEach(() => {
  drainCaptures();
  clearSecrets();
  if (ciCaptureDir !== undefined) process.env.PSYCHE_CAPTURE_DIR = ciCaptureDir;
});

describe("model-visible capture", () => {
  it("passes clean captures with placeholders", () => {
    captureModelVisible("prompt", { messages: [{ text: "log in with {{cred:github-login}}" }] });
    captureModelVisible("tool_result", "filled {{cred:github-login.password}}: masked •••");
    expect(() => assertNoModelVisibleLeaks()).not.toThrow();
    expect(peekCaptures()).toHaveLength(0);
  });

  it("labels a resolved vault field as a placeholder-resolution leak", () => {
    const pw = fixtureSecret("github-login", "password");
    captureModelVisible("transcript", { turns: [`typed ${pw}`] }, { where: "FakeBrowser.type" });
    const [leak] = scanCaptures(drainCaptures());
    expect(leak).toMatchObject({
      kind: "placeholder_resolution",
      label: "cred:github-login.password",
      captureKind: "transcript",
      where: "FakeBrowser.type",
      path: "$.turns[0]",
    });
  });

  it("finds encoded forms of standalone fixture secrets", () => {
    const token = fixtureSecret("gateway-device-token");
    captureModelVisible("log", `GET /ws?t=${encodeURIComponent(token)}`);
    captureModelVisible("log", Buffer.from(`Bearer ${token}`).toString("base64"));
    const leaks = scanCaptures(drainCaptures());
    expect(leaks.map((l) => [l.kind, l.label, l.encoding])).toEqual([
      ["registered_secret", "device_token:gateway-device-token", "raw"],
      ["registered_secret", "device_token:gateway-device-token", "base64"],
    ]);
  });

  it("includes secrets registered by the test itself", () => {
    registerSecret("runtime-secret-value-123", "runtime");
    captureModelVisible("notification", "runtime-secret-value-123");
    expect(scanCaptures(drainCaptures())[0]).toMatchObject({ label: "runtime" });
  });

  it("flags patterns unless the capture allows that kind", () => {
    // An unregistered card (pattern only): a published test number from the registry samples.
    const card = resolveSample(loadSecretRegistry().patternSamples.card?.mustMatch?.[3] ?? "");
    captureModelVisible("receipt", `card ${card} charged`);
    captureModelVisible("receipt", `card ${card} charged`, { allow: ["card"] });
    const leaks = scanCaptures(drainCaptures());
    expect(leaks).toHaveLength(1);
    expect(leaks[0]).toMatchObject({ kind: "card", offset: 5 });
  });

  it("throws an error that never contains the value", () => {
    const pw = fixtureSecret("bank-login", "password");
    captureModelVisible("prompt", pw);
    let err: unknown;
    try {
      assertNoModelVisibleLeaks("turn 3");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ModelVisibleLeakError);
    expect(String((err as Error).message)).toContain("cred:bank-login.password");
    expect(String((err as Error).message)).not.toContain(pw);
    expect(JSON.stringify((err as ModelVisibleLeakError).leaks)).not.toContain(pw);
  });

  it("writes JSONL captures when PSYCHE_CAPTURE_DIR is set, and the CLI reader scans them", () => {
    const dir = mkdtempSync(join(tmpdir(), "psyche-captures-"));
    process.env.PSYCHE_CAPTURE_DIR = dir;
    try {
      captureModelVisible("log", new Map([["k", fixtureSecret("pairing-bootstrap")]]), {
        where: "gateway",
      });
      drainCaptures();
      const files = readdirSync(dir);
      expect(files).toHaveLength(1);
      expect(readFileSync(join(dir, files[0] ?? ""), "utf8")).toContain('"kind":"log"');
      const leaks = scanCaptures(readCaptures(dir));
      expect(leaks[0]).toMatchObject({ label: "bootstrap_token:pairing-bootstrap" });
      expect(leaks[0]?.where).toMatch(/gateway$/);
    } finally {
      delete process.env.PSYCHE_CAPTURE_DIR;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("every registry value is long enough to register", () => {
    for (const s of fixtureSecrets()) expect(s.value.length).toBeGreaterThanOrEqual(6);
  });
});

describe("check:secrets repo scan", () => {
  it("passes on this repository", () => {
    const root = join(import.meta.dirname, "../../..");
    expect(scanRepo(root)).toEqual([]);
  });
});
