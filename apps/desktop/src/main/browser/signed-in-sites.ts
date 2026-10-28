import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Sites the owner chose to stay signed in to (security §6 "Logged-out default"). The file lives
 * at `$PSYCHE_HOME/browser/signed-in.json` and holds origins and host names only: never a cookie
 * or a credential. The Gateway reads the origins on every new browser session, so `auto` mode
 * opens exactly these in the persistent profile and everything else stays clean.
 *
 * Shape: `{ sites: [{ origin, hosts, addedAt }], neverSave: [origin] }`. `hosts` are the hosts
 * whose cookies were moved into the profile (the site plus any SSO hosts visited during the
 * sign-in); Forget removes the cookies of those hosts. `neverSave` is the "Never for this site"
 * list for the save-to-vault prompt.
 */

export interface SignedInSite {
  origin: string;
  hosts: string[];
  addedAt: string;
}

interface Doc {
  sites: SignedInSite[];
  neverSave: string[];
}

export function signedInFile(home: string): string {
  return join(home, "browser", "signed-in.json");
}

function parse(raw: string): Doc {
  try {
    const v = JSON.parse(raw) as Partial<Doc>;
    const sites = Array.isArray(v.sites)
      ? v.sites.filter(
          (s): s is SignedInSite =>
            typeof s?.origin === "string" &&
            Array.isArray(s.hosts) &&
            s.hosts.every((h) => typeof h === "string"),
        )
      : [];
    const neverSave = Array.isArray(v.neverSave)
      ? v.neverSave.filter((o): o is string => typeof o === "string")
      : [];
    return { sites, neverSave };
  } catch {
    return { sites: [], neverSave: [] };
  }
}

export class SignedInStore {
  readonly #file: string;
  readonly #now: () => Date;

  constructor(home: string, now: () => Date = () => new Date()) {
    this.#file = signedInFile(home);
    this.#now = now;
  }

  #read(): Doc {
    try {
      return parse(readFileSync(this.#file, "utf8"));
    } catch {
      return { sites: [], neverSave: [] };
    }
  }

  #write(doc: Doc): void {
    mkdirSync(dirname(this.#file), { recursive: true, mode: 0o700 });
    const tmp = `${this.#file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.#file);
  }

  list(): SignedInSite[] {
    return this.#read().sites;
  }

  has(origin: string): boolean {
    return this.#read().sites.some((s) => s.origin === origin);
  }

  /** Adds the site, or widens the hosts of an existing entry. */
  add(origin: string, hosts: string[]): SignedInSite {
    const doc = this.#read();
    const existing = doc.sites.find((s) => s.origin === origin);
    const merged = [...new Set([...(existing?.hosts ?? []), ...hosts])].sort();
    const site: SignedInSite = {
      origin,
      hosts: merged,
      addedAt: existing?.addedAt ?? this.#now().toISOString(),
    };
    this.#write({
      ...doc,
      sites: [...doc.sites.filter((s) => s.origin !== origin), site],
    });
    return site;
  }

  /** Removes the entry and returns it (so the caller can clear its cookies). */
  forget(origin: string): SignedInSite | undefined {
    const doc = this.#read();
    const site = doc.sites.find((s) => s.origin === origin);
    if (site === undefined) return undefined;
    this.#write({ ...doc, sites: doc.sites.filter((s) => s.origin !== origin) });
    return site;
  }

  isNeverSave(origin: string): boolean {
    return this.#read().neverSave.includes(origin);
  }

  neverSave(origin: string): void {
    const doc = this.#read();
    if (doc.neverSave.includes(origin)) return;
    this.#write({ ...doc, neverSave: [...doc.neverSave, origin] });
  }
}
