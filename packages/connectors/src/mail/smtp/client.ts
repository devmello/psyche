import { PsycheError } from "@psyche/protocol";
import { LineReader, type MailSocket } from "../transport.ts";
import { MailAuthError } from "../types.ts";

/**
 * Minimal SMTP submission client (RFC 5321 / 4954 / 6409 subset) over implicit TLS or a STARTTLS
 * upgrade: EHLO, STARTTLS, AUTH PLAIN, MAIL FROM, RCPT TO, DATA with dot-stuffing, QUIT. One
 * message per connection.
 */

export interface SmtpReply {
  code: number;
  lines: string[];
}

export class SmtpError extends Error {
  readonly reply: SmtpReply;
  constructor(command: string, reply: SmtpReply) {
    super(`SMTP ${command} ${reply.code}: ${reply.lines.join(" ")}`);
    this.name = "SmtpError";
    this.reply = reply;
  }
}

export class SmtpClient {
  #socket: MailSocket;
  #reader: LineReader;
  #extensions = new Set<string>();

  constructor(socket: MailSocket) {
    this.#socket = socket;
    this.#reader = new LineReader(socket);
  }

  get extensions(): ReadonlySet<string> {
    return this.#extensions;
  }

  async greeting(): Promise<void> {
    const r = await this.#reply();
    if (r.code !== 220) throw new SmtpError("greeting", r);
  }

  async ehlo(name = "psyche.local"): Promise<void> {
    const r = await this.command(`EHLO ${name}`, 250);
    this.#extensions = new Set(r.lines.slice(1).map((l) => l.split(" ")[0]?.toUpperCase() ?? ""));
  }

  /**
   * Upgrade with STARTTLS before AUTH. Refuses unless EHLO advertised STARTTLS, and refuses when
   * bytes arrived after the 220 reply. The caller runs EHLO again on the TLS socket.
   */
  async startTls(host: string): Promise<void> {
    if (!this.#extensions.has("STARTTLS")) {
      throw new PsycheError(
        "unavailable",
        "SMTP server does not offer STARTTLS; refusing to authenticate without TLS",
      );
    }
    const socket = this.#socket;
    if (socket.upgradeTls === undefined) {
      throw new PsycheError("unavailable", "SMTP connection cannot upgrade to TLS");
    }
    await this.command("STARTTLS", 220);
    if (this.#reader.buffered() > 0 || (socket.pendingBytes?.() ?? 0) > 0) {
      throw new PsycheError(
        "unavailable",
        "SMTP server sent data after the STARTTLS reply; refusing to continue",
      );
    }
    const secure = await socket.upgradeTls(host);
    this.#socket = secure;
    this.#reader = new LineReader(secure);
    this.#extensions = new Set();
  }

  async authPlain(user: string, password: string): Promise<void> {
    const token = Buffer.from(`\0${user}\0${password}`, "utf8").toString("base64");
    let r: SmtpReply;
    try {
      r = await this.command(`AUTH PLAIN ${token}`, 235);
    } catch (err) {
      if (err instanceof SmtpError) r = err.reply;
      else throw err;
    }
    if (r.code !== 235)
      throw new MailAuthError("invalid_credentials", `SMTP authentication refused (${r.code})`);
  }

  /** Returns the server's queue id when the 250 reply names one. */
  async send(from: string, recipients: string[], raw: Uint8Array): Promise<{ queueId?: string }> {
    if (recipients.length === 0) throw new PsycheError("invalid_params", "no recipients");
    await this.command(
      `MAIL FROM:<${from}>${this.#extensions.has("8BITMIME") ? " BODY=8BITMIME" : ""}`,
      250,
    );
    for (const rcpt of recipients) await this.command(`RCPT TO:<${rcpt}>`, [250, 251]);
    await this.command("DATA", 354);
    const text = Buffer.from(raw)
      .toString("latin1")
      .replace(/\r?\n/g, "\r\n")
      .replace(/^\./gm, "..");
    await this.#socket.write(`${text}${text.endsWith("\r\n") ? "" : "\r\n"}.\r\n`);
    const r = await this.#reply();
    if (r.code !== 250) throw new SmtpError("DATA", r);
    const m = /queued as (\S+)|id=(\S+)/i.exec(r.lines.join(" "));
    const queueId = m?.[1] ?? m?.[2];
    return queueId === undefined ? {} : { queueId };
  }

  async quit(): Promise<void> {
    try {
      await this.command("QUIT", 221);
    } catch {
      // closing anyway
    } finally {
      this.#socket.end();
    }
  }

  async command(line: string, expect: number | number[]): Promise<SmtpReply> {
    if (/[\r\n]/.test(line))
      throw new PsycheError("invalid_params", "SMTP command contains a line break");
    await this.#socket.write(`${line}\r\n`);
    const r = await this.#reply();
    const ok = Array.isArray(expect) ? expect.includes(r.code) : r.code === expect;
    if (!ok) throw new SmtpError(line.split(" ")[0] ?? line, r);
    return r;
  }

  async #reply(): Promise<SmtpReply> {
    const lines: string[] = [];
    let code = 0;
    for (;;) {
      const line = await this.#reader.readLine();
      if (line === undefined)
        throw new PsycheError("unavailable", "SMTP connection closed", { retryable: true });
      const m = /^(\d{3})([ -])(.*)$/.exec(line);
      if (m === null) continue;
      code = Number(m[1]);
      lines.push(m[3] ?? "");
      if (m[2] === " ") return { code, lines };
    }
  }
}
