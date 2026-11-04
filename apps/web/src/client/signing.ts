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
