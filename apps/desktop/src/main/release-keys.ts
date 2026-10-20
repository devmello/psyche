import type { ReleaseKey } from "./update-manifest.ts";

/**
 * Ed25519 public keys whose signatures the updater accepts on `update-manifest.json`
 * (security §11). The private keys never enter the repository; see docs/05-security-and-permissions.md
 * §11 "Release key" for generation (`node deploy/scripts/update-manifest.mjs keygen`), storage and
 * rotation (add the new key here one release before signing with it, remove the old one after).
 *
 * Empty until the owner generates the first release key: with no trusted key the updater stays
 * off (it never applies an update it cannot verify).
 */
export const TRUSTED_RELEASE_KEYS: readonly ReleaseKey[] = [];
