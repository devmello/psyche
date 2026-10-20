import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  OnboardingFlow,
  type OnboardingFlowProps,
} from "../src/screens/onboarding/OnboardingFlow.tsx";
import type { OnboardingResult } from "../src/screens/onboarding/types.ts";
import { StoryWorld } from "../src/stories/harness.tsx";

function setup(props: Partial<OnboardingFlowProps> = {}) {
  const onComplete = vi.fn<(r: OnboardingResult) => void>();
  const onStepChange = vi.fn();
  render(
    <StoryWorld>
      <OnboardingFlow onComplete={onComplete} onStepChange={onStepChange} {...props} />
    </StoryWorld>,
  );
  return { onComplete, onStepChange };
}

const steps = () => within(screen.getByRole("navigation", { name: "Onboarding progress" }));
const next = () => userEvent.click(screen.getByRole("button", { name: "Next" }));
const heading = () => screen.getByRole("heading", { level: 1 });

describe("OnboardingFlow", () => {
  it("shows the steps as an ordered list with aria-current on the current one", async () => {
    const { onStepChange } = setup();
    const list = steps().getByRole("list");
    expect(list.tagName).toBe("OL");
    const items = steps().getAllByRole("listitem");
    expect(items).toHaveLength(6);
    expect(items[0]?.getAttribute("aria-current")).toBe("step");
    expect(items[0]?.textContent).toContain("Meet your agent");
    expect((screen.getByRole("button", { name: /Back/ }) as HTMLButtonElement).disabled).toBe(true);

    await next();
    expect(heading().textContent).toContain("Permissions");
    expect(steps().getAllByRole("listitem")[1]?.getAttribute("aria-current")).toBe("step");
    expect(steps().getAllByRole("listitem")[0]?.getAttribute("aria-current")).toBeNull();
    expect(onStepChange).toHaveBeenLastCalledWith("permissions");
    // Focus lands on the new step's heading.
    expect(document.activeElement).toBe(heading());

    await userEvent.click(screen.getByRole("button", { name: /Back/ }));
    expect(heading().textContent).toContain("Meet your agent");
    // A visited step is reachable from the list.
    await userEvent.click(steps().getByRole("button", { name: "Permissions" }));
    expect(heading().textContent).toContain("Permissions");
  });

  it("names the agent from suggestions or keeps Psyche, and previews the creature", async () => {
    setup();
    const name = screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement;
    await userEvent.click(screen.getByRole("button", { name: "Moss" }));
    expect(name.value).toBe("Moss");
    expect(screen.getByRole("button", { name: "Moss" }).getAttribute("aria-pressed")).toBe("true");
    await userEvent.click(screen.getByRole("button", { name: "Keep “Psyche”" }));
    expect(name.value).toBe("Psyche");
    await userEvent.clear(name);
    await userEvent.type(name, "Wren");
    await userEvent.click(screen.getByRole("radio", { name: "Owl" }));
    const preview = screen.getByRole("figure", { name: "Preview" });
    expect(within(preview).getByText("Wren")).toBeTruthy();
    expect(within(preview).getByRole("img").getAttribute("aria-label") ?? "").toMatch(/Wren/);
    await userEvent.click(screen.getByRole("radio", { name: "Describe it in your words" }));
    await userEvent.type(screen.getByLabelText("Describe Wren"), "a moth with a scarf");
    expect(within(preview).getByText("“a moth with a scarf”")).toBeTruthy();
    // The persona name flows into later step labels.
    expect(steps().getByText("Where Wren works")).toBeTruthy();
  });

  it("asks the shell for each permission, or skips it", async () => {
    const onRequestPermission = vi.fn(async (p: string) =>
      p === "accessibility" ? ("granted" as const) : ("denied" as const),
    );
    setup({ defaultStep: "permissions", onRequestPermission });
    await userEvent.click(screen.getByRole("button", { name: "Allow Accessibility" }));
    expect(onRequestPermission).toHaveBeenCalledWith("accessibility");
    expect(await screen.findByText("Allowed", { selector: "span" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Allow Screen Recording" }));
    expect(await screen.findByText("Denied in macOS")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Skip Notifications" }));
    expect(screen.getByText("Skipped")).toBeTruthy();
  });

  it("says Unavailable, not Skipped, when this shell can't ask (issue #384)", async () => {
    setup({ defaultStep: "permissions" });
    await userEvent.click(screen.getByRole("button", { name: "Allow Accessibility" }));
    expect(await screen.findByText("Unavailable")).toBeTruthy();
    expect(screen.queryByText("Skipped")).toBeNull();
    expect(screen.getByText(/only in the Psyche app on a Mac/)).toBeTruthy();
  });

  it("shows Asking… during the prompt and re-reads macOS on window focus", async () => {
    let answer: (s: "denied") => void = () => undefined;
    const onRequestPermission = vi.fn(() => new Promise<"denied">((resolve) => (answer = resolve)));
    let screenState: "denied" | "granted" = "denied";
    const onReadPermissions = vi.fn(async () => ({ screenRecording: screenState }));
    setup({ defaultStep: "permissions", onRequestPermission, onReadPermissions });
    await userEvent.click(screen.getByRole("button", { name: "Allow Screen Recording" }));
    expect(screen.getByRole("button", { name: "Allow Screen Recording" }).textContent).toContain(
      "Asking…",
    );
    answer("denied");
    expect(await screen.findByText("Denied in macOS")).toBeTruthy();
    // The owner flips the switch in System Settings and comes back.
    screenState = "granted";
    window.dispatchEvent(new Event("focus"));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Allow Screen Recording" }).textContent).toBe(
        "Allowed",
      ),
    );
  });

  it("connects accounts one at a time with read-only vs read-and-act", async () => {
    const onConnect = vi.fn(async () => true);
    setup({ defaultStep: "connectors", onConnect });
    await userEvent.click(screen.getByRole("radio", { name: /^Read and act/ }));
    await userEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(onConnect).toHaveBeenCalledWith("google", "read_act");
    const connected = await screen.findByRole("list", { name: "Connected accounts" });
    expect(within(connected).getByText("Google (Gmail, Calendar, Drive)")).toBeTruthy();
    // The connected type leaves the picker; the next one is offered.
    const picker = screen.getByLabelText("Connect another account") as HTMLSelectElement;
    expect(Array.from(picker.options).map((o) => o.value)).not.toContain("google");
  });

  it("stores the key by reference, shows RAM guidance and runs the tool-calling check", async () => {
    const onSaveKey = vi.fn(async (provider: string) => `vault:${provider}-api-key`);
    const onCheckModel = vi.fn(async () => "failed" as const);
    setup({ defaultStep: "model", onSaveKey, onCheckModel, ramGb: 16 });
    const key = screen.getByLabelText("API key") as HTMLInputElement;
    expect(key.type).toBe("password");
    await userEvent.type(key, "sk-test-123");
    await userEvent.click(screen.getByRole("button", { name: "Save to vault" }));
    expect(onSaveKey).toHaveBeenCalledWith("anthropic", "sk-test-123");
    expect(await screen.findByText("vault:anthropic-api-key")).toBeTruthy();
    expect(document.body.textContent).not.toContain("sk-test-123");
    await userEvent.click(screen.getByRole("button", { name: "Run check" }));
    expect(await screen.findByText("Chat only: tool-calling check failed")).toBeTruthy();
    expect(onCheckModel).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "anthropic", keyRef: "vault:anthropic-api-key" }),
    );

    await userEvent.click(screen.getByRole("radio", { name: /^Local model/ }));
    expect(screen.getByText(/This Mac has 16 GB/)).toBeTruthy();
    expect(screen.queryByLabelText("API key")).toBeNull();
  });

  it("explains what the VM guest can see", async () => {
    setup({ defaultStep: "where", initial: { persona: { name: "Wren" } } });
    expect(heading().textContent).toContain("Where Wren works");
    await userEvent.click(screen.getByRole("radio", { name: /VM mode/ }));
    expect(screen.getByText(/Its own disk, folders you share/)).toBeTruthy();
  });

  it("completes with the full result", async () => {
    const { onComplete } = setup({
      onRequestPermission: () => "granted",
      onConnect: () => true,
      onSaveKey: (p) => `vault:${p}`,
      onCheckModel: () => "passed",
    });
    await userEvent.click(screen.getByRole("button", { name: "Pip" }));
    await userEvent.type(
      screen.getByRole("textbox", { name: "Vibe or tagline" }),
      "Small and sure.",
    );
    await next();
    await userEvent.click(screen.getByRole("button", { name: "Allow Accessibility" }));
    await userEvent.click(screen.getByRole("button", { name: "Skip Screen Recording" }));
    await next();
    await userEvent.click(screen.getByRole("button", { name: "Connect" }));
    await screen.findByRole("list", { name: "Connected accounts" });
    await next();
    await userEvent.type(screen.getByLabelText("API key"), "k");
    await userEvent.click(screen.getByRole("button", { name: "Save to vault" }));
    await userEvent.click(await screen.findByRole("button", { name: "Run check" }));
    await screen.findByText("Tool calling: passed");
    await next();
    await userEvent.click(screen.getByRole("radio", { name: /VM mode/ }));
    await next();
    expect(heading().textContent).toContain("Done");
    expect(screen.getByText("Pip is ready.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Open the main chat" }));
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(onComplete.mock.calls[0]?.[0]).toEqual({
      persona: {
        name: "Pip",
        creatureId: "moth",
        creatureDescription: null,
        tagline: "Small and sure.",
      },
      permissions: {
        accessibility: "granted",
        screenRecording: "skipped",
        notifications: "pending",
      },
      connectors: [{ type: "google", label: "Google (Gmail, Calendar, Drive)", mode: "read" }],
      model: {
        kind: "cloud",
        provider: "anthropic",
        modelRef: "anthropic/claude-sonnet-5-5",
        keyRef: "vault:anthropic",
        toolCheck: "passed",
      },
      workspace: "vm",
    });
  });

  it("is keyboard operable: Tab to Next and press Enter", async () => {
    setup();
    const nextButton = screen.getByRole("button", { name: "Next" });
    nextButton.focus();
    await userEvent.keyboard("{Enter}");
    expect(heading().textContent).toContain("Permissions");
    expect(document.activeElement).toBe(heading());
    await userEvent.tab();
    expect(document.activeElement?.textContent).toBe("Allow");
  });
});

describe("First run from scratch", () => {
  it("shows the vault recovery key once when saving the key created the vault", async () => {
    setup({
      step: "model",
      onSaveKey: async () => ({ keyRef: "model-anthropic", recoveryKey: "ABCD-EFGH-IJKL" }),
    });
    await userEvent.type(screen.getByLabelText("API key"), "sk-ant-x");
    await userEvent.click(screen.getByRole("button", { name: "Save to vault" }));
    expect((await screen.findByTestId("vault-recovery-key")).textContent).toContain(
      "ABCD-EFGH-IJKL",
    );
    expect(screen.getByRole("status").textContent).toContain("model-anthropic");
    const next = screen.getByRole("button", { name: "Next" }) as HTMLButtonElement;
    expect(next.disabled).toBe(true);
    await userEvent.click(screen.getByRole("checkbox", { name: "I saved it" }));
    expect(next.disabled).toBe(false);
  });

  it("lists the setup checks on Done", async () => {
    const onVerify = vi.fn(async () => [
      { id: "gateway", label: "Gateway", state: "ok" as const, detail: "Running on this Mac." },
      { id: "model", label: "Model", state: "warn" as const, detail: "None picked." },
    ]);
    setup({ step: "done", onVerify });
    const list = await screen.findByTestId("setup-checks");
    expect(list.textContent).toContain("Running on this Mac.");
    expect(list.textContent).toContain("None picked.");
    expect(onVerify).toHaveBeenCalledOnce();
  });
});

describe("Mac helper in onboarding", () => {
  it("shows the bundled helper's state in Permissions without blocking Next", async () => {
    setup({ step: "permissions", helper: { kind: "starting" } });
    const row = screen.getByTestId("mac-helper-status");
    expect(row.textContent).toContain("Psyche Helper");
    expect(row.textContent).toContain("Starting…");
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("shows nothing for it when the host has no helper (web)", () => {
    setup({ step: "permissions" });
    expect(screen.queryByTestId("mac-helper-status")).toBeNull();
  });
});

describe("Onboarding polish (UI design §3.19)", () => {
  it("carries the Psyche mark above the steps", () => {
    setup();
    expect(screen.getByTestId("onboarding-mark").textContent).toContain("Psyche");
  });

  it("offers Skip for now while nothing is connected, and lists what is", async () => {
    setup({ defaultStep: "connectors", onConnect: async () => true });
    expect(screen.getByRole("button", { name: "Skip for now" })).toBeTruthy();
    expect(screen.getByText(/Nothing connected yet/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Connect" }));
    const connected = await screen.findByRole("list", { name: "Connected accounts" });
    expect(within(connected).getAllByRole("listitem")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Skip for now" })).toBeNull();
  });

  it("skips Connectors with nothing connected", async () => {
    const { onStepChange } = setup({ defaultStep: "connectors" });
    await userEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(onStepChange).toHaveBeenLastCalledWith("model");
    expect(heading().textContent).toContain("Model & provider");
  });

  it("picks the model from a list, with another model as an escape hatch", async () => {
    const onCheckModel = vi.fn(async () => "passed" as const);
    setup({ defaultStep: "model", onCheckModel });
    const models = screen.getByRole("radiogroup", { name: "Model" });
    expect(
      (
        within(models).getByRole("radio", { name: /^Claude Sonnet 5\.5/ }) as HTMLElement
      ).getAttribute("aria-checked"),
    ).toBe("true");
    expect(screen.queryByRole("textbox", { name: "Model id" })).toBeNull();
    await userEvent.click(within(models).getByRole("radio", { name: /^Claude Opus 5\.5/ }));
    await userEvent.click(within(models).getByRole("radio", { name: /^Another model/ }));
    const id = screen.getByRole("textbox", { name: "Model id" }) as HTMLInputElement;
    expect(id.value).toBe("anthropic/claude-opus-5-5");
  });

  it("draws each bundled creature as one radio tile", () => {
    setup();
    const group = screen.getByRole("radiogroup", { name: "Bundled creatures" });
    const owl = within(group).getByRole("radio", { name: "Owl" });
    expect(owl.querySelector('[role="radio"]')).toBeNull();
  });
});
