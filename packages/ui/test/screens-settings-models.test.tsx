import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { FIXTURE_NOW } from "../src/fixtures/index.ts";
import { EndpointProbeStatus } from "../src/screens/settings/ModelSection.tsx";
import { SettingsScreen } from "../src/screens/settings/SettingsScreen.tsx";
import {
  sampleEndpointProbes,
  sampleModelProviders,
  sampleModelRoles,
  sampleSettings,
} from "../src/screens/settings/sample-data.ts";
import { StoryWorld } from "../src/stories/harness.tsx";

/** Settings → Model & providers over `models.*` (B1, B4), against recorded probe fixtures. */

function setup(): () => MockGateway {
  let gw: MockGateway | null = null;
  render(
    <StoryWorld
      edit={(w) => {
        Object.assign(w.settings, sampleSettings());
        w.modelProviders = sampleModelProviders();
        w.modelRoles = sampleModelRoles();
        w.modelProbes = sampleEndpointProbes();
      }}
      onGateway={(g) => {
        gw = g;
      }}
    >
      <SettingsScreen now={Date.parse(FIXTURE_NOW)} defaultSection="model" />
    </StoryWorld>,
  );
  return () => {
    if (gw === null) throw new Error("gateway not ready");
    return gw;
  };
}

const callsOf = (g: MockGateway, method: string) => g.calls.filter((c) => c.method === method);

describe("Model & providers over models.*", () => {
  it("shows configured providers as not checked and probes only on a click", async () => {
    const gateway = setup();
    const lmstudio = await screen.findByRole("button", { name: "Check the LM Studio endpoint" });
    expect(screen.getAllByText("Endpoint not checked")).toHaveLength(3);
    expect(screen.getByText(/Endpoint http:\/\/127\.0\.0\.1:1234\/v1/)).toBeTruthy();
    expect(callsOf(gateway(), "models.probe")).toEqual([]);

    await userEvent.click(lmstudio);
    expect(callsOf(gateway(), "models.probe").map((c) => c.params)).toEqual([
      { providerId: "lmstudio" },
    ]);
    expect(await screen.findByText("Reachable")).toBeTruthy();
    expect(screen.getByText(/3 models · LM Studio · 12 ms/)).toBeTruthy();
    const models = screen.getByRole("list", { name: "LM Studio models" });
    expect(within(models).getByText("lmstudio/google/gemma-4-12b")).toBeTruthy();
    expect(within(models).getAllByText("Vision")).toHaveLength(1);
    expect(within(models).getByText("32K context")).toBeTruthy();
    expect(within(models).getByText("Embeddings")).toBeTruthy();
    // Embedding models are not offered as chat roles.
    const primary = screen.getByLabelText(/^Primary/) as HTMLSelectElement;
    const options = [...primary.options].map((o) => o.value);
    expect(options).toContain("lmstudio/qwen/qwen3.8-27b");
    expect(options).not.toContain("lmstudio/text-embedding-nomic-embed-text-v1.5");
  });

  it("names models by their label, with the ref at level 2 (audit decision 3)", async () => {
    const gateway = setup();
    await userEvent.click(
      await screen.findByRole("button", { name: "Check the LM Studio endpoint" }),
    );
    const models = await screen.findByRole("list", { name: "LM Studio models" });
    expect(await within(models).findByText("Qwen3.8 27B")).toBeTruthy();
    expect(within(models).getByText("lmstudio/qwen/qwen3.8-27b").className).toContain(
      "text-muted-foreground",
    );
    expect(
      within(screen.getByLabelText(/^Primary/)).getByRole("option", { name: /^Qwen3\.8 27B/ }),
    ).toBeTruthy();
    expect(gateway()).toBeTruthy();
  });

  it("shows a failed models.list inline and keeps the saved providers", async () => {
    let gw: MockGateway | null = null;
    render(
      <StoryWorld
        edit={(w) => Object.assign(w.settings, sampleSettings())}
        onGateway={(g) => {
          gw = g;
          g.failNext("models.list", "unavailable", "the router is restarting");
        }}
      >
        <SettingsScreen now={Date.parse(FIXTURE_NOW)} defaultSection="model" />
      </StoryWorld>,
    );
    expect(
      await screen.findByText(/Psyche couldn't list the models \(the router is restarting\)/),
    ).toBeTruthy();
    expect(
      screen.getByText("Showing the providers saved in settings.", { exact: false }),
    ).toBeTruthy();
    expect(gw).not.toBeNull();
  });

  it("reports an endpoint nothing answers at", async () => {
    setup();
    await userEvent.click(
      await screen.findByRole("button", { name: "Check the llama.cpp endpoint" }),
    );
    expect(await screen.findByText("nothing answered at http://127.0.0.1:8080/v1")).toBeTruthy();
    expect(screen.getAllByText("Not reachable").length).toBeGreaterThan(0);
  });

  it("picks the utility model through models.setRole", async () => {
    const gateway = setup();
    await userEvent.click(
      await screen.findByRole("button", { name: "Check the LM Studio endpoint" }),
    );
    await screen.findByText("Reachable");
    await userEvent.selectOptions(screen.getByLabelText(/^Utility/), "lmstudio/google/gemma-4-12b");
    await waitFor(() =>
      expect(callsOf(gateway(), "models.setRole").map((c) => c.params)).toEqual([
        { role: "utility", ref: "lmstudio/google/gemma-4-12b" },
      ]),
    );
    expect(callsOf(gateway(), "settings.set")).toEqual([]);
    await waitFor(() =>
      expect((screen.getByLabelText(/^Utility/) as HTMLSelectElement).value).toBe(
        "lmstudio/google/gemma-4-12b",
      ),
    );
  });

  it("asks before using a chat-only model as primary (B4)", async () => {
    const gateway = setup();
    const primary = (await screen.findByLabelText(/^Primary/)) as HTMLSelectElement;
    await waitFor(() => expect(primary.value).toBe("anthropic/claude-sonnet-5-5"));
    await userEvent.selectOptions(primary, "llamacpp/tiny-chat");
    const alert = await screen.findByText(/failed the tool-calling check/);
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(alert.textContent).toContain("llamacpp/tiny-chat");
    await userEvent.click(screen.getByRole("button", { name: "Use anyway" }));
    await waitFor(() =>
      expect(callsOf(gateway(), "models.setRole").map((c) => c.params)).toEqual([
        { role: "primary", ref: "llamacpp/tiny-chat" },
        { role: "primary", ref: "llamacpp/tiny-chat", override: true },
      ]),
    );
    await waitFor(() => expect(primary.value).toBe("llamacpp/tiny-chat"));
  });

  it("runs the tool-calling check through models.check", async () => {
    const gateway = setup();
    await userEvent.click(
      await screen.findByRole("button", {
        name: "Run the tool-calling check on llamacpp/tiny-chat",
      }),
    );
    await waitFor(() =>
      expect(callsOf(gateway(), "models.check").map((c) => c.params)).toEqual([
        { ref: "llamacpp/tiny-chat" },
      ]),
    );
    expect(await screen.findAllByText("Tool calling: passed")).toBeTruthy();
  });
});

describe("EndpointProbeStatus", () => {
  it("shows a refused key with its reason and offers a re-check", async () => {
    let clicked = 0;
    render(
      <EndpointProbeStatus
        label="Anthropic"
        probe={{
          state: "auth_failed",
          probedAt: "2026-10-19T20:00:00Z",
          models: [],
          error: "the endpoint refused the key (HTTP 401)",
        }}
        onProbe={() => {
          clicked += 1;
        }}
      />,
    );
    expect(screen.getByText("Key refused")).toBeTruthy();
    expect(screen.getByText("the endpoint refused the key (HTTP 401)")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Check the Anthropic endpoint" }));
    expect(clicked).toBe(1);
  });

  it("shows a running probe without the button", () => {
    render(
      <EndpointProbeStatus label="LM Studio" probe={{ state: "not_probed", models: [] }} probing />,
    );
    expect(screen.getByText("Checking the endpoint")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
