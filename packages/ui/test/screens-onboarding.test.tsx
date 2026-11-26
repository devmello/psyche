import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
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
  let gw: MockGateway | null = null;
  render(
    // First run: the Gateway has no connectors yet. The vault exists (the model step just made it)
    // and its recovery key is the one the step shows, so `vault.confirmRecovery` can check it.
    <StoryWorld
      slots={slots}
      edit={(w) => {
        w.connectors = [];
        w.vault = {
          status: {
            state: "unlocked",
            slots: ["key_file"],
            recoveryConfirmed: false,
            autoLockMinutes: 480,
            lockAt: null,
            itemCount: 0,
          },
          recoveryKey: "ABCD-EFGH-IJKL",
        };
      }}
      onGateway={(g) => {
        gw = g;
      }}
    >
      <OnboardingFlow onComplete={onComplete} onStepChange={onStepChange} {...props} />
    </StoryWorld>,
  );
  const gateway = () => {
    if (gw === null) throw new Error("gateway not ready");
    return gw;
  };
  return { onComplete, onStepChange, gateway };
}

const progress = () => screen.getByRole("progressbar", { name: "Onboarding progress" });
const next = () => userEvent.click(screen.getByRole("button", { name: "Next" }));
const heading = () => screen.getByRole("heading", { level: 1 });
/** Accounts that sign in online stay folded until asked for. */
const openAccounts = async () =>
  userEvent.click(
    await screen.findByRole("button", { name: "Add a Google, Microsoft or email account" }),
  );
/** The model step leads with an API key; the other ways open on request. */
const otherWays = () => userEvent.click(screen.getByRole("button", { name: "Other ways" }));

describe("OnboardingFlow", () => {
  it("shows quiet progress text with progressbar semantics for the current step", async () => {
    const { onStepChange } = setup();
    // Four steps: you, the model, what to help with, done.
    expect(progress().getAttribute("aria-valuemax")).toBe("4");
    expect(progress().getAttribute("aria-valuenow")).toBe("1");
    expect(progress().getAttribute("aria-valuetext")).toBe("1 of 4");
    expect((screen.getByRole("button", { name: /Back/ }) as HTMLButtonElement).disabled).toBe(true);

    await next();
    expect(heading().textContent).toContain("Choose a model");
    expect(progress().getAttribute("aria-valuenow")).toBe("2");
    expect(onStepChange).toHaveBeenLastCalledWith("model");
    // Focus lands on the new step's heading.
    expect(document.activeElement).toBe(heading());

    await next();
    expect(heading().textContent).toContain("What should I help with?");
    await userEvent.click(screen.getByRole("button", { name: /Back/ }));
    expect(heading().textContent).toContain("Choose a model");

    // The visible count opens the step menu: reached steps jump, unreached ones are disabled.
    await userEvent.click(screen.getByRole("button", { name: "Steps" }));
    const items = await screen.findAllByRole("menuitem");
    expect(items).toHaveLength(4);
    expect(items[1]?.getAttribute("aria-current")).toBe("step");
    expect(items[2]?.getAttribute("aria-disabled")).toBeNull(); // reached before Back
    expect(items[3]?.getAttribute("aria-disabled")).toBe("true");
    await userEvent.click(items[0] as HTMLElement);
    expect(heading().textContent).toContain("You and your agent");
    expect(progress().getAttribute("aria-valuetext")).toBe("1 of 4");
    // A reached step ahead of the current one is reachable too.
    await userEvent.click(screen.getByRole("button", { name: "Steps" }));
    await userEvent.click((await screen.findAllByRole("menuitem"))[2] as HTMLElement);
    expect(heading().textContent).toContain("What should I help with?");
  });

  it("says the step count once: no text node repeats it for assistive tech", async () => {
    setup();
    await next();
    const flow = screen.getByTestId("onboarding-flow");
    const reads = (text: string) =>
      Array.from(flow.querySelectorAll("*")).filter(
        (el) =>
          el.getAttribute("aria-hidden") !== "true" &&
          (el.getAttribute("aria-label")?.includes(text) === true ||
            el.getAttribute("aria-valuetext")?.includes(text) === true ||
            Array.from(el.childNodes).some(
              (n) => n.nodeType === Node.TEXT_NODE && n.textContent?.includes(text),
            )),
      );
    // The progressbar's value text reads it; the visible "2 of 4" is the menu button's own text,
    // and neither the button's name nor the heading adds another copy.
    expect(progress().getAttribute("aria-valuetext")).toBe("2 of 4");
    expect(screen.getByRole("button", { name: "Steps" }).getAttribute("aria-label")).toBe("Steps");
    expect(heading().textContent).toBe("Choose a model");
    expect(reads("2 of 4").length).toBeLessThanOrEqual(2);
  });

  it("names the agent from suggestions or keeps Psyche, and previews the creature", async () => {
    setup();
    const name = screen.getByRole("textbox", { name: "Agent name" }) as HTMLInputElement;
    await userEvent.click(screen.getByRole("button", { name: "Moss" }));
    expect(name.value).toBe("Moss");
    expect(screen.getByRole("button", { name: "Moss" }).getAttribute("aria-pressed")).toBe("true");
    await userEvent.click(screen.getByRole("button", { name: "Keep “Psyche”" }));
    expect(name.value).toBe("Psyche");
    await userEvent.clear(name);
    await userEvent.type(name, "Wren");
    // The look is one step away, behind "Customize look".
    await userEvent.click(screen.getByText("Customize look"));
    await userEvent.click(screen.getByRole("radio", { name: "Owl" }));
    const preview = screen.getByRole("figure", { name: "Preview" });
    expect(within(preview).getByText("Wren")).toBeTruthy();
    expect(within(preview).getByRole("img").getAttribute("aria-label") ?? "").toMatch(/Wren/);
    await userEvent.click(screen.getByRole("radio", { name: "Describe it in your words" }));
    await userEvent.type(screen.getByLabelText("Describe Wren"), "a moth with a scarf");
    expect(within(preview).getByText("“a moth with a scarf”")).toBeTruthy();
  });

  it("keeps time zone, work and city behind More about you, with the zone detected", async () => {
    setup();
    await userEvent.click(screen.getByText("More about you"));
    expect((screen.getByRole("textbox", { name: "Time zone" }) as HTMLInputElement).value).not.toBe(
      "",
    );
    expect(screen.getByRole("textbox", { name: "Work or study" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Home city" })).toBeTruthy();
  });

  it("asks macOS for Notifications on Safety, and for nothing else", async () => {
    const onRequestPermission = vi.fn(async () => "granted" as const);
    setup({ defaultStep: "safety", onRequestPermission });
    expect(screen.queryByRole("button", { name: /Accessibility|Screen Recording/ })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(onRequestPermission).toHaveBeenCalledOnce();
    expect(onRequestPermission).toHaveBeenCalledWith("notifications");
    expect(await screen.findByText("Allowed")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
  });

  it("says Unavailable, not Skipped, when this shell can't ask (issue #384)", async () => {
    setup({ defaultStep: "safety" });
    await userEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(await screen.findByText(/only in the Psyche app on a Mac/)).toBeTruthy();
    expect(screen.queryByText("Skipped")).toBeNull();
  });

  it("shows Asking… during the prompt and re-reads macOS on window focus", async () => {
    let answer: (s: "denied") => void = () => undefined;
    const onRequestPermission = vi.fn(() => new Promise<"denied">((resolve) => (answer = resolve)));
    let state: "denied" | "granted" = "denied";
    const onReadPermissions = vi.fn(async () => ({ notifications: state }));
    setup({ defaultStep: "safety", onRequestPermission, onReadPermissions });
    await userEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(screen.getByRole("button", { name: /Asking/ })).toBeTruthy();
    answer("denied");
    expect(await screen.findByText("Denied in macOS")).toBeTruthy();
    // The owner flips the switch in System Settings and comes back.
    state = "granted";
    window.dispatchEvent(new Event("focus"));
    expect(await screen.findByText("Allowed")).toBeTruthy();
  });

  it("connects accounts one at a time with read-only vs read-and-act", async () => {
    const onConnect = vi.fn(async () => true);
    setup({ defaultStep: "stuff", onConnect });
    await openAccounts();
    await userEvent.click(screen.getByRole("radio", { name: /^Read and act/ }));
    await userEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(onConnect).toHaveBeenCalledWith("google", "read_act");
    const connected = await screen.findByRole("list", { name: "Your accounts" });
    expect(within(connected).getByText("Google (Gmail, Calendar, Drive)")).toBeTruthy();
    // The connected type leaves the picker; the next one is offered.
    const picker = screen.getByLabelText("Connect another account") as HTMLSelectElement;
    expect(Array.from(picker.options).map((o) => o.value)).not.toContain("google");
  });

  it("stores the key by reference, shows RAM guidance and runs the connection test", async () => {
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
    await userEvent.click(screen.getByRole("button", { name: "Test it" }));
    expect(await screen.findByText("Chat only")).toBeTruthy();
    expect(onCheckModel).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "anthropic", keyRef: "vault:anthropic-api-key" }),
    );

    await otherWays();
    await userEvent.click(screen.getByRole("radio", { name: /^Local model/ }));
    expect(screen.getByText(/This Mac has 16 GB/)).toBeTruthy();
    expect(screen.queryByLabelText("API key")).toBeNull();
  });

  it("binds a Claude subscription to the claude-code CLI provider, not the API (#537)", async () => {
    const onCheckModel = vi.fn(() => "passed" as const);
    setup({ defaultStep: "model", onCheckModel });
    await otherWays();
    await userEvent.click(screen.getByRole("radio", { name: /^Subscription/ }));
    expect(screen.queryByLabelText("API key")).toBeNull();
    expect(screen.getByText(/needs no API key and stores none/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Test it" }));
    expect(onCheckModel).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "subscription",
        provider: "claude-code",
        modelRef: "claude-code/sonnet",
      }),
    );
    await userEvent.click(screen.getByRole("radio", { name: /^Claude Opus/ }));
    await userEvent.click(screen.getByRole("button", { name: "Test it" }));
    expect(onCheckModel).toHaveBeenLastCalledWith(
      expect.objectContaining({ modelRef: "claude-code/opus" }),
    );
    await userEvent.selectOptions(screen.getByRole("combobox", { name: /Provider/ }), "codex");
    await userEvent.click(screen.getByRole("button", { name: "Test it" }));
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

  it("completes with the full result", async () => {
    const { onComplete } = setup({
      onRequestPermission: () => "granted",
      onConnect: () => true,
      onSaveKey: (p) => `vault:${p}`,
      onCheckModel: () => "passed",
    });
    await userEvent.type(screen.getByRole("textbox", { name: "Your name" }), "Sam");
    await userEvent.click(screen.getByRole("button", { name: "Pip" }));
    await userEvent.click(screen.getByText("Customize look"));
    await userEvent.type(
      screen.getByRole("textbox", { name: "Vibe or tagline" }),
      "Small and sure.",
    );
    await next();
    expect(heading().textContent).toContain("Choose a model");
    await userEvent.type(screen.getByLabelText("API key"), "k");
    await userEvent.click(screen.getByRole("button", { name: "Save to vault" }));
    await userEvent.click(await screen.findByRole("button", { name: "Test it" }));
    await screen.findByText("Works");
    await next();
    expect(heading().textContent).toContain("What should I help with?");
    await openAccounts();
    await userEvent.click(screen.getByRole("button", { name: "Connect" }));
    await screen.findByRole("list", { name: "Your accounts" });
    // Google is a mail account, so the mail and meetings switches show on the same step (§7.5).
    await userEvent.click(screen.getByRole("switch", { name: "Track replies you’re waiting on" }));
    await next();
    expect(heading().textContent).toContain("You’re set");
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
      // Nothing is asked on the way: macOS prompts come on first use.
      permissions: {
        accessibility: "pending",
        screenRecording: "pending",
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
      mail: { digest: true, prep: true, followups: false, voice: false, notes: true },
      owner: { name: "Sam", timeZone: expect.any(String), work: "", city: "" },
      // No Memory step on the way: habits and memory stay as Settings has them.
    });
  });

  it("is keyboard operable: Tab to Next and press Enter", async () => {
    setup();
    const nextButton = screen.getByRole("button", { name: "Next" });
    nextButton.focus();
    await userEvent.keyboard("{Enter}");
    expect(heading().textContent).toContain("Choose a model");
    expect(document.activeElement).toBe(heading());
    await userEvent.tab();
    expect(document.activeElement).not.toBe(document.body);
    expect(screen.getByTestId("onboarding-flow").contains(document.activeElement)).toBe(true);
  });
});

describe("First run from scratch", () => {
  it("keeps the vault recovery key until the owner types its last group back", async () => {
    const { gateway } = setup({
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
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true);

    // A wrong group is refused with Settings' error, clears the field, and keeps the key shown.
    await userEvent.type(screen.getByLabelText("Last group"), "WXYZ");
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "not the last group of the recovery key",
    );
    expect((screen.getByLabelText("Last group") as HTMLInputElement).value).toBe("");
    expect(screen.getByTestId("vault-recovery-key")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true);

    // The last group is confirmed on the Gateway; the key goes away and Next opens.
    await userEvent.type(screen.getByLabelText("Last group"), "IJKL");
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(screen.queryByTestId("vault-recovery-key")).toBeNull());
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    const confirms = gateway().calls.filter((c) => c.method === "vault.confirmRecovery");
    expect(confirms).toHaveLength(2);
    expect(confirms.at(-1)?.params).toEqual({ lastGroup: "IJKL" });
  });

  it("shows the recovery key gate after a rejected first paste and an accepted second one", async () => {
    let calls = 0;
    setup({
      step: "model",
      onSaveKey: async () => {
        calls += 1;
        if (calls === 1) {
          // The vault was created, then the key was rejected: the error carries the recovery key.
          throw Object.assign(new Error("that is not an Anthropic API key"), {
            recoveryKey: "ABCD-EFGH-IJKL",
          });
        }
        return { keyRef: "model-anthropic" };
      },
    });
    await userEvent.type(screen.getByLabelText("API key"), "wrong");
    await userEvent.click(screen.getByRole("button", { name: "Save to vault" }));
    expect((await screen.findByTestId("vault-recovery-key")).textContent).toContain(
      "ABCD-EFGH-IJKL",
    );
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true);

    await userEvent.type(screen.getByLabelText("API key"), "sk-ant-right");
    await userEvent.click(screen.getByRole("button", { name: "Save to vault" }));
    await waitFor(() => expect(calls).toBe(2));
    // Still shown, and Next still held, until the owner confirms it is saved.
    expect(screen.getByTestId("vault-recovery-key").textContent).toContain("ABCD-EFGH-IJKL");
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("Done shows a refused key as a failure and its link goes back to the Model step", async () => {
    setup({
      defaultStep: "done",
      onVerify: async () => [
        {
          id: "model",
          label: "Model",
          state: "fail",
          detail: "the provider refused the key",
          fixStep: "model",
        },
        { id: "other", label: "Other", state: "unchecked", detail: "could not check" },
      ],
    });
    await screen.findByText("the provider refused the key");
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getByText("Not checked")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Fix in the Model step" }));
    expect(heading().textContent).toContain("Choose a model");
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

describe("Onboarding where this window can't ask macOS (web, #554)", () => {
  it("leaves out the Notifications row of the Safety step when it is opened directly", async () => {
    setup({ macPermissions: false, defaultStep: "safety" });
    // Safety is no longer on the way: it opens only when a route names it, as a fifth step.
    expect(progress().getAttribute("aria-valuemax")).toBe("5");
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
    expect(screen.queryByText("Notifications")).toBeNull();
    // Sandbox stays one step away.
    expect(screen.getByRole("button", { name: /Set up a sandbox for commands/ })).toBeTruthy();
  });

  it("does not ask for Accessibility or Screen Recording anywhere in setup", async () => {
    setup();
    for (let i = 0; i < 3; i++) {
      expect(screen.queryByText(/Accessibility|Screen Recording/)).toBeNull();
      await next();
    }
  });

  it("a saved step from the old flow lands on the step that holds it now", () => {
    setup({ step: "permissions" as never });
    expect(heading().textContent).toContain("What should I help with?");
  });
});

describe("Onboarding polish (UI design §3.19)", () => {
  it("carries the Psyche mark above the steps", () => {
    setup();
    expect(screen.getByTestId("onboarding-mark").textContent).toContain("Psyche");
  });

  it("offers Skip for now while nothing is connected, and lists what is", async () => {
    setup({ defaultStep: "stuff", onConnect: async () => true });
    expect(screen.getByRole("button", { name: "Skip for now" })).toBeTruthy();
    expect(screen.getByText(/Nothing connected yet/)).toBeTruthy();
    await openAccounts();
    await userEvent.click(screen.getByRole("button", { name: "Connect" }));
    const connected = await screen.findByRole("list", { name: "Your accounts" });
    expect(within(connected).getAllByRole("listitem")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Skip for now" })).toBeNull();
  });

  it("skips What should I help with with nothing connected", async () => {
    const { onStepChange } = setup({ defaultStep: "stuff" });
    await userEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(onStepChange).toHaveBeenLastCalledWith("done");
    expect(heading().textContent).toContain("You’re set");
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
        <OnboardingFlow onComplete={() => {}} defaultStep="stuff" />
      </StoryWorld>,
    );
    await openAccounts();
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

describe("Short onboarding (QA)", () => {
  it("leads the model step with an API key and keeps the other ways behind Other ways", async () => {
    setup({ defaultStep: "model" });
    expect(screen.getByLabelText("API key")).toBeTruthy();
    // Positive control: the four ways exist, but only after asking.
    expect(screen.queryByRole("radio", { name: /^Subscription/ })).toBeNull();
    expect(screen.queryByRole("radio", { name: /^Local model/ })).toBeNull();
    expect(screen.queryByText("Tool-calling check")).toBeNull();
    await otherWays();
    expect(screen.getByRole("radio", { name: /^Subscription/ })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /^OpenRouter/ })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /^Local model/ })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /^Cloud API key/ })).toBeTruthy();
  });

  it("walks name, model, what to help with: no Memory, Folders or Safety step", async () => {
    setup();
    const seen: string[] = [heading().textContent ?? ""];
    for (let i = 0; i < 3; i++) {
      await next();
      seen.push(heading().textContent ?? "");
    }
    expect(seen).toEqual([
      "You and your agent",
      "Choose a model",
      "What should I help with?",
      "You’re set",
    ]);
  });

  it("ticks no Mac app by default, so no macOS prompt fires unasked", async () => {
    const onRequestPermission = vi.fn(() => "granted" as const);
    setup({ defaultStep: "stuff", onRequestPermission });
    for (const box of await screen.findAllByRole("checkbox"))
      expect(box.getAttribute("aria-checked")).toBe("false");
    expect(onRequestPermission).not.toHaveBeenCalled();
  });

  it("Done says the agent is not ready when the model row is not fine, and points at the key", async () => {
    setup({
      defaultStep: "done",
      onVerify: async () => [
        {
          id: "model",
          label: "Model",
          state: "warn",
          detail: "Add a key: anthropic/claude-sonnet-5-5 has no key yet.",
          fixStep: "model",
        },
      ],
    });
    await screen.findByText(/Add a key:/);
    expect(screen.getByText("Psyche is not ready to answer yet.")).toBeTruthy();
    expect(screen.queryByText("Psyche is ready.")).toBeNull();
  });

  it("Done says ready when the model row is fine (positive control)", async () => {
    setup({
      defaultStep: "done",
      onVerify: async () => [
        { id: "model", label: "Model", state: "ok", detail: "Using a key from your environment." },
      ],
    });
    await screen.findByText("Using a key from your environment.");
    expect(screen.getByText("Psyche is ready.")).toBeTruthy();
  });

  it("Try next offers buttons that finish setup and say where to open", async () => {
    for (const [label, target] of [
      ["Ask a question in Search", "search"],
      ["Catch up on Home", "home"],
      ["Start a new chat", "chat"],
    ] as const) {
      const { onComplete } = setup({ defaultStep: "done" });
      await userEvent.click(screen.getByRole("button", { name: label }));
      await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
      expect(onComplete.mock.calls[0]?.[0].openAfter).toBe(target);
      cleanup();
    }
    // The gear menu is not mentioned: the ideas are buttons, not prose.
    setup({ defaultStep: "done" });
    expect(document.body.textContent).not.toMatch(/gear menu/i);
  });

  describe("step transition", () => {
    const section = () => screen.getByTestId("onboarding-flow").querySelector("section");
    const media = (reduced: boolean) => {
      window.matchMedia = ((q: string) => ({
        matches: reduced && q.includes("reduce"),
        media: q,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        onchange: null,
        dispatchEvent: () => false,
      })) as unknown as typeof window.matchMedia;
    };

    it("ignores the pointer while the new step fades in, then lets clicks through", async () => {
      media(false);
      setup();
      await next();
      expect(section()?.className).toContain("pointer-events-none");
      await waitFor(() => expect(section()?.className).not.toContain("pointer-events-none"), {
        timeout: 1000,
      });
    });

    it("does not wait at all under reduced motion", async () => {
      media(true);
      setup();
      await next();
      expect(section()?.className).not.toContain("pointer-events-none");
    });
  });
});
