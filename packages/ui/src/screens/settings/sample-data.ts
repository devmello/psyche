import type {
  ChannelIdentity,
  EndpointProbe,
  ModelProviderSummary,
  ModelRoles,
} from "@psyche/protocol";
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
    "permissions.policy": {
      folders: sampleFolders().map((f) => ({ path: f.path, mode: f.access })),
    },
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

/**
 * `models.list` providers as the Gateway reports them (B1, B4): a hosted provider with a key and
 * two local servers nobody has probed yet.
 */
export function sampleModelProviders(): ModelProviderSummary[] {
  return [
    {
      id: "anthropic",
      kind: "anthropic",
      label: "Anthropic",
      baseURL: "https://api.anthropic.com/v1",
      local: false,
      keyConfigured: true,
      models: [
        {
          ref: "anthropic/claude-sonnet-5-5",
          toolCheck: "agent-capable",
          capabilities: {
            toolCalling: true,
            vision: true,
            reasoning: true,
            contextWindow: 1_000_000,
            source: "catalog",
          },
        },
      ],
      probe: { state: "not_probed", models: [] },
    },
    {
      id: "lmstudio",
      kind: "lmstudio",
      label: "LM Studio",
      baseURL: "http://127.0.0.1:1234/v1",
      local: true,
      keyConfigured: false,
      models: [],
      probe: { state: "not_probed", models: [] },
    },
    {
      id: "llamacpp",
      kind: "llamacpp",
      label: "llama.cpp",
      baseURL: "http://127.0.0.1:8080/v1",
      local: true,
      keyConfigured: false,
      models: [{ ref: "llamacpp/tiny-chat", toolCheck: "chat-only" }],
      probe: { state: "not_probed", models: [] },
    },
  ];
}

export function sampleModelRoles(): ModelRoles {
  return { primary: "anthropic/claude-sonnet-5-5" };
}

/** What `models.probe` finds, recorded from LM Studio's `/api/v1/models` answer. */
export function sampleEndpointProbes(): Record<string, EndpointProbe> {
  return {
    lmstudio: {
      state: "reachable",
      probedAt: "2026-10-19T20:00:00Z",
      latencyMs: 12,
      server: "LM Studio",
      models: [
        {
          ref: "lmstudio/qwen/qwen3.8-27b",
          id: "qwen/qwen3.8-27b",
          label: "Qwen3.8 27B",
          loaded: true,
          capabilities: {
            toolCalling: true,
            vision: false,
            reasoning: true,
            contextWindow: 32768,
            source: "listing",
          },
        },
        {
          ref: "lmstudio/google/gemma-4-12b",
          id: "google/gemma-4-12b",
          loaded: false,
          capabilities: {
            toolCalling: true,
            vision: true,
            contextWindow: 131072,
            source: "listing",
          },
        },
        {
          ref: "lmstudio/text-embedding-nomic-embed-text-v1.5",
          id: "text-embedding-nomic-embed-text-v1.5",
          capabilities: { embeddings: true, toolCalling: false, source: "listing" },
        },
      ],
    },
  };
}

/** The owner's subscriptions through their CLIs, before anyone probed them. */
export function sampleSubscriptionProviders(): ModelProviderSummary[] {
  return [
    {
      id: "claude-code",
      kind: "claude-code",
      label: "Claude Code (subscription)",
      local: false,
      keyConfigured: false,
      models: [],
      probe: { state: "not_probed", models: [] },
    },
    {
      id: "codex",
      kind: "codex",
      label: "ChatGPT via Codex (subscription)",
      local: false,
      keyConfigured: false,
      models: [],
      probe: { state: "not_probed", models: [] },
    },
  ];
}

/** What probing them finds: Claude Code signed in, Codex installed but signed out. */
export function sampleSubscriptionProbes(): Record<string, EndpointProbe> {
  const caps = {
    toolCalling: true,
    vision: true,
    reasoning: true,
    embeddings: false,
    source: "catalog" as const,
  };
  return {
    "claude-code": {
      state: "reachable",
      probedAt: "2026-10-20T08:00:00Z",
      latencyMs: 410,
      server: "Claude Code 2.1.286 (claude.ai, max plan)",
      models: ["default", "opus", "sonnet", "haiku"].map((id) => ({
        ref: `claude-code/${id}`,
        id,
        capabilities: caps,
      })),
    },
    codex: {
      state: "auth_failed",
      probedAt: "2026-10-20T08:00:00Z",
      latencyMs: 120,
      server: "Codex 0.162.0",
      models: [],
      error: "Codex is installed but not signed in: run `codex login`",
    },
  };
}
