import { SETUP_TOKEN_PATTERN, SETUP_TOKEN_TTL_MS } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import {
  consumeSetupToken,
  createSetupToken,
  hashSetupToken,
  listSetupTokens,
  MAX_LIVE_SETUP_TOKENS,
  openDb,
  pruneSetupTokens,
  revokeSetupToken,
  revokeSetupTokensCreatedBy,
} from "../src/index.ts";

const T0 = Date.parse("2026-11-04T12:00:00.000Z");

/** A database whose clock the test moves. */
function clockedDb() {
  let t = T0;
  const db = openDb(":memory:", { now: () => new Date(t).toISOString() });
  return {
    db,
    set: (ms: number) => {
      t = ms;
    },
    at: (ms: number) => new Date(T0 + ms).toISOString(),
  };
}

const READ_WRITE = ["operator.read", "operator.write"] as const;

describe("setup tokens", () => {
  it("makes a 256-bit token and stores only its hash", () => {
    const { db } = clockedDb();
    const { token, record } = createSetupToken(db, { scopes: READ_WRITE });
    expect(token).toMatch(SETUP_TOKEN_PATTERN);
    expect(Buffer.from(token.slice(4), "base64url")).toHaveLength(32);
    const row = db.sqlite.prepare("SELECT * FROM setup_tokens").get() as Record<string, string>;
    expect(row.token_hash).toBe(hashSetupToken(token));
    expect(JSON.stringify(row)).not.toContain(token);
    expect(JSON.stringify(row)).not.toContain(token.slice(4));
    expect(record.status).toBe("live");
    expect(record.scopes).toEqual(["operator.read", "operator.write"]);
    // Two tokens are never the same.
    expect(createSetupToken(db, { scopes: READ_WRITE }).token).not.toBe(token);
  });

  it("can be used once", () => {
    const { db } = clockedDb();
    const { token } = createSetupToken(db, { scopes: READ_WRITE });
    expect(consumeSetupToken(db, token, "dev-a")?.scopes).toEqual(READ_WRITE);
    expect(consumeSetupToken(db, token, "dev-b")).toBeUndefined();
    const [record] = listSetupTokens(db);
    expect(record).toMatchObject({ status: "used", usedByDeviceId: "dev-a" });
  });

  it("expires after ten minutes: valid just before, refused at the instant", () => {
    expect(SETUP_TOKEN_TTL_MS).toBe(10 * 60 * 1000);
    const a = clockedDb();
    const early = createSetupToken(a.db, { scopes: READ_WRITE });
    expect(early.record.expiresAt).toBe(a.at(10 * 60 * 1000));
    a.set(T0 + 10 * 60 * 1000 - 1);
    expect(consumeSetupToken(a.db, early.token, "dev")).toBeDefined();

    const b = clockedDb();
    const late = createSetupToken(b.db, { scopes: READ_WRITE });
    b.set(T0 + 10 * 60 * 1000);
    expect(consumeSetupToken(b.db, late.token, "dev")).toBeUndefined();
    expect(listSetupTokens(b.db)[0]?.status).toBe("expired");
  });

  it("refuses a token that was revoked, and an unknown or altered one", () => {
    const { db } = clockedDb();
    const { token, record } = createSetupToken(db, { scopes: READ_WRITE });
    expect(revokeSetupToken(db, record.id)?.status).toBe("revoked");
    expect(consumeSetupToken(db, token, "dev")).toBeUndefined();
    const other = createSetupToken(db, { scopes: READ_WRITE });
    // Change the last character to a different one (the token may already end in "A").
    const last = other.token.slice(-1) === "A" ? "B" : "A";
    expect(consumeSetupToken(db, `${other.token.slice(0, -1)}${last}`, "dev")).toBeUndefined();
    expect(consumeSetupToken(db, "pst_nothing", "dev")).toBeUndefined();
    expect(consumeSetupToken(db, other.token, "dev")).toBeDefined();
  });

  it("revoking a used token changes nothing about its use", () => {
    const { db } = clockedDb();
    const { token, record } = createSetupToken(db, { scopes: READ_WRITE });
    consumeSetupToken(db, token, "dev");
    expect(revokeSetupToken(db, record.id)?.status).toBe("used");
    expect(revokeSetupToken(db, "missing")).toBeUndefined();
  });

  it("allows only a few live tokens at once; used, revoked and expired ones do not count", () => {
    const { db, set } = clockedDb();
    const made = Array.from({ length: MAX_LIVE_SETUP_TOKENS }, () =>
      createSetupToken(db, { scopes: READ_WRITE }),
    );
    expect(() => createSetupToken(db, { scopes: READ_WRITE })).toThrow(/Too many/);
    consumeSetupToken(db, made[0]?.token ?? "", "dev");
    expect(createSetupToken(db, { scopes: READ_WRITE }).record.status).toBe("live");
    expect(() => createSetupToken(db, { scopes: READ_WRITE })).toThrow(/Too many/);
    revokeSetupToken(db, made[1]?.record.id ?? "");
    createSetupToken(db, { scopes: READ_WRITE });
    set(T0 + SETUP_TOKEN_TTL_MS);
    expect(createSetupToken(db, { scopes: READ_WRITE }).record.status).toBe("live");
  });

  it("grants the scopes it was made with, and never the node scope", () => {
    const { db } = clockedDb();
    expect(() => createSetupToken(db, { scopes: ["operator.read", "node"] })).toThrow(/operator/);
    expect(() => createSetupToken(db, { scopes: [] })).toThrow(/operator/);
    const noAdmin = createSetupToken(db, { scopes: ["operator.read", "operator.approvals"] });
    expect(consumeSetupToken(db, noAdmin.token, "a")?.scopes).toEqual([
      "operator.read",
      "operator.approvals",
    ]);
    const admin = createSetupToken(db, { scopes: ["operator.read", "operator.admin"] });
    expect(consumeSetupToken(db, admin.token, "b")?.scopes).toEqual([
      "operator.read",
      "operator.admin",
    ]);
  });

  it("refuses a stored row with a scope outside the allowed set, and spends it", () => {
    const { db } = clockedDb();
    const { token, record } = createSetupToken(db, { scopes: READ_WRITE });
    db.sqlite
      .prepare("UPDATE setup_tokens SET scopes = ? WHERE id = ?")
      .run(JSON.stringify(["operator.read", "node"]), record.id);
    expect(consumeSetupToken(db, token, "dev")).toBeUndefined();
    expect(consumeSetupToken(db, token, "dev")).toBeUndefined();
  });

  it("prunes tokens that were used, revoked or expired more than a day ago, when a new one is made", () => {
    const { db, set } = clockedDb();
    const a = createSetupToken(db, { scopes: READ_WRITE });
    consumeSetupToken(db, a.token, "dev");
    createSetupToken(db, { scopes: READ_WRITE });
    const c = createSetupToken(db, { scopes: READ_WRITE });
    revokeSetupToken(db, c.record.id);
    const count = () =>
      (db.sqlite.prepare("SELECT count(*) AS n FROM setup_tokens").get() as { n: number }).n;
    set(T0 + 23 * 3_600_000);
    createSetupToken(db, { scopes: READ_WRITE });
    expect(count()).toBe(4);
    set(T0 + 25 * 3_600_000);
    createSetupToken(db, { scopes: READ_WRITE });
    // Only the one made a moment ago and the two never-used ones that expired a day ago are
    // judged by age: the used and the revoked are gone, the expired one too.
    expect(count()).toBe(2);
    expect(pruneSetupTokens(db)).toBe(0);
  });
});

describe("revoking the tokens a device made", () => {
  it("revokes its unused tokens and leaves used ones and other devices' tokens alone", () => {
    const { db } = clockedDb();
    const mine = createSetupToken(db, { scopes: READ_WRITE, createdByDeviceId: "dev-a" });
    const used = createSetupToken(db, { scopes: READ_WRITE, createdByDeviceId: "dev-a" });
    const other = createSetupToken(db, { scopes: READ_WRITE, createdByDeviceId: "dev-b" });
    expect(consumeSetupToken(db, used.token, "dev-new")).toBeDefined();

    expect(revokeSetupTokensCreatedBy(db, "dev-a")).toBe(1);

    const status = (id: string) => listSetupTokens(db).find((r) => r.id === id)?.status;
    expect(status(mine.record.id)).toBe("revoked");
    expect(status(used.record.id)).toBe("used");
    expect(status(other.record.id)).toBe("live");
    expect(consumeSetupToken(db, mine.token, "dev-x")).toBeUndefined();
    expect(revokeSetupTokensCreatedBy(db, "dev-a")).toBe(0);
  });
});
