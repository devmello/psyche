import { validateParams } from "@psyche/protocol";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { FIXTURE_NOW } from "../src/fixtures/index.ts";
import { isMessageId } from "../src/i18n/core.ts";
import {
  type McpPreset,
  missingFields,
  type PresetValues,
  presetMessageId,
  presetServer,
} from "../src/screens/settings/mcp-preset-build.ts";
import { MCP_PRESETS } from "../src/screens/settings/mcp-presets.ts";
import { SettingsScreen } from "../src/screens/settings/SettingsScreen.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

/** The Add connector gallery: curated MCP presets must be valid, translated and safe. */

/** A plausible value for every field of a preset. */
function sampleValues(p: McpPreset): PresetValues {
  const sample: Record<string, string> = {};
  for (const f of p.fields) {
    sample[f.id] =
      f.prefix !== undefined
        ? `${f.prefix}live_secretvalue123`
        : f.kind === "secret"
          ? "sk-secret-value-123"
          : f.domains
            ? "example.com, api.example.org"
            : f.placeholder?.startsWith("https://")
              ? "https://home.example.com/api/mcp"
              : "/Users/you/Folder";
  }
  return sample;
}

describe("MCP presets", () => {
  it("have unique ids and a message for every word they show", () => {
    expect(new Set(MCP_PRESETS.map((p) => p.id)).size).toBe(MCP_PRESETS.length);
    for (const p of MCP_PRESETS) {
      const ids = [
        `gallery.preset.${presetMessageId(p)}.desc`,
        `gallery.preset.${presetMessageId(p)}.example`,
        ...p.fields.flatMap((f) => [
          `gallery.preset.${presetMessageId(p)}.field.${f.id}.label`,
          `gallery.preset.${presetMessageId(p)}.field.${f.id}.help`,
        ]),
      ];
      for (const id of ids) expect(isMessageId(id), id).toBe(true);
    }
  });

  it("build requests that validate against mcp.probe, with keys only as vault placeholders", () => {
    for (const p of MCP_PRESETS) {
      const values = sampleValues(p);
      expect(missingFields(p, values), p.id).toEqual([]);
      const { input, secrets } = presetServer(p, values, "ab12");
      expect(() => validateParams("mcp.probe", { server: input }), p.id).not.toThrow();
      for (const k of secrets) {
        expect(() =>
          validateParams("vault.add", {
            kind: "api_key",
            name: k.name,
            slug: k.slug,
            bindings: [{ connector: `mcp:${input.id}` }],
            secret: { token: k.token },
          }),
        ).not.toThrow();
      }
      const json = JSON.stringify(input);
      for (const f of p.fields.filter((x) => x.kind === "secret")) {
        expect(json, p.id).not.toContain(values[f.id] as string);
      }
      expect(secrets.length, p.id).toBe(p.fields.filter((f) => f.kind === "secret").length);
      if (input.transport.kind === "http") expect(input.transport.url).toMatch(/^https:\/\//);
      else expect(input.transport.command.join(" ")).not.toContain("{");
    }
  });

  it("need what they ask for, and Stripe only takes a restricted key", () => {
    const stripe = MCP_PRESETS.find((p) => p.id === "stripe") as McpPreset;
    expect(missingFields(stripe, {})).toEqual(["key"]);
    expect(missingFields(stripe, { key: "sk_live_full_access" })).toEqual(["key"]);
    expect(missingFields(stripe, { key: "rk_live_readonly" })).toEqual([]);
    const gh = MCP_PRESETS.find((p) => p.id === "github") as McpPreset;
    expect(presetServer(gh, { token: "ghp_x" }, "zz00").input.transport).toMatchObject({
      auth: { kind: "bearer", credential: "{{cred:mcp-github-token-zz00}}" },
    });
  });

  it("let the owner list the websites a stdio server may reach", () => {
    const fetch = MCP_PRESETS.find((p) => p.id === "fetch") as McpPreset;
    const { input } = presetServer(fetch, { sites: "en.wikipedia.org, example.com" }, "zz00");
    expect(input.allowedDomains).toEqual(
      expect.arrayContaining(["pypi.org", "en.wikipedia.org", "example.com"]),
    );
  });
});

function setup(): () => MockGateway {
  let gw: MockGateway | null = null;
  render(
    <StoryWorld onGateway={(g) => (gw = g)}>
      <SettingsScreen now={Date.parse(FIXTURE_NOW)} defaultSection="connectors" />
    </StoryWorld>,
  );
  return () => {
    if (gw === null) throw new Error("gateway not ready");
    return gw;
  };
}

async function openGallery() {
  await waitFor(async () => {
    await userEvent.click(
      screen.getAllByRole("button", { name: "Add connector" })[0] as HTMLElement,
    );
    expect(screen.getByRole("searchbox", { name: "Search connectors" })).toBeTruthy();
  });
}

describe("Add connector gallery", () => {
  it("groups built-in connectors and presets by category, and searches them", async () => {
    setup();
    await openGallery();
    const popular = screen.getByRole("region", { name: "Popular" });
    expect(within(popular).getByRole("button", { name: /GitHub/ })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Files and knowledge" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Your own" })).toBeTruthy();
    // A built-in connector sits next to the presets.
    expect(screen.getByRole("button", { name: /Obsidian/ })).toBeTruthy();

    await userEvent.type(screen.getByRole("searchbox", { name: "Search connectors" }), "stripe");
    expect(screen.getByRole("button", { name: /Stripe/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Obsidian/ })).toBeNull();
    await userEvent.clear(screen.getByRole("searchbox", { name: "Search connectors" }));
    await userEvent.type(screen.getByRole("searchbox", { name: "Search connectors" }), "zzzz");
    expect(screen.getByText(/Nothing matches/)).toBeTruthy();
  });

  it("stores a key in the vault, probes with a placeholder, and removes the key if cancelled", async () => {
    const gateway = setup();
    await openGallery();
    await userEvent.click(screen.getByRole("button", { name: /Brave Search/ }));
    const key = screen.getByLabelText("API key");
    await userEvent.type(key, "BSA-secret-123");
    await userEvent.click(screen.getByRole("button", { name: "Check server" }));

    const card = await screen.findByTestId("mcp-trust-card");
    const calls = gateway().calls;
    const add = calls.find((c) => c.method === "vault.add");
    expect(add?.params).toMatchObject({
      kind: "api_key",
      bindings: [{ connector: "mcp:brave-search" }],
      secret: { token: "BSA-secret-123" },
    });
    const probe = calls.find((c) => c.method === "mcp.probe");
    expect(JSON.stringify(probe?.params)).not.toContain("BSA-secret-123");
    expect(JSON.stringify(probe?.params)).toMatch(/\{\{cred:mcp-brave-search-key-/);

    await userEvent.click(within(card).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(gateway().calls.map((c) => c.method)).toContain("vault.delete"));
  });
});
