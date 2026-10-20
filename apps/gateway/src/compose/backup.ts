import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { redactForAudit, redactSensitive } from "@psyche/audit";
import {
  backupEntry,
  backupFileName,
  createBackup,
  type Decryption,
  deleteBackup,
  type Encryption,
  ensureBackupsDir,
  listBackups,
  markVerified,
  resolveBackupFile,
  verifyBackup,
} from "@psyche/backup";
import { type LogLevel, type LogLine, type MethodParams, PsycheError } from "@psyche/protocol";
import type { Call, HandlerDef } from "../context.ts";
import { GATEWAY_VERSION } from "../server.ts";
import type { ComposedPart, ComposeServices } from "./services.ts";

/**
 * `backup.*` and `logs.tail` (features U4, U5; Settings › Backups and the log viewer).
 *
 * Backups use `@psyche/backup`, the same archives `psyche backup` writes and restores. The
 * Gateway keeps running: `state/psyche.sqlite` comes from SQLite's online backup API on the
 * Gateway's own connection, every other file from a hard-link snapshot. Restore stays a CLI
 * operation with the Gateway stopped. Passphrases are used once and never stored or logged.
 *
 * `logs.tail` reads `$PSYCHE_HOME/logs/gateway*.log` (what the LaunchAgent writes) and passes
 * every line through the audit redactor before it leaves the Gateway, although the logger
 * already writes metadata only.
 */

export interface BackupPartOptions {
  /** age identity file for verifying recipient-encrypted archives (`PSYCHE_BACKUP_IDENTITY_FILE`). */
  identityFile?: string;
  now?: () => Date;
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
/** Bytes read from the end of each log file. */
const LOG_TAIL_BYTES = 4 << 20;

function encryptionOf(params: MethodParams<"backup.create">): Encryption {
  if (params.passphrase) return { kind: "passphrase", passphrase: params.passphrase };
  if (params.recipients?.length) return { kind: "recipients", recipients: params.recipients };
  if (params.unencrypted === true) return { kind: "none" };
  throw new PsycheError(
    "invalid_params",
    "Choose a passphrase, age recipients, or unencrypted: true (the archive holds the vault database and transcripts)",
  );
}

function decryptionOf(
  path: string,
  passphrase: string | undefined,
  identityFile?: string,
): Decryption {
  if (!path.endsWith(".age")) return { kind: "none" };
  if (passphrase) return { kind: "passphrase", passphrase };
  if (identityFile && existsSync(identityFile)) {
    const identities = readFileSync(identityFile, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("AGE-SECRET-KEY-"));
    if (identities.length) return { kind: "identities", identities };
  }
  throw new PsycheError(
    "invalid_params",
    "This archive is encrypted: give its passphrase (recipient archives need PSYCHE_BACKUP_IDENTITY_FILE on the Gateway)",
  );
}

export function composeBackup(
  services: ComposeServices,
  opts: BackupPartOptions = {},
): ComposedPart {
  const { home } = services;
  const now = opts.now ?? (() => new Date(services.clock.now()));
  let running = false;

  /** One backup or verify at a time: both read the whole home and can take a while. */
  async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (running)
      throw new PsycheError("conflict", "Another backup or verification is running", {
        retryable: true,
      });
    running = true;
    try {
      return await fn();
    } finally {
      running = false;
    }
  }

  const handlers: Record<string, HandlerDef> = {
    "backup.list": {
      run: () => ({ backups: listBackups(home), dir: ensureBackupsDir(home) }),
    },
    "backup.create": {
      run: (_call: Call, params: MethodParams<"backup.create">) =>
        exclusive(async () => {
          const enc = encryptionOf(params);
          const at = now();
          const file = backupFileName(at, enc.kind !== "none");
          const manifest = await createBackup(
            home,
            join(ensureBackupsDir(home), file),
            enc,
            `psyched ${GATEWAY_VERSION}`,
            {
              now: at,
              snapshots: {
                // A consistent copy while the Gateway keeps writing (WAL mode).
                "state/psyche.sqlite": async (dest) => {
                  await services.db.sqlite.backup(dest);
                },
              },
            },
          );
          services.logger?.log("info", "backup created", { file, files: manifest.files.length });
          return { backup: backupEntry(home, file), files: manifest.files.length };
        }),
    },
    "backup.verify": {
      run: (_call: Call, params: MethodParams<"backup.verify">) =>
        exclusive(async () => {
          const path = resolveBackupFile(home, params.file);
          const dec = decryptionOf(path, params.passphrase, opts.identityFile);
          const { manifest, problems } = await verifyBackup(path, dec, home);
          if (problems.length === 0) markVerified(home, params.file, now());
          return {
            ok: problems.length === 0,
            files: manifest.files.length,
            problems,
            backup: backupEntry(home, params.file),
          };
        }),
    },
    "backup.delete": {
      run: (_call: Call, params: MethodParams<"backup.delete">) => {
        deleteBackup(home, params.file);
        services.logger?.log("info", "backup deleted", { file: params.file });
        return { ok: true };
      },
    },
    "logs.tail": {
      run: (_call: Call, params: MethodParams<"logs.tail">) => tailLogs(home, params),
    },
  };
  return { handlers };
}

function logFiles(home: string): string[] {
  const dir = join(home, "logs");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith("gateway") && f.endsWith(".log"))
    .map((f) => join(dir, f));
}

function readTail(file: string): string[] {
  const size = statSync(file).size;
  const len = Math.min(size, LOG_TAIL_BYTES);
  const buf = Buffer.alloc(len);
  const fd = openSync(file, "r");
  try {
    readSync(fd, buf, 0, len, size - len);
  } finally {
    closeSync(fd);
  }
  const lines = buf.toString("utf8").split("\n");
  if (len < size) lines.shift(); // the first line is probably cut
  return lines.filter(Boolean);
}

/** One JSON log line → a redacted `LogLine`, or null for anything that is not one. */
export function parseLogLine(raw: string): LogLine | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const { ts, level, msg, subsystem, ...rest } = v as Record<string, unknown>;
  if (typeof ts !== "string" || Number.isNaN(Date.parse(ts)) || typeof msg !== "string")
    return null;
  if (typeof level !== "string" || !(level in LEVELS)) return null;
  const fields = redactForAudit(rest, { maxStringLength: 512 });
  return {
    ts: new Date(ts).toISOString(),
    level: level as LogLevel,
    ...(typeof subsystem === "string"
      ? { subsystem: redactSensitive(subsystem).slice(0, 64) }
      : {}),
    msg: redactSensitive(msg),
    ...(Object.keys(fields).length ? { fields } : {}),
  };
}

export function tailLogs(
  home: string,
  params: MethodParams<"logs.tail">,
): { lines: LogLine[]; subsystems: string[]; truncated: boolean } {
  const want = params.lines ?? 200;
  const min = LEVELS[params.level ?? "debug"];
  const since = params.since ? Date.parse(params.since) : Number.NEGATIVE_INFINITY;
  const search = params.search?.toLowerCase();
  const subsystems = new Set<string>();
  const matched: LogLine[] = [];
  for (const file of logFiles(home)) {
    for (const raw of readTail(file)) {
      const line = parseLogLine(raw);
      if (!line) continue;
      if (line.subsystem) subsystems.add(line.subsystem);
      if (LEVELS[line.level] < min) continue;
      if (params.subsystem && line.subsystem !== params.subsystem) continue;
      if (Date.parse(line.ts) < since) continue;
      if (
        search &&
        !`${line.msg} ${JSON.stringify(line.fields ?? {})}`.toLowerCase().includes(search)
      )
        continue;
      matched.push(line);
    }
  }
  matched.sort((a, b) => a.ts.localeCompare(b.ts));
  return {
    lines: matched.slice(-want),
    subsystems: [...subsystems].sort(),
    truncated: matched.length > want,
  };
}
