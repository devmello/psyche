import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { getSetting, openDb, setSetting } from "@psyche/db";
import { describe, expect, it } from "vitest";
import type { Call } from "../src/context.ts";
import {
  mergeStoredFolderReals,
  recordPolicyFolderReals,
  settingsHandlers,
} from "../src/handlers/settings.ts";

/** The `real` a write records for a new folder: its real path, or none when it is not there. */
function realOf(path: string): { real?: string } {
  try {
    return { real: realpathSync(path) };
  } catch {
    return {};
  }
}

/** Settings → File access cannot add a sensitive root either (security §3.5). */

function callWith(db: ReturnType<typeof openDb>): Call {
  return {
    ctx: {
      db,
      config: { home: `${homedir()}/.psyche` },
      bus: { bumpStateVersion: () => 1 },
      presenceState: () => "off",
    },
    identity: { scopes: ["operator.admin"] },
    emit: () => undefined,
  } as unknown as Call;
}

const setRun = (c: Call, p: unknown) => {
  const run = settingsHandlers["settings.set"]?.run as unknown as
    | ((c: Call, p: unknown) => Promise<unknown>)
    | undefined;
  if (run === undefined) throw new Error("no settings.set handler");
  return run(c, p);
};

describe("settings.set permissions.policy folders", () => {
  it("refuses the home root, ~/.ssh and ~/Library before any approval is raised", async () => {
    const db = openDb(":memory:");
    for (const path of [homedir(), `${homedir()}/.ssh`, `${homedir()}/Library`, "/"]) {
      await expect(
        setRun(callWith(db), {
          key: "permissions.policy",
          value: { folders: [{ path, mode: "ro" }] },
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
    }
  });

  it("a ~ path goes through expand, the sensitive check and storage", async () => {
    const db = openDb(":memory:");
    await setRun(callWith(db), {
      key: "permissions.policy",
      value: { folders: [{ path: "~/Documents", mode: "ro" }] },
    });
    expect(getSetting(db, "permissions.policy")?.value).toEqual({
      folders: [
        { path: `${homedir()}/Documents`, mode: "ro", ...realOf(`${homedir()}/Documents`) },
      ],
    });
    // ~/Library expands to the sensitive root and is refused, so nothing more is stored.
    await expect(
      setRun(callWith(db), {
        key: "permissions.policy",
        value: {
          folders: [
            { path: "~/Documents", mode: "ro" },
            { path: "~/Library", mode: "ro" },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(getSetting(db, "permissions.policy")?.value).toEqual({
      folders: [
        { path: `${homedir()}/Documents`, mode: "ro", ...realOf(`${homedir()}/Documents`) },
      ],
    });
  });

  it("an old literal ~/x entry stays literal after an unrelated policy write", async () => {
    const db = openDb(":memory:");
    // Written before ~ expansion existed: stored as typed.
    setSetting(db, "permissions.policy", { folders: [{ path: "~/x", mode: "rw" }] });
    await setRun(callWith(db), {
      key: "permissions.policy",
      value: { folders: [{ path: "~/x", mode: "rw" }], other: 1 },
    });
    expect(getSetting(db, "permissions.policy")?.value).toEqual({
      folders: [{ path: "~/x", mode: "rw" }],
      other: 1,
    });
  });
});

/**
 * PR #1395 review r1, finding 1(b): each folder grant records its real path when it is added, so
 * a root whose PARENT is later swapped for a link (its real path moves with it) stops counting.
 * The Gateway sets `real`; a client never does.
 */
describe("settings.set permissions.policy records each folder's real path", () => {
  const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "psy-real-")));
  const stored = (db: ReturnType<typeof openDb>) =>
    (getSetting(db, "permissions.policy")?.value as { folders?: unknown[] } | undefined)?.folders;

  it("a new folder gets its real path, also when typed through a linked parent", async () => {
    const root = tmp();
    mkdirSync(join(root, "real-cloud", "Notes"), { recursive: true });
    symlinkSync(join(root, "real-cloud"), join(root, "cloud"));
    mkdirSync(join(root, "plain"));
    const db = openDb(":memory:");
    await setRun(callWith(db), {
      key: "permissions.policy",
      value: {
        folders: [
          { path: join(root, "plain"), mode: "rw" },
          { path: join(root, "cloud", "Notes"), mode: "ro" },
          { path: join(root, "not-yet"), mode: "rw" },
        ],
      },
    });
    expect(stored(db)).toEqual([
      { path: join(root, "plain"), mode: "rw", real: join(root, "plain") },
      { path: join(root, "cloud", "Notes"), mode: "ro", real: join(root, "real-cloud", "Notes") },
      { path: join(root, "not-yet"), mode: "rw" },
    ]);
  });

  it("ignores a real path the client sends, and keeps the recorded one across later writes", async () => {
    const root = tmp();
    mkdirSync(join(root, "app"));
    mkdirSync(join(root, "other"));
    const db = openDb(":memory:");
    await setRun(callWith(db), {
      key: "permissions.policy",
      value: { folders: [{ path: join(root, "app"), mode: "rw", real: join(root, "other") }] },
    });
    expect(stored(db)).toEqual([{ path: join(root, "app"), mode: "rw", real: join(root, "app") }]);
    // An older Settings writes the list back without `real`, or with a different one: the
    // recorded value stays (a swap since the grant is not adopted by an unrelated write).
    for (const real of [undefined, join(root, "other")]) {
      await setRun(callWith(db), {
        key: "permissions.policy",
        value: {
          folders: [
            { path: join(root, "app"), mode: "rw", ...(real === undefined ? {} : { real }) },
          ],
          other: 1,
        },
      });
      expect(stored(db)).toEqual([
        { path: join(root, "app"), mode: "rw", real: join(root, "app") },
      ]);
    }
  });

  it("an older stored grant with nothing recorded is not given one by a write (the broker records it)", async () => {
    const root = tmp();
    mkdirSync(join(root, "old"));
    const db = openDb(":memory:");
    setSetting(db, "permissions.policy", { folders: [{ path: join(root, "old"), mode: "rw" }] });
    await setRun(callWith(db), {
      key: "permissions.policy",
      value: { folders: [{ path: join(root, "old"), mode: "rw", real: "/elsewhere" }], other: 1 },
    });
    expect(stored(db)).toEqual([{ path: join(root, "old"), mode: "rw" }]);
  });
});

/** PR #1395 r2 finding 5: one real path per new folder, and no record lost to a slow write. */
describe("policy writes keep the folders' real paths", () => {
  it("records only the real path the check judged, never a second lookup", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "psy-judged-")));
    mkdirSync(join(root, "a"));
    mkdirSync(join(root, "b"));
    const value = {
      folders: [
        { path: join(root, "a"), mode: "rw" },
        { path: join(root, "b"), mode: "rw" },
      ],
    };
    // `b` exists, but the check did not judge it at a real path: nothing is recorded for it.
    expect(
      recordPolicyFolderReals(value, undefined, new Map([[join(root, "a"), join(root, "a")]])),
    ).toEqual({
      folders: [
        { path: join(root, "a"), mode: "rw", real: join(root, "a") },
        { path: join(root, "b"), mode: "rw" },
      ],
    });
  });

  it("an entry without a real path takes the one stored meanwhile, and nothing else changes", () => {
    const value = {
      other: 1,
      folders: [
        { path: "/u/a", mode: "rw" },
        { path: "/u/b", mode: "ro", real: "/u/b" },
        { path: "/u/new", mode: "rw" },
      ],
    };
    const stored = {
      folders: [
        { path: "/u/a", mode: "rw", real: "/u/a" },
        { path: "/u/b", mode: "ro", real: "/elsewhere" },
        { path: "/u/gone", mode: "rw", real: "/u/gone" },
      ],
    };
    expect(mergeStoredFolderReals(value, stored)).toEqual({
      other: 1,
      folders: [
        { path: "/u/a", mode: "rw", real: "/u/a" },
        { path: "/u/b", mode: "ro", real: "/u/b" },
        { path: "/u/new", mode: "rw" },
      ],
    });
    expect(mergeStoredFolderReals(value, undefined)).toEqual(value);
  });
});

describe("folder identity (ref) is the Gateway's, never the client's", () => {
  const ref = { dev: "1", ino: "2", birth: "3" };
  it("keeps the stored identity and drops one the client sends", () => {
    const stored = { folders: [{ path: "/a", mode: "ro", real: "/a", ref }] };
    const client = {
      folders: [{ path: "/a", mode: "ro", ref: { dev: "9", ino: "9", birth: "9" } }],
    };
    const out = recordPolicyFolderReals(client, stored, new Map()) as typeof stored;
    expect(out.folders[0]?.ref).toEqual(ref);
    const fresh = { folders: [{ path: "/n", mode: "ro", ref }] };
    const out2 = recordPolicyFolderReals(fresh, stored, new Map()) as typeof stored;
    expect(out2.folders[0]?.ref).toBeUndefined();
  });
});

/**
 * PR #1483 r2: a Reconnect that lands while a policy change waits for its card must not be undone
 * by the older folder list in that change. The write is refused with `conflict` instead.
 */
describe("settings.set permissions.policy while a folder is reconnected", () => {
  const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "psy-conflict-")));

  function pending(db: ReturnType<typeof openDb>, duringCard?: () => void): Call {
    return {
      ctx: {
        db,
        config: { home: `${homedir()}/.psyche` },
        bus: { bumpStateVersion: () => 1 },
        presenceState: () => "on",
        broker: {
          get: async () => {
            // The owner answers the card; meanwhile a Reconnect re-points the folder.
            duringCard?.();
            return { kind: "policy_change" };
          },
          verifyBinding: async () => ({ ok: true }),
        },
      },
      identity: { scopes: ["operator.admin"], deviceId: "dev_admin" },
      emit: () => undefined,
    } as unknown as Call;
  }

  const paths = (db: ReturnType<typeof openDb>) =>
    (getSetting(db, "permissions.policy")?.value as { folders: { path: string }[] }).folders.map(
      (f) => f.path,
    );

  it("refuses the write with `conflict` when the folders changed during the card", async () => {
    const root = tmp();
    const old = join(root, "app");
    const renamed = join(root, "app2");
    const extra = join(root, "extra");
    for (const d of [old, renamed, extra]) mkdirSync(d);
    const db = openDb(":memory:");
    setSetting(db, "permissions.policy", { folders: [{ path: old, mode: "rw", real: old }] });
    // The change adds `extra` (it widens, so it needs the card) and still names the old path.
    const value = {
      folders: [
        { path: old, mode: "rw" },
        { path: extra, mode: "rw" },
      ],
    };
    const reconnect = () =>
      setSetting(db, "permissions.policy", {
        folders: [{ path: renamed, mode: "rw", real: renamed }],
      });
    await expect(
      setRun(pending(db, reconnect), { key: "permissions.policy", value, approvalId: "ap1" }),
    ).rejects.toMatchObject({ code: "conflict" });
    // The reconnect stands: the old path did not come back.
    expect(paths(db)).toEqual([renamed]);
  });

  it("writes normally when nothing changed during the card", async () => {
    const root = tmp();
    const old = join(root, "app");
    const extra = join(root, "extra");
    for (const d of [old, extra]) mkdirSync(d);
    const db = openDb(":memory:");
    setSetting(db, "permissions.policy", { folders: [{ path: old, mode: "rw", real: old }] });
    await setRun(pending(db), {
      key: "permissions.policy",
      value: {
        folders: [
          { path: old, mode: "rw" },
          { path: extra, mode: "rw" },
        ],
      },
      approvalId: "ap1",
    });
    expect(paths(db)).toEqual([old, extra]);
  });
});
