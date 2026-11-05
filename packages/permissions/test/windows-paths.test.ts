import { describe, expect, it } from "vitest";
import { folderCovers, refuseFolder } from "../src/index.ts";
import { CTX, call, makeBroker, path } from "./helpers.ts";

/**
 * Windows host paths under the folder policy and the prohibitions. NTFS compares names without
 * case, so a grant and a protected root must too; and Win32 rewrites some names before NTFS sees
 * them (`.ssh.` opens `.ssh`, `a.txt:s` is a stream of `a.txt`, `DOCUME~1` is `Documents`), so
 * those are refused rather than matched lexically.
 */
describe.runIf(process.platform === "win32")("Windows host paths", () => {
  const folders = [
    { path: "C:\\Users\\X\\Docs", mode: "rw" as const },
    { path: "C:\\Users\\X\\Docs\\ro", mode: "ro" as const },
  ];
  const permissive = { folders, allow: ["*"] };
  const at = (tool: string, se: "read" | "write", p: string) => call(tool, se, path(p));

  it("a folder grant covers its own folder in any case, and nothing beside it", async () => {
    const h = makeBroker({ policy: { folders } });
    const rule = async (se: "read" | "write", p: string) =>
      (await h.broker.decide(at(se === "read" ? "read_file" : "write_file", se, p), CTX)).rule;
    expect(await rule("write", "C:\\Users\\X\\Docs\\a.txt")).toBe("folder:rw");
    expect(await rule("write", "c:\\users\\x\\DOCS\\a.txt")).toBe("folder:rw");
    expect(await rule("write", "c:/users/x/docs/sub/a.txt")).toBe("folder:rw");
    expect(await rule("write", "\\\\?\\C:\\Users\\X\\Docs\\a.txt")).toBe("folder:rw");
    // The longest root decides, without case too.
    expect(await rule("write", "C:\\USERS\\X\\docs\\RO\\a.txt")).toBe("folder:read_only");
    // Prefix tricks are other folders.
    for (const p of [
      "C:\\Users\\X\\Docs2\\a.txt",
      "C:\\Users\\X\\Docs-old",
      "C:\\Users\\X",
      "D:\\Users\\X\\Docs\\a.txt",
      "C:\\Users\\X\\Docs\\..\\secret.txt",
      "\\\\server\\share\\Users\\X\\Docs\\a.txt",
    ]) {
      expect(await rule("read", p), p).toBe("folder:not_granted");
    }
  });

  it("names Win32 would rewrite are refused, never matched to a grant", async () => {
    const h = makeBroker({ policy: { folders } });
    for (const p of [
      "C:\\Users\\X\\Docs\\a.txt:hidden",
      "C:\\Users\\X\\Docs\\a.txt::$DATA",
      "C:\\Users\\X\\Docs.\\a.txt",
      "C:\\Users\\X\\Docs \\a.txt",
      "C:\\Users\\X\\DOCS~1\\a.txt",
      "C:\\Users\\X\\Docs\\NUL",
      "C:\\Users\\X\\Docs\\con.txt",
      "C:Docs\\a.txt",
      "\\Users\\X\\Docs\\a.txt",
      "\\\\.\\C:\\Users\\X\\Docs\\..\\..\\..\\Windows\\System32\\config\\SAM:x",
    ]) {
      const d = await h.broker.decide(at("read_file", "read", p), CTX);
      expect(d.decision, p).toBe("deny");
      expect(d.rule, p).toMatch(/^(folder:invalid_path|prohibition:invalid_path)$/);
    }
  });

  it("Psyche's own home and the credential stores stay closed, whatever the case", async () => {
    const { broker } = makeBroker({
      policy: { ...permissive, folders: [{ path: "C:\\Users\\X", mode: "rw" }] },
      psycheHome: "C:\\Users\\X\\.psyche",
    });
    const rule = async (p: string) =>
      (await broker.decide(at("read_file", "read", p), { ...CTX, permissionMode: "auto" })).rule;
    for (const p of [
      "C:\\Users\\X\\.psyche\\vault\\vault.db",
      "c:\\USERS\\x\\.PSYCHE\\Vault\\slots.json",
      "C:/Users/X/.psyche/vault",
    ]) {
      expect(await rule(p), p).toBe("prohibition:psyche_state");
    }
    expect(await rule("C:\\Users\\X\\.psyche\\state\\teach\\t.json")).toBe(
      "prohibition:teach_recordings",
    );
    expect(await rule("C:\\Users\\X\\.psyche\\config.json")).toBe("prohibition:psyche_state");
    for (const p of [
      "C:\\Users\\X\\.ssh\\id_ed25519",
      "C:\\Users\\X\\.SSH\\config",
      "C:\\Users\\X\\.aws\\credentials",
      "C:\\Users\\X\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Cookies",
      "C:\\Users\\X\\AppData\\Local\\Microsoft\\Edge\\User Data\\Default\\Login Data",
      "C:\\Users\\X\\AppData\\Roaming\\Mozilla\\Firefox\\Profiles\\p\\logins.json",
      "C:\\Users\\X\\AppData\\Roaming\\Microsoft\\Credentials\\ABC",
      "C:\\Users\\X\\AppData\\Roaming\\Microsoft\\Protect\\S-1-5-21-1\\key",
      "C:\\Users\\X\\AppData\\Roaming\\Psyche\\device-key.json",
      "C:\\Users\\X\\NTUSER.DAT",
      "C:\\Windows\\System32\\config\\SAM",
    ]) {
      expect(await rule(p), p).toBe("prohibition:system_credentials");
    }
    // Ordinary files in the granted folder are not caught by any of that.
    expect(await rule("C:\\Users\\X\\Documents\\notes.txt")).not.toMatch(/^prohibition:/);
  });

  it("deleting through cmd, PowerShell or a Windows rm asks for the typed confirmation", async () => {
    const { broker } = makeBroker({
      policy: {
        allow: ["*"],
        folders: [{ path: "C:\\Users\\o\\Projects", mode: "rw" }],
        exec: { execHostEnabled: true },
      },
    });
    const decide = (argv: string[]) =>
      broker.decide(
        call("exec_host", "destructive", undefined, {
          binding: {
            argv,
            cwd: "C:\\Users\\o\\Projects\\app",
            executable: "C:\\Windows\\System32\\cmd.exe",
            executableSha256: `sha256:${"a".repeat(64)}`,
          },
        }),
        CTX,
      );
    for (const argv of [
      ["C:\\Program Files\\Git\\usr\\bin\\RM.EXE", "-rf", "build"],
      ["del", "/s", "/q", "build"],
      ["cmd", "/c", "rd /s /q build"],
      ["cmd.exe", "/c", "dir & del build\\a.txt"],
      ["powershell", "-Command", "Remove-Item -Recurse build"],
      ["pwsh.exe", "-c", "ri build"],
    ]) {
      expect((await decide(argv)).rule, argv.join(" ")).toBe("prohibition:permanent_delete");
    }
    expect((await decide(["cmd", "/c", "dir build"])).rule).not.toBe(
      "prohibition:permanent_delete",
    );
  });

  it("folder picks refuse drive and share roots, system folders and the profile's AppData", () => {
    const env = { home: "C:\\Users\\X", psycheHome: "C:\\Users\\X\\.psyche" };
    for (const p of [
      "C:\\",
      "D:\\",
      "\\\\server\\share",
      "C:\\Users",
      "c:\\users",
      "C:\\Users\\X",
      "C:\\Users\\x",
      "C:\\Windows",
      "C:\\Windows\\System32",
      "C:\\Program Files\\App",
      "C:\\ProgramData",
      "C:\\$Recycle.Bin\\S-1-5-21",
      "D:\\System Volume Information",
      "C:\\Users\\X\\AppData",
      "C:\\Users\\X\\appdata\\Local\\Thing",
      "C:\\Users\\X\\.ssh",
      "C:\\Users\\X\\.psyche\\workspace",
    ]) {
      expect(refuseFolder(p, env), p).toMatch(/^(sensitive_root|contains_sensitive_root)$/);
    }
    expect(refuseFolder("C:\\Users\\X\\Documents", env)).toBeUndefined();
    expect(refuseFolder("D:\\Work\\repo", env)).toBeUndefined();
    // A POSIX path names no Windows folder; a rewritten name is refused before judging.
    expect(refuseFolder("/Users/X/Documents", env)).toBe("not_absolute");
    expect(refuseFolder("C:\\Users\\X\\.ssh.", env)).toBe("not_absolute");
    expect(refuseFolder("C:\\Users\\X\\DOCUME~1", env)).toBe("not_absolute");
  });

  it("folderCovers compares without case and by whole segments", () => {
    const grants = [{ path: "C:\\Users\\X\\Docs", mode: "rw" as const }];
    expect(folderCovers(grants, "c:\\users\\x\\docs\\a.txt", "rw")?.path).toBe(
      "C:\\Users\\X\\Docs",
    );
    expect(folderCovers(grants, "C:\\Users\\X\\Docs2\\a.txt", "ro")).toBeUndefined();
    expect(folderCovers(grants, "C:\\Users\\X\\Docs\\a.txt:s", "ro")).toBeUndefined();
  });

  it("path rules written with either separator match without crossing a folder", async () => {
    const { broker } = makeBroker({
      policy: {
        folders: [{ path: "C:\\Users\\X", mode: "rw" }],
        deny: ["path:C:\\Users\\X\\Secret\\**", "path:**/*.pem"],
        allow: ["path:C:/Users/X/Public/*"],
      },
    });
    const rule = async (p: string) => (await broker.decide(at("read_file", "read", p), CTX)).rule;
    expect(await rule("C:\\Users\\X\\Secret\\a\\b.txt")).toMatch(/^policy:deny/);
    expect(await rule("c:\\users\\x\\secret\\b.txt")).toMatch(/^policy:deny/);
    expect(await rule("C:\\Users\\X\\Public\\key.pem")).toMatch(/^policy:deny/);
  });
});
