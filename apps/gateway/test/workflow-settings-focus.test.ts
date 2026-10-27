import { openDb, setSetting } from "@psyche/db";
import { describe, expect, it } from "vitest";
import { WORKFLOW_SETTING_KEYS, workflowSettings } from "../src/compose/workflow-settings.ts";

describe("mail.schedule.focusTime in the workflow settings", () => {
  it("is off until the owner turns it on, and a change re-syncs the schedules", () => {
    const db = openDb(":memory:");
    expect(workflowSettings(db).focusTime).toBe(false);
    setSetting(db, "mail.schedule.focusTime", true);
    expect(workflowSettings(db).focusTime).toBe(true);
    setSetting(db, "mail.schedule.focusTime", "yes");
    expect(workflowSettings(db).focusTime).toBe(false);
    expect(WORKFLOW_SETTING_KEYS).toContain("mail.schedule.focusTime");
  });
});
