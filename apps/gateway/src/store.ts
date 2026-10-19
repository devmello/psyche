import type { Device, DeviceScope, PairingRequest, SettingEntry, Settings } from "@psyche/protocol";

/**
 * The persistence the bootstrap Gateway needs, kept narrow so the db adapter is the only file
 * that knows `@psyche/db` (S01 replaces this with its repositories).
 */
export interface GatewayStore {
  getDevice(id: string): Device | null;
  /** Inserts a device, or updates name, key, scopes and pairing time of a non-revoked one. */
  upsertDevice(device: Device): void;
  touchDevice(id: string, at: string): void;

  createPairingRequest(input: {
    deviceId: string;
    display: string;
    expiresAt: string;
  }): PairingRequest;
  findPendingPairingForDevice(deviceId: string, now: string): PairingRequest | null;
  expirePendingPairingsForDevice(deviceId: string, now: string): void;
  countPendingPairings(now: string): number;

  getSettings(keys?: string[]): Settings;
  setSetting(key: string, value: unknown): SettingEntry;

  /** Runs `fn` in one transaction. */
  transaction<T>(fn: () => T): T;

  readStateVersion(): number;
  writeStateVersion(v: number): void;

  close(): void;
}

export const OPERATOR_SCOPES: DeviceScope[] = [
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.admin",
];

/** Setting keys starting with this prefix are Gateway-internal and never exposed. */
export const INTERNAL_SETTING_PREFIX = "_";
export const STATE_VERSION_KEY = "_gateway.stateVersion";
