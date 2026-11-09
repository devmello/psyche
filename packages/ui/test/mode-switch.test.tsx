import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ModeSwitch } from "../src/chat/ModeSwitch.tsx";
import {
  AUTO_EXPLAINER_KEY,
  applyModeChoice,
  autoModeBlockedBy,
  autoModeSuggestion,
  isAutoModelRefusal,
  type ListedModels,
} from "../src/chat/mode-switch.ts";

const listed: ListedModels = {
  providers: [
    {
      id: "lmstudio",
      local: true,
      keyConfigured: true,
      models: [{ ref: "lmstudio/tiny-7b", autoMode: false }],
    },
    {
      id: "anthropic",
      keyConfigured: true,
      models: [
        { ref: "anthropic/claude-sonnet-5-5", autoMode: true },
        { ref: "anthropic/claude-embed", autoMode: true, capabilities: { embeddings: true } },
      ],
    },
    {
      id: "openai",
      keyConfigured: false,
      models: [{ ref: "openai/gpt-6-sol", autoMode: true }],
    },
  ],
  roles: { primary: "lmstudio/tiny-7b" },
};

describe("autoModeSuggestion", () => {
  it("offers an allowed model the owner has a key for, never an unkeyed or embedding one", () => {
    expect(autoModeSuggestion(listed, "lmstudio/tiny-7b")).toBe("anthropic/claude-sonnet-5-5");
  });

  it("prefers the current model's own provider", () => {
    const both: ListedModels = {
      ...listed,
      providers: [
        ...(listed.providers ?? []).slice(0, 2),
        {
          id: "openai",
          keyConfigured: true,
          models: [{ ref: "openai/gpt-6-sol", autoMode: true }],
        },
      ],
    };
    expect(autoModeSuggestion(both, "openai/gpt-4o")).toBe("openai/gpt-6-sol");
  });

  it("is null when nothing configured is allowed", () => {
    expect(
      autoModeSuggestion({ providers: [{ keyConfigured: true, models: [] }] }, "x/y"),
    ).toBeNull();
  });
});

describe("autoModeBlockedBy", () => {
  it("blocks only on a model the Gateway marked autoMode:false", () => {
    expect(autoModeBlockedBy(listed, null)).toBe("lmstudio/tiny-7b");
    expect(autoModeBlockedBy(listed, "anthropic/claude-sonnet-5-5")).toBeNull();
    expect(autoModeBlockedBy(listed, "mystery/model")).toBeNull();
    expect(autoModeBlockedBy(undefined, null)).toBeNull();
  });
});

describe("isAutoModelRefusal", () => {
  it("reads the Gateway's refusal details", () => {
    expect(
      isAutoModelRefusal({
        code: "forbidden",
        details: { reason: "auto_model_not_allowed", model: "a/b" },
      }),
    ).toEqual({ model: "a/b" });
    expect(isAutoModelRefusal({ code: "forbidden", details: {} })).toBeNull();
    expect(isAutoModelRefusal(new Error("x"))).toBeNull();
  });
});

describe("applyModeChoice", () => {
  it("changes the chat, then remembers the choice as the default for new chats", async () => {
    const call = vi.fn().mockResolvedValue({});
    await applyModeChoice(call, "t1", "auto", "anthropic/claude-sonnet-5-5");
    expect(call).toHaveBeenNthCalledWith(1, "threads.update", {
      threadId: "t1",
      permissionMode: "auto",
      modelRef: "anthropic/claude-sonnet-5-5",
    });
    expect(call).toHaveBeenNthCalledWith(2, "settings.set", {
      key: "permissions.mode",
      value: "auto",
    });
  });

  it("does not remember a choice the Gateway refused, and ignores a failed remember", async () => {
    const refused = vi.fn().mockRejectedValueOnce(new Error("no"));
    await expect(applyModeChoice(refused, "t1", "auto")).rejects.toThrow("no");
    expect(refused).toHaveBeenCalledTimes(1);

    const noRemember = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("offline"));
    await expect(applyModeChoice(noRemember, "t1", "manual")).resolves.toBeUndefined();
  });
});

describe("<ModeSwitch>", () => {
  beforeEach(() => localStorage.clear());

  it("switches mode in one click on an allowed model, with a first-time explainer", async () => {
    const onSelect = vi.fn().mockResolvedValue(undefined);
    render(
      <ModeSwitch
        mode="balanced"
        modelRef="anthropic/claude-sonnet-5-5"
        listed={listed}
        onSelect={onSelect}
      />,
    );
    await userEvent.click(screen.getByTestId("mode-switch-auto"));
    expect(onSelect).toHaveBeenCalledWith("auto", undefined);
    expect(await screen.findByTestId("mode-switch-explainer")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /got it/i }));
    expect(localStorage.getItem(AUTO_EXPLAINER_KEY)).toBe("1");
    expect(screen.queryByTestId("mode-switch-explainer")).toBeNull();
  });

  it("does not repeat the explainer once seen", async () => {
    localStorage.setItem(AUTO_EXPLAINER_KEY, "1");
    render(
      <ModeSwitch
        mode="balanced"
        modelRef="anthropic/claude-sonnet-5-5"
        listed={listed}
        onSelect={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    await userEvent.click(screen.getByTestId("mode-switch-auto"));
    await waitFor(() => expect(screen.getByTestId("mode-switch-auto")).toBeTruthy());
    expect(screen.queryByTestId("mode-switch-explainer")).toBeNull();
  });

  it("marks the current mode and sets manual without any prompt", async () => {
    const onSelect = vi.fn().mockResolvedValue(undefined);
    render(<ModeSwitch mode="auto" modelRef={null} listed={undefined} onSelect={onSelect} />);
    expect(screen.getByTestId("mode-switch-auto").getAttribute("aria-checked")).toBe("true");
    await userEvent.click(screen.getByTestId("mode-switch-manual"));
    expect(onSelect).toHaveBeenCalledWith("manual", undefined);
  });

  it("offers a one-tap model switch when the model cannot run Auto", async () => {
    const onSelect = vi.fn().mockResolvedValue(undefined);
    render(
      <ModeSwitch
        mode="balanced"
        modelRef="lmstudio/tiny-7b"
        listed={listed}
        onSelect={onSelect}
      />,
    );
    await userEvent.click(screen.getByTestId("mode-switch-auto"));
    expect(onSelect).not.toHaveBeenCalled();
    await userEvent.click(await screen.findByTestId("mode-switch-take-offer"));
    expect(onSelect).toHaveBeenCalledWith("auto", "anthropic/claude-sonnet-5-5");
  });

  it("turns a Gateway refusal into the same offer", async () => {
    const onSelect = vi.fn().mockRejectedValue({
      code: "forbidden",
      details: { reason: "auto_model_not_allowed", model: "mystery/model" },
    });
    render(
      <ModeSwitch mode="balanced" modelRef="mystery/model" listed={listed} onSelect={onSelect} />,
    );
    await userEvent.click(screen.getByTestId("mode-switch-auto"));
    expect(await screen.findByTestId("mode-switch-take-offer")).toBeTruthy();
  });

  it("says what to add when no allowed model is configured", async () => {
    render(
      <ModeSwitch
        mode="balanced"
        modelRef="lmstudio/tiny-7b"
        listed={{ providers: listed.providers?.slice(0, 1) ?? [] }}
        onSelect={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByTestId("mode-switch-auto"));
    expect(await screen.findByTestId("mode-switch-offer")).toBeTruthy();
    expect(screen.queryByTestId("mode-switch-take-offer")).toBeNull();
  });
});
