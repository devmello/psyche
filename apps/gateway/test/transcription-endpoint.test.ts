import { openDb, type PsycheDb, setSetting } from "@psyche/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { transcriptionEndpoint } from "../src/compose/speech.ts";

/** The owner's transcription endpoint from Settings → Mail & meetings (#842 item 5); no network. */

let db: PsycheDb;

beforeEach(() => {
  db = openDb(":memory:");
});

afterEach(() => {
  db.close();
});

describe("transcriptionEndpoint", () => {
  it("is absent until the owner sets an address", () => {
    expect(transcriptionEndpoint(db)).toBeUndefined();
    setSetting(db, "meetings.transcribe.endpoint", "   ");
    expect(transcriptionEndpoint(db)).toBeUndefined();
  });

  it("accepts a loopback server, defaulting the model to whisper-1", () => {
    setSetting(db, "meetings.transcribe.endpoint", "http://127.0.0.1:8080");
    expect(transcriptionEndpoint(db)).toBeDefined();
  });

  it("refuses a plain-text address on the network rather than sending audio there", () => {
    setSetting(db, "meetings.transcribe.endpoint", "http://192.168.1.20:8080");
    expect(transcriptionEndpoint(db)).toBeUndefined();
  });
});
