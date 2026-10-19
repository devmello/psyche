// @psyche/browser (S08): the agent-owned browser. See README.md.
// Test helpers (fixture site, mock desktop) live at "@psyche/browser/testing"; the driver
// conformance suite (imports vitest) at "@psyche/browser/conformance".

export * from "./bridge/allowlist.ts";
export * from "./bridge/bridge.ts";
export { BRIDGE_MAX_FRAME_BYTES, FrameConnection } from "./bridge/framing.ts";
export { type CdpTarget, looksLikeCardNumber, PageController } from "./cdp/page.ts";
export * from "./downloads/library.ts";
export * from "./downloads/sniff.ts";
export { DriverBase, type DriverDeps } from "./drivers/base.ts";
export { CdpBridgeDriver } from "./drivers/cdp.ts";
export { PlaywrightDriver, type PlaywrightDriverOptions } from "./drivers/playwright.ts";
export * from "./origin/canonical.ts";
export * from "./origin/partition.ts";
export * from "./origin/policy.ts";
export * from "./origin/reputation.ts";
export * from "./profiles.ts";
export * from "./recording/recorder.ts";
export * from "./recording/store.ts";
export { buildSnapshot, extractText, SECURE_MASK } from "./snapshot/builder.ts";
export { RefRegistry } from "./snapshot/refs.ts";
export { bindingHash, canonicalJson, classifyActivation } from "./tools/classify.ts";
export { ApprovalGate, type CallContext } from "./tools/gate.ts";
export { type BrowserToolDeps, browserToolDefs, registerBrowserTools } from "./tools/register.ts";
export * from "./types.ts";
