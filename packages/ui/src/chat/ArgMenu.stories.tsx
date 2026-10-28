import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactElement } from "react";
import { sampleModelProviders, sampleModelRoles } from "../screens/settings/sample-data.ts";
import { ArgMenu, type ArgMenuState } from "./ArgMenu.tsx";
import { type ArgContext, filterOptions, modelOptions, modeOptions } from "./command-args.ts";

const meta = {
  title: "Chat/Argument menu",
  parameters: { layout: "fullscreen" },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** The popup as the composer shows it, in a stand-in for the capsule beneath. */
function Frame({ menu, typed }: { menu: ArgMenuState; typed: string }): ReactElement {
  return (
    <div className="flex h-[420px] items-end justify-center p-6">
      <div className="relative w-[640px]">
        <ArgMenu menu={menu} />
        <div className="rounded-full bg-fill-tertiary px-4 py-2.5 text-reading text-label-primary">
          {typed}
        </div>
      </div>
    </div>
  );
}

function state(over: Partial<ArgMenuState> & Pick<ArgMenuState, "command">): ArgMenuState {
  return {
    open: true,
    id: "arg-menu-story",
    loading: false,
    matches: [],
    current: null,
    active: 0,
    optionId: (i) => `arg-menu-story-${i}`,
    pick: () => {},
    onKeyDown: () => {},
    ...over,
  };
}

const ctx: ArgContext = {
  models: {
    providers: [
      ...sampleModelProviders(),
      {
        id: "openai",
        kind: "openai",
        label: "OpenAI",
        local: false,
        keyConfigured: false,
        models: [{ ref: "openai/gpt-5.5", toolCheck: "agent-capable" }],
        probe: { state: "not_probed", models: [] },
      },
    ],
    roles: sampleModelRoles(),
  },
  modelRef: null,
  permissionMode: "balanced",
};

/** `/model `: the configured models with provider and capability badges; the one in use is ticked; a model without a key is greyed with the reason. */
export const Models: Story = {
  render: () => (
    <Frame
      typed="/model "
      menu={state({
        command: "model",
        matches: modelOptions(ctx),
        current: "anthropic/claude-sonnet-5-5",
      })}
    />
  ),
};

/** `/mode `: each permission mode with a one-line description. */
export const Modes: Story = {
  render: () => (
    <Frame
      typed="/mode "
      menu={state({ command: "mode", matches: modeOptions(), current: "balanced", active: 1 })}
    />
  ),
};

/** Typing narrows the list. */
export const Filtered: Story = {
  render: () => (
    <Frame
      typed="/model lla"
      menu={state({ command: "model", matches: filterOptions(modelOptions(ctx), "lla") })}
    />
  ),
};

/** A source that loads on demand shows a status line until it answers. */
export const Loading: Story = {
  render: () => <Frame typed="/model " menu={state({ command: "model", loading: true })} />,
};
