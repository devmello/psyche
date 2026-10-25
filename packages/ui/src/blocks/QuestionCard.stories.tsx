import type { Meta, StoryObj } from "@storybook/react-vite";
import { Avatar } from "../avatar/Avatar.tsx";
import { createFixtureWorld, IDS } from "../fixtures/index.ts";
import { QuestionCard } from "./QuestionCard.tsx";

const w = createFixtureWorld();
const req = (id: string) => {
  const r = w.inputRequests.find((x) => x.id === id);
  if (r === undefined) throw new Error(`fixture input request ${id} missing`);
  return r;
};

const meta = {
  title: "Cards/Question card",
  component: QuestionCard,
  args: {
    request: req(IDS.inputRequests.dentistSlot),
    persona: "Wren",
    avatar: <Avatar name="Wren" size={20} decorative />,
    onAnswer: () => {},
    onSkip: () => {},
  },
} satisfies Meta<typeof QuestionCard>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ChipsAndMultiSelect: Story = {};
export const ListWithPreviews: Story = { args: { request: req(IDS.inputRequests.lisbonDates) } };
export const Answered: Story = {
  args: { request: req(IDS.inputRequests.answered), onChangeAnswer: () => {} },
};
export const Cancelled: Story = {
  args: { request: { ...req(IDS.inputRequests.dentistSlot), status: "cancelled" } },
};
