import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  backupFileName,
  createBackup,
  type Decryption,
  type Encryption,
  restoreBackup,
  verifyBackup,
} from "@psyche/backup";
import { PsycheError } from "@psyche/protocol";
import { bool, type CommandSpec, type OptionValues, str } from "../command.ts";
import type { Ctx } from "../context.ts";
import { CliError } from "../errors.ts";
import { bytes, kv } from "../output.ts";
import { readAll } from "../prompt.ts";
import { resumeService, stopService } from "../supervisor.ts";
import { CLI_VERSION } from "../version.ts";
import { supervisorEnv } from "./service.ts";

/**
 * Copying a live SQLite database in WAL mode is not a consistent snapshot, and the CLI never
 * opens the database itself, so backups need the Gateway stopped: `--stop` stops the service,
 * snapshots, and starts it again.
 */
async function withGatewayStopped<T>(
  ctx: Ctx,
  opts: OptionValues,
  what: string,
  fn: () => Promise<T>,
): Promise<T> {
  const probe = await ctx.probe().catch(() => ({ healthy: false }));
  if (!probe.healthy) return fn();
  if (!bool(opts, "stop")) {
    throw new CliError(
      "failure",
      `The Gateway is running. Stop it first (\`psyche stop\`), or pass --stop to stop it for the ${what} and start it again afterwards.`,
    );
  }
  const s = supervisorEnv(ctx);
  await stopService(s);
  const deadline = Date.now() + ctx.opts.timeoutMs;
  while ((await ctx.probe()).healthy) {
    if (Date.now() > deadline) throw new CliError("failure", "The Gateway did not stop");
    await new Promise((r) => setTimeout(r, 250));
  }
  try {
    return await fn();
  } finally {
    await resumeService(s);
  }
}

/** Archive errors (wrong key, damaged file, existing state) are failures (exit 1), not usage. */
async function archiveErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof PsycheError) {
      throw new CliError(
        "failure",
        err.message,
        err.details && typeof err.details === "object" ? (err.details as Record<string, unknown>) : undefined,
      );
    }
    throw err;
  }
}

async function passphrase(ctx: Ctx, opts: OptionValues, confirm: boolean): Promise<string> {
  if (bool(opts, "passphrase-stdin")) {
    const p = (await readAll(ctx.deps.io.stdin)).replace(/\r?\n$/, "");
    if (!p) throw new CliError("usage", "stdin was empty");
    return p;
  }
  const env = ctx.env.PSYCHE_BACKUP_PASSPHRASE;
  if (env) return env;
  if (!ctx.deps.prompter.interactive) {
    throw new CliError(
      "usage",
      "No terminal: use --recipient, --passphrase-stdin or PSYCHE_BACKUP_PASSPHRASE",
    );
  }
  const p = await ctx.deps.prompter.secret("Backup passphrase");
  if (p.length < 12)
    throw new CliError("usage", "Use a passphrase of at least 12 characters (or --recipient)");
  if (confirm && (await ctx.deps.prompter.secret("Repeat passphrase")) !== p) {
    throw new CliError("usage", "Passphrases do not match");
  }
  return p;
}

async function encryptionFrom(ctx: Ctx, opts: OptionValues): Promise<Encryption> {
  if (bool(opts, "no-encrypt")) return { kind: "none" };
  const recipients = [...((opts.recipient as string[] | undefined) ?? [])];
  const file = str(opts, "recipients-file");
  if (file) {
    recipients.push(
      ...readFileSync(file, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#")),
    );
  }
  if (recipients.length) return { kind: "recipients", recipients };
  return { kind: "passphrase", passphrase: await passphrase(ctx, opts, true) };
}

async function decryptionFrom(ctx: Ctx, opts: OptionValues): Promise<Decryption> {
  if (bool(opts, "no-encrypt")) return { kind: "none" };
  const idFile = str(opts, "identity");
  if (idFile) {
    // `-i -` reads the identity from stdin (the Compose scripts pipe it into the container).
    const text = idFile === "-" ? await readAll(ctx.deps.io.stdin) : readFileSync(idFile, "utf8");
    const identities = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("AGE-SECRET-KEY-"));
    if (!identities.length) throw new CliError("usage", `${idFile} has no AGE-SECRET-KEY lines`);
    return { kind: "identities", identities };
  }
  return { kind: "passphrase", passphrase: await passphrase(ctx, opts, false) };
}

const ENC_OPTIONS = {
  "passphrase-stdin": {
    type: "boolean",
    description: "Read the passphrase from stdin (or set PSYCHE_BACKUP_PASSPHRASE)",
  },
  "no-encrypt": {
    type: "boolean",
    description:
      "Plain .tar.gz (not recommended: the archive holds the vault database and transcripts)",
  },
} as const;

export const backupCommands: CommandSpec[] = [
  {
    path: ["backup", "create"],
    summary: "Write an age-encrypted backup of state, workspace, vault, library and config",
    options: {
      out: {
        type: "string",
        short: "o",
        description: "Output file (default $PSYCHE_HOME/backups/psyche-<time>.tar.gz.age)",
      },
      recipient: {
        type: "string",
        short: "r",
        multiple: true,
        description: "age recipient (age1…), repeatable",
      },
      "recipients-file": { type: "string", description: "File with one age recipient per line" },
      stop: {
        type: "boolean",
        description: "Stop the Gateway service for the snapshot and start it again",
      },
      ...ENC_OPTIONS,
    },
    async run(ctx, { opts }) {
      const enc = await encryptionFrom(ctx, opts);
      const now = ctx.deps.now();
      const out = resolve(
        str(opts, "out") ?? join(ctx.home, "backups", backupFileName(now, enc.kind !== "none")),
      );
      mkdirSync(join(out, ".."), { recursive: true, mode: 0o700 });
      if (existsSync(out)) throw new CliError("usage", `${out} already exists`);
      const manifest = await withGatewayStopped(ctx, opts, "backup", () =>
        archiveErrors(() => createBackup(ctx.home, out, enc, `psyche ${CLI_VERSION}`, { now })),
      );
      const total = manifest.files.reduce((n, f) => n + f.size, 0);
      const data = {
        file: out,
        encrypted: enc.kind !== "none",
        entries: manifest.entries,
        files: manifest.files.length,
        bytes: total,
      };
      return {
        data,
        human: `${kv({ backup: out, includes: manifest.entries.join(", "), files: manifest.files.length, size: bytes(total), encrypted: enc.kind === "none" ? "NO" : enc.kind })}\nRestoring on another machine needs the vault recovery key.`,
      };
    },
  },
  {
    path: ["backup", "verify"],
    summary: "Decrypt a backup and check every file against its manifest",
    args: [{ name: "file", description: "Backup file", required: true }],
    options: {
      identity: {
        type: "string",
        short: "i",
        description: "age identity file, or - for stdin (for --recipient backups)",
      },
      ...ENC_OPTIONS,
    },
    async run(ctx, { args, opts }) {
      const file = resolve(args[0] as string);
      // Extract under $PSYCHE_HOME (0700), never next to the archive: that may be a synced or
      // shared folder, and the extracted tree is plaintext.
      const dec = await decryptionFrom(ctx, opts);
      const { manifest, problems } = await archiveErrors(() => verifyBackup(file, dec, ctx.home));
      return {
        data: {
          ok: problems.length === 0,
          createdAt: manifest.createdAt,
          files: manifest.files.length,
          problems,
        },
        human: problems.length
          ? `Backup has ${problems.length} problem(s):\n${problems.map((p) => `  ${p}`).join("\n")}`
          : `OK: ${manifest.files.length} files from ${manifest.createdAt} verified`,
        exitCode: problems.length ? 1 : 0,
      };
    },
  },
  {
    path: ["backup", "restore"],
    summary: "Restore a backup into $PSYCHE_HOME (verifies first; the Gateway must be stopped)",
    args: [{ name: "file", description: "Backup file", required: true }],
    options: {
      identity: {
        type: "string",
        short: "i",
        description: "age identity file, or - for stdin (for --recipient backups)",
      },
      force: {
        type: "boolean",
        description: "Move existing state aside (to .pre-restore-<time>/) instead of refusing",
      },
      stop: {
        type: "boolean",
        description: "Stop the Gateway service for the restore and start it again",
      },
      ...ENC_OPTIONS,
    },
    async run(ctx, { args, opts }) {
      const file = resolve(args[0] as string);
      const dec = await decryptionFrom(ctx, opts);
      const { manifest, movedAside } = await withGatewayStopped(ctx, opts, "restore", () =>
        archiveErrors(() =>
          restoreBackup(file, dec, ctx.home, { force: bool(opts, "force"), now: ctx.deps.now() }),
        ),
      );
      return {
        data: {
          restored: true,
          home: ctx.home,
          createdAt: manifest.createdAt,
          files: manifest.files.length,
          movedAside,
        },
        human: `Restored ${manifest.files.length} files from ${manifest.createdAt} into ${ctx.home}.${movedAside ? ` Previous state moved to ${movedAside}.` : ""}\nIf this is a new machine, unlock the vault with its recovery key: psyche vault unlock --recovery`,
      };
    },
  },
];
