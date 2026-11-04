import { describe, expect, it } from "vitest";
import { lanHostKind, parseIpv4, parseIpv6 } from "../src/index.ts";

describe("which hosts are the local network", () => {
  it("accepts private IPv4 (RFC 1918) and nothing near it", () => {
    for (const host of [
      "10.0.0.1",
      "10.255.255.255",
      "172.16.0.1",
      "172.31.255.254",
      "192.168.1.20",
    ]) {
      expect(lanHostKind(host), host).toBe("ipv4-private");
    }
    for (const host of [
      "172.15.255.255",
      "172.32.0.1",
      "192.167.1.1",
      "192.169.1.1",
      "11.0.0.1",
      "8.8.8.8",
      "100.64.0.1", // carrier-grade NAT, a tailnet's range
      "169.254.1.1", // link-local
      "127.0.0.1",
      "0.0.0.0",
      "255.255.255.255",
      "224.0.0.251",
    ]) {
      expect(lanHostKind(host), host).toBeNull();
    }
  });

  it("refuses IPv4 spelled any way but plain decimal", () => {
    for (const host of [
      "010.0.0.1",
      "10.0.0",
      "10.0.0.1.1",
      "10.0.0.256",
      "0xa.0.0.1",
      "10.0.0.-1",
      "10.0.0.01",
    ]) {
      expect(lanHostKind(host), host).toBeNull();
    }
  });

  it("accepts IPv6 unique-local (fc00::/7), bracketed or not", () => {
    for (const host of [
      "fd00::1",
      "[fd12:3456:789a:1::1]",
      "FC00::1",
      "[fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff]",
      "fd12:3456:789a:1:0:0:0:1",
    ]) {
      expect(lanHostKind(host), host).toBe("ipv6-unique-local");
    }
  });

  it("refuses global unicast, link-local, loopback, multicast and mapped IPv6", () => {
    for (const host of [
      "[2001:db8::1]",
      "[2600:1700::1]",
      "[2a00:1450:4001::200e]",
      "[3fff::1]",
      "[fe80::1]",
      "[febf::1]",
      "[::1]",
      "[::]",
      "[ff02::fb]",
      "[fe00::1]",
      "[fbff::1]", // just below fc00
      "[100::1]",
      "[::ffff:10.0.0.1]", // IPv4-mapped: not unique-local, and a way to hide an address
      "[::ffff:a00:1]",
      "[64:ff9b::a00:1]", // NAT64
    ]) {
      expect(lanHostKind(host), host).toBeNull();
    }
  });

  it("refuses any zone id, so link-local can never be smuggled in with one", () => {
    for (const host of [
      "fe80::1%en0",
      "[fe80::1%en0]",
      "[fe80::1%25en0]",
      "fd00::1%en0",
      "10.0.0.1%en0",
    ]) {
      expect(lanHostKind(host), host).toBeNull();
    }
  });

  it("refuses malformed IPv6", () => {
    for (const host of [
      "[fd00::1::2]",
      "[fd00:1]",
      "[fd00:0:0:0:0:0:0:0:1]",
      "[fd00::gggg]",
      "[fd00:::1]",
      "[fd00::1.2.3]",
      "[]",
      "[fd00::12345]",
    ]) {
      expect(lanHostKind(host), host).toBeNull();
    }
  });

  it("accepts .local names, any case, and refuses other names", () => {
    expect(lanHostKind("studio-mac.local")).toBe("mdns");
    expect(lanHostKind("Studio-Mac.LOCAL")).toBe("mdns");
    expect(lanHostKind("a.b.local")).toBe("mdns");
    for (const host of [
      "local",
      ".local",
      "studio-mac.local.evil.com",
      "studio-mac.localhost",
      "studio-mac.ts.net",
      "example.com",
      "-bad.local",
      "bad-.local",
      "under_score.local",
      "studio mac.local",
      "",
    ]) {
      expect(lanHostKind(host), host).toBeNull();
    }
    expect(lanHostKind(`${"a".repeat(64)}.local`)).toBeNull();
  });

  it("parses what it classifies", () => {
    expect(parseIpv4("192.168.0.1")).toEqual([192, 168, 0, 1]);
    expect(parseIpv6("fd00::1")).toEqual([0xfd00, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIpv6("::")).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(parseIpv6("::ffff:10.0.0.1")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0a00, 1]);
    expect(parseIpv6("fd00::")).toEqual([0xfd00, 0, 0, 0, 0, 0, 0, 0]);
    expect(parseIpv6("1:2:3:4:5:6:7::")).toEqual([1, 2, 3, 4, 5, 6, 7, 0]);
    // `::` must stand for at least one group.
    expect(parseIpv6("1:2:3:4:5:6:7::8")).toBeNull();
  });
});
