import {
  FakeLineReader,
  type FakeMailSocket,
  fakeSocketPair,
  type FakeLineReader as Reader,
} from "./socket.ts";
import type { FakeMailMessage, FakeMailStore } from "./store.ts";

/**
 * Fake IMAP4rev1 server over in-memory sockets: CAPABILITY, LOGIN (quoted or literal
 * password), LIST with SPECIAL-USE, SELECT, UID SEARCH / FETCH / STORE / MOVE / COPY / EXPUNGE,
 * APPEND, LOGOUT. Options drop MOVE or SPECIAL-USE to exercise the client's fallbacks. The
 * command log never holds the password.
 */

export interface FakeImapServerOptions {
  /** Capabilities advertised after login; default includes MOVE, UIDPLUS, SPECIAL-USE. */
  capabilities?: string[];
  /** Refuse `CHARSET UTF-8` searches with `NO [BADCHARSET]`. */
  asciiSearchOnly?: boolean;
}

type Token = string | null | Uint8Array | Token[];

const FLAG: Record<string, string> = {
  Seen: "\\Seen",
  Flagged: "\\Flagged",
  Answered: "\\Answered",
  Draft: "\\Draft",
  Deleted: "\\Deleted",
};
const SPECIAL: Record<string, string> = {
  drafts: "\\Drafts",
  sent: "\\Sent",
  trash: "\\Trash",
  junk: "\\Junk",
  archive: "\\Archive",
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function imapFlags(msg: FakeMailMessage): string {
  return `(${[...msg.flags].map((f) => FLAG[f] ?? f).join(" ")})`;
}

function storeFlag(f: string): string {
  const back = Object.entries(FLAG).find(([, v]) => v.toLowerCase() === f.toLowerCase());
  return back === undefined ? f : back[0];
}

function internalDate(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
}

function parseImapDate(v: string): number {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(v);
  if (m === null) return Number.NaN;
  return Date.UTC(
    Number(m[3]),
    MONTHS.findIndex((x) => x.toLowerCase() === (m[2] as string).toLowerCase()),
    Number(m[1]),
  );
}

/** Tokenize a command line whose literals were replaced by `\u0000<i>\u0000`. */
function tokenize(line: string, literals: Uint8Array[]): Token[] {
  let i = 0;
  const read = (): Token[] => {
    const out: Token[] = [];
    while (i < line.length) {
      const c = line[i] as string;
      if (c === " ") {
        i += 1;
        continue;
      }
      if (c === ")") {
        i += 1;
        return out;
      }
      if (c === "(") {
        i += 1;
        out.push(read());
        continue;
      }
      if (c === '"') {
        i += 1;
        let s = "";
        while (i < line.length && line[i] !== '"') {
          if (line[i] === "\\") i += 1;
          s += line[i];
          i += 1;
        }
        i += 1;
        out.push(s);
        continue;
      }
      if (c === "\u0000") {
        const end = line.indexOf("\u0000", i + 1);
        out.push(literals[Number(line.slice(i + 1, end))] ?? new Uint8Array());
        i = end + 1;
        continue;
      }
      let s = "";
      while (i < line.length && line[i] !== " " && line[i] !== ")" && line[i] !== "(") {
        if (line[i] === "[") {
          while (i < line.length && line[i] !== "]") {
            s += line[i];
            i += 1;
          }
        }
        s += line[i];
        i += 1;
      }
      out.push(s.toUpperCase() === "NIL" ? null : s);
    }
    return out;
  };
  return read();
}

const str = (t: Token | undefined): string =>
  typeof t === "string" ? t : t instanceof Uint8Array ? Buffer.from(t).toString("utf8") : "";

export class FakeImapServer {
  readonly store: FakeMailStore;
  readonly options: FakeImapServerOptions;
  /** Commands as received, with LOGIN credentials and literals redacted. */
  readonly commands: string[] = [];
  readonly connections: { loggedIn: boolean; closed: boolean }[] = [];

  constructor(store: FakeMailStore, options: FakeImapServerOptions = {}) {
    this.store = store;
    this.options = options;
  }

  get capabilities(): string[] {
    return (
      this.options.capabilities ?? [
        "IMAP4rev1",
        "UIDPLUS",
        "MOVE",
        "SPECIAL-USE",
        "LITERAL+",
        "ENABLE",
      ]
    );
  }

  /** Client-side socket of a new connection; the server loop runs in the background. */
  connect(): FakeMailSocket {
    const { client, server } = fakeSocketPair();
    const conn = { loggedIn: false, closed: false };
    this.connections.push(conn);
    void this.#serve(server, conn).catch(() => undefined);
    return client;
  }

  async #serve(
    socket: FakeMailSocket,
    conn: { loggedIn: boolean; closed: boolean },
  ): Promise<void> {
    const reader = new FakeLineReader(socket);
    const send = (line: string) => socket.write(`${line}\r\n`);
    await send(`* OK [CAPABILITY ${this.capabilities.join(" ")}] fake IMAP ready`);
    let selected: string | undefined;
    for (;;) {
      const read = await this.#readCommand(reader, send);
      if (read === undefined) break;
      const { tag, name, args, logLine } = read;
      this.commands.push(logLine);
      const ok = (text = `${name} completed`) => send(`${tag} OK ${text}`);
      const no = (text: string) => send(`${tag} NO ${text}`);
      const bad = (text: string) => send(`${tag} BAD ${text}`);
      if (name === "CAPABILITY") {
        await send(`* CAPABILITY ${this.capabilities.join(" ")}`);
        await ok();
        continue;
      }
      if (name === "NOOP" || name === "ID" || name === "ENABLE") {
        await ok();
        continue;
      }
      if (name === "LOGOUT") {
        await send("* BYE logging out");
        await ok();
        break;
      }
      if (name === "LOGIN") {
        const [user, pass] = [str(args[0]), str(args[1])];
        if (user === this.store.account.address && pass === this.store.account.secret) {
          conn.loggedIn = true;
          await ok(`[CAPABILITY ${this.capabilities.join(" ")}] logged in`);
        } else await no("[AUTHENTICATIONFAILED] invalid credentials");
        continue;
      }
      if (!conn.loggedIn) {
        await no("not authenticated");
        continue;
      }
      if (name === "LIST") {
        for (const m of this.store.mailboxes) {
          const attrs = ["\\HasNoChildren"];
          if (
            this.capabilities.includes("SPECIAL-USE") &&
            m.role !== undefined &&
            SPECIAL[m.role] !== undefined
          ) {
            attrs.push(SPECIAL[m.role] as string);
          }
          await send(`* LIST (${attrs.join(" ")}) "/" "${m.name}"`);
        }
        await ok();
        continue;
      }
      if (name === "SELECT" || name === "EXAMINE") {
        const box = this.store.mailbox(str(args[0]));
        if (box === undefined) {
          await no("[NONEXISTENT] no such mailbox");
          continue;
        }
        selected = box.id;
        await send(`* ${this.store.inMailbox(box.id).length} EXISTS`);
        await send("* 0 RECENT");
        await send(`* OK [UIDVALIDITY ${box.uidValidity}] UIDs valid`);
        await send(`* OK [UIDNEXT ${box.uidNext}] predicted next UID`);
        await send("* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)");
        await ok("[READ-WRITE] selected");
        continue;
      }
      if (name === "APPEND") {
        const box = this.store.mailbox(str(args[0]));
        const flagsTok = Array.isArray(args[1]) ? (args[1] as Token[]) : [];
        const literal = args.find((a) => a instanceof Uint8Array) as Uint8Array | undefined;
        if (box === undefined || literal === undefined) {
          await no("[TRYCREATE] cannot append");
          continue;
        }
        const msg = this.store.add(box.id, literal, {
          flags: flagsTok.map((f) => storeFlag(str(f))),
        });
        await ok(`[APPENDUID ${box.uidValidity} ${msg.uid}] appended`);
        continue;
      }
      if (name === "EXPUNGE") {
        if (selected === undefined) {
          await bad("no mailbox selected");
          continue;
        }
        for (const m of this.store.inMailbox(selected).filter((x) => x.flags.has("Deleted")))
          this.store.remove(m.id);
        await ok();
        continue;
      }
      if (name === "UID") {
        if (selected === undefined) {
          await bad("no mailbox selected");
          continue;
        }
        const sub = str(args[0]).toUpperCase();
        const rest = args.slice(1);
        if (sub === "SEARCH") {
          const r = this.#search(selected, rest);
          if (r === "badcharset") {
            await no("[BADCHARSET (US-ASCII)] charset not supported");
            continue;
          }
          await send(`* SEARCH${r.length > 0 ? ` ${r.join(" ")}` : ""}`);
          await ok();
          continue;
        }
        if (sub === "FETCH") {
          const items = Array.isArray(rest[1]) ? (rest[1] as Token[]).map(str) : [str(rest[1])];
          for (const msg of this.#set(selected, str(rest[0]))) {
            const seq = this.store.inMailbox(selected).indexOf(msg) + 1;
            await send(`* ${seq} FETCH (${this.#fetchItems(msg, items, socket)})`);
          }
          await ok();
          continue;
        }
        if (sub === "STORE") {
          const op = str(rest[1]).toUpperCase();
          const flags = (Array.isArray(rest[2]) ? (rest[2] as Token[]) : [rest[2] as Token]).map(
            (f) => storeFlag(str(f)),
          );
          for (const msg of this.#set(selected, str(rest[0]))) {
            if (op.startsWith("+FLAGS")) this.store.setFlags(msg.id, flags, []);
            else if (op.startsWith("-FLAGS")) this.store.setFlags(msg.id, [], flags);
            else
              this.store.setFlags(
                msg.id,
                flags,
                [...msg.flags].filter((f) => !flags.includes(f)),
              );
          }
          await ok();
          continue;
        }
        if (sub === "MOVE" || sub === "COPY") {
          if (sub === "MOVE" && !this.capabilities.includes("MOVE")) {
            await bad("unknown command");
            continue;
          }
          const target = this.store.mailbox(str(rest[1]));
          if (target === undefined) {
            await no("[TRYCREATE] no such mailbox");
            continue;
          }
          const src = this.store.mailbox(selected) as NonNullable<
            ReturnType<FakeMailStore["mailbox"]>
          >;
          const copied: [number, number][] = [];
          for (const msg of this.#set(selected, str(rest[0]))) {
            const oldUid = msg.uid;
            if (sub === "MOVE") {
              this.store.move(msg.id, target.id);
              copied.push([oldUid, msg.uid]);
            } else {
              const dup = this.store.add(target.id, msg.raw, {
                flags: [...msg.flags],
                receivedAt: msg.receivedAt,
                threadId: msg.threadId,
              });
              copied.push([oldUid, dup.uid]);
            }
          }
          const code = `[COPYUID ${src.uidValidity} ${copied.map((c) => c[0]).join(",")} ${copied.map((c) => c[1]).join(",")}]`;
          if (sub === "MOVE") await send(`* OK ${code} moved`);
          await ok(sub === "COPY" ? `${code} copied` : "moved");
          continue;
        }
        if (sub === "EXPUNGE") {
          for (const msg of this.#set(selected, str(rest[0])))
            if (msg.flags.has("Deleted")) this.store.remove(msg.id);
          await ok();
          continue;
        }
        await bad(`unknown UID command ${sub}`);
        continue;
      }
      await bad(`unknown command ${name}`);
    }
    conn.closed = true;
    socket.end();
  }

  /** One command line with its literals; answers `+` continuations. */
  async #readCommand(reader: Reader, send: (l: string) => Promise<void>) {
    const literals: Uint8Array[] = [];
    let text = "";
    for (;;) {
      const line = await reader.readLine();
      if (line === undefined) return undefined;
      text += line;
      const m = /\{(\d+)\+?\}$/.exec(line);
      if (m === null) break;
      if (!line.endsWith("+}")) await send("+ ready for literal");
      const bytes = await reader.readBytes(Number(m[1]));
      text = `${text.slice(0, text.length - m[0].length)}\u0000${literals.length}\u0000`;
      literals.push(bytes);
    }
    const tokens = tokenize(text, literals);
    const tag = str(tokens[0]);
    const name = str(tokens[1]).toUpperCase();
    const args = tokens.slice(2);
    const logLine =
      name === "LOGIN"
        ? `${name} ${str(args[0])} ***`
        : `${name} ${args.map((a) => (a instanceof Uint8Array ? `{${a.byteLength}}` : Array.isArray(a) ? "(...)" : str(a))).join(" ")}`.trim();
    return { tag, name, args, logLine };
  }

  #set(mailbox: string, set: string): FakeMailMessage[] {
    const all = this.store.inMailbox(mailbox);
    const max = Math.max(0, ...all.map((m) => m.uid));
    const wanted = new Set<number>();
    for (const part of set.split(",")) {
      const [a, b] = part.split(":");
      const lo = a === "*" ? max : Number(a);
      const hi = b === undefined ? lo : b === "*" ? Math.max(max, lo) : Number(b);
      for (let u = Math.min(lo, hi); u <= Math.max(lo, hi); u++) wanted.add(u);
    }
    return all.filter((m) => wanted.has(m.uid));
  }

  #search(mailbox: string, args: Token[]): number[] | "badcharset" {
    let i = 0;
    let list = this.store.inMailbox(mailbox);
    if (str(args[0]).toUpperCase() === "CHARSET") {
      if (this.options.asciiSearchOnly === true && str(args[1]).toUpperCase() !== "US-ASCII")
        return "badcharset";
      i = 2;
    }
    while (i < args.length) {
      const key = str(args[i]).toUpperCase();
      i += 1;
      const value = () => {
        const v = str(args[i]);
        i += 1;
        return v;
      };
      if (key === "ALL") continue;
      if (key === "UNSEEN") list = list.filter((m) => !m.flags.has("Seen"));
      else if (key === "SEEN") list = list.filter((m) => m.flags.has("Seen"));
      else if (key === "TEXT") {
        const v = value().toLowerCase();
        list = list.filter((m) => this.store.searchable(m).includes(v));
      } else if (key === "FROM" || key === "TO" || key === "SUBJECT" || key === "CC") {
        const v = value().toLowerCase();
        list = list.filter((m) => this.store.header(m, key).toLowerCase().includes(v));
      } else if (key === "SINCE") {
        const t = parseImapDate(value());
        list = list.filter((m) => Date.parse(m.receivedAt) >= t);
      } else if (key === "BEFORE") {
        const t = parseImapDate(value());
        list = list.filter((m) => Date.parse(m.receivedAt) < t);
      } else if (key === "UID") {
        const uids = new Set(this.#set(mailbox, value()).map((m) => m.uid));
        list = list.filter((m) => uids.has(m.uid));
      }
    }
    return list.map((m) => m.uid);
  }

  #fetchItems(msg: FakeMailMessage, items: string[], _socket: FakeMailSocket): string {
    const out: string[] = [];
    const literal = (bytes: Uint8Array) =>
      `{${bytes.byteLength}}\r\n${Buffer.from(bytes).toString("latin1")}`;
    const seen = new Set<string>();
    for (const raw of ["UID", ...items]) {
      const item = raw.toUpperCase();
      if (seen.has(item)) continue;
      seen.add(item);
      if (item === "UID") out.push(`UID ${msg.uid}`);
      else if (item === "FLAGS") out.push(`FLAGS ${imapFlags(msg)}`);
      else if (item === "INTERNALDATE") out.push(`INTERNALDATE "${internalDate(msg.receivedAt)}"`);
      else if (item === "RFC822.SIZE") out.push(`RFC822.SIZE ${msg.raw.byteLength}`);
      else if (item === "BODY.PEEK[]" || item === "BODY[]" || item === "RFC822")
        out.push(`BODY[] ${literal(msg.raw)}`);
      else if (
        item.startsWith("BODY.PEEK[HEADER.FIELDS") ||
        item.startsWith("BODY[HEADER.FIELDS")
      ) {
        const fields = (/\(([^)]*)\)/.exec(item)?.[1] ?? "").split(/\s+/).filter(Boolean);
        const head =
          Buffer.from(msg.raw)
            .toString("latin1")
            .split(/\r?\n\r?\n/)[0] ?? "";
        const lines: string[] = [];
        for (const f of fields) {
          const v = this.store.header(msg, f);
          if (v !== "") lines.push(`${f[0]?.toUpperCase()}${f.slice(1).toLowerCase()}: ${v}`);
        }
        void head;
        const section = item.replace(/^BODY\.PEEK\[/, "BODY[");
        out.push(`${section} ${literal(Buffer.from(`${lines.join("\r\n")}\r\n\r\n`, "latin1"))}`);
      }
    }
    return out.join(" ");
  }
}
