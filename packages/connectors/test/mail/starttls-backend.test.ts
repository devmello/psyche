import { ResolvedSecret } from "@psyche/protocol";
import { FakeImapServer, FakeMailStore, FakeSmtpServer, seedMailStore } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import { ImapBackend } from "../../src/mail/imap/backend.ts";
import type { MailDialer, MailSecurity } from "../../src/mail/transport.ts";

const OWNER = "owner@example.com";
const PASSWORD = "fx-app-pw-7Qx9mZ2pLw";
const IMAP_HOST = "imap.example.net";
const SMTP_HOST = "smtp.example.net";
const RAW = new TextEncoder().encode("Subject: hi\r\n\r\nbody\r\n");

function secret(): ResolvedSecret {
  return new ResolvedSecret(PASSWORD, {
    credentialId: "cred_mail",
    target: { kind: "account", value: OWNER },
    maxUses: 5,
  });
}

/**
 * Backend through its real open / send paths. Ports 143 and 587 default to STARTTLS, so the
 * injected dialer must be asked for STARTTLS on both, and it hands back the plaintext fakes.
 */
function setup(opts: { imapStarttls: boolean; smtpStarttls: boolean }) {
  const store = seedMailStore(new FakeMailStore({ address: OWNER, secret: PASSWORD }));
  const imap = new FakeImapServer(store, { starttls: opts.imapStarttls });
  const smtp = new FakeSmtpServer(store);
  smtp.offerStarttls = opts.smtpStarttls;
  const dials: { host: string; port: number; security: MailSecurity | undefined }[] = [];
  const dial: MailDialer = async (host, port, _signal, security) => {
    dials.push({ host, port, security });
    if (security !== "STARTTLS") throw new Error(`unexpected plaintext-or-TLS dial to ${host}`);
    if (port === 143) return imap.connectPlain();
    if (port === 587) return smtp.connectPlain();
    throw new Error(`unexpected dial ${host}:${port}`);
  };
  const backend = new ImapBackend(
    {
      host: IMAP_HOST,
      port: 143,
      username: OWNER,
      smtpHost: SMTP_HOST,
      smtpPort: 587,
    },
    { dial },
  );
  return { backend, imap, smtp, dials };
}

describe("STARTTLS through ImapBackend: open", () => {
  it("upgrades IMAP with STARTTLS before LOGIN, against the configured host", async () => {
    const { backend, imap, dials } = setup({ imapStarttls: true, smtpStarttls: true });
    await backend.open(secret());
    expect(dials[0]).toEqual({ host: IMAP_HOST, port: 143, security: "STARTTLS" });
    expect(imap.tlsUpgrades).toBe(1);
    expect(imap.upgradedWith).toEqual([IMAP_HOST]);
    const starttls = imap.commands.findIndex((c) => /STARTTLS/.test(c));
    const login = imap.commands.findIndex((c) => /LOGIN/.test(c));
    expect(starttls).toBeGreaterThanOrEqual(0);
    expect(login).toBeGreaterThan(starttls);
  });

  it("refuses before LOGIN when the IMAP server does not offer STARTTLS", async () => {
    const { backend, imap } = setup({ imapStarttls: false, smtpStarttls: true });
    await expect(backend.open(secret())).rejects.toThrow(/does not offer STARTTLS/);
    expect(imap.commands.some((c) => /LOGIN|AUTH/i.test(c))).toBe(false);
    expect(imap.tlsUpgrades).toBe(0);
  });
});

describe("STARTTLS through ImapBackend: send", () => {
  it("upgrades SMTP with STARTTLS, repeats EHLO, then AUTHs against the configured host", async () => {
    const { backend, smtp, dials } = setup({ imapStarttls: true, smtpStarttls: true });
    const session = await backend.open(secret());
    await session.send({ to: ["friend@example.com"], subject: "hi", text: "body" }, RAW);
    expect(dials[1]).toEqual({ host: SMTP_HOST, port: 587, security: "STARTTLS" });
    expect(smtp.tlsUpgrades).toBe(1);
    expect(smtp.upgradedWith).toEqual([SMTP_HOST]);
    const starttls = smtp.commands.findIndex((c) => c === "STARTTLS");
    const auth = smtp.commands.findIndex((c) => c.startsWith("AUTH"));
    expect(starttls).toBeGreaterThanOrEqual(0);
    expect(auth).toBeGreaterThan(starttls);
    expect(smtp.sent).toHaveLength(1);
  });

  it("refuses before AUTH when the SMTP server does not offer STARTTLS", async () => {
    const { backend, smtp } = setup({ imapStarttls: true, smtpStarttls: false });
    const session = await backend.open(secret());
    await expect(
      session.send({ to: ["friend@example.com"], subject: "hi", text: "body" }, RAW),
    ).rejects.toThrow(/does not offer STARTTLS/);
    expect(smtp.commands.some((c) => c.startsWith("AUTH"))).toBe(false);
    expect(smtp.tlsUpgrades).toBe(0);
    expect(smtp.sent).toHaveLength(0);
  });
});
