import type { Meta, StoryObj } from "@storybook/react-vite";
import { createFixtureWorld, IDS } from "../fixtures/index.ts";
import { DisclosureProvider } from "./disclosure.tsx";
import { ReceiptLine } from "./Receipt.tsx";
import { WrapUpBox } from "./WrapUp.tsx";

/** Wrap-up box and receipt line states (docs/design/redesign-2026.md §5.3). */

const w = createFixtureWorld();
const receipt = (id: string) => {
  const r = w.receipts.find((x) => x.id === id);
  if (r === undefined) throw new Error(`fixture receipt ${id} missing`);
  return r;
};

const meta = { title: "Cards/Wrap-up and receipt" } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const WrapUpRecapOnly: Story = {
  render: () => (
    <WrapUpBox
      block={{
        type: "wrap_up",
        recap: "Held Tue 2:30 at Acme Dental and sent the confirmation to Jane.",
      }}
    />
  ),
};

export const WrapUpWithAskAndActions: Story = {
  render: () => (
    <WrapUpBox
      block={{
        type: "wrap_up",
        recap:
          "Held Tue 2:30 at Acme Dental, sent the confirmation to Jane and moved your focus block to Wednesday morning.",
        ask: "Add the appointment to your calendar?",
        actions: [{ label: "Add it" }, { label: "Not now" }],
      }}
      onAction={() => {}}
    />
  ),
};

export const ReceiptOk: Story = {
  render: () => <ReceiptLine receipt={receipt(IDS.receipts.emailSent)} />,
};

export const ReceiptUncertain: Story = {
  render: () => <ReceiptLine receipt={receipt(IDS.receipts.holdUncertain)} />,
};

export const ReceiptFailed: Story = {
  render: () => <ReceiptLine receipt={receipt(IDS.receipts.cancelFailed)} />,
};

export const ReceiptWithOpen: Story = {
  render: () => <ReceiptLine receipt={receipt(IDS.receipts.emailSent)} onOpen={() => {}} />,
};

export const ReceiptsAtLevel2: Story = {
  render: () => (
    <DisclosureProvider initial={2} keyboard={false}>
      {[IDS.receipts.emailSent, IDS.receipts.holdUncertain, IDS.receipts.cancelFailed].map((id) => (
        <ReceiptLine key={id} receipt={receipt(id)} onOpen={() => {}} />
      ))}
    </DisclosureProvider>
  ),
};
