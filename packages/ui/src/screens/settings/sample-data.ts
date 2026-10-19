import type { ChannelIdentity } from "@psyche/protocol";
import { IDS } from "../../fixtures/index.ts";
import type {
  AboutInfo,
  ComputerUseApp,
  DoctorCheck,
  FolderGrant,
  ProviderInfo,
  ServerStatus,
} from "./types.ts";

/**
 * Sample data for settings the fixture world does not cover (no protocol method yet). Stories
 * seed these into `settings.*` keys or pass them as shell props; tests use the same values.
 */

export function sampleProviders(): ProviderInfo[] {
  return [
    {
      id: "anthropic",
      label: "Anthropic",
      kind: "cloud",
      keyRef: "vault:anthropic-api-key",
      status: "ok",
      models: [
        { ref: "anthropic/claude-sonnet-5-5", toolCheck: "passed" },
        { ref: "anthropic/claude-haiku-5", toolCheck: "passed" },
      ],
    },
    {
      id: "openrouter",
      label: "OpenRouter",
      kind: "openrouter",
      keyRef: null,
      status: "missing",
      models: [],
    },
    {
      id: "ollama",
      label: "Ollama (this Mac)",
      kind: "local",
      keyRef: null,
      status: "ok",
      models: [
        { ref: "ollama/qwen3.8-27b", toolCheck: "passed" },
        { ref: "ollama/gemma4-e4b", toolCheck: "failed" },
        { ref: "ollama/glm-4.7-flash", toolCheck: "untested" },
      ],
    },
  ];
}

export function sampleComputerUseApps(): ComputerUseApp[] {
  return [
    { id: "com.apple.mail", name: "Mail", tier: "interact" },
    { id: "com.apple.Notes", name: "Notes", tier: "read" },
    { id: "com.apple.iCal", name: "Calendar", tier: "off" },
  ];
}

export function sampleFolders(): FolderGrant[] {
  return [
    { path: "~/Documents", access: "ro" },
    { path: "~/Projects/psyche", access: "rw" },
  ];
}

export function sampleVmShares(): FolderGrant[] {
  return [{ path: "~/Downloads/for-wren", access: "ro" }];
}

export function sampleIdentities(): ChannelIdentity[] {
  return [
    {
      id: "ident_owner",
      display: "You (owner)",
      links: ["telegram:tg:10442211", "imessage:+15550101"],
      delegatedPersona: null,
      toolAllow: null,
      createdAt: "2026-10-16T19:00:00Z",
      updatedAt: "2026-10-16T19:00:00Z",
    },
    {
      id: "ident_partner",
      display: "Partner",
      links: ["telegram:tg:20991834"],
      delegatedPersona: "Wren for Partner",
      toolAllow: ["calendar.*", "notes.read"],
      createdAt: "2026-10-17T20:00:00Z",
      updatedAt: "2026-10-17T20:00:00Z",
    },
  ];
}

export function sampleServerStatus(): ServerStatus {
  return {
    bind: "127.0.0.1:7979",
    remote: { kind: "tailscale", status: "ok", url: "https://wren.tail1234.ts.net" },
    passkeys: 2,
    sandbox: { backend: "apple-container", available: true },
    vm: { state: "stopped", name: "wren-guest" },
  };
}

export function sampleAbout(): AboutInfo {
  return {
    appVersion: "0.4.0",
    gatewayVersion: "0.4.0",
    protocolVersion: 1,
    platform: "macOS 27.0 (arm64)",
    home: "~/Library/Application Support/Psyche",
  };
}

export function sampleDoctor(): DoctorCheck[] {
  return [
    { id: "gateway", label: "Gateway", status: "ok", detail: "Listening on 127.0.0.1:7979" },
    { id: "sandbox", label: "Sandbox", status: "ok", detail: "apple-container 1.2 available" },
    {
      id: "tcc",
      label: "Screen Recording",
      status: "warn",
      detail: "Denied. Computer use can't see the screen.",
    },
    { id: "vault", label: "Vault", status: "ok", detail: "Unlocked with Touch ID" },
  ];
}

/** Settings keys these screens add on top of the fixture world's settings. */
export function sampleSettings(): Record<string, unknown> {
  return {
    "models.providers": sampleProviders(),
    "models.image": "none",
    "computerUse.enabled": true,
    "computerUse.apps": sampleComputerUseApps(),
    "permissions.folders": sampleFolders(),
    "vm.shares": sampleVmShares(),
    "vault.backend": "psyche",
    "vault.fillDefault": "once",
    "voice.pushToTalk": "fn",
    "voice.mode": "hold",
    "voice.hotkey": "Control+Option+D",
    "voice.engine": "local",
    "data.replayRetentionDays": 30,
    "data.transcriptRecall": true,
    "persona.creatureId": "moth",
  };
}

/** The Notion connector id, whose tools/list hash change revokes its grants. */
export const NOTION_ID = IDS.connectors.notion;
