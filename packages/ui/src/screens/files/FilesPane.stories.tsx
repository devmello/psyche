import type { Meta, StoryObj } from "@storybook/react-vite";
import { FILE_ROOTS, fileRootGrants } from "../../fixtures/index.ts";
import { STORY_NOW, withWorld } from "../../stories/harness.tsx";
import { FilesPane } from "./FilesPane.tsx";

const grants = withWorld({
  edit: (w) => {
    w.settings["permissions.policy"] = { folders: fileRootGrants() };
  },
});

const meta = {
  title: "Screens/Files/FilesPane",
  component: FilesPane,
  args: { now: STORY_NOW },
  decorators: [
    (Story) => (
      <div style={{ height: 480, border: "1px solid var(--color-gray-6)" }}>
        <Story />
      </div>
    ),
  ],
  parameters: { layout: "padded" },
} satisfies Meta<typeof FilesPane>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Granted folders (ro / rw) and the Library; the first folder starts open. */
export const Default: Story = { decorators: [grants] };

/** A file picked: its header, and the composed app's viewer in the slot. */
export const Previewing: Story = {
  decorators: [grants],
  args: {
    target: `${FILE_ROOTS.project}/README.md`,
    renderViewer: (file) => (
      <div className="m-4 rounded-md border border-dashed border-gray-6 p-6 text-sm text-muted-foreground">
        The viewer for {file.name} renders here.
      </div>
    ),
  },
};

export const NoFoldersShared: Story = {
  decorators: [withWorld()],
  args: { onShareFolder: () => {} },
};

/** In a narrow pane the tree stacks above the preview. */
export const Narrow: Story = {
  decorators: [
    grants,
    (Story) => (
      <div style={{ width: 360 }}>
        <Story />
      </div>
    ),
  ],
};
