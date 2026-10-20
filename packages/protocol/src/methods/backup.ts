import { type Static, Type } from "@sinclair/typebox";
import { IsoDateTime, Nullable } from "../common.ts";
import { defineMethod } from "./define.ts";

/**
 * `backup.*` (feature U4; architecture §12 and §14; data model §12): local backups of
 * `$PSYCHE_HOME` (`state/`, `workspace/`, `vault/`, `library/`, channel sessions) in the format
 * `psyche backup` writes (a tar.gz with a SHA-256 manifest, age-encrypted unless the owner opts
 * out). The vault stays encrypted inside the archive. Restoring replaces the Gateway's own
 * state, so it stays a CLI operation with the Gateway stopped (`psyche backup restore`); these
 * methods cover the in-app flow: list, create, verify, delete.
 */

/** One backup archive under `$PSYCHE_HOME/backups/`. */
export const BackupInfo = Type.Object(
  {
    /** File name inside the backups directory (never a path the client chooses). */
    file: Type.String({ minLength: 1, maxLength: 255 }),
    createdAt: IsoDateTime,
    bytes: Type.Integer({ minimum: 0 }),
    /** `true` when the archive is age-encrypted (passphrase or recipients). */
    encrypted: Type.Boolean(),
    /** When `backup.verify` last passed on this archive, or null. */
    verifiedAt: Nullable(IsoDateTime),
  },
  { $id: "BackupInfo" },
);
export type BackupInfo = Static<typeof BackupInfo>;

/** A backup archive's file name: no separators, no traversal. */
const BackupFile = Type.String({ minLength: 1, maxLength: 255, pattern: "^[^/\\\\]+$" });

/**
 * Encryption choice for `backup.create`: a passphrase (sent once; never stored or logged),
 * age recipients (public keys), or `unencrypted: true`. Exactly one applies; passphrase wins.
 */
const EncryptionParams = {
  passphrase: Type.Optional(Type.String({ minLength: 12, maxLength: 1024 })),
  recipients: Type.Optional(
    Type.Array(Type.String({ pattern: "^age1[a-z0-9]+$" }), { minItems: 1, maxItems: 32 }),
  ),
  unencrypted: Type.Optional(Type.Boolean()),
} as const;

export const BackupMethods = {
  "backup.list": defineMethod({
    params: Type.Object({}),
    result: Type.Object({
      backups: Type.Array(BackupInfo),
      /** The backups directory, for the restore instructions. */
      dir: Type.String(),
    }),
    scope: "operator.read",
    description: "Lists local backup archives, newest first.",
  }),
  "backup.create": defineMethod({
    params: Type.Object(EncryptionParams),
    result: Type.Object({
      backup: BackupInfo,
      /** Files in the manifest. */
      files: Type.Integer({ minimum: 0 }),
    }),
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Writes a consistent snapshot of $PSYCHE_HOME to the backups directory (SQLite online backup for the state DB). Refuses without passphrase, recipients or unencrypted: true. Side-effecting.",
  }),
  "backup.verify": defineMethod({
    params: Type.Object({
      file: BackupFile,
      /** Needed for passphrase-encrypted archives; recipient archives need the identity file on the Gateway. */
      passphrase: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
    }),
    result: Type.Object({
      ok: Type.Boolean(),
      files: Type.Integer({ minimum: 0 }),
      /** Human-readable problems (hash mismatches, missing files), empty when ok. */
      problems: Type.Array(Type.String()),
      backup: BackupInfo,
    }),
    scope: "operator.admin",
    description: "Decrypts an archive into a scratch directory and checks every manifest hash.",
  }),
  "backup.delete": defineMethod({
    params: Type.Object({ file: BackupFile }),
    result: Type.Object({ ok: Type.Boolean() }),
    scope: "operator.admin",
    sideEffecting: true,
    description: "Deletes one backup archive. Side-effecting.",
  }),
} as const;
