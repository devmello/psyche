import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactElement, ReactNode } from "react";
import { AgentHeader } from "../agent/AgentHeader.tsx";
import { useThreads } from "../data/index.ts";
import { IDS } from "../fixtures/index.ts";
import { SPACE_IDS, withSpaces } from "../fixtures/spaces.ts";
import { InLocale, STORY_NOW, withWorld } from "../stories/harness.tsx";
import { HomeSpacesSection } from "./HomeSpacesSection.tsx";
import { SpacePage } from "./SpacePage.tsx";
import { SpaceComposerChip, SpaceSwitcher } from "./SpaceSwitcher.tsx";
import { SpacesScreen } from "./SpacesScreen.tsx";

/**
 * Spaces (docs/design/spaces-2026.md §7.1) against the mock Gateway: Home's section, the list, a
 * Space's page with its trackers, and the chat header's switcher and composer chip. The accent is
 * "New chat here" and nothing else.
 */

/** Loads the thread list into the store, like the shell does. */
function Threads({ children }: { children: ReactNode }): ReactElement {
  useThreads();
  return <>{children}</>;
}

const meta = {
  title: "Screens/Spaces",
  decorators: [withWorld({ edit: withSpaces })],
  parameters: { layout: "fullscreen" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const column = (child: ReactNode) => (
  <div className="mx-auto w-full max-w-[calc(720px+3rem)] p-6">{child}</div>
);

/** Home's section: the most recent Spaces, a private one left off. */
export const HomeSection: Story = {
  render: () => column(<HomeSpacesSection onNavigate={() => {}} now={STORY_NOW} />),
};

/** `/spaces`: every Space in the owner's order, private ones too. */
export const List: Story = {
  render: () => <SpacesScreen onNavigate={() => {}} now={STORY_NOW} />,
};

/** `/spaces` with nothing yet. */
export const ListEmpty: Story = {
  decorators: [withWorld({ edit: () => {} })],
  render: () => <SpacesScreen onNavigate={() => {}} now={STORY_NOW} />,
};

/** `/spaces/<id>`: two trackers (one from email, marked untrusted), chats, a folder and a link. */
export const Page: Story = {
  render: () => (
    <Threads>
      <SpacePage spaceId={SPACE_IDS.kitchen} onNavigate={() => {}} now={STORY_NOW} />
    </Threads>
  ),
};

/** A new Space: no trackers, chats or files yet. */
export const PageEmpty: Story = {
  render: () => (
    <Threads>
      <SpacePage spaceId={SPACE_IDS.math} onNavigate={() => {}} now={STORY_NOW} />
    </Threads>
  ),
};

/** The same page right to left. */
export const PageArabic: Story = {
  render: () => (
    <InLocale locale="ar">
      <Threads>
        <SpacePage spaceId={SPACE_IDS.kitchen} onNavigate={() => {}} now={STORY_NOW} />
      </Threads>
    </InLocale>
  ),
};

/** The chat header's Space switcher, and the chip above the composer, for a chat in a Space. */
export const ChatHeader: Story = {
  render: () => (
    <Threads>
      <AgentHeader
        onOpenSheet={() => {}}
        spaceSwitcher={<SpaceSwitcher threadId={IDS.threads.dentist} onNavigate={() => {}} />}
      />
      <div className="p-4">
        <SpaceComposerChip threadId={IDS.threads.dentist} onNavigate={() => {}} />
      </div>
    </Threads>
  ),
};
