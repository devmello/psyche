import { FakeLineReader, type FakeMailSocket, fakeSocketPair } from "./socket.ts";
import type { FakeMailStore } from "./store.ts";

/**
 * Fake SMTP submission server over in-memory sockets: EHLO, AUTH PLAIN (checked against the
 * store's account), MAIL FROM, RCPT TO, DATA (dot-unstuffed), QUIT. Sent messages are recorded;
 * the command log never holds credentials.
 */
export class FakeSmtpServer {
  readonly store: FakeMailStore;
  readonly sent: { from: string; recipients: string[]; raw: Uint8Array; queueId: string }[] = [];
  readonly commands: string[] = [];
  /** Recipients refused with 550. */
  rejectRecipients = new Set<string>();

  constructor(store: FakeMailStore) {
    this.store = store;
  }

  connect(): FakeMailSocket {
    const { client, server } = fakeSocketPair();
    void this.#serve(server).catch(() => undefined);
    return client;
  }

  async #serve(socket: FakeMailSocket): Promise<void> {
    const reader = new FakeLineReader(socket);
    const send = (line: string) => socket.write(`${line}\r\n`);
    await send("220 fake.smtp.example ESMTP ready");
    let authed = false;
    let from = "";
    let recipients: string[] = [];
    for (;;) {
      const line = await reader.readLine();
      if (line === undefined) break;
      const [verb = "", ...restParts] = line.split(" ");
      const cmd = verb.toUpperCase();
      const rest = restParts.join(" ");
      this.commands.push(cmd === "AUTH" ? "AUTH PLAIN ***" : line);
      if (cmd === "EHLO" || cmd === "HELO") {
        await send("250-fake.smtp.example");
        await send("250-AUTH PLAIN");
        await send("250-SIZE 52428800");
        await send("250 8BITMIME");
        continue;
      }
      if (cmd === "AUTH") {
        const token = rest.split(" ")[1] ?? "";
        const [, user, pass] = Buffer.from(token, "base64").toString("utf8").split("\0");
        if (user === this.store.account.address && pass === this.store.account.secret) {
          authed = true;
          await send("235 2.7.0 Authentication successful");
        } else await send("535 5.7.8 Authentication credentials invalid");
        continue;
      }
      if (cmd === "QUIT") {
        await send("221 2.0.0 Bye");
        break;
      }
      if (!authed) {
        await send("530 5.7.0 Authentication required");
        continue;
      }
      if (cmd === "MAIL") {
        from = /<([^>]*)>/.exec(rest)?.[1] ?? "";
        recipients = [];
        await send("250 2.1.0 Ok");
        continue;
      }
      if (cmd === "RCPT") {
        const rcpt = /<([^>]*)>/.exec(rest)?.[1] ?? "";
        if (this.rejectRecipients.has(rcpt)) {
          await send("550 5.1.1 User unknown");
          continue;
        }
        recipients.push(rcpt);
        await send("250 2.1.5 Ok");
        continue;
      }
      if (cmd === "DATA") {
        if (recipients.length === 0) {
          await send("503 5.5.1 Need RCPT");
          continue;
        }
        await send("354 End data with <CR><LF>.<CR><LF>");
        const lines: string[] = [];
        for (;;) {
          const l = await reader.readLine();
          if (l === undefined || l === ".") break;
          lines.push(l.startsWith("..") ? l.slice(1) : l);
        }
        const queueId = `fakeq-${String(this.sent.length + 1).padStart(4, "0")}`;
        this.sent.push({
          from,
          recipients,
          raw: Buffer.from(`${lines.join("\r\n")}\r\n`, "latin1"),
          queueId,
        });
        await send(`250 2.0.0 Ok: queued as ${queueId}`);
        continue;
      }
      if (cmd === "RSET" || cmd === "NOOP") {
        await send("250 2.0.0 Ok");
        continue;
      }
      await send("500 5.5.1 Command unrecognized");
    }
    socket.end();
  }
}
