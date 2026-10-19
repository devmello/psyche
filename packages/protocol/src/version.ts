/**
 * Protocol version negotiated at `connect` (architecture §11, ADR-015).
 * Bump only for breaking changes; everything before v1 is additive (see CHANGES.md).
 */
export const PROTOCOL_VERSION = 1;

/** Default Gateway bind (architecture §11, security §10). */
export const DEFAULT_GATEWAY_HOST = "127.0.0.1";
export const DEFAULT_GATEWAY_PORT = 7979;
