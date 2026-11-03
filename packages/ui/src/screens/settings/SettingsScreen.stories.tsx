import { EVERYTHING_MEMORY_DEFAULTS, type ReviewItem } from "@psyche/protocol";
import type { Decorator, Meta, StoryObj } from "@storybook/react-vite";
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
    onAddPasskey: noop,
  },
  parameters: { layout: "padded" },
} satisfies Meta<typeof SettingsScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Where Settings opens: the few choices most people make, each with a safe default. */
export const Essentials: Story = { args: { defaultSection: "essentials" } };
export const ModelAndProviders: Story = { args: { defaultSection: "model" } };
export const Persona: Story = { args: { defaultSection: "persona" } };
export const Connectors: Story = { args: { defaultSection: "connectors" } };
export const Permissions: Story = { args: { defaultSection: "permissions" } };
export const ComputerUse: Story = { args: { defaultSection: "computer-use" } };
/** Real-Chrome mode (I13); the desktop shell can open the Psyche Chrome profile. */
export const Browser: Story = {
  args: {
    defaultSection: "browser",
    onOpenRealChromeProfile: async (profile: string) => ({
      path: `/Users/you/.psyche/browser/real-chrome/${profile}`,
    }),
  },
};
export const FileAccess: Story = { args: { defaultSection: "files" } };
export const VmMode: Story = { args: { defaultSection: "vm" } };
export const DevicesAndNodes: Story = { args: { defaultSection: "devices" } };
/** `channels.pairing.list` and `channels.identities.list` are not in the mock: inline errors. */
export const Channels: Story = { args: { defaultSection: "channels" } };
export const Credentials: Story = { args: { defaultSection: "credentials" } };
export const Appearance: Story = { args: { defaultSection: "appearance" } };
export const VoiceAndDictation: Story = { args: { defaultSection: "voice" } };
export const DataControls: Story = { args: { defaultSection: "data" } };
/** Memory: review first, then remembering & learning, Everything memory, People & projects. */
export const Memory: Story = { args: { defaultSection: "memory" } };

/** Memory in use: Everything memory and People on, three facts waiting for review, one held back. */
export const MemoryInUse: Story = {
  args: { defaultSection: "memory" },
  decorators: [
    withWorld({
      edit: (w) => {
        Object.assign(w.settings, sampleSettings());
        w.settings["memory.everything"] = {
          ...EVERYTHING_MEMORY_DEFAULTS,
          enabled: true,
          model: { default: { kind: "cloud" } },
          sources: {
            ...EVERYTHING_MEMORY_DEFAULTS.sources,
            mail: true,
            notes: true,
            calendar: true,
          },
        };
        w.settings["memory.graph"] = {
          enabled: true,
          sources: {
            contacts: true,
            mail: true,
            calendar: true,
            messages: false,
            notes: false,
            chats: true,
          },
          interactionRetentionDays: 540,
          entityRecall: true,
          model: {
            nightly: true,
            afterRun: true,
            maxEntitiesPerNight: 200,
            maxTokensPerNight: 150000,
          },
        };
        const at = "2026-11-01T09:00:00.000Z";
        const fact = (
          id: string,
          name: string,
          attribute: ReviewItem["fact"]["attribute"],
          value: string,
          quote: string,
        ): ReviewItem => ({
          fact: {
            id,
            entityId: `ent_${name}`,
            attribute,
            value,
            provenance: "agent" as const,
            confidence: 0.9,
            sources: [],
            evidence: null,
            validFrom: at,
            validTo: null,
            recordedAt: at,
            supersededBy: null,
            retractedAt: null,
            review: "pending" as const,
            sensitivity: "none" as const,
            subjectKind: "owner_stated" as const,
            lastSeenAt: at,
          },
          entityName: name,
          citations: [
            {
              id: `c_${id}`,
              targetKind: "fact" as const,
              targetId: id,
              source: "notes" as const,
              docId: null,
              sourceRef: "n1",
              quote,
              start: 0,
              end: quote.length,
              sourceHash: "h",
              authorEntityId: null,
              provenance: "agent" as const,
              observedAt: at,
              createdAt: at,
            },
          ],
          change: "new" as const,
          previousValue: null,
          sentence: `${name}: ${attribute} ${value}`,
        });
        w.review = {
          items: [
            fact("f1", "Dana Reyes", "likes", "climbing", "Dana loves climbing"),
            fact("f2", "Dana Reyes", "city", "Lisbon", "Dana moved to Lisbon in June"),
            fact("f3", "Sam Lee", "employer", "Initech", "Sam just joined Initech"),
          ],
          quarantine: [],
          runs: [],
        };
      },
    }),
  ],
};
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

// --- Window widths (#596) ------------------------------------------------------------------------

/**
 * The screen in a window-sized frame: two panes from 720 px, each scrolling on its own. The
 * baseline viewport is 960 px wide, so wider frames are scaled down to fit (the layout still sees
 * the full width; it is a container query).
 */
const frame =
  (width: number, height: number): Decorator =>
  (Story) => {
    const scale = Math.min(1, 940 / width);
    return (
      <div style={{ width: width * scale, height: height * scale, overflow: "hidden" }}>
        <div
          className="flex flex-col overflow-auto border border-separator"
          style={{ width, height, transform: `scale(${scale})`, transformOrigin: "top left" }}
        >
          <Story />
        </div>
      </div>
    );
  };

export const Window760: Story = {
  args: { defaultSection: "permissions" },
  decorators: [frame(760, 560)],
};
export const Window920: Story = {
  args: { defaultSection: "appearance" },
  decorators: [frame(920, 600)],
};
/** The selected row (the last group) is scrolled into view in the list. */
export const Window1200: Story = {
  args: { defaultSection: "about" },
  decorators: [frame(1200, 640)],
};
/** Search finds pages, panes and single settings; choosing one scrolls to it and tints it. */
export const SearchResults: Story = {
  args: { defaultSection: "general", defaultQuery: "search" },
  decorators: [frame(920, 600)],
};
/** An old section id opens its page scrolled to that pane (`/settings/files`). */
export const OldLinkToPane: Story = {
  args: { defaultSection: "files" },
  decorators: [frame(920, 600)],
};
/** Below 720 px the list stacks above the content (the web on a phone). */
export const Window600Stacked: Story = {
  args: { defaultSection: "model" },
  decorators: [frame(600, 640)],
};
