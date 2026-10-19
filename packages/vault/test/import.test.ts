import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectFormat, parseCsv } from "../src/index.ts";
import { type Harness, makeHarness } from "./helpers.ts";

let h: Harness;
beforeEach(async () => {
  h = makeHarness();
  await h.vault.setup();
});
afterEach(() => h.cleanup());

const CHROME = `name,url,username,password,note
github.com,https://github.com/login,pat,chrome-pw-111111,
"Bank, Inc",https://bank.example/,pat,"pw-with,comma-""q""",card 4111 1111 1111 1111
app,android://xyz@com.example.app/,pat,android-only-pw-1,
`;

const BITWARDEN = `folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp
,,login,GitLab,,,0,"https://gitlab.com,https://gitlab.example.org",pat,bw-pw-222222,JBSWY3DPEHPK3PXP
,,note,Wifi,the wifi password is hunter22,,0,,,,
,,card,Visa,,,0,,,,
,,login,Broken TOTP,,,0,https://x.example,pat,bw-pw-333333,!!notbase32!!
`;

const ONEPASSWORD = `Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes
Fastmail,https://www.fastmail.com,pat@fastmail.com,op-pw-444444,otpauth://totp/Fastmail:pat?secret=JBSWY3DPEHPK3PXP&issuer=Fastmail,false,false,,
Tax,https://irs.example,pat,op-pw-555555,,false,false,,SSN 123-45-6789
`;

describe("CSV parsing", () => {
  it("handles quotes, doubled quotes, commas, CRLF and a BOM", () => {
    expect(parseCsv('﻿a,b\r\n"x,1","say ""hi"""\r\n')).toEqual([
      ["a", "b"],
      ["x,1", 'say "hi"'],
    ]);
    expect(detectFormat(["name", "url", "username", "password"])).toBe("chrome");
    expect(detectFormat(["foo"])).toBeNull();
  });
});

describe("CSV import (G3)", () => {
  it("imports Chrome exports and refuses rows with card data", async () => {
    const r = await h.vault.importCsv(CHROME);
    expect(r.format).toBe("chrome");
    expect(r.imported.map((m) => [m.slug, m.bindings])).toEqual([
      ["github-com", [{ origin: "https://github.com" }]],
      ["app", []],
    ]);
    expect(r.skipped).toEqual([{ row: 3, reason: "refused: card_number in notes" }]);
    expect(JSON.stringify(r)).not.toMatch(/chrome-pw|android-only|4111/);
  });

  it("imports Bitwarden logins with several URIs and TOTP; notes; refuses cards", async () => {
    const r = await h.vault.importCsv(BITWARDEN, "bitwarden");
    expect(r.imported.map((m) => [m.name, m.kind])).toEqual([
      ["GitLab", "login"],
      ["Wifi", "note"],
      ["Broken TOTP", "login"],
    ]);
    expect(r.imported[0]?.bindings).toEqual([
      { origin: "https://gitlab.com" },
      { origin: "https://gitlab.example.org" },
    ]);
    expect(r.skipped).toEqual([{ row: 4, reason: "refused: card items" }]);
  });

  it("imports 1Password exports and refuses government ids", async () => {
    const r = await h.vault.importCsv(ONEPASSWORD);
    expect(r.format).toBe("1password");
    expect(r.imported.map((m) => m.slug)).toEqual(["fastmail"]);
    expect(r.skipped).toEqual([{ row: 3, reason: "refused: government_id in notes" }]);
  });

  it("rejects unknown headers", async () => {
    await expect(h.vault.importCsv("a,b\n1,2\n")).rejects.toMatchObject({ code: "invalid_params" });
  });
});
