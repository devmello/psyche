import { openDb, setSetting } from "@psyche/db";
import { EVERYTHING_READABLE_SOURCES } from "@psyche/protocol";
import { defaultSourcesConfig } from "@psyche/search";
import { describe, expect, it } from "vitest";
import { everythingSettings, indexedSources } from "../src/compose/everything.ts";
import { contactParent } from "../src/compose/search-apple.ts";
import { sourceRules } from "../src/compose/search-memory.ts";

describe("Contacts is a Search source, and changes nothing about what memory learned from it", () => {
  it("a fact learned from the Contacts connector keeps passing the source rules", () => {
    const cfg = defaultSourcesConfig();
    cfg.sources.memory.agent = true;
    cfg.sources.contacts.enabled = true;
    // Owner-only for the agent by default, yet a fact cited from Contacts is not held back by it.
    expect(cfg.sources.contacts.agent).toBe(false);
    expect(sourceRules(cfg)("contacts")).toBe(true);
    // A real Search source still applies its rule.
    cfg.sources.messages.agent = false;
    expect(sourceRules(cfg)("messages")).toBe(false);
  });

  it("memory never learns from the Contacts search source", () => {
    expect(EVERYTHING_READABLE_SOURCES).not.toContain("contacts");
    const db = openDb(":memory:");
    setSetting(db, "search.sources", { sources: { contacts: { enabled: true } } });
    expect(indexedSources(db)).toContain("contacts");
    expect(Object.keys(everythingSettings(undefined, indexedSources(db)).sources)).not.toContain(
      "contacts",
    );
  });
});

const person = { id: "e1", kind: "person", status: "active", hidden: false, private: false };
const graph = (
  entity: Record<string, unknown> | undefined,
  known: Record<string, string> = { "email:jordan@acme.example": "e1" },
) =>
  ({
    resolveIdentifier: (kind: string, value: string) => known[`${kind}:${value}`],
    getEntity: (id: string) => (id === entity?.id ? entity : undefined),
  }) as never;

const jordan = { id: "c1" };

describe("contactParent: one result per person", () => {
  it("matches by the Apple contact id the people graph recorded, onto the person's document", () => {
    expect(contactParent(graph(person, { "contact:c1": "e1" }), jordan)).toBe("entity:e1");
  });

  it("never by an email or number: another source could have planted those", () => {
    const known = { "email:jordan@acme.example": "e1", "phone:+15105550101": "e1" };
    expect(contactParent(graph(person, known), jordan)).toBeUndefined();
  });

  it("is undefined without memory, without a match, or for a hidden, private or non-person entity", () => {
    const known = { "contact:c1": "e1" };
    expect(contactParent(undefined, jordan)).toBeUndefined();
    expect(contactParent(graph(person, {}), jordan)).toBeUndefined();
    expect(contactParent(graph({ ...person, hidden: true }, known), jordan)).toBeUndefined();
    expect(contactParent(graph({ ...person, private: true }, known), jordan)).toBeUndefined();
    expect(contactParent(graph({ ...person, kind: "org" }, known), jordan)).toBeUndefined();
    expect(contactParent(graph({ ...person, status: "merged" }, known), jordan)).toBeUndefined();
  });
});
