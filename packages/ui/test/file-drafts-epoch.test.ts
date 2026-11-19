// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import {
  draftEpoch,
  dropDraft,
  getDraft,
  putDraft,
  resetFileDrafts,
} from "../src/screens/files/file-drafts.ts";

afterEach(() => resetFileDrafts());

describe("file drafts: dropping", () => {
  it("ignores a draft reported after the owner dropped it", () => {
    const at = draftEpoch("/n/a.csv");
    putDraft("/n/a.csv", { content: "x", etag: "e1" }, at);
    dropDraft("/n/a.csv");
    // The editor's unmount report, taken before the drop, lands afterwards.
    putDraft("/n/a.csv", { content: "x", etag: "e1" }, at);
    expect(getDraft("/n/a.csv")).toBeUndefined();
    // A new editor (new epoch) keeps drafts again.
    putDraft("/n/a.csv", { content: "y", etag: "e2" }, draftEpoch("/n/a.csv"));
    expect(getDraft("/n/a.csv")?.content).toBe("y");
  });

  it("keeps drops per path", () => {
    const at = draftEpoch("/n/b.md");
    dropDraft("/n/a.md");
    putDraft("/n/b.md", { content: "b", etag: "e" }, at);
    expect(getDraft("/n/b.md")?.content).toBe("b");
  });

  it("warns before unload while any draft is kept, even one not on screen", () => {
    const fire = () => {
      const e = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(fire()).toBe(false);
    putDraft("/n/hidden.md", { content: "h", etag: "e" });
    expect(fire()).toBe(true);
    dropDraft("/n/hidden.md");
    expect(fire()).toBe(false);
  });
});

describe("file drafts: the desktop's release check", () => {
  it("tells the desktop app while any draft is kept", () => {
    const unsaved = (window as { psycheUnsavedFiles?: () => boolean }).psycheUnsavedFiles;
    expect(unsaved?.()).toBe(false);
    putDraft("/n/c.md", { content: "c", etag: "e" }, draftEpoch("/n/c.md"));
    expect(unsaved?.()).toBe(true);
    dropDraft("/n/c.md");
    expect(unsaved?.()).toBe(false);
  });
});
