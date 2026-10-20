import { createHash } from "node:crypto";
import { webauthnChallengeFor } from "@psyche/gateway/compose";
import { describe, expect, it, vi } from "vitest";
import {
  type AuthenticationJSON,
  approvalPresence,
  browserAuthenticator,
  PasskeyCancelled,
  passkeyErrorText,
  presenceChallengeHex,
  presenceFromAssertion,
  webauthnChallenge,
} from "../../src/lib/webauthn.ts";

const ASSERTION: AuthenticationJSON = {
  id: "cred_1",
  rawId: "cred_1",
  type: "public-key",
  response: { authenticatorData: "ad", clientDataJSON: "cd", signature: "sig", userHandle: "uh" },
  clientExtensionResults: {},
};

/** `navigator.credentials` and the `PublicKeyCredential` JSON helpers, mocked. */
function mockedBrowser(result: unknown = { toJSON: () => ASSERTION }) {
  const credentials = { create: vi.fn(async () => result), get: vi.fn(async () => result) };
  const PublicKeyCredential = {
    parseCreationOptionsFromJSON: vi.fn((o: unknown) => ({ parsed: "create", o })),
    parseRequestOptionsFromJSON: vi.fn((o: unknown) => ({ parsed: "get", o })),
  };
  return {
    globals: { isSecureContext: true, PublicKeyCredential, navigator: { credentials } },
    credentials,
    PublicKeyCredential,
  };
}

describe("presence challenge", () => {
  it("is the broker's sha256 over the approval, binding and answer token", async () => {
    const hex = await presenceChallengeHex("ap_1", "b".repeat(64), "tok");
    expect(hex).toBe(
      createHash("sha256")
        .update(`psyche.presence.v1|ap_1|${"b".repeat(64)}|tok`)
        .digest("hex"),
    );
    // Its 32 raw bytes are the WebAuthn challenge, as the Gateway's verifier expects (the
    // broker's form carries a `sha256:` prefix).
    expect(webauthnChallenge(hex)).toBe(webauthnChallengeFor(`sha256:${hex}`));
    expect(Buffer.from(webauthnChallenge(hex), "base64url")).toHaveLength(32);
  });

  it("maps an assertion to a webauthn presence for this device", () => {
    expect(presenceFromAssertion("dev_1", ASSERTION)).toEqual({
      kind: "webauthn",
      deviceId: "dev_1",
      signature: "sig",
      payload: {
        credentialId: "cred_1",
        authenticatorData: "ad",
        clientDataJSON: "cd",
        userHandle: "uh",
      },
    });
    const noHandle = { ...ASSERTION, response: { ...ASSERTION.response, userHandle: null } };
    expect(presenceFromAssertion("dev_1", noHandle).payload).not.toHaveProperty("userHandle");
  });
});

describe("browserAuthenticator", () => {
  it("is unavailable outside a secure context or without the JSON helpers", () => {
    const { globals } = mockedBrowser();
    expect(browserAuthenticator({ ...globals, isSecureContext: false })).toBeNull();
    expect(browserAuthenticator({ ...globals, navigator: {} })).toBeNull();
    expect(browserAuthenticator({ ...globals, PublicKeyCredential: {} })).toBeNull();
    expect(browserAuthenticator(globals)).not.toBeNull();
  });

  it("parses the JSON options for navigator.credentials and returns toJSON()", async () => {
    const { globals, credentials, PublicKeyCredential } = mockedBrowser();
    const auth = browserAuthenticator(globals);
    expect(await auth?.create({ challenge: "c1" })).toEqual(ASSERTION);
    expect(PublicKeyCredential.parseCreationOptionsFromJSON).toHaveBeenCalledWith({
      challenge: "c1",
    });
    expect(credentials.create).toHaveBeenCalledWith({
      publicKey: { parsed: "create", o: { challenge: "c1" } },
    });
    expect(await auth?.get({ challenge: "c2" })).toEqual(ASSERTION);
    expect(credentials.get).toHaveBeenCalledWith({
      publicKey: { parsed: "get", o: { challenge: "c2" } },
    });
  });

  it("treats a missing credential as a cancelled prompt", async () => {
    const auth = browserAuthenticator(mockedBrowser(null).globals);
    await expect(auth?.get({})).rejects.toBeInstanceOf(PasskeyCancelled);
  });
});

describe("approvalPresence", () => {
  const approval = { id: "ap_9", bindingHash: "a".repeat(64) };

  it("asks for this device's passkeys with the approval's challenge", async () => {
    const { globals, credentials } = mockedBrowser();
    const call = vi.fn(async () => ({
      ceremonyId: "cer_1",
      options: {
        challenge: "server-challenge",
        rpId: "psyche.example.test",
        allowCredentials: [{ id: "cred_1", type: "public-key", transports: ["internal"] }],
        userVerification: "required",
      },
    }));
    const host = {
      deviceId: async () => "dev_web",
      authenticator: browserAuthenticator(globals) ?? expect.fail("no authenticator"),
    };
    const presence = await approvalPresence(call, host, approval, "tok_9");
    expect(call).toHaveBeenCalledWith("passkeys.reauth.begin", {});
    const hex = await presenceChallengeHex("ap_9", approval.bindingHash, "tok_9");
    const passed = (credentials.get.mock.calls[0] as unknown as [{ publicKey: { o: unknown } }])[0]
      .publicKey.o;
    expect(passed).toEqual({
      challenge: webauthnChallengeFor(hex),
      rpId: "psyche.example.test",
      allowCredentials: [{ id: "cred_1", type: "public-key", transports: ["internal"] }],
      userVerification: "required",
    });
    expect(presence).toMatchObject({ kind: "webauthn", deviceId: "dev_web", signature: "sig" });
  });

  it("explains a device without a passkey and a Gateway without https", async () => {
    const host = { deviceId: async () => "d", authenticator: { create: vi.fn(), get: vi.fn() } };
    const failing = (code: string) => async () => {
      throw Object.assign(new Error(code), { code });
    };
    await expect(approvalPresence(failing("not_found"), host, approval, "t")).rejects.toThrow(
      /no passkey yet/,
    );
    await expect(approvalPresence(failing("unavailable"), host, approval, "t")).rejects.toThrow(
      /https address/,
    );
    expect(host.authenticator.get).not.toHaveBeenCalled();
  });
});

describe("passkeyErrorText", () => {
  it("reads a cancelled or mismatched prompt plainly", () => {
    expect(passkeyErrorText(new DOMException("x", "NotAllowedError"))).toMatch(/cancelled/);
    expect(passkeyErrorText(new PasskeyCancelled())).toMatch(/cancelled/);
    expect(passkeyErrorText(new DOMException("x", "SecurityError"))).toMatch(/publicOrigin/);
    expect(passkeyErrorText(new Error("boom"))).toBe("boom");
  });
});
