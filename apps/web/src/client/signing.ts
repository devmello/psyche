/**
 * `connectSigningPayload` from docs/archive/plans/s00.md "Wire spec v1" (security §10).
 * Must stay byte-identical to packages/protocol and apps/mac-helper (`ConnectSigning.payload`).
 */
export interface ConnectSigningInput {
  nonce: string;
  platform: string;
  deviceFamily: string;
  protocolVersion: number;
  serverOrigin: string;
  /** The Gateway key this client verified: the v2 payload (see packages/protocol). */
  gatewayKey?: string;
}

export function connectSigningPayload(input: ConnectSigningInput): Uint8Array<ArrayBuffer> {
  // Newline-delimited fields: one containing a newline would make the payload ambiguous (the
  // protocol package's copy refuses it the same way).
  for (const [key, value] of Object.entries({
    nonce: input.nonce,
    platform: input.platform,
    deviceFamily: input.deviceFamily,
    serverOrigin: input.serverOrigin,
    ...(input.gatewayKey === undefined ? {} : { gatewayKey: input.gatewayKey }),
  })) {
    if (typeof value !== "string" || value.length === 0 || /[\r\n]/.test(value)) {
      throw new Error(`${key} must be a non-empty single-line string`);
    }
  }
  const text = [
    input.gatewayKey === undefined ? "psyche-connect-v1" : "psyche-connect-v2",
    input.nonce,
    input.platform,
    input.deviceFamily,
    String(input.protocolVersion),
    input.serverOrigin,
    ...(input.gatewayKey === undefined ? [] : [input.gatewayKey]),
  ].join("\n");
  return new TextEncoder().encode(text);
}
