import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkRestoredByHand,
  guardRestoredByHand,
  RESTORE_DIALOG,
  type RestoreDialogStrings,
  restoreDialogStrings,
} from "../../src/main/restore-check.ts";

/**
 * "I put my data back myself" (review round 4, M1): it only goes ahead when the owner's data is
 * really there, and the owner has confirmed in a native dialog.
 */

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

function interrupted(): string {
  const home = mkdtempSync(join(tmpdir(), "psy-rc-"));
  homes.push(home);
  mkdirSync(join(home, "run"));
  const snapshot = join(home, "backups", "pre-update", "0.4.0-to-0.5.0-x");
  mkdirSync(snapshot, { recursive: true });
  writeFileSync(
    join(snapshot, "manifest.json"),
    JSON.stringify({ entries: [{ rel: "state/psyche.sqlite" }, { rel: "config.json" }] }),
  );
  writeFileSync(join(home, "run", "restore-in-progress.json"), JSON.stringify({ snapshot }));
  writeFileSync(
    join(home, "run", "update-failed.json"),
    JSON.stringify({ key: "restore-interrupted", message: "x" }),
  );
  return home;
}
const put = (home: string, rel: string) => {
  mkdirSync(join(home, rel, ".."), { recursive: true });
  writeFileSync(join(home, rel), "data");
};

function ui(answer = true) {
  const calls = { refused: [] as string[], confirmed: 0 };
  return {
    calls,
    ui: {
      refuse: async (_t: string, body: string) => {
        calls.refused.push(body);
      },
      confirm: async () => {
        calls.confirmed += 1;
        return answer;
      },
    },
  };
}

describe("checkRestoredByHand", () => {
  it("names the files that are missing", () => {
    const home = interrupted();
    put(home, "config.json");
    expect(checkRestoredByHand(home)).toEqual({
      ok: false,
      reason: "missing",
      missing: ["state/psyche.sqlite"],
    });
    put(home, "state/psyche.sqlite");
    expect(checkRestoredByHand(home)).toEqual({ ok: true });
  });

  it("refuses without the note, without the marker, and with a marker pointing outside the snapshots", () => {
    const home = interrupted();
    writeFileSync(join(home, "run", "update-failed.json"), JSON.stringify({ key: "build-b" }));
    expect(checkRestoredByHand(home)).toMatchObject({ ok: false, reason: "no_note" });
    writeFileSync(
      join(home, "run", "update-failed.json"),
      JSON.stringify({ key: "restore-interrupted" }),
    );
    rmSync(join(home, "run", "restore-in-progress.json"));
    expect(checkRestoredByHand(home)).toMatchObject({ ok: false, reason: "no_marker" });
    writeFileSync(
      join(home, "run", "restore-in-progress.json"),
      JSON.stringify({ snapshot: tmpdir() }),
    );
    expect(checkRestoredByHand(home)).toMatchObject({ ok: false, reason: "unreadable" });
  });

  it("does not require the config and key files of a restore that put back databases only", () => {
    const home = interrupted();
    writeFileSync(
      join(home, "run", "restore-in-progress.json"),
      JSON.stringify({
        snapshot: join(home, "backups", "pre-update", "0.4.0-to-0.5.0-x"),
        onlyDatabases: true,
      }),
    );
    put(home, "state/psyche.sqlite");
    expect(checkRestoredByHand(home)).toEqual({ ok: true });
  });
});

describe("guardRestoredByHand", () => {
  it("refuses, naming the missing files, without asking, when the data is not all there", async () => {
    const home = interrupted();
    const { ui: u, calls } = ui();
    expect(await guardRestoredByHand(home, u, "en-US")).toBe(false);
    expect(calls.confirmed).toBe(0);
    expect(calls.refused[0]).toContain("state/psyche.sqlite, config.json");
  });

  it("asks when everything is there, and goes ahead only on a yes", async () => {
    const home = interrupted();
    put(home, "state/psyche.sqlite");
    put(home, "config.json");
    const no = ui(false);
    expect(await guardRestoredByHand(home, no.ui, "de")).toBe(false);
    expect(no.calls).toEqual({ refused: [], confirmed: 1 });
    const yes = ui(true);
    expect(await guardRestoredByHand(home, yes.ui, "de")).toBe(true);
  });

  it("says there is nothing to confirm when no restore is waiting", async () => {
    const home = interrupted();
    rmSync(join(home, "run", "update-failed.json"));
    const { ui: u, calls } = ui();
    expect(await guardRestoredByHand(home, u, "fr-FR")).toBe(false);
    expect(calls.refused[0]).toContain("rien à confirmer");
  });
});

describe("the dialog's words", () => {
  const langs = ["ar", "de", "es", "fr", "hi", "it", "ja", "ko", "pt", "zh"];
  const keys = Object.keys(RESTORE_DIALOG.en as object) as (keyof RestoreDialogStrings)[];

  it("exist in all ten languages, none of them English, each with its placeholder", () => {
    const en = RESTORE_DIALOG.en as RestoreDialogStrings;
    for (const lang of langs) {
      const s = RESTORE_DIALOG[lang] as RestoreDialogStrings;
      expect(s, lang).toBeDefined();
      for (const k of keys) {
        expect(typeof s[k], `${lang}.${k}`).toBe("string");
        expect(s[k], `${lang}.${k}`).not.toBe(en[k]);
      }
      expect(s.refuseMissing, lang).toContain("{files}");
    }
  });

  it("follows the system language, with a region, and falls back to English only for others", () => {
    expect(restoreDialogStrings("zh-CN")).toBe(RESTORE_DIALOG.zh);
    expect(restoreDialogStrings("pt_BR")).toBe(RESTORE_DIALOG.pt);
    expect(restoreDialogStrings("nl")).toBe(RESTORE_DIALOG.en);
  });
});
