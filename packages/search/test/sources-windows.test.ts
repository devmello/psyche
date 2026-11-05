import { describe, expect, it } from "vitest";
import {
  type AppleSourceDeps,
  appleAdapters,
  defaultSourcesConfig,
  SourceIndexer,
  type ToolCall,
} from "../src/index.ts";
import { NOW, setup } from "./helpers.ts";

/**
 * On Windows the Apple adapters read whatever the Gateway hands in (Outlook through the Windows
 * helper, Microsoft 365, Google, To Do), and Notes and Messages, Mac apps, are not offered at all:
 * no row in Settings, never read, whatever an old setting says.
 */
describe("sources on Windows", () => {
  it("lists no Notes or Messages row and reads the rest from what the host hands in", async () => {
    const calls: string[] = [];
    let connected = true;
    const call: ToolCall = async (tool, p) => {
      calls.push(tool);
      if (tool === "reminders_list")
        return {
          reminders:
            p.completed === true
              ? []
              : [{ id: "L1|t1", title: "Renew passport", completed: false, shared: false }],
        };
      throw new Error(`no ${tool}`);
    };
    const deps: AppleSourceDeps = {
      call: (app) => (connected && app === "reminders" ? call : undefined),
      helper: () => async (cap) => {
        calls.push(cap);
        return { messages: [], cursor: 0, hasMore: false };
      },
      ownAddresses: () => [],
      owned: (_app, row) => row.shared === false,
      platform: "win32",
      now: () => NOW,
    };
    const { index } = setup();
    const config = defaultSourcesConfig();
    for (const id of ["mail", "notes", "messages", "reminders"] as const)
      config.sources[id].enabled = true;
    const indexer = new SourceIndexer(index, appleAdapters(deps), {
      config: () => config,
      now: () => NOW,
      pauseMs: 0,
      pageSize: 2,
    });
    const ids = indexer.status().sources.map((s) => s.id);
    expect(ids).not.toContain("notes");
    expect(ids).not.toContain("messages");
    expect(ids).toEqual(expect.arrayContaining(["mail", "calendar", "reminders", "contacts"]));
    expect(indexer.status().sources.find((s) => s.id === "mail")?.detail).toBe(
      "neither Outlook nor a Microsoft 365 or Google account is connected",
    );
    await indexer.tick();
    expect(calls).not.toContain("notes_list");
    expect(calls).not.toContain("messages.graph_read");
    const rows = index.db.prepare("SELECT id, provenance FROM search_docs").all() as {
      id: string;
      provenance: string;
    }[];
    expect(rows).toEqual([{ id: "reminders:L1|t1", provenance: "owner" }]);
    connected = false;
    expect(indexer.status().sources.find((s) => s.id === "reminders")?.detail).toBe(
      "neither Outlook nor Microsoft To Do (Microsoft 365) is connected",
    );
  });
});
