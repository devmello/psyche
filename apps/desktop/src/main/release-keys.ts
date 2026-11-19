import type { ReleaseKey } from "./update-manifest.ts";

/**
 * Ed25519 public keys whose signatures the updater accepts on `update-manifest.json`
 * (security §11). The private keys never enter the repository; see docs/05-security-and-permissions.md
 * §11 "Release key" for generation (`node deploy/scripts/update-manifest.mjs keygen`), storage and
 * rotation (add the new key here one release before signing with it, remove the old one after).
 *
 * With no trusted key the updater stays off (it never applies an update it cannot verify).
 */
export const TRUSTED_RELEASE_KEYS: readonly ReleaseKey[] = [
  // The owner's first release key, generated 2026-11-19. Its private half is held by the owner
  // (password manager, and RELEASE_SIGNING_KEY in the GitHub `release` environment), never here.
  { keyId: "37312dba0e2eddad", publicKey: "hbM9GyfYsfhRfSZX6E6QimBS7GqkV2CMlDpVdxolxNk=" },
];
