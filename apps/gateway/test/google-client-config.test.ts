import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { googleClientSetup } from "../src/compose/parts.ts";
import { readConfigFile } from "../src/config.ts";

/** #505: the owner's Google OAuth client from `config.json` and the environment, never a secret. */

const ID = "1234567890-abc.apps.googleusercontent.com";
let home = "";
let n = 0;
afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  home = "";
});

function file(json: unknown): string {
  home ||= mkdtempSync(join(tmpdir(), "psyche-google-cfg-"));
  const path = join(home, `config-${++n}.json`);
  writeFileSync(path, JSON.stringify(json));
  return path;
}

describe("connectors.google in config.json", () => {
  it("reads the client id and a vault placeholder for the secret", () => {
    const cfg = readConfigFile(
      file({
        connectors: { google: { clientId: ID, clientSecret: "{{cred:google-oauth-client}}" } },
      }),
    );
    expect(cfg.connectors?.google).toEqual({
      clientId: ID,
      clientSecret: "{{cred:google-oauth-client}}",
    });
  });

  it("refuses a raw secret, an unknown key and something that is not a client id", () => {
    expect(() =>
      readConfigFile(
        file({ connectors: { google: { clientId: ID, clientSecret: "GOCSPX-abc" } } }),
      ),
    ).toThrow(/vault placeholder/);
    expect(() => readConfigFile(file({ connectors: { google: { secret: "x" } } }))).toThrow(
      /connectors\.google\.secret/,
    );
    expect(() => readConfigFile(file({ connectors: { slack: {} } }))).toThrow(/connectors\.slack/);
    expect(() =>
      readConfigFile(file({ connectors: { google: { clientId: "https://evil.example" } } })),
    ).toThrow(/client id/);
  });
});

describe("googleClientSetup", () => {
  it("lets the environment override config.json and refuses a raw secret there too", () => {
    expect(googleClientSetup({}, undefined)).toEqual({});
    expect(
      googleClientSetup(
        { PSYCHE_GOOGLE_CLIENT_SECRET: "{{cred:g-env}}" },
        { clientId: ID, clientSecret: "{{cred:g-file}}" },
      ),
    ).toEqual({ clientId: ID, clientSecret: "{{cred:g-env}}" });
    expect(() =>
      googleClientSetup({ PSYCHE_GOOGLE_CLIENT_SECRET: "GOCSPX-raw" }, undefined),
    ).toThrow(/vault placeholder/);
  });
});
