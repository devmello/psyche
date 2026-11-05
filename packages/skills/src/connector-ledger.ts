import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PsycheError } from "@psyche/protocol";
import type { ConnectorRequests } from "./connector-bundle.ts";

/**
 * Which installed MCP servers came from a connector bundle, and what the owner approved for each
 * (`$PSYCHE_HOME/connectors/bundles.json`, 0600, inside the home the agent's file tools cannot
 * reach). It is what an update is compared with (the diff and the widening), what a signer change
 * is judged against, what keeps a bundle's server off after its key or bundle was revoked, and
 * what makes an imported server unexportable (only a connector the owner set up is signed).
 */
export interface ConnectorLedgerRecord {
  serverId: string;
  /** The exact signed bytes' hash (the id a revocation notice uses). */
  bundleHash: string;
  signerKeyId?: string;
  signerName?: string;
  /** Earlier keys the bundle's rotation chain named (nearest first). */
  signerAncestors: string[];
  title: string;
  version?: string;
  createdAt: string;
  requests: ConnectorRequests;
  /** Hash of the script payload tree as approved (`treeHash` of an empty tree when none). */
  treeHash: string;
  /** Where the payload is on disk, when the bundle carried files. */
  dir?: string;
  installedAt: string;
}

interface LedgerFile {
  v: 1;
  servers: Record<string, ConnectorLedgerRecord>;
}

export const CONNECTOR_LEDGER_FILE = join("connectors", "bundles.json");

export class ConnectorLedger {
  readonly path: string;
  #now: () => number;

  constructor(home: string, now: () => number = Date.now) {
    this.path = join(home, CONNECTOR_LEDGER_FILE);
    this.#now = now;
  }

  #read(): LedgerFile {
    if (!existsSync(this.path)) return { v: 1, servers: {} };
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(this.path, "utf8"));
    } catch {
      data = undefined;
    }
    const f = data as LedgerFile | undefined;
    // A corrupt record trusts nothing and is never silently rewritten.
    if (f?.v !== 1 || typeof f.servers !== "object" || f.servers === null)
      throw new PsycheError("internal", "cannot read the connector bundle records");
    return f;
  }

  #write(f: LedgerFile): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    rmSync(tmp, { force: true });
    writeFileSync(tmp, `${JSON.stringify(f, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(tmp, this.path);
  }

  get(serverId: string): ConnectorLedgerRecord | undefined {
    const r = this.#read().servers[serverId];
    return r === undefined ? undefined : structuredClone(r);
  }

  list(): ConnectorLedgerRecord[] {
    return Object.values(this.#read().servers).map((r) => structuredClone(r));
  }

  /** Records (or replaces) the approved bundle of a server. */
  put(rec: Omit<ConnectorLedgerRecord, "installedAt">): ConnectorLedgerRecord {
    const f = this.#read();
    const full: ConnectorLedgerRecord = {
      ...rec,
      installedAt: new Date(this.#now()).toISOString(),
    };
    f.servers[rec.serverId] = full;
    this.#write(f);
    return structuredClone(full);
  }

  remove(serverId: string): void {
    const f = this.#read();
    if (f.servers[serverId] === undefined) return;
    delete f.servers[serverId];
    this.#write(f);
  }
}
