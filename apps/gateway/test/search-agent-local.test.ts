import { createSearchIndex, defaultSourcesConfig, SOURCE_IDS, sourceTag } from "@psyche/search";
import { describe, expect, it } from "vitest";
import { agentLocalSearch } from "../src/compose/search-tool.ts";

/**
 * Deep research's local search (`includeLocal`) runs as the agent: a source the owner kept from the
 * agent never reaches a research model or a report, like `search_everything`.
 */

function world() {
  const index = createSearchIndex();
  const config = defaultSourcesConfig();
  // The indexer mirrors these flags into the index (`setAgentSearchable`).
  for (const id of ["messages", "contacts", "memory", "notes"] as const)
    index.setAgentSearchable(sourceTag(id), config.sources[id].agent);
  return index;
}

const doc = (id: string, source: string, title: string) => ({
  id,
  kind: "connector" as const,
  title,
  text: `${title}: harbor district lease, flat 4B, key code`,
  provenance: "untrusted" as const,
  source,
  createdAt: Date.UTC(2026, 10, 1),
});

describe("agentLocalSearch (deep research)", () => {
  it("finds what the agent may search, and never Contacts, Messages or Memory by default", async () => {
    const index = world();
    await index.indexMany([
      doc("notes:n1", sourceTag("notes"), "Notes lease"),
      doc("contacts:c1", sourceTag("contacts"), "Jordan contact"),
      doc("messages:m1", sourceTag("messages"), "Messages lease"),
      doc("memory:e1", sourceTag("memory"), "Memory lease"),
    ]);
    // The old path (owner audience) saw all four.
    expect((await index.query({ q: "harbor district lease", limit: 10 })).hits).toHaveLength(4);
    const hits = await agentLocalSearch(index)("harbor district lease");
    expect(hits.map((h) => h.id)).toEqual(["notes:n1"]);
  });

  it("follows the owner allowing the agent, and stops again when they take it back", async () => {
    const index = world();
    await index.indexMany([doc("contacts:c1", sourceTag("contacts"), "Jordan contact")]);
    const search = agentLocalSearch(index);
    expect(await search("harbor lease")).toEqual([]);
    index.setAgentSearchable(sourceTag("contacts"), true);
    expect((await search("harbor lease")).map((h) => h.id)).toEqual(["contacts:c1"]);
    index.setAgentSearchable(sourceTag("contacts"), false);
    expect(await search("harbor lease")).toEqual([]);
  });

  it("returns the shape deep research reads", async () => {
    const index = world();
    await index.indexMany([doc("notes:n1", sourceTag("notes"), "Notes lease")]);
    const [hit] = await agentLocalSearch(index)("harbor lease");
    expect(hit).toMatchObject({ id: "notes:n1", kind: "connector", title: "Notes lease" });
    expect(typeof hit?.snippet).toBe("string");
  });

  it("keeps sources set to processing none or local off a cloud research model", async () => {
    const index = world();
    index.setAgentSearchable(sourceTag("contacts"), true);
    index.setAgentSearchable(sourceTag("memory"), true);
    await index.indexMany([
      doc("notes:n1", sourceTag("notes"), "Notes lease"),
      doc("contacts:c1", sourceTag("contacts"), "Jordan contact"),
      doc("memory:e1", sourceTag("memory"), "Memory lease"),
    ]);
    const config = defaultSourcesConfig();
    config.sources.memory.processing = "local";
    const blocked = () =>
      SOURCE_IDS.filter((id) => config.sources[id].processing !== "cloud").map(sourceTag);
    let cloud = true;
    const search = agentLocalSearch(index, 5, { cloudBlocked: blocked, cloud: () => cloud });
    expect((await search("harbor district lease")).map((h) => h.id)).toEqual(["notes:n1"]);
    // Every research model runs on this Mac: nothing to withhold.
    cloud = false;
    expect((await search("harbor district lease")).map((h) => h.id).sort()).toEqual([
      "contacts:c1",
      "memory:e1",
      "notes:n1",
    ]);
    // The owner turns Contacts to cloud processing: it is allowed again.
    cloud = true;
    config.sources.contacts.processing = "cloud";
    expect((await search("harbor district lease")).map((h) => h.id).sort()).toEqual([
      "contacts:c1",
      "notes:n1",
    ]);
  });
});
