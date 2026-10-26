import { describe, expect, it } from "vitest";
import { FsSkillLoader } from "../src/loader.ts";
import { BUNDLED_DIR, OPEN_GATE, tempDir } from "./helpers.ts";

/** Mail and meeting workflow skills (docs/workflows/mail-and-meetings-2026.md, #671). */

async function status(tools: string[]) {
  const loader = new FsSkillLoader({
    homeDir: tempDir(),
    bundledDir: BUNDLED_DIR,
    gate: { ...OPEN_GATE, tools },
  });
  return new Map((await loader.listDetailed()).map((s) => [s.name, s]));
}

describe("gating the mail and meeting skills", () => {
  it("loads them with the workflow tools", async () => {
    const s = await status([
      "mail_search",
      "mail_read",
      "mail.draft_reply",
      "mail.propose_times",
      "calendar_find_free_time",
      "waiting_on",
      "loop_update",
      "speech.transcribe_file",
      "reminders_create",
    ]);
    for (const n of [
      "follow-up-tracking",
      "scheduling-over-email",
      "meeting-notes",
      "inbox-triage",
      "reply-drafting",
    ])
      expect(s.get(n)?.status, n).toBe("active");
  });

  it("follow-ups fall back to reminders; meeting notes to transcript files", async () => {
    const s = await status(["mail_search", "reminders_create", "read_file"]);
    expect(s.get("follow-up-tracking")?.status).toBe("active");
    expect(s.get("meeting-notes")?.status).toBe("active");
  });

  it("says what is missing", async () => {
    const s = await status(["mail_search"]);
    expect(s.get("scheduling-over-email")?.reasons[0]).toContain("needs a calendar");
    expect(s.get("follow-up-tracking")?.reasons[0]).toMatch(
      /People & projects or reminders .*Settings → Memory.*Apple Reminders/,
    );
    expect(s.get("meeting-notes")?.reasons[0]).toContain(
      "turn on the Mac helper's speech engine in Settings → Voice & dictation",
    );
  });
});
