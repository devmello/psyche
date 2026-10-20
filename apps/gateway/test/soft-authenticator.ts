import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";

/** Minimal CBOR encoder: unsigned / negative integers, byte strings, text strings, maps. */
function cbor(value: unknown): Buffer {
  const head = (major: number, n: number): Buffer => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]);
    const b = Buffer.alloc(5);
    b[0] = (major << 5) | 26;
    b.writeUInt32BE(n, 1);
    return b;
  };
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string") {
    const s = Buffer.from(value, "utf8");
    return Buffer.concat([head(3, s.length), s]);
  }
  if (value instanceof Uint8Array)
    return Buffer.concat([head(2, value.length), Buffer.from(value)]);
  if (value instanceof Map) {
    const parts: Buffer[] = [head(5, value.size)];
    for (const [k, v] of value) parts.push(cbor(k), cbor(v));
    return Buffer.concat(parts);
  }
  throw new Error("unsupported CBOR value");
}

const b64u = (b: Uint8Array | string) => Buffer.from(b).toString("base64url");
const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest();

/**
 * A software passkey (ES256, `none` attestation, user verified) for tests: what a browser's
 * `navigator.credentials.create()` / `get()` would return, as WebAuthn JSON.
 */
export class SoftAuthenticator {
  readonly credentialId = randomBytes(16);
  readonly #privateKey: KeyObject;
  readonly #cose: Buffer;
  #counter = 0;

  readonly rpID: string;
  readonly origin: string;

  constructor(rpID: string, origin: string) {
    this.rpID = rpID;
    this.origin = origin;
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.#privateKey = privateKey;
    const jwk = publicKey.export({ format: "jwk" });
    this.#cose = cbor(
      new Map<number, unknown>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x as string, "base64url")],
        [-3, Buffer.from(jwk.y as string, "base64url")],
      ]),
    );
  }

  get id(): string {
    return b64u(this.credentialId);
  }

  #authData(attested: boolean): Buffer {
    const flags = 0x01 | 0x04 | (attested ? 0x40 : 0); // UP | UV | AT
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(++this.#counter);
    const parts: Uint8Array[] = [sha256(this.rpID), Buffer.from([flags]), counter];
    if (attested) {
      const len = Buffer.alloc(2);
      len.writeUInt16BE(this.credentialId.length);
      parts.push(Buffer.alloc(16), len, this.credentialId, this.#cose);
    }
    return Buffer.concat(parts);
  }

  /** `navigator.credentials.create()` for registration options. */
  create(options: { challenge: string }): Record<string, unknown> {
    const clientDataJSON = JSON.stringify({
      type: "webauthn.create",
      challenge: options.challenge,
      origin: this.origin,
      crossOrigin: false,
    });
    const attestationObject = cbor(
      new Map<string, unknown>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", this.#authData(true)],
      ]),
    );
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64u(clientDataJSON),
        attestationObject: b64u(attestationObject),
        transports: ["internal"],
      },
    };
  }

  /** `navigator.credentials.get()` over a base64url challenge. */
  get(
    challenge: string,
    origin = this.origin,
  ): {
    id: string;
    rawId: string;
    type: "public-key";
    clientExtensionResults: Record<string, never>;
    response: { authenticatorData: string; clientDataJSON: string; signature: string };
  } {
    const authData = this.#authData(false);
    const clientDataJSON = JSON.stringify({
      type: "webauthn.get",
      challenge,
      origin,
      crossOrigin: false,
    });
    const signature = sign(
      "sha256",
      Buffer.concat([authData, sha256(clientDataJSON)]),
      this.#privateKey,
    );
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      clientExtensionResults: {},
      response: {
        authenticatorData: b64u(authData),
        clientDataJSON: b64u(clientDataJSON),
        signature: b64u(signature),
      },
    };
  }
}
