import type { EndpointProbe, ModelCapabilityGuess } from "@psyche/protocol";

/**
 * UI-local shapes for settings data the protocol does not carry yet (providers, TCC state,
 * computer-use tiers, folder shares, server status, versions). The connected sections read them
 * from `settings.*` keys or from shell props; see the S12 report for the protocol gaps.
 */

export type ToolCheck = "passed" | "failed" | "running" | "untested";

export type ProviderKind = "cloud" | "subscription" | "openrouter" | "local";

export interface ProviderModel {
  /** `provider/model`, e.g. `anthropic/claude-sonnet-5-5`. */
  ref: string;
  /** A human name from the endpoint or the adapter's catalog; the ref stays at level 2. */
  label?: string;
  toolCheck: ToolCheck;
  /** What the last endpoint probe (or the catalog) says the model can do. */
  capabilities?: ModelCapabilityGuess;
}

/** One configured model provider. `keyRef` is a vault reference; the key never reaches the UI. */
export interface ProviderInfo {
  id: string;
  label: string;
  kind: ProviderKind;
  keyRef: string | null;
  /** `unknown`: configured, but nobody has checked the endpoint yet. */
  status: "ok" | "missing" | "invalid" | "offline" | "unknown" | "signed_out";
  models: ProviderModel[];
  /** Endpoint, shown for local servers (never carries a key). */
  baseURL?: string;
  /** The last endpoint probe (`models.probe`); `not_probed` until the owner runs one. */
  probe?: EndpointProbe;
}

/** macOS privacy (TCC) permission state as the shell reads it. */
export type TccState = "granted" | "denied" | "not_determined";

export type TccPermission = "accessibility" | "screenRecording" | "notifications";

/** `ask`: the owner has not chosen; each first use in a task asks (J5). */
export type AppTier = "ask" | "off" | "read" | "interact";

/** A per-app computer-use row. `locked` rows have a fixed cap the owner cannot raise. */
export interface ComputerUseApp {
  id: string;
  name: string;
  tier: AppTier;
  locked?: { cap: "read" | "click" | "off"; reason: string };
}

export interface FolderGrant {
  path: string;
  access: "ro" | "rw";
}

export interface ServerStatus {
  bind: string;
  remote: { kind: "none" | "tailscale" | "proxy"; status: "ok" | "off" | "error"; url?: string };
  passkeys: number;
  sandbox: { backend: string; available: boolean } | null;
  vm: { state: "none" | "stopped" | "running" | "error"; name?: string } | null;
}

export interface AboutInfo {
  appVersion: string;
  gatewayVersion: string;
  protocolVersion: number;
  platform: string;
  home: string;
}

export interface DoctorCheck {
  id: string;
  label: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}
