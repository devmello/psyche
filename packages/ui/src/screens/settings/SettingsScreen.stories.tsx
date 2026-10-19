import type { Meta, StoryObj } from "@storybook/react-vite";
import { createFixtureWorld, IDS } from "../../fixtures/index.ts";
import { STORY_NOW, withWorld } from "../../stories/harness.tsx";
import { SettingsScreen } from "./SettingsScreen.tsx";
import { sampleAbout, sampleDoctor, sampleServerStatus, sampleSettings } from "./sample-data.ts";

const world = createFixtureWorld();
const noop = () => {};

const meta = {
  title: "Screens/Settings/SettingsScreen",
  component: SettingsScreen,
  decorators: [
    withWorld({
      edit: (w) => {
        Object.assign(w.settings, sampleSettings());
      },
    }),
  ],
  args: {
    now: STORY_NOW,
    ramGb: 32,
    thisDeviceId: IDS.devices.mac,
    tcc: { accessibility: "granted", screenRecording: "denied", notifications: "granted" },
    usage: world.usage,
    server: sampleServerStatus(),
    about: sampleAbout(),
    doctor: sampleDoctor(),
    onOpenSystemSettings: noop,
    onConnect: noop,
    onReconnect: noop,
    onDisconnect: noop,
    onRemove: noop,
    onRunModelCheck: noop,
    onAddProvider: noop,
    onEditProviderKey: noop,
    onConnectManager: noop,
    onRunDoctor: noop,
    onOpenLogs: noop,
    onStartVm: noop,
    onAddPasskey: noop,
  },
  parameters: { layout: "padded" },
} satisfies Meta<typeof SettingsScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ModelAndProviders: Story = { args: { defaultSection: "model" } };
export const Persona: Story = { args: { defaultSection: "persona" } };
export const Connectors: Story = { args: { defaultSection: "connectors" } };
export const Permissions: Story = { args: { defaultSection: "permissions" } };
export const ComputerUse: Story = { args: { defaultSection: "computer-use" } };
export const FileAccess: Story = { args: { defaultSection: "files" } };
export const DevicesAndNodes: Story = { args: { defaultSection: "devices" } };
/** `channels.pairing.list` and `channels.identities.list` are not in the mock: inline errors. */
export const Channels: Story = { args: { defaultSection: "channels" } };
export const Credentials: Story = { args: { defaultSection: "credentials" } };
export const Appearance: Story = { args: { defaultSection: "appearance" } };
export const VoiceAndDictation: Story = { args: { defaultSection: "voice" } };
export const DataControls: Story = { args: { defaultSection: "data" } };
/** `sandbox.status` is not in the mock, so the Sandbox group shows its error state. */
export const ServerAndRemoteAccess: Story = { args: { defaultSection: "server" } };
export const Usage: Story = { args: { defaultSection: "usage" } };
export const About: Story = { args: { defaultSection: "about" } };

/** Settings could not load: the section shows what failed and a retry. */
export const LoadFailed: Story = {
  args: { defaultSection: "appearance" },
  decorators: [withWorld({ onGateway: (g) => g.failNext("settings.get", "unavailable") })],
};

/** An empty Gateway: every list section shows its empty state. */
export const EmptyWorld: Story = {
  args: { defaultSection: "connectors", usage: null, about: null, doctor: null },
  decorators: [
    withWorld({
      edit: (w) => {
        w.connectors = [];
        w.grants = [];
        w.credentials = [];
        w.devices = [];
        w.nodes = [];
        w.pairingRequests = [];
        w.channels = [];
      },
    }),
  ],
};
