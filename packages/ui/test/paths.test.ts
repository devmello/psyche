import { describe, expect, it } from "vitest";
import {
  displayPath,
  isAbsolutePath,
  joinPath,
  pathBasename,
  pathDirname,
  pathFlavor,
} from "../src/lib/paths.ts";

describe("host paths", () => {
  it("tells POSIX from Windows paths by their form", () => {
    expect(pathFlavor("/Users/ada")).toBe("posix");
    expect(pathFlavor("C:\\Users\\ada")).toBe("win32");
    expect(pathFlavor("c:/Users/ada")).toBe("win32");
    expect(pathFlavor("\\\\nas\\share")).toBe("win32");
    expect(pathFlavor("//nas/share")).toBe("win32");
    expect(pathFlavor("docs\\a.txt")).toBe("win32");
    expect(pathFlavor("documents/a.pdf")).toBe("posix");
    expect(pathFlavor("library:documents/a.pdf")).toBe("posix");
  });

  it("knows absolute paths on both hosts", () => {
    for (const p of [
      "/",
      "/Users/ada",
      "C:\\",
      "C:\\Users",
      "d:/work",
      "\\\\nas\\share",
      "\\\\nas\\share\\dir",
      "//nas/share",
      "\\\\?\\C:\\long",
      "\\\\?\\UNC\\nas\\share",
    ]) {
      expect(isAbsolutePath(p), p).toBe(true);
    }
    for (const p of ["", "a/b", "C:x", "\\x", "\\\\nas", "library:documents/a.pdf", "~/Docs"]) {
      expect(isAbsolutePath(p), p).toBe(false);
    }
  });

  it("names the last segment", () => {
    expect(pathBasename("/Users/me/Downloads/")).toBe("Downloads");
    expect(pathBasename("/Users/me/a.txt")).toBe("a.txt");
    expect(pathBasename("C:\\Users\\me\\Downloads\\")).toBe("Downloads");
    expect(pathBasename("C:/Users/me/a.txt")).toBe("a.txt");
    expect(pathBasename("\\\\nas\\share\\Photos\\x.jpg")).toBe("x.jpg");
    expect(pathBasename("\\\\?\\C:\\long\\name.md")).toBe("name.md");
    expect(pathBasename("documents/a.pdf")).toBe("a.pdf");
    expect(pathBasename("gmail")).toBe("gmail");
    expect(pathBasename("/")).toBe("/");
    expect(pathBasename("C:\\")).toBe("C:\\");
    expect(pathBasename("")).toBe("");
  });

  it("names the parent folder", () => {
    expect(pathDirname("/Users/me/Downloads")).toBe("/Users/me");
    expect(pathDirname("/Users")).toBe("/");
    expect(pathDirname("/")).toBe("/");
    expect(pathDirname("C:\\Users\\me")).toBe("C:\\Users");
    expect(pathDirname("C:\\Users")).toBe("C:\\");
    expect(pathDirname("C:/Users/me/a.txt")).toBe("C:\\Users\\me");
    expect(pathDirname("\\\\nas\\share\\dir\\x")).toBe("\\\\nas\\share\\dir");
    expect(pathDirname("\\\\nas\\share\\dir")).toBe("\\\\nas\\share\\");
    expect(pathDirname("a.txt")).toBe(".");
  });

  it("joins with the base's separator", () => {
    expect(joinPath("/Users/me", "Docs", "a.txt")).toBe("/Users/me/Docs/a.txt");
    expect(joinPath("/", "etc")).toBe("/etc");
    expect(joinPath("C:\\Users\\me\\", "Docs/a.txt")).toBe("C:\\Users\\me\\Docs\\a.txt");
    expect(joinPath("C:\\", "x")).toBe("C:\\x");
    expect(joinPath("\\\\nas\\share", "x")).toBe("\\\\nas\\share\\x");
    expect(joinPath("/Users/me")).toBe("/Users/me");
    expect(joinPath("docs", "a.md")).toBe("docs/a.md");
  });

  it("displays home folders short and Windows paths with backslashes", () => {
    expect(displayPath("/Users/ada/Documents")).toBe("~/Documents");
    expect(displayPath("/home/ada")).toBe("~");
    expect(displayPath("/Volumes/Work")).toBe("/Volumes/Work");
    expect(displayPath("C:\\Users\\ada\\Documents")).toBe("~\\Documents");
    expect(displayPath("c:\\users\\ada")).toBe("~");
    expect(displayPath("C:/Projects/psyche")).toBe("C:\\Projects\\psyche");
    expect(displayPath("\\\\?\\D:\\Work")).toBe("D:\\Work");
    expect(displayPath("\\\\?\\UNC\\nas\\share")).toBe("\\\\nas\\share");
    expect(displayPath("//nas/share/x")).toBe("\\\\nas\\share\\x");
  });
});
