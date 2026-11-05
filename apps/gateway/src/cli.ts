import { listDevices, listPairingRequests, openDb, type PsycheDb } from "@psyche/db";
import { DeviceScope, PsycheError, type DeviceScope as Scope } from "@psyche/protocol";
import { resolveConfig } from "./config.ts";
import { loadOrCreateGatewayIdentity, rotateGatewayIdentity } from "./identity.ts";
import { DEFAULT_APPROVE_SCOPES } from "./security/recoveries.ts";

const SCOPES = (DeviceScope as unknown as { enum: Scope[] }).enum;

function parseScopes(raw: string | undefined): Scope[] {
  const scopes = (raw ?? DEFAULT_APPROVE_SCOPES.join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const s of scopes) {
    if (!SCOPES.includes(s as Scope)) throw new PsycheError("invalid_params", `unknown scope ${s}`);
  }
  return scopes as Scope[];
}

const USAGE = `usage:
  psyched                                   run the Gateway
  psyched devices list                      paired devices and pending pairing requests
  psyched devices approve <code> [scopes]   approve the pending request showing <code>
  psyched devices grant <deviceId> <scopes> set a paired device's scopes
  psyched presence reset                    after losing every passkey and helper key: let
                                            security changes run on operator.admin until a new
                                            one is registered (they fail presence_required now)
  psyched security status                   whether the security records are sealed; open alerts
                                            and waiting requests
  psyched security reseal                   accept the current security records after they
                                            failed their check
  psyched recovery cancel <id>              cancel a waiting request
  psyched identity show                     the Gateway's identity key fingerprint (what a new
                                            computer shows next to its pairing code)
  psyched identity rotate                   make a new identity key: every computer that pinned the
                                            old one stops with "identity changed" and must pair
                                            again; restart psyched afterwards
scopes: comma-separated; default for approve is every operator scope (the owner's first device)

The commands that change security state ask the running psyched and wait for its answer. Making
the first admin device (no admin exists yet), and narrowing a device's scopes, apply at once.
Everything else applies 24 hours later, with a warning on every device until then, unless it is
cancelled or approved sooner with Touch ID or a passkey on an admin device.
exit codes: 0 applied, 1 refused or failed, 2 usage, 3 waiting (applies later), 4 psyched did not
answer (nothing changed)`;

/** Exit codes of the commands that go through the running Gateway. */
export const CLI_EXIT = { applied: 0, refused: 1, usage: 2, waiting: 3, noAnswer: 4 } as const;

export interface CliOptions {
  /** How long to wait for the running Gateway to take a request (default 15 s). */
  waitMs?: number;
  /** Poll interval while waiting (default 200 ms). */
  pollMs?: number;
}

interface RequestRow {
  status: "new" | "applied" | "waiting" | "refused";
  outcome: string | null;
  recovery_id: string | null;
  not_before: string | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Queues a security request for the running Gateway (`security_requests`) and waits for its
 * answer (docs/design/security-state-integrity-2026.md §7.2). The CLI never writes security
 * state itself: a row it wrote would be undone by the seal, and the Gateway decides what an
 * unauthenticated request from the machine may become.
 */
async function submit(
  db: PsycheDb,
  op: string,
  params: Record<string, unknown>,
  out: (line: string) => void,
  opts: CliOptions,
): Promise<number> {
  const id = db.newId();
  const at = db.now();
  db.sqlite
    .prepare(
      "INSERT INTO security_requests (id, op, params, status, created_at, updated_at) VALUES (?, ?, ?, 'new', ?, ?)",
    )
    .run(id, op, JSON.stringify(params), at, at);
  const deadline = Date.now() + (opts.waitMs ?? 15_000);
  for (;;) {
    const row = db.sqlite
      .prepare(
        "SELECT status, outcome, recovery_id, not_before FROM security_requests WHERE id = ?",
      )
      .get(id) as RequestRow | undefined;
    if (row !== undefined && row.status !== "new") {
      if (row.status === "applied") {
        out(row.outcome ?? "done");
        return CLI_EXIT.applied;
      }
      if (row.status === "waiting") {
        out(row.outcome ?? `waiting until ${row.not_before}`);
        return CLI_EXIT.waiting;
      }
      out(`error: ${row.outcome ?? "refused"}`);
      return CLI_EXIT.refused;
    }
    if (Date.now() >= deadline) break;
    await sleep(opts.pollMs ?? 200);
  }
  // Nobody took it: take it back, so a later start of psyched does not act on a stale request.
  db.sqlite.prepare("DELETE FROM security_requests WHERE id = ? AND status = 'new'").run(id);
  out(
    "error: psyched did not answer, so nothing changed. Start psyched (or the Psyche app) and run this again.",
  );
  return CLI_EXIT.noAnswer;
}

function securityStatus(db: PsycheDb, out: (line: string) => void): number {
  const seal = db.sqlite.prepare("SELECT state, sealed_at FROM security_seal WHERE id = 1").get() as
    | { state: string; sealed_at: string }
    | undefined;
  out(
    seal === undefined
      ? "security records: not sealed yet (psyched seals them when it starts)"
      : `security records: ${seal.state} (sealed ${seal.sealed_at})`,
  );
  const alerts = db.sqlite
    .prepare(
      "SELECT id, kind, created_at FROM security_alerts WHERE acknowledged_at IS NULL ORDER BY created_at DESC",
    )
    .all() as { id: string; kind: string; created_at: string }[];
  for (const a of alerts) out(`alert ${a.id}  ${a.kind}  ${a.created_at}`);
  const waiting = db.sqlite
    .prepare(
      "SELECT id, op, not_before FROM security_recoveries WHERE status = 'waiting' ORDER BY not_before",
    )
    .all() as { id: string; op: string; not_before: string }[];
  for (const r of waiting) out(`waiting ${r.id}  ${r.op}  applies at ${r.not_before}`);
  out("(read from the database; psyched verifies it, this command does not)");
  return 0;
}

/**
 * Local owner commands. Reads (`devices list`, `security status`, `identity show`) work on the
 * files directly. Changes to security state go through the running Gateway (`submit`): the first
 * `operator.admin` device is still approved here on the machine (the handshake secret never
 * grants admin, S23 review PR-1-A), and once an admin exists, anything that widens access waits
 * 24 hours in plain view or needs the owner's presence on an admin device.
 */
export async function runCli(
  argv: string[],
  out: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  opts: CliOptions = {},
): Promise<number> {
  const [group, verb, a, b] = argv;
  if (group === "identity" && (verb === "show" || verb === "rotate")) {
    const home = resolveConfig().home;
    const identity =
      verb === "rotate" ? rotateGatewayIdentity(home) : loadOrCreateGatewayIdentity(home);
    out(identity.fingerprint);
    if (verb === "rotate") {
      out(
        "identity rotated: restart psyched, then pair each computer again (they refuse the new key until you forget and pair again)",
      );
    }
    return 0;
  }
  const known =
    (group === "devices" && (verb === "list" || verb === "approve" || verb === "grant")) ||
    (group === "presence" && verb === "reset") ||
    (group === "security" && (verb === "status" || verb === "reseal")) ||
    (group === "recovery" && verb === "cancel");
  if (!known) {
    out(USAGE);
    return group === undefined || group === "help" || group === "--help" ? 0 : CLI_EXIT.usage;
  }
  const db = openDb(resolveConfig().dbPath);
  try {
    if (group === "devices" && verb === "list") {
      for (const d of listDevices(db)) {
        out(
          `${d.id}  ${d.name}  ${d.platform}/${d.role}  ${d.pairedAt ? d.scopes.join(",") : "unpaired"}`,
        );
      }
      for (const r of listPairingRequests(db, { status: "pending" })) {
        out(
          `pending ${r.code}  ${r.display}  key ${r.publicKeyFingerprint ?? "?"}  via ${r.transport ?? "?"} ${r.remoteAddress ?? ""}`,
        );
      }
      return 0;
    }
    if (group === "security" && verb === "status") return securityStatus(db, out);
    if (group === "devices" && verb === "approve") {
      if (!a) {
        out(USAGE);
        return CLI_EXIT.usage;
      }
      return await submit(
        db,
        "devices.approve",
        { code: a.toUpperCase(), scopes: parseScopes(b) },
        out,
        opts,
      );
    }
    if (group === "devices" && verb === "grant") {
      if (!a || !b) {
        out(USAGE);
        return CLI_EXIT.usage;
      }
      return await submit(db, "devices.grant", { deviceId: a, scopes: parseScopes(b) }, out, opts);
    }
    if (group === "presence") return await submit(db, "presence.reset", {}, out, opts);
    if (group === "security") return await submit(db, "seal.reset", {}, out, opts);
    if (!a) {
      out(USAGE);
      return CLI_EXIT.usage;
    }
    return await submit(db, "recovery.cancel", { id: a }, out, opts);
  } catch (err) {
    out(`error: ${PsycheError.from(err).message}`);
    return CLI_EXIT.refused;
  } finally {
    db.close();
  }
}
