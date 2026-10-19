import { generateKeyPairSync, sign, verify } from "node:crypto";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  CapabilityManifest,
  CONNECT_SIGNING_PREFIX,
  connectSigningPayload,
  type ErrorCode,
  okRes,
  PROTOCOL_VERSION,
  PsycheError,
  parseFrame,
  reqFrame,
  serializeFrame,
  validateParams,
  validateResult,
} from "../src/index.ts";

function codeOf(fn: () => unknown): ErrorCode | undefined {
  try {
    fn();
  } catch (err) {
    if (err instanceof PsycheError) return err.code;
    throw err;
  }
  return undefined;
}

const SIGNING_INPUT = {
  nonce: "q83vEjRWeJA",
  platform: "macos",
  deviceFamily: "mac-helper",
  protocolVersion: 1,
  serverOrigin: "http://127.0.0.1:7979",
};

describe("connectSigningPayload", () => {
  it("produces the exact bytes from the wire spec", () => {
    const bytes = connectSigningPayload(SIGNING_INPUT);
    const expected = "psyche-connect-v1\nq83vEjRWeJA\nmacos\nmac-helper\n1\nhttp://127.0.0.1:7979";
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(bytes).toString("utf8")).toBe(expected);
    expect(Buffer.from(bytes).toString("hex")).toBe(Buffer.from(expected, "utf8").toString("hex"));
    expect(bytes.length).toBe(70);
    expect(Buffer.from(bytes.subarray(0, 18)).toString()).toBe(`${CONNECT_SIGNING_PREFIX}\n`);
  });

  it("encodes non-ASCII fields as UTF-8", () => {
    const bytes = connectSigningPayload({
      ...SIGNING_INPUT,
      serverOrigin: "https://psyché.example",
    });
    expect(Buffer.from(bytes).toString("utf8").endsWith("https://psyché.example")).toBe(true);
  });

  it("rejects fields that would make the payload ambiguous", () => {
    expect(
      codeOf(() => connectSigningPayload({ ...SIGNING_INPUT, deviceFamily: "desktop\nweb" })),
    ).toBe("invalid_params");
    expect(codeOf(() => connectSigningPayload({ ...SIGNING_INPUT, nonce: "" }))).toBe(
      "invalid_params",
    );
    expect(codeOf(() => connectSigningPayload({ ...SIGNING_INPUT, serverOrigin: "a\rb" }))).toBe(
      "invalid_params",
    );
    expect(codeOf(() => connectSigningPayload({ ...SIGNING_INPUT, protocolVersion: 1.5 }))).toBe(
      "invalid_params",
    );
  });

  it("signs and verifies with a raw base64url Ed25519 key, as connect.verify expects", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const raw = publicKey.export({ format: "jwk" }).x as string;
    const nonce = Buffer.alloc(32, 7).toString("base64url");
    const payload = connectSigningPayload({
      ...SIGNING_INPUT,
      nonce,
      protocolVersion: PROTOCOL_VERSION,
    });
    const signature = sign(null, payload, privateKey).toString("base64url");

    validateParams("connect", {
      protocolVersion: { min: 1, max: PROTOCOL_VERSION },
      deviceId: "dev_helper",
      publicKey: raw,
      role: "node",
      platform: "macos",
      deviceFamily: "mac-helper",
      name: "Mac helper",
      capabilities: [],
    });
    validateParams("connect.verify", { nonce, signature });
    validateResult("connect", {
      phase: "challenge",
      nonce,
      serverOrigin: SIGNING_INPUT.serverOrigin,
      protocolVersion: PROTOCOL_VERSION,
      expiresAt: "2026-10-18T20:12:05Z",
    });
    expect(verify(null, payload, publicKey, Buffer.from(signature, "base64url"))).toBe(true);
    const tampered = connectSigningPayload({
      ...SIGNING_INPUT,
      nonce,
      serverOrigin: "http://evil.test",
    });
    expect(verify(null, tampered, publicKey, Buffer.from(signature, "base64url"))).toBe(false);
  });
});

describe("node protocol", () => {
  const receipt = {
    id: "rcpt_1",
    kind: "computer_action",
    taskId: null,
    toolCallId: "tc_1",
    approvalId: null,
    outcome: "ok",
    summary: "Clicked Send",
    externalRefs: {},
    payload: null,
    createdAt: "2026-10-18T20:11:05Z",
  };

  it("validates the node.invoke → accepted → node.event → node.result exchange", () => {
    const invoke = reqFrame("g1", "node.invoke", {
      invocationId: "inv_1",
      capability: "computer.click",
      params: { x: 10, y: 20 },
      approvalId: "appr_1",
    });
    const parsed = parseFrame(serializeFrame(invoke));
    expect(parsed.type === "req" && validateParams("node.invoke", parsed.params)).toBeTruthy();
    const res = parseFrame(serializeFrame(okRes("g1", { accepted: true })));
    if (res.type !== "res" || !res.ok) throw new Error("expected an ok res");
    expect(validateResult("node.invoke", res.payload)).toEqual({ accepted: true });
    expect(
      validateParams("node.event", { invocationId: "inv_1", data: { progress: 0.5 } }),
    ).toBeTruthy();
    expect(
      validateParams("node.result", { invocationId: "inv_1", ok: true, result: {}, receipt }),
    ).toBeTruthy();
    expect(
      validateParams("node.result", {
        invocationId: "inv_1",
        ok: false,
        error: { code: "cancelled", message: "user pressed Esc" },
      }),
    ).toBeTruthy();
  });

  it("rejects malformed node frames", () => {
    expect(codeOf(() => validateParams("node.invoke", { capability: "x", params: {} }))).toBe(
      "invalid_params",
    );
    expect(codeOf(() => validateResult("node.invoke", { accepted: false }))).toBe("internal");
    expect(
      codeOf(() =>
        validateParams("node.result", { invocationId: "i", ok: true, receipt: { id: "r" } }),
      ),
    ).toBe("invalid_params");
  });

  it("validates a capability manifest", () => {
    const manifest = {
      platform: "macos",
      version: "0.1.0",
      capabilities: [
        { name: "computer.click", sideEffect: "write", targetKind: "app" },
        { name: "notify.show", sideEffect: "write", streaming: false },
      ],
    };
    expect(Value.Check(CapabilityManifest, manifest)).toBe(true);
    expect(Value.Check(CapabilityManifest, { ...manifest, capabilities: [{ name: "x" }] })).toBe(
      false,
    );
  });
});
