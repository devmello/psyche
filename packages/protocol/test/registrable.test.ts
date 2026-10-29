import { describe, expect, it } from "vitest";
import { registrableDomain, sameSite } from "../src/registrable.ts";

describe("registrableDomain", () => {
  it("collapses subdomains to the site", () => {
    expect(registrableDomain("canvas.ucsc.edu")).toBe("ucsc.edu");
    expect(registrableDomain("login.ucsc.edu")).toBe("ucsc.edu");
    expect(registrableDomain(".Login.UCSC.edu")).toBe("ucsc.edu");
    expect(registrableDomain("a.b.example.com")).toBe("example.com");
  });
  it("handles country second-level suffixes and bare hosts", () => {
    expect(registrableDomain("www.bbc.co.uk")).toBe("bbc.co.uk");
    expect(registrableDomain("shop.example.com.au")).toBe("example.com.au");
    expect(registrableDomain("example.com")).toBe("example.com");
    expect(registrableDomain("localhost")).toBe("localhost");
    expect(registrableDomain("127.0.0.1")).toBe("127.0.0.1");
  });
  it("tells sites apart", () => {
    expect(sameSite("canvas.ucsc.edu", "login.ucsc.edu")).toBe(true);
    expect(sameSite("ucsc.edu", "ucla.edu")).toBe(false);
    expect(sameSite("a.co.uk", "b.co.uk")).toBe(false);
  });
});
