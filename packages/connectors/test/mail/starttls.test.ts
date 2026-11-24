import { FakeImapServer, FakeMailStore, FakeSmtpServer, seedMailStore } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import {
  IMAP_DEFAULT_PORT,
  parseImapConfig,
  SMTP_DEFAULT_PORT,
} from "../../src/mail/imap/backend.ts";
import { ImapClient } from "../../src/mail/imap/client.ts";
import { SmtpClient } from "../../src/mail/smtp/client.ts";

const OWNER = "owner@example.com";
const PASSWORD = "fx-app-pw-7Qx9mZ2pLw";
const HOST = "mail.example.net";

function mailStore() {
  return seedMailStore(new FakeMailStore({ address: OWNER, secret: PASSWORD }));
}

describe("STARTTLS: IMAP", () => {
  it("upgrades the plaintext connection and only then logs in", async () => {
    const imap = new FakeImapServer(mailStore(), { starttls: true });
    const client = new ImapClient(imap.connectPlain());
    await client.greeting();
    await client.startTls(HOST);
    await client.login(OWNER, PASSWORD);
    expect(imap.tlsUpgrades).toBe(1);
    expect(client.has("IMAP4REV1")).toBe(true);
    const starttls = imap.commands.findIndex((c) => /STARTTLS/.test(c));
    const login = imap.commands.findIndex((c) => /LOGIN/.test(c));
    expect(starttls).toBeGreaterThanOrEqual(0);
    expect(login).toBeGreaterThan(starttls);
    client.close();
  });

  it("refuses before LOGIN when the server does not offer STARTTLS", async () => {
    const imap = new FakeImapServer(mailStore(), {});
    const client = new ImapClient(imap.connectPlain());
    await client.greeting();
    await expect(client.startTls(HOST)).rejects.toThrow(/does not offer STARTTLS/);
    expect(imap.commands.some((c) => /LOGIN|AUTH/i.test(c))).toBe(false);
    expect(imap.tlsUpgrades).toBe(0);
    client.close();
  });
});

describe("STARTTLS: SMTP", () => {
  it("upgrades, repeats EHLO, then authenticates over TLS", async () => {
    const smtp = new FakeSmtpServer(mailStore());
    smtp.offerStarttls = true;
    const client = new SmtpClient(smtp.connectPlain());
    await client.greeting();
    await client.ehlo();
    await client.startTls(HOST);
    await client.ehlo();
    await client.authPlain(OWNER, PASSWORD);
    expect(smtp.tlsUpgrades).toBe(1);
    const starttls = smtp.commands.findIndex((c) => c === "STARTTLS");
    const auth = smtp.commands.findIndex((c) => c.startsWith("AUTH"));
    expect(starttls).toBeGreaterThanOrEqual(0);
    expect(auth).toBeGreaterThan(starttls);
    await client.quit();
  });

  it("refuses before AUTH when EHLO does not offer STARTTLS", async () => {
    const smtp = new FakeSmtpServer(mailStore());
    const client = new SmtpClient(smtp.connectPlain());
    await client.greeting();
    await client.ehlo();
    await expect(client.startTls(HOST)).rejects.toThrow(/does not offer STARTTLS/);
    expect(smtp.commands.some((c) => c.startsWith("AUTH"))).toBe(false);
    expect(smtp.tlsUpgrades).toBe(0);
    await client.quit();
  });
});

describe("STARTTLS: config defaults", () => {
  it("picks the security mode from the port", () => {
    expect(parseImapConfig({ host: HOST, username: "u" })).toMatchObject({
      port: IMAP_DEFAULT_PORT,
      security: "TLS",
      smtpPort: SMTP_DEFAULT_PORT,
      smtpSecurity: "TLS",
    });
    expect(parseImapConfig({ host: HOST, username: "u", port: 143, smtpPort: 587 })).toMatchObject({
      port: 143,
      security: "STARTTLS",
      smtpPort: 587,
      smtpSecurity: "STARTTLS",
    });
  });

  it("takes an explicit mode and refuses anything other than TLS or STARTTLS", () => {
    expect(
      parseImapConfig({ host: HOST, username: "u", port: 1143, security: "STARTTLS" }),
    ).toMatchObject({ security: "STARTTLS" });
    expect(() => parseImapConfig({ host: HOST, username: "u", security: "PLAIN" })).toThrow(
      /"TLS" or "STARTTLS"/,
    );
    expect(() => parseImapConfig({ host: HOST, username: "u", security: "none" })).toThrow();
    expect(() => parseImapConfig({ host: HOST, username: "u", smtpSecurity: "plain" })).toThrow();
  });
});
