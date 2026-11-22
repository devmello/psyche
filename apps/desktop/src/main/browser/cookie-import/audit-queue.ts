import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { PsycheError } from "@psyche/protocol";
import type { ImportBrowser } from "./sources.ts";

/**
 * The local audit queue for cookie imports and removals. The record of "what sign-ins came into
 * Psyche" must never be lost because the Gateway was down or this window wasn't admin yet, so
 * main writes a value-free entry here (action, browser, domains, counts) before the cookies are
 * touched and sends it to this Mac's own Gateway later, in order, deleting each entry only after
 * the Gateway answered ok. Entries never go to a remote Gateway: the caller flushes only when
 * the connection is the local one with `operator.admin`.
 *
 * `$PSYCHE_HOME/browser/cookie-import-audit.json`, mode 0600, written atomically (temp file and
 * rename), bounded in entries, sites per entry and bytes.
 */

export interface QueuedAudit {
  action: "imported" | "removed";
  browser: ImportBrowser;
  sites: { domain: string; cookies: number }[];
}

interface Entry {
  id: string;
  at: string;
  record: QueuedAudit;
}

export const MAX_QUEUED = 500;
export const MAX_SITES_PER_ENTRY = 5000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const DOMAIN = /^[a-z0-9.-]{1,253}$/;

export function auditQueueFile(home: string): string {
  return join(home, "browser", "cookie-import-audit.json");
}

export class CookieAuditQueue {
  readonly #file: string;
  readonly #now: () => number;
  readonly #max: number;
  /** Entries whose import or removal is still running: their counts may still change. */
  readonly #open = new Set<string>();
  #flushing: Promise<number> | undefined;

  constructor(home: string, opts: { now?: () => number; max?: number } = {}) {
    this.#file = auditQueueFile(home);
    this.#now = opts.now ?? Date.now;
    this.#max = opts.max ?? MAX_QUEUED;
  }

  pending(): number {
    try {
      return this.#load().length;
    } catch {
      // A read error is not a reason to touch the file: say nothing is known, leave it be.
      return 0;
    }
  }

  /**
   * Writes the entry before the cookies are touched and returns its id. Throws when the queue
   * is full or can't be written: the caller must not go ahead then, or the record could be lost.
   */
  enqueue(record: QueuedAudit): string {
    const entries = this.#load();
    if (entries.length >= this.#max) {
      throw new PsycheError(
        "unavailable",
        "too many sign-in records are waiting for the Gateway; open Psyche with its Gateway running first",
      );
    }
    const id = randomBytes(8).toString("hex");
    entries.push({ id, at: new Date(this.#now()).toISOString(), record: clean(record) });
    if (Buffer.byteLength(serialize(entries)) > MAX_FILE_BYTES) {
      throw new PsycheError(
        "unavailable",
        "too many sign-in records are waiting for the Gateway; open Psyche with its Gateway running first",
      );
    }
    this.#save(entries);
    this.#open.add(id);
    return id;
  }

  /** The work is done: store the real counts (or, with no record, drop an entry for nothing). */
  settle(id: string, record: QueuedAudit | undefined): void {
    this.#open.delete(id);
    let entries: Entry[];
    try {
      entries = this.#load();
    } catch {
      // Unreadable right now: the planned counts stay queued rather than the entry vanishing.
      return;
    }
    const i = entries.findIndex((e) => e.id === id);
    if (i === -1) return;
    if (record === undefined || record.sites.length === 0) entries.splice(i, 1);
    else (entries[i] as Entry).record = clean(record);
    this.#save(entries);
  }

  /**
   * Sends the finished entries in order; an entry is deleted only after `send` resolves. Stops
   * at the first failure and leaves the rest for the next connect. One flush at a time.
   */
  flush(send: (record: QueuedAudit) => Promise<void>): Promise<number> {
    this.#flushing ??= this.#flush(send).finally(() => {
      this.#flushing = undefined;
    });
    return this.#flushing;
  }

  async #flush(send: (record: QueuedAudit) => Promise<void>): Promise<number> {
    let sent = 0;
    let entries: Entry[];
    try {
      this.#salvage();
      entries = this.#load();
    } catch {
      return 0;
    }
    for (const e of entries) {
      if (this.#open.has(e.id)) break;
      try {
        await send(e.record);
      } catch {
        break;
      }
      try {
        this.#save(this.#load().filter((x) => x.id !== e.id));
      } catch {
        break;
      }
      sent += 1;
    }
    return sent;
  }

  /** Throws on an I/O error and leaves the file alone; only unparseable content is set aside. */
  #load(): Entry[] {
    if (!existsSync(this.#file)) return [];
    const text = readFileSync(this.#file, "utf8");
    try {
      const doc = JSON.parse(text) as { entries?: unknown };
      if (!Array.isArray(doc.entries)) throw new Error("shape");
      return doc.entries.filter(isEntry);
    } catch {
      // Never throw the record away: keep the unparseable file aside; the next flush salvages it.
      try {
        renameSync(this.#file, `${this.#file}.corrupt-${this.#now()}`);
      } catch {
        // Nothing more to do.
      }
      return [];
    }
  }

  /** Moves the valid entries of any `.corrupt-*` file back into the queue. */
  #salvage(): void {
    const dir = dirname(this.#file);
    const prefix = `${basename(this.#file)}.corrupt-`;
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(prefix)) continue;
      const path = join(dir, name);
      let found: Entry[];
      try {
        const doc = JSON.parse(readFileSync(path, "utf8")) as { entries?: unknown };
        if (!Array.isArray(doc.entries)) continue;
        found = doc.entries.filter(isEntry);
      } catch {
        continue;
      }
      const entries = this.#load();
      const have = new Set(entries.map((e) => e.id));
      for (const e of found) if (!have.has(e.id)) entries.push(e);
      this.#save(entries);
      unlinkSync(path);
    }
  }

  #save(entries: Entry[]): void {
    mkdirSync(dirname(this.#file), { recursive: true, mode: 0o700 });
    const tmp = `${this.#file}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(tmp, serialize(entries), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.#file);
  }
}

function serialize(entries: Entry[]): string {
  return `${JSON.stringify({ version: 1, entries })}\n`;
}

/** Only the fields the audit takes, with sizes bounded. Never a cookie name or a value. */
function clean(r: QueuedAudit): QueuedAudit {
  return {
    action: r.action,
    browser: r.browser,
    sites: r.sites
      .slice(0, MAX_SITES_PER_ENTRY)
      .filter((s) => DOMAIN.test(s.domain))
      .map((s) => ({ domain: s.domain, cookies: Math.max(0, Math.floor(s.cookies)) })),
  };
}

function isEntry(e: unknown): e is Entry {
  const x = e as Entry | null;
  return (
    typeof x?.id === "string" &&
    typeof x.at === "string" &&
    (x.record?.action === "imported" || x.record?.action === "removed") &&
    typeof x.record.browser === "string" &&
    Array.isArray(x.record.sites)
  );
}
