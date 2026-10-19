import type { Handler } from "@psyche/web/testing";

/** Gateway answers shaped like the protocol results the CLI reads. */

export const TS = "2026-10-19T11:00:00.000Z";

export const PAIRING_REQUEST = {
  id: "01JPAIRREQ0000000000000001",
  kind: "device",
  code: "K7Q2-9XZD",
  display: "Pixel 10 (web)",
  status: "pending",
  createdAt: TS,
  expiresAt: "2026-10-19T12:10:00.000Z",
  publicKeyFingerprint: "SHA256:abcd",
  remoteAddress: "127.0.0.1",
};

export const DEVICE = {
  id: "01JDEVICE00000000000000001",
  name: "Pranav's MacBook",
  platform: "macos",
  role: "client",
  publicKey: "AAAA",
  scopes: ["operator.read", "operator.write", "operator.approvals", "operator.admin"],
  pairedAt: TS,
  lastSeenAt: "2026-10-19T12:00:00.000Z",
  revokedAt: null,
};

export const CREDENTIAL = {
  id: "01JCRED0000000000000000001",
  kind: "api_key",
  name: "Anthropic",
  slug: "anthropic",
  bindings: [{ origin: "https://api.anthropic.com" }],
  ownerConnectorId: null,
  lastUsedAt: null,
  useCount: 3,
  createdAt: TS,
  updatedAt: TS,
};

export const VAULT_STATUS = {
  state: "unlocked",
  slots: ["keychain"],
  recoveryConfirmed: true,
  autoLockMinutes: 15,
  lockAt: null,
  itemCount: 1,
};

export const AUTOMATION = {
  id: "01JAUTO000000000000000001",
  title: "Morning brief",
  kind: "briefing",
  schedule: "0 7 * * *",
  enabled: true,
  nextRunAt: "2026-10-20T07:00:00.000Z",
  lastStatus: "ok",
};

const p = (params: unknown) => (params ?? {}) as Record<string, unknown>;

export const HANDLERS: Record<string, Handler> = {
  "devices.pairing.list": () => ({ pairingRequests: [PAIRING_REQUEST] }),
  "devices.approve": (params) => ({
    device: { ...DEVICE, id: "01JDEVICE00000000000000002", name: "Pixel 10", scopes: p(params).scopes },
  }),
  "devices.deny": () => ({ pairingRequest: { ...PAIRING_REQUEST, status: "denied" } }),
  "devices.list": () => ({ devices: [DEVICE] }),
  "devices.revoke": (params) => ({ device: { ...DEVICE, id: p(params).deviceId, revokedAt: TS } }),
  "automations.list": () => ({ automations: [AUTOMATION] }),
  "automations.run": () => ({ runId: "01JRUN00000000000000000001", taskId: "01JTASK0000000000000000001" }),
  "automations.update": (params) => ({
    automation: { ...AUTOMATION, enabled: p(params).enabled },
  }),
  "vault.status": () => ({ status: VAULT_STATUS }),
  "vault.list": () => ({ credentials: [CREDENTIAL] }),
  "vault.add": (params) => ({
    credential: { ...CREDENTIAL, name: p(params).name, slug: p(params).slug ?? "github-token" },
  }),
  "vault.import": () => ({ imported: [CREDENTIAL], skipped: [{ row: 3, reason: "no password" }] }),
  "vault.lock": () => ({ status: { ...VAULT_STATUS, state: "locked" } }),
  "vault.unlock": () => ({ status: VAULT_STATUS }),
  "settings.get": () => ({
    settings: { "appearance.theme": "dark", "telemetry.enabled": false },
    stateVersion: 3,
  }),
  "settings.set": (params) => ({
    entry: { key: p(params).key, value: p(params).value, updatedAt: TS },
    stateVersion: 4,
  }),
};
