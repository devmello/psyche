import { describe, expect, it } from "vitest";
import { contactsAdapter, defaultSourcesConfig, SourceIndexer } from "../src/index.ts";
import { NOW, setup } from "./helpers.ts";

/**
 * A source's status line carries a machine `reason` beside the English `detail`, so Settings can
 * say it in the owner's language: for the texts an adapter gives for "cannot read now", and for an
 * error a helper refusal raised with `details.reason`. Free text never becomes a reason.
 */
type Helper = (capability: string, params: Record<string, unknown>) => Promise<unknown>;

function indexerFor(helper: Helper | undefined, noHelper?: string) {
  const { index } = setup();
  const config = defaultSourcesConfig();
  config.sources.contacts.enabled = true;
  const adapter = contactsAdapter({
    helper: () => helper as never,
    ...(noHelper === undefined ? {} : { noHelper }),
    now: () => NOW,
  });
  return new SourceIndexer(index, [adapter], { config: () => config, now: () => NOW, pauseMs: 0 });
}
const contacts = (i: SourceIndexer) => i.status().sources.find((s) => s.id === "contacts");
const failing =
  (err: Error): Helper =>
  async () => {
    throw err;
  };

describe("source status reasons", () => {
  it("names the reason of the known 'helper not connected' text", () => {
    const s = contacts(indexerFor(undefined));
    expect(s).toMatchObject({
      state: "unavailable",
      detail: "the Mac helper is not connected",
      reason: "needs_helper",
    });
  });

  it("gives no reason for a text it has no id for (the Windows one), keeping the English", () => {
    const s = contacts(indexerFor(undefined, "classic Outlook is not available"));
    expect(s?.detail).toBe("classic Outlook is not available");
    expect(s).not.toHaveProperty("reason");
  });

  it("carries a helper refusal's details.reason on an error state", async () => {
    const refuse = Object.assign(new Error("needs Full Disk Access to read Messages"), {
      details: { reason: "full_disk_access_missing" },
    });
    const i = indexerFor(failing(refuse));
    await i.tick();
    expect(contacts(i)).toMatchObject({
      state: "error",
      detail: "needs Full Disk Access to read Messages",
      reason: "full_disk_access_missing",
    });
  });

  it("drops a reason that is not an identifier, and one from an error without details", async () => {
    const odd = Object.assign(new Error("odd"), { details: { reason: "Not allowed, sorry" } });
    const i = indexerFor(failing(odd));
    await i.tick();
    expect(contacts(i)).toMatchObject({ state: "error", detail: "odd" });
    expect(contacts(i)).not.toHaveProperty("reason");
    const j = indexerFor(failing(new Error("plain")));
    await j.tick();
    expect(contacts(j)).not.toHaveProperty("reason");
  });
});
