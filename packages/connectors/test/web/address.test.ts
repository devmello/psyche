import { describe, expect, it } from "vitest";
import { checkAddress, isBlockedHostname } from "../../src/web/address.ts";

describe("checkAddress", () => {
  const blocked = [
    "127.0.0.1",
    "127.255.255.254",
    "10.0.0.5",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "100.127.255.255",
    "0.0.0.0",
    "0.1.2.3",
    "224.0.0.1",
    "239.255.255.250",
    "255.255.255.255",
    "240.0.0.1",
    "198.18.0.1",
    "192.0.2.1",
    "::",
    "::1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "fe80::1%en0",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "::ffff:7f00:1",
    "::ffff:a9fe:a9fe",
    "::127.0.0.1",
    "64:ff9b::10.0.0.1",
    "2002:7f00:1::",
    "2002:c0a8:101::1",
    "2001:db8::1",
    "2001:0:4136:e378::1",
  ];
  const allowed = [
    "93.184.216.34",
    "8.8.8.8",
    "1.1.1.1",
    "172.32.0.1",
    "100.128.0.1",
    "192.169.0.1",
    "2606:4700:4700::1111",
    "2a00:1450:4001:80b::200e",
    "::ffff:8.8.8.8",
    "64:ff9b::8.8.8.8",
    "2002:808:808::1",
  ];

  for (const a of blocked) {
    it(`blocks ${a}`, () => {
      expect(checkAddress(a).ok).toBe(false);
    });
  }
  for (const a of allowed) {
    it(`allows ${a}`, () => {
      expect(checkAddress(a).ok).toBe(true);
    });
  }

  it("rejects non-IP input", () => {
    expect(checkAddress("example.com").ok).toBe(false);
  });
});

describe("isBlockedHostname", () => {
  it.each([
    "localhost",
    "LOCALHOST.",
    "app.localhost",
    "db.internal",
    "metadata.google.internal",
    "printer.local",
    "router.home.arpa",
    "",
  ])("blocks %j", (h) => {
    expect(isBlockedHostname(h)).toBe(true);
  });
  it.each(["example.com", "localhost.example.com", "internal.example.org"])("allows %s", (h) => {
    expect(isBlockedHostname(h)).toBe(false);
  });
});
