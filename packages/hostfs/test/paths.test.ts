import { describe, expect, it } from "vitest";
import {
  absoluteHostPathPattern,
  canonicalHostPath,
  HostPathError,
  isAbsoluteHostPath,
  isUnderHostPath,
  joinHostPath,
  relativeHostPath,
  sameHostPath,
  slashHostPath,
} from "../src/index.ts";

const win = (p: string) => canonicalHostPath(p, "win32");

describe("POSIX host paths (unchanged on every platform)", () => {
  it("normalizes `..`, `.` and a trailing slash, and refuses relative paths and NUL", () => {
    expect(canonicalHostPath("/a/b/../c/", "darwin")).toBe("/a/c");
    expect(canonicalHostPath("/", "darwin")).toBe("/");
    expect(canonicalHostPath("/workspace", "win32")).toBe("/workspace");
    // `//` is a POSIX root off Windows and a UNC prefix on it.
    expect(canonicalHostPath("//a//b", "darwin")).toBe("/a/b");
    expect(() => canonicalHostPath("//a//b", "win32")).toThrow(HostPathError);
    expect(canonicalHostPath("//srv/share//b", "win32")).toBe("\\\\srv\\share\\b");
    expect(() => canonicalHostPath("a/b", "darwin")).toThrow(HostPathError);
    expect(() => canonicalHostPath("/a\0b", "darwin")).toThrow(HostPathError);
  });

  it("compares by whole segments and with case", () => {
    expect(isUnderHostPath("/Users/o/Docs/a", "/Users/o/Docs")).toBe(true);
    expect(isUnderHostPath("/Users/o/Docs2", "/Users/o/Docs")).toBe(false);
    expect(isUnderHostPath("/users/o/docs", "/Users/o/Docs")).toBe(false);
    expect(isUnderHostPath("/anything", "/")).toBe(true);
  });

  it("does not take Windows forms on macOS or Linux", () => {
    expect(isAbsoluteHostPath("C:\\Users", "darwin")).toBe(false);
    expect(() => canonicalHostPath("C:\\Users", "linux")).toThrow(HostPathError);
  });
});

describe("Windows host paths", () => {
  it("accepts drive and UNC paths, with either separator and the long-path prefix", () => {
    expect(win("c:/Users/o/Docs/")).toBe("C:\\Users\\o\\Docs");
    expect(win("C:\\")).toBe("C:\\");
    expect(win("\\\\?\\C:\\Users\\o")).toBe("C:\\Users\\o");
    expect(win("\\\\srv\\share\\dir\\")).toBe("\\\\srv\\share\\dir");
    expect(win("\\\\?\\UNC\\srv\\share\\dir")).toBe("\\\\srv\\share\\dir");
    expect(win("C:\\Users\\o\\Docs\\..\\..\\x")).toBe("C:\\Users\\x");
    expect(win("C:\\..\\..\\Windows")).toBe("C:\\Windows");
    expect(win("\\\\srv\\share\\..\\..\\other")).toBe("\\\\srv\\share\\other");
  });

  it("refuses relative, drive-relative, root-relative and device paths", () => {
    for (const p of [
      "Docs",
      "C:Docs",
      "\\Docs",
      "\\\\.\\PhysicalDrive0",
      "\\\\?\\GLOBALROOT\\x",
      "\\\\srv",
    ]) {
      expect(() => win(p), p).toThrow(HostPathError);
      expect(isAbsoluteHostPath(p, "win32"), p).toBe(false);
    }
  });

  it("refuses names Win32 would rewrite to another file", () => {
    for (const p of [
      "C:\\Users\\o\\notes.txt:secret",
      "C:\\Users\\o\\notes.txt::$DATA",
      "C:\\Users\\o\\.ssh.\\id_ed25519",
      "C:\\Users\\o\\.ssh \\id_ed25519",
      "C:\\Users\\o\\Docs...",
      "C:\\Users\\o\\NUL",
      "C:\\Users\\o\\com1.txt",
      "C:\\PROGRA~1\\x",
      "C:\\Users\\o\\DOCUME~1",
      "C:\\Users\\o\\a*b",
      "C:\\Users\\o\\a?b",
    ]) {
      expect(() => win(p), p).toThrow(HostPathError);
    }
    // Look-alikes that are ordinary names.
    expect(win("C:\\Users\\o\\.ssh\\config")).toBe("C:\\Users\\o\\.ssh\\config");
    expect(win("C:\\Users\\o\\nullable.txt")).toBe("C:\\Users\\o\\nullable.txt");
    expect(win("C:\\Users\\o\\a~b.txt")).toBe("C:\\Users\\o\\a~b.txt");
  });

  it("compares without case, by whole segments", () => {
    const docs = win("C:\\Users\\X\\Docs");
    expect(isUnderHostPath(win("c:\\users\\x\\docs"), docs)).toBe(true);
    expect(isUnderHostPath(win("c:\\users\\x\\DOCS\\a.txt"), docs)).toBe(true);
    expect(isUnderHostPath(win("C:\\Users\\X\\Docs2"), docs)).toBe(false);
    expect(isUnderHostPath(win("C:\\Users\\X\\Docs2\\a"), docs)).toBe(false);
    expect(isUnderHostPath(win("D:\\Users\\X\\Docs"), docs)).toBe(false);
    expect(isUnderHostPath(win("C:\\anything"), win("c:\\"))).toBe(true);
    expect(isUnderHostPath(win("\\\\srv\\share\\a"), win("\\\\SRV\\Share"))).toBe(true);
    expect(isUnderHostPath(win("\\\\srv\\share2"), win("\\\\srv\\share"))).toBe(false);
    expect(sameHostPath(win("C:\\Users\\X\\Docs"), win("c:/users/x/docs/"))).toBe(true);
    // Non-ASCII folds one to one; `ß` is not `SS` on NTFS.
    expect(sameHostPath(win("C:\\Café"), win("C:\\CAFÉ"))).toBe(true);
    expect(sameHostPath(win("C:\\straße"), win("C:\\STRASSE"))).toBe(false);
  });

  it("never matches a POSIX path against a Windows one", () => {
    expect(isUnderHostPath("/Users/x/Docs", win("C:\\Users\\x"))).toBe(false);
    expect(isUnderHostPath(win("C:\\workspace"), "/workspace")).toBe(false);
    expect(isUnderHostPath(win("C:\\workspace"), "/")).toBe(false);
  });

  it("offers a tool-input pattern for the platform's absolute paths", () => {
    const win = new RegExp(absoluteHostPathPattern("win32"));
    for (const p of ["C:\\Users", "c:/Users", "\\\\srv\\share"]) expect(win.test(p), p).toBe(true);
    for (const p of ["/Users", "Users", "C:Users", "\\\\.\\pipe\\x", "\\\\?\\C:\\x"]) {
      expect(win.test(p), p).toBe(false);
    }
    expect(absoluteHostPathPattern("darwin")).toBe("^/");
  });

  it("joins, relativizes and writes slashes in the path's own form", () => {
    expect(joinHostPath("C:\\Users\\o", ".ssh")).toBe("C:\\Users\\o\\.ssh");
    expect(joinHostPath("/Users/o", ".config/gh")).toBe("/Users/o/.config/gh");
    expect(joinHostPath("C:\\Users\\o", ".config/gh")).toBe("C:\\Users\\o\\.config\\gh");
    expect(relativeHostPath("C:\\Users\\o", "C:\\Users\\o\\a\\b.txt")).toBe("a/b.txt");
    expect(relativeHostPath("C:\\", "C:\\a")).toBe("a");
    expect(relativeHostPath("/r", "/r")).toBe("");
    expect(slashHostPath("C:\\Users\\o")).toBe("C:/Users/o");
    expect(slashHostPath("/Users/o")).toBe("/Users/o");
  });
});
