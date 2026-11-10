import { describe, expect, it } from "vitest";
import { keepBundleProtections } from "../src/handlers/settings.ts";

/**
 * `handlesMoney` lowers or raises whether a server's tools are payments, so it changes only
 * through `mcp.handlesMoney.set` and its card. A raw `settings.set mcp.servers` keeps it.
 */
describe("a raw mcp.servers write cannot change handlesMoney", () => {
  const stdio = { kind: "stdio", command: ["node", "x.mjs"] };

  it("keeps the stored value of an existing server, whatever the write says", () => {
    const stored = [
      { id: "bank", name: "Bank", transport: stdio, handlesMoney: true },
      { id: "shop", name: "Shop", transport: stdio },
      { id: "notes", name: "Notes", transport: stdio, handlesMoney: false },
    ];
    const incoming = [
      { id: "bank", name: "Bank", transport: stdio, handlesMoney: false },
      { id: "shop", name: "Shop", transport: stdio, handlesMoney: false },
      { id: "notes", name: "Notes", transport: stdio },
    ];
    expect(keepBundleProtections(stored, incoming)).toEqual([
      { id: "bank", name: "Bank", transport: stdio, handlesMoney: true },
      { id: "shop", name: "Shop", transport: stdio },
      { id: "notes", name: "Notes", transport: stdio, handlesMoney: false },
    ]);
  });

  it("lets a new server only turn it on", () => {
    const incoming = [
      { id: "a", name: "A", transport: stdio, handlesMoney: false },
      { id: "b", name: "B", transport: stdio, handlesMoney: true },
    ];
    expect(keepBundleProtections([], incoming)).toEqual([
      { id: "a", name: "A", transport: stdio },
      { id: "b", name: "B", transport: stdio, handlesMoney: true },
    ]);
  });
});
