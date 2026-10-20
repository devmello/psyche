import { PsycheError } from "@psyche/protocol";
import { LineReader, type MailSocket } from "../transport.ts";
import { MailAuthError } from "../types.ts";
import { asString, fetchItems, type ImapToken, LITERAL_MARK, tokenize } from "./parser.ts";

/**
 * Minimal IMAP4rev1 client (RFC 9051 / 3501 subset) for the mail connector: LOGIN, CAPABILITY,
 * LIST (SPECIAL-USE attributes when offered), SELECT, UID SEARCH / FETCH / STORE / MOVE (or
 * COPY + \Deleted + EXPUNGE), APPEND, LOGOUT. One command at a time; untagged responses are
 * collected per command. Strings go quoted when they are safe ASCII, otherwise as literals.
 */

export interface ImapResponse {
  status: "OK" | "NO" | "BAD";
  text: string;
  /** Response code in `[...]`, e.g. `BADCHARSET`, `TRYCREATE` (first word), and the whole bracket. */
  code?: string;
  codeText?: string;
  untagged: ImapToken[][];
}

export interface ImapListEntry {
  name: string;
  attributes: string[];
  delimiter: string | null;
}

export interface ImapSelect {
  exists: number;
  uidValidity: number;
  uidNext: number;
}

export interface ImapFetched {
  uid: number;
  items: Map<string, ImapToken>;
}

export class ImapError extends Error {
  readonly response: ImapResponse;
  constructor(command: string, response: ImapResponse) {
    super(`IMAP ${command} ${response.status}: ${response.text}`);
    this.name = "ImapError";
    this.response = response;
  }
}

export type CommandPart = string | { literal: Uint8Array } | { string: string };

const SAFE_QUOTED = /^[\x20-\x7e]*$/;

export class ImapClient {
  readonly #socket: MailSocket;
  readonly #reader: LineReader;
  #tag = 0;
  #capabilities = new Set<string>();
  #closed = false;

  constructor(socket: MailSocket) {
    this.#socket = socket;
    this.#reader = new LineReader(socket);
  }

  get capabilities(): ReadonlySet<string> {
    return this.#capabilities;
  }

  has(capability: string): boolean {
    return this.#capabilities.has(capability.toUpperCase());
  }

  /** Read the server greeting; `* PREAUTH` is accepted, `* BYE` is an error. */
  async greeting(): Promise<void> {
    const line = await this.#readLine();
    const tokens = tokenize(line.text, line.literals);
    const status = asString(tokens[1]).toUpperCase();
    if (asString(tokens[0]) !== "*" || (status !== "OK" && status !== "PREAUTH")) {
      throw new PsycheError("unavailable", "IMAP server did not greet");
    }
    this.#captureCapabilities(line.text);
  }

  async capability(): Promise<ReadonlySet<string>> {
    const r = await this.command("CAPABILITY");
    for (const u of r.untagged) {
      if (asString(u[1]).toUpperCase() === "CAPABILITY") {
        this.#capabilities = new Set(u.slice(2).map((t) => asString(t).toUpperCase()));
      }
    }
    return this.#capabilities;
  }

  async login(user: string, password: string): Promise<void> {
    let r: ImapResponse;
    try {
      r = await this.command("LOGIN", [{ string: user }, { string: password }]);
    } catch (err) {
      if (err instanceof ImapError) r = err.response;
      else throw err;
    }
    if (r.status !== "OK") {
      throw new MailAuthError("invalid_credentials", `IMAP login refused (${r.code ?? r.status})`);
    }
    this.#captureCapabilities(r.text);
    if (this.#capabilities.size === 0) await this.capability();
  }

  async list(): Promise<ImapListEntry[]> {
    const r = await this.command("LIST", ['""', '"*"']);
    const out: ImapListEntry[] = [];
    for (const u of r.untagged) {
      if (asString(u[1]).toUpperCase() !== "LIST") continue;
      const attrs = Array.isArray(u[2]) ? u[2].map((a) => asString(a)) : [];
      const delimiter = u[3] === null ? null : asString(u[3]);
      const name = asString(u[4]);
      if (name !== "") out.push({ name: decodeMailboxName(name), attributes: attrs, delimiter });
    }
    return out;
  }

  async select(mailbox: string): Promise<ImapSelect> {
    const r = await this.command("SELECT", [{ string: encodeMailboxName(mailbox) }]);
    const sel: ImapSelect = { exists: 0, uidValidity: 0, uidNext: 0 };
    for (const u of r.untagged) {
      const a = asString(u[1]).toUpperCase();
      const b = asString(u[2]).toUpperCase();
      if (b === "EXISTS") sel.exists = Number(a);
      if (a === "OK" && Array.isArray(u[2])) {
        const code = asString(u[2][0]).toUpperCase();
        if (code === "UIDVALIDITY") sel.uidValidity = Number(asString(u[2][1]));
        if (code === "UIDNEXT") sel.uidNext = Number(asString(u[2][1]));
      }
    }
    // Servers that send `* OK [UIDNEXT 5] ...` as text rather than a list (tokenizer keeps `[` groups
    // in the atom): fall back to a regex over the raw lines.
    for (const line of r.untaggedText) {
      const v = /\[UIDVALIDITY (\d+)\]/i.exec(line);
      if (v !== null) sel.uidValidity = Number(v[1]);
      const n = /\[UIDNEXT (\d+)\]/i.exec(line);
      if (n !== null) sel.uidNext = Number(n[1]);
    }
    return sel;
  }

  /** `UID SEARCH` with the given criteria parts; returns UIDs ascending. */
  async uidSearch(criteria: CommandPart[], charset?: string): Promise<number[]> {
    const parts: CommandPart[] =
      charset === undefined ? criteria : ["CHARSET", charset, ...criteria];
    const r = await this.command("UID SEARCH", parts);
    const uids: number[] = [];
    for (const u of r.untagged) {
      if (asString(u[1]).toUpperCase() !== "SEARCH") continue;
      for (const t of u.slice(2)) {
        const n = Number(asString(t));
        if (Number.isInteger(n) && n > 0) uids.push(n);
      }
    }
    return uids.sort((a, b) => a - b);
  }

  async uidFetch(set: string, items: string): Promise<ImapFetched[]> {
    const r = await this.command("UID FETCH", [set, items]);
    const out: ImapFetched[] = [];
    for (const u of r.untagged) {
      if (asString(u[2]).toUpperCase() !== "FETCH" || !Array.isArray(u[3])) continue;
      const map = fetchItems(u[3]);
      const uid = Number(asString(map.get("UID")));
      if (Number.isInteger(uid)) out.push({ uid, items: map });
    }
    return out;
  }

  async uidStore(uid: number, op: "+FLAGS" | "-FLAGS", flags: string[]): Promise<void> {
    if (flags.length === 0) return;
    await this.command("UID STORE", [String(uid), `${op}.SILENT`, `(${flags.join(" ")})`]);
  }

  /** MOVE when the server has it, else COPY + \Deleted + (UID) EXPUNGE. The new UID comes from COPYUID (UIDPLUS). */
  async uidMove(uid: number, mailbox: string): Promise<{ newUid?: number }> {
    const box = { string: encodeMailboxName(mailbox) };
    let r: Awaited<ReturnType<ImapClient["command"]>>;
    if (this.has("MOVE")) {
      r = await this.command("UID MOVE", [String(uid), box]);
    } else {
      r = await this.command("UID COPY", [String(uid), box]);
      await this.uidStore(uid, "+FLAGS", ["\\Deleted"]);
      if (this.has("UIDPLUS")) await this.command("UID EXPUNGE", [String(uid)]);
      else await this.command("EXPUNGE");
    }
    const m = /\[COPYUID \d+ \S+ (\d+)/i.exec([r.codeText ?? "", ...r.untaggedText].join("\n"));
    return m === null ? {} : { newUid: Number(m[1]) };
  }

  /** The new UID comes from APPENDUID (UIDPLUS) when the server offers it. */
  async append(mailbox: string, flags: string[], raw: Uint8Array): Promise<{ uid?: number }> {
    const parts: CommandPart[] = [{ string: encodeMailboxName(mailbox) }];
    if (flags.length > 0) parts.push(`(${flags.join(" ")})`);
    parts.push({ literal: raw });
    const r = await this.command("APPEND", parts);
    const m = /^APPENDUID \d+ (\d+)/i.exec(r.codeText ?? "");
    return m === null ? {} : { uid: Number(m[1]) };
  }

  async logout(): Promise<void> {
    if (this.#closed) return;
    try {
      await this.command("LOGOUT");
    } catch {
      // the server may close first
    } finally {
      this.close();
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#socket.end();
  }

  /** Send one command and collect its responses; `NO` / `BAD` throw `ImapError`. */
  async command(
    name: string,
    parts: CommandPart[] = [],
  ): Promise<ImapResponse & { untaggedText: string[] }> {
    if (this.#closed) throw new PsycheError("unavailable", "IMAP connection closed");
    this.#tag += 1;
    const tag = `A${String(this.#tag).padStart(4, "0")}`;
    let line = `${tag} ${name}`;
    const pending: Uint8Array[] = [];
    for (const p of parts) {
      if (typeof p === "string") line += ` ${p}`;
      else if ("string" in p) {
        if (SAFE_QUOTED.test(p.string) && !p.string.includes("\\") && !p.string.includes('"')) {
          line += ` "${p.string}"`;
        } else if (SAFE_QUOTED.test(p.string)) {
          line += ` "${p.string.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
        } else {
          const bytes = Buffer.from(p.string, "utf8");
          line += ` {${bytes.byteLength}}`;
          pending.push(bytes);
          line = await this.#flushLiteral(line, pending);
        }
      } else {
        line += ` {${p.literal.byteLength}}`;
        pending.push(p.literal);
        line = await this.#flushLiteral(line, pending);
      }
    }
    await this.#socket.write(`${line}\r\n`);
    const untagged: ImapToken[][] = [];
    const untaggedText: string[] = [];
    for (;;) {
      const got = await this.#readLine();
      if (got.text.startsWith("* ")) {
        untagged.push(tokenize(got.text, got.literals));
        untaggedText.push(got.text);
        continue;
      }
      if (got.text.startsWith("+")) continue;
      if (!got.text.startsWith(`${tag} `)) continue;
      const m = /^\S+ (OK|NO|BAD)(?: \[([^\]]+)\])? ?(.*)$/i.exec(got.text);
      const status = (m?.[1] ?? "BAD").toUpperCase() as ImapResponse["status"];
      const response: ImapResponse & { untaggedText: string[] } = {
        status,
        text: m?.[3] ?? got.text,
        untagged,
        untaggedText,
        ...(m?.[2] === undefined
          ? {}
          : { code: m[2].split(" ")[0]?.toUpperCase(), codeText: m[2] }),
      };
      if (status !== "OK") throw new ImapError(name, response);
      return response;
    }
  }

  /** Send the command so far plus the literal after the server's continuation `+`. */
  async #flushLiteral(line: string, pending: Uint8Array[]): Promise<string> {
    const literal = pending.pop();
    if (literal === undefined) return line;
    await this.#socket.write(`${line}\r\n`);
    for (;;) {
      const got = await this.#readLine();
      if (got.text.startsWith("+")) break;
      if (got.text.startsWith("* ")) continue;
      // A tagged NO/BAD instead of a continuation.
      const m = /^\S+ (OK|NO|BAD)(?: \[([^\]]+)\])? ?(.*)$/i.exec(got.text);
      throw new ImapError("literal", {
        status: (m?.[1] ?? "BAD").toUpperCase() as ImapResponse["status"],
        text: m?.[3] ?? got.text,
        untagged: [],
        ...(m?.[2] === undefined ? {} : { code: m[2].split(" ")[0]?.toUpperCase() }),
      });
    }
    await this.#socket.write(literal);
    return "";
  }

  /** A full response line with its literals read and replaced by markers. */
  async #readLine(): Promise<{ text: string; literals: Uint8Array[] }> {
    const literals: Uint8Array[] = [];
    let text = "";
    for (;;) {
      const line = await this.#reader.readLine();
      if (line === undefined) {
        this.#closed = true;
        throw new PsycheError("unavailable", "IMAP connection closed", { retryable: true });
      }
      text += line;
      const m = /\{(\d+)\}$/.exec(line);
      if (m === null) return { text, literals };
      const n = Number(m[1]);
      if (n > 64 * 1024 * 1024) throw new PsycheError("unavailable", "IMAP literal too large");
      const bytes = await this.#reader.readBytes(n);
      text = `${text.slice(0, text.length - m[0].length)}${LITERAL_MARK}${literals.length}${LITERAL_MARK}`;
      literals.push(bytes);
    }
  }

  #captureCapabilities(text: string): void {
    const m = /\[CAPABILITY ([^\]]+)\]/i.exec(text);
    if (m !== null)
      this.#capabilities = new Set((m[1] as string).split(" ").map((c) => c.toUpperCase()));
  }
}

/** RFC 3501 modified UTF-7 is not implemented: names are used as the server sent them. */
export function decodeMailboxName(name: string): string {
  return name;
}

export function encodeMailboxName(name: string): string {
  return name;
}
