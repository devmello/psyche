import { FakeClock, fixtureSecret, loadSecretRegistry, resolveSample } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import {
  type AnchorSigner,
  type AnchorVerifier,
  containsSensitive,
  createAuditLog,
  findSensitive,
  MemoryAuditStore,
  Receipts,
  sha256,
} from "../src/index.ts";

/** Regression tests for the S05 adversarial review (findings 4, 5, 12, 15). */

const TEST_CARD = fixtureSecret("link-virtual-card").replace(/\D/g, "");
const groups = (d: string) => d.match(/.{1,4}/g) ?? [];
const IBAN = resolveSample(loadSecretRegistry().patternSamples.iban?.mustMatch?.[0] ?? "");

describe("detectors run in linear time on adversarial input (finding 4)", () => {
  it.each([
    ["dotted run", "a.".repeat(100_000)],
    ["jwt-like run", "eyJ-".repeat(50_000)],
    ["sk run", "sk-".repeat(70_000)],
    ["scheme run", "a+".repeat(100_000)],
    ["BEGIN headers", ["-----BEGIN ", "PRIVATE KEY-----"].join("").repeat(8_000)],
  ])("%s", (_n, text) => {
    const t0 = performance.now();
    findSensitive(text);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

describe("encoded identifiers are still found (finding 5)", () => {
  it.each([
    ["dots", groups(TEST_CARD).join(".")],
    ["tabs", groups(TEST_CARD).join("\t")],
    [
      "full-width digits",
      [...TEST_CARD].map((c) => String.fromCharCode(0xff10 + Number(c))).join(""),
    ],
    ["zero-width joiners", [...TEST_CARD].join("​")],
    ["lowercase IBAN", IBAN.toLowerCase()],
    ["SSN with spaces", "123 45 6789"],
  ])("%s", (_n, text) => {
    expect(containsSensitive(`value: ${text} end`)).toBe(true);
  });
});

describe("anchors are required at every boundary (finding 12)", () => {
  const signer: AnchorSigner = { keyId: "k", sign: (m) => sha256(`k|${m}`) };
  const verifier: AnchorVerifier = { verify: (k, m, s) => s === sha256(`${k}|${m}`) };

  it("deleting anchors and truncating the tail is detected", async () => {
    const store = new MemoryAuditStore();
    const log = createAuditLog({
      clock: new FakeClock(),
      store,
      signer,
      verifier,
      anchorEvery: 10,
    });
    for (let i = 0; i < 25; i += 1)
      await log.append({ kind: "thread.created", actor: { type: "system" }, data: { i } });
    store.lines.splice(15);
    expect(await log.verifyDetailed()).toMatchObject({ ok: false, reason: "truncated" });
    // Dropping the anchor past the cut too is indistinguishable from a 15-entry log without an
    // external witness of the last anchored seq (the mac helper keeps it; see the README).
    store.anchorList.splice(1);
    expect(await log.verifyDetailed()).toMatchObject({ ok: true, count: 15 });
    store.anchorList.splice(0);
    expect(await log.verifyDetailed()).toMatchObject({
      ok: false,
      reason: "anchor_missing",
      brokenAtSeq: 9,
    });
  });
});

describe("receipts (finding 15)", () => {
  it("keeps long summaries as strings and redacts reconciled refs", async () => {
    const receipts = new Receipts({ clock: new FakeClock() });
    const r = await receipts.record({
      kind: "exec",
      outcome: "uncertain",
      summary: "x".repeat(5000),
    });
    expect(typeof r.summary).toBe("string");
    expect(r.summary.length).toBeLessThanOrEqual(2049);
    const token = ["sk-", "ant-", "z".repeat(30)].join("");
    const ok = await receipts.reconcile(r.id, {
      outcome: "ok",
      note: "checked",
      externalRefs: { note: token },
    });
    expect(JSON.stringify(ok)).not.toContain(token);
  });
});
