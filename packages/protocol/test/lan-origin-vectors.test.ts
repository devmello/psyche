import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { encodePairingLinkV2, lanHostKind, parsePairingLinkAny } from "../src/index.ts";

interface OriginCase {
  text: string;
  ok: boolean;
  normalized?: string;
  /** The phone is stricter than `URL.origin` here (port 0): TypeScript accepts, Swift refuses. */
  tsAccepts?: boolean;
}
const vectors = JSON.parse(
  readFileSync(join(import.meta.dirname, "vectors/lan-origin.json"), "utf8"),
) as { origins: OriginCase[]; hosts: { host: string; kind: string | null }[] };

const KEY = Buffer.alloc(32, 3).toString("base64url");
const PIN = Buffer.alloc(32, 4).toString("base64url");
const TOKEN = `pst_${Buffer.alloc(32, 7).toString("base64url")}`;
const payload = (gatewayUrl: string) => ({
  gatewayUrl,
  gatewayKey: KEY,
  certPin: PIN,
  setupToken: TOKEN,
  hostName: "Studio Mac",
});

/** Whether the v2 parser takes `gatewayUrl`, and what it gives back. */
function parsed(text: string): string | null {
  try {
    const link = encodePairingLinkV2(payload(text));
    const result = parsePairingLinkAny(link);
    return result.version === 2 ? result.payload.gatewayUrl : null;
  } catch {
    return null;
  }
}

// The iOS app parses the same links (`LanHost.lanOrigin`, `PairingLinkV2Tests`) against the same table. A row
// changed here without the Swift side, or the other way round, fails one of the two suites.
describe("lan origin vectors (shared with the iOS app)", () => {
  for (const c of vectors.origins) {
    const expectOk = c.ok || c.tsAccepts === true;
    it(`${expectOk ? "accepts" : "refuses"} ${JSON.stringify(c.text)}`, () => {
      const got = parsed(c.text);
      expect(got !== null).toBe(expectOk);
      if (c.ok) expect(got?.replace(/\/$/, "")).toBe(c.normalized);
    });
  }

  for (const h of vectors.hosts) {
    it(`classifies ${JSON.stringify(h.host)} as ${h.kind}`, () => {
      expect(lanHostKind(h.host)).toBe(h.kind);
    });
  }
});
