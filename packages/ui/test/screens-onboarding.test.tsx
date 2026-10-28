import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import type { FixtureWorld } from "../src/fixtures/index.ts";
import {
  OnboardingFlow,
  type OnboardingFlowProps,
} from "../src/screens/onboarding/OnboardingFlow.tsx";
import type { OnboardingResult } from "../src/screens/onboarding/types.ts";
import type { UiSlots } from "../src/slots.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

function setup(props: Partial<OnboardingFlowProps> = {}, slots: UiSlots = {}) {
  const onComplete = vi.fn<(r: OnboardingResult) => void>();
  const onStepChange = vi.fn();
  render(
    // First run: the Gateway has no connectors yet.
    <StoryWorld
      slots={slots}
      edit={(w) => {
        w.connectors = [];
      }}
    >
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
    expect(items).toHaveLength(11);
    expect(items[0]?.getAttribute("aria-current")).toBe("step");
    expect(items[0]?.textContent).toContain("Meet your agent");
    expect((screen.getByRole("button", { name: /Back/ }) as HTMLButtonElement).disabled).toBe(true);

    await next();
    expect(heading().textContent).toContain("About you");
    await next();
    expect(heading().textContent).toContain("Permissions");
    expect(steps().getAllByRole("listitem")[2]?.getAttribute("aria-current")).toBe("step");
    expect(steps().getAllByRole("listitem")[0]?.getAttribute("aria-current")).toBeNull();
    expect(onStepChange).toHaveBeenLastCalledWith("permissions");
    // Focus lands on the new step's heading.
    expect(document.activeElement).toBe(heading());

    await userEvent.click(screen.getByRole("button", { name: /Back/ }));
    expect(heading().textContent).toContain("About you");
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
    const connected = await screen.findByRole("list", { name: "Your accounts" });
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

  it("binds a Claude subscription to the claude-code CLI provider, not the API (#537)", async () => {
    const onCheckModel = vi.fn(() => "passed" as const);
    setup({ defaultStep: "model", onCheckModel });
    await userEvent.click(screen.getByRole("radio", { name: /^Subscription/ }));
    expect(screen.queryByLabelText("API key")).toBeNull();
    expect(screen.getByText(/needs no API key and stores none/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Run check" }));
    expect(onCheckModel).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "subscription",
        provider: "claude-code",
        modelRef: "claude-code/sonnet",
      }),
    );
    await userEvent.click(screen.getByRole("radio", { name: /^Claude Opus/ }));
    await userEvent.click(screen.getByRole("button", { name: "Run check" }));
    expect(onCheckModel).toHaveBeenLastCalledWith(
      expect.objectContaining({ modelRef: "claude-code/opus" }),
    );
    await userEvent.selectOptions(screen.getByRole("combobox", { name: /Provider/ }), "codex");
    await userEvent.click(screen.getByRole("button", { name: "Run check" }));
    expect(onCheckModel).toHaveBeenLastCalledWith(
      expect.objectContaining({ provider: "codex", modelRef: "codex/default" }),
    );
  });

  it("keeps the key field open when the provider refuses the saved key (#504)", async () => {
    const onSaveKey = vi.fn(async (provider: string) => ({
      keyRef: `model-${provider}`,
      refused: "the endpoint refused the key (HTTP 401: invalid x-api-key)",
    }));
    setup({ defaultStep: "model", onSaveKey });
    await userEvent.type(screen.getByLabelText("API key"), "sk-ant-wrong");
    await userEvent.click(screen.getByRole("button", { name: "Save to vault" }));
    expect(
      await screen.findByText(
        /The provider refused this key \(the endpoint refused the key \(HTTP 401: invalid x-api-key\)\)/,
      ),
    ).toBeTruthy();
    expect(screen.queryByText("The key was not stored.")).toBeNull();
    // Not marked stored: another paste replaces it.
    expect(screen.queryByText("model-anthropic")).toBeNull();
    expect(screen.getByLabelText("API key")).toBeTruthy();
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
    // About you is skippable and optional.
    await screen.findByRole("textbox", { name: "Your name" });
    await next();
    await userEvent.click(screen.getByRole("button", { name: "Allow Accessibility" }));
    await userEvent.click(screen.getByRole("button", { name: "Skip Screen Recording" }));
    await next();
    await userEvent.click(screen.getByRole("button", { name: "Connect" }));
    await screen.findByRole("list", { name: "Your accounts" });
    await next();
    // Google is a mail account, so the mail and meetings decision screen follows (§7.5).
    expect(heading().textContent).toContain("Mail and meetings");
    await userEvent.click(screen.getByRole("switch", { name: "Track replies you’re waiting on" }));
    await next();
    // The optional Sandbox step: the mock Gateway already has one.
    expect(heading().textContent).toContain("Sandbox");
    await next();
    await userEvent.type(screen.getByLabelText("API key"), "k");
    await userEvent.click(screen.getByRole("button", { name: "Save to vault" }));
    await userEvent.click(await screen.findByRole("button", { name: "Run check" }));
    await screen.findByText("Tool calling: passed");
    await next();
    await userEvent.click(screen.getByRole("radio", { name: /VM mode/ }));
    await next();
    // Memory import, First wins and Habits are each skippable.
    expect(heading().textContent).toContain("Bring your memory");
    await next();
    expect(heading().textContent).toContain("First wins");
    await next();
    expect(heading().textContent).toContain("Turn on habits");
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
      mail: { digest: true, prep: true, followups: false, voice: false, notes: true },
      owner: { name: "", timeZone: expect.any(String), work: "", city: "" },
      habits: { brief: true, wrapup: false, followups: true },
    });
  });

  it("is keyboard operable: Tab to Next and press Enter", async () => {
    setup();
    const nextButton = screen.getByRole("button", { name: "Next" });
    nextButton.focus();
    await userEvent.keyboard("{Enter}");
    expect(heading().textContent).toContain("About you");
    expect(document.activeElement).toBe(heading());
    await userEvent.tab();
    expect((document.activeElement as HTMLElement).id).toBe("onboarding-about-name");
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
    expect(
      screen.getAllByRole("status").some((s) => s.textContent?.includes("model-anthropic")),
    ).toBe(true);
    const next = screen.getByRole("button", { name: "Next" }) as HTMLButtonElement;
    expect(next.disabled).toBe(true);
    await userEvent.click(screen.getByRole("checkbox", { name: "I saved it" }));
    expect(next.disabled).toBe(false);
  });

  it("copies the recovery key through the host's clipboard and says so (#507)", async () => {
    const writeClipboard = vi.fn(async (_text: string) => {});
    setup(
      {
        step: "model",
        onSaveKey: async () => ({ keyRef: "model-anthropic", recoveryKey: "ABCD-EFGH-IJKL" }),
      },
      { writeClipboard },
    );
    await userEvent.type(screen.getByLabelText("API key"), "sk-ant-x");
    await userEvent.click(screen.getByRole("button", { name: "Save to vault" }));
    const box = await screen.findByTestId("vault-recovery-key");
    await userEvent.click(within(box).getByRole("button", { name: "Copy" }));
    expect(writeClipboard).toHaveBeenCalledWith("ABCD-EFGH-IJKL");
    expect(await within(box).findByRole("button", { name: "Copied" })).toBeTruthy();
    expect(within(box).getByText("Recovery key copied to the clipboard.")).toBeTruthy();
  });

  it("says when the key couldn't be copied", async () => {
    const writeClipboard = vi.fn(async () => {
      throw new Error("denied");
    });
    Object.defineProperty(globalThis.navigator, "clipboard", {
      value: undefined,
      configurable: true,
    });
    setup(
      {
        step: "model",
        onSaveKey: async () => ({ keyRef: "model-anthropic", recoveryKey: "ABCD-EFGH-IJKL" }),
      },
      { writeClipboard },
    );
    await userEvent.type(screen.getByLabelText("API key"), "sk-ant-x");
    await userEvent.click(screen.getByRole("button", { name: "Save to vault" }));
    const box = await screen.findByTestId("vault-recovery-key");
    await userEvent.click(within(box).getByRole("button", { name: "Copy" }));
    expect(await within(box).findByRole("alert")).toHaveProperty(
      "textContent",
      "Couldn't copy. Select the key and copy it.",
    );
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

describe("Onboarding where this window can't ask macOS (web, #554)", () => {
  it("leaves out Permissions and says on Done they are set up in the Mac app", async () => {
    const { onStepChange } = setup({ macPermissions: false });
    const items = steps().getAllByRole("listitem");
    expect(items).toHaveLength(10);
    expect(steps().queryByText("Permissions")).toBeNull();
    expect(screen.queryByRole("button", { name: /Allow/ })).toBeNull();
    await next();
    await next();
    expect(heading().textContent).toContain("Connect");
    expect(onStepChange).toHaveBeenLastCalledWith("connectors");
    expect(heading().querySelector(".sr-only")?.textContent).toContain("Step 3 of 10");
  });

  it("a /onboarding/permissions route lands on the next step", () => {
    setup({ macPermissions: false, step: "permissions" });
    expect(heading().textContent).toContain("Connect");
  });

  it("Done says where the permissions are set up", () => {
    setup({ macPermissions: false, step: "done" });
    expect(
      screen.getByText(
        "Accessibility, Screen Recording and Notifications are set up in the Psyche app on your Mac",
      ),
    ).toBeTruthy();
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
    const connected = await screen.findByRole("list", { name: "Your accounts" });
    expect(within(connected).getAllByRole("listitem")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Skip for now" })).toBeNull();
  });

  it("skips Connectors with nothing connected", async () => {
    const { onStepChange } = setup({ defaultStep: "connectors" });
    await userEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(onStepChange).toHaveBeenLastCalledWith("sandbox");
    expect(heading().textContent).toContain("Sandbox");
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

describe("Connect in onboarding is the real sign-in (#505)", () => {
  async function startGoogle(slots: UiSlots = {}, edit?: (w: FixtureWorld) => void) {
    let gw: MockGateway | null = null;
    render(
      <StoryWorld
        slots={slots}
        onGateway={(g) => (gw = g)}
        edit={(w) => {
          w.connectors = [];
          edit?.(w);
        }}
      >
        <OnboardingFlow onComplete={() => {}} defaultStep="connectors" />
      </StoryWorld>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Connect" }));
    return gw as unknown as MockGateway;
  }

  it("opens the consent page and shows Connected only once the Gateway holds a token", async () => {
    const openExternal = vi.fn(async (_url: string) => {});
    const gw = await startGoogle({ openExternal });
    const pending = await screen.findByTestId("connect-signing-in");
    expect(pending.textContent).toContain("Finish signing in to Google");
    const call = gw.calls.find((c) => c.method === "connectors.connect");
    expect(call?.params).toMatchObject({ catalogueId: "google", scopeMode: "read" });
    expect(openExternal).toHaveBeenCalledWith(
      expect.stringContaining("https://accounts.example.test/"),
    );
    // Not connected yet: the Gateway has no token.
    expect(screen.getByRole("heading", { name: /Connected \(0\)/ })).toBeTruthy();
    const id = gw.world.connectors.at(-1)?.id ?? "";
    act(() => gw.finishConnectorSignIn(id, "connected", "owner@gmail.com"));
    expect(
      await screen.findByText("Google (Gmail, Calendar, Drive) is connected as owner@gmail.com."),
    ).toBeTruthy();
    expect(await screen.findByRole("heading", { name: /Connected \(1\)/ })).toBeTruthy();
  });

  it("says when the sign-in failed and offers to try again", async () => {
    const gw = await startGoogle();
    await screen.findByTestId("connect-signing-in");
    const id = gw.world.connectors.at(-1)?.id ?? "";
    act(() => gw.finishConnectorSignIn(id, "failed"));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Google (Gmail, Calendar, Drive) wasn't connected: Google said the consent was refused.",
    );
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /Connected \(0\)/ })).toBeTruthy();
  });

  it("never claims Connected when the Gateway can't sign in yet", async () => {
    await startGoogle({}, (w) => {
      w.connectorConnect = "unavailable";
    });
    expect(
      await screen.findByText(
        /Signing in to Google \(Gmail, Calendar, Drive\) isn't available on this Gateway yet/,
      ),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: /Connected \(0\)/ })).toBeTruthy();
  });

  it("says when the Gateway has no OAuth client for Google yet (#524)", async () => {
    await startGoogle({}, (w) => {
      w.connectorConnect = "not_configured";
    });
    expect(
      await screen.findByText(/isn't set up on this Gateway yet: it needs your own OAuth client/),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: /Connected \(0\)/ })).toBeTruthy();
  });
});
