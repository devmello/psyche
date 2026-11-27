// Gateway client code shared by the web shell and the desktop main process (S11).
// Pure TypeScript over the platform's WebSocket and fetch: no DOM, no Node built-ins.
export * from "./backoff.ts";
export * from "./connection.ts";
export * from "./encoding.ts";
export * from "./handshake.ts";
export * from "./signing.ts";
export * from "./status.ts";
