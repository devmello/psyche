import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { speechSetupFromEnv, speechSrtSettings } from "../src/compose/speech.ts";
import { silentLogger } from "../src/log.ts";

/** Security §5.3: ffmpeg and whisper-cli run under srt with Psyche's profile. */

let composed: ComposedGateway | null = null;
let home = "";
afterEach(async () => {
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

describe("speech helpers under srt", () => {
  it("PSYCHE_SRT_PATH selects srt; an explicit prefix still wins", () => {
    expect(speechSetupFromEnv({ PSYCHE_SRT_PATH: "/opt/srt" })).toEqual({ srtPath: "/opt/srt" });
    expect(
      speechSetupFromEnv({ PSYCHE_SRT_PATH: "/opt/srt", PSYCHE_SPEECH_RUNNER_PREFIX: "nice -n 5" }),
    ).toEqual({ runnerPrefix: ["nice", "-n", "5"] });
    expect(speechSetupFromEnv({})).toEqual({});
  });

  it("the profile denies the secrets, keeps models readable, writes only scratch, no network", () => {
    const s = speechSrtSettings("/h/.psyche", "/tmp/x") as {
      filesystem: { denyRead: string[]; allowWrite: string[]; denyWrite: string[] };
      network: { allowedDomains: string[]; allowLocalBinding: boolean };
      allowAppleEvents: boolean;
      enableWeakerNetworkIsolation: boolean;
    };
    for (const d of ["vault", "state", "audit", "security", "browser", "library"]) {
      expect(s.filesystem.denyRead).toContain(join("/h/.psyche", d));
    }
    expect(s.filesystem.denyRead).toContain(join(homedir(), ".ssh"));
    expect(s.filesystem.denyRead).toContain(join(homedir(), "Library", "Keychains"));
    expect(s.filesystem.denyRead).not.toContain("/h/.psyche"); // models stay readable
    expect(s.filesystem.denyRead).not.toContain(join("/h/.psyche", "models"));
    expect(s.filesystem.allowWrite).toEqual(["/tmp/x"]);
    expect(s.filesystem.denyWrite).toEqual(["/h/.psyche"]);
    expect(s.network).toMatchObject({ allowedDomains: [], allowLocalBinding: false });
    expect(s.allowAppleEvents).toBe(false);
    expect(s.enableWeakerNetworkIsolation).toBe(false);
  });

  it("the composed Gateway writes the profile 0600 when srt is configured", async () => {
    home = mkdtempSync(join(tmpdir(), "psyche-speech-srt-"));
    composed = await composeGateway({
      env: {},
      logger: silentLogger,
      retentionIntervalMs: 0,
      background: false,
      config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
      model: { provider: new FakeModelProvider(), model: "fake/model" },
      speech: { srtPath: "/opt/srt" },
    });
    const file = join(home, "speech", "srt-settings.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, "speech")).mode & 0o777).toBe(0o700);
    const settings = JSON.parse(readFileSync(file, "utf8")) as {
      filesystem: { denyRead: string[] };
    };
    expect(settings.filesystem.denyRead).toContain(join(home, "vault"));
  });
});
