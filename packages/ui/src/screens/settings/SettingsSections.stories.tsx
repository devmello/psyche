import type { Meta, StoryObj } from "@storybook/react-vite";
import { createFixtureWorld, IDS, PERSONA } from "../../fixtures/index.ts";
import { STORY_NOW, withWorld } from "../../stories/harness.tsx";
import { AboutPanel } from "./AboutSection.tsx";
import { AppearancePanel } from "./AppearanceSection.tsx";
import { BrowserPanel } from "./BrowserSection.tsx";
import { ChannelsPanel } from "./ChannelsSection.tsx";
import { ComputerUsePanel } from "./ComputerUseSection.tsx";
import { ConnectorsPanel } from "./ConnectorsSection.tsx";
import { CredentialsPanel } from "./CredentialsSection.tsx";
import { DataControlsPanel } from "./DataControlsSection.tsx";
import { DevicesPanel } from "./DevicesSection.tsx";
import { FileAccessPanel } from "./FileAccessSection.tsx";
import { ModelProvidersPanel } from "./ModelSection.tsx";
import { PermissionsPanel } from "./PermissionsSection.tsx";
import { PersonaPanel } from "./PersonaSection.tsx";
import { ServerPanel } from "./ServerSection.tsx";
import {
  sampleAbout,
  sampleDoctor,
  sampleFolders,
  sampleIdentities,
  sampleProviders,
  sampleServerStatus,
  sampleSettings,
} from "./sample-data.ts";
import { UsagePanel } from "./UsageSection.tsx";
import { VoicePanel } from "./VoiceSection.tsx";

/**
 * Every settings section rendered from plain data, covering the states the connected screen
 * reaches only with a slow or failing Gateway: loading, empty, error and the special cases.
 */

const world = createFixtureWorld();
const values = { ...world.settings, ...sampleSettings() };
const noop = () => {};
const form = { values, onChange: noop };
const forbidden = new Set([
  "permissions.mode",
  "permissions.connectors.conn_gmail",
  "vault.backend",
  "gateway.bind",
  "models.primary",
  "permissions.policy",
]);
const channelPairing = world.pairingRequests.filter((p) => p.kind === "channel-sender");

const meta = {
  title: "Screens/Settings/Sections",
  decorators: [withWorld()],
  parameters: { layout: "padded" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

// --- Model & providers -------------------------------------------------------------------------

export const ModelLoading: Story = {
  render: () => <ModelProvidersPanel {...form} providers={[]} loading />,
};
export const ModelEmpty: Story = {
  render: () => <ModelProvidersPanel {...form} providers={[]} onAddProvider={noop} />,
};
export const ModelError: Story = {
  render: () => (
    <ModelProvidersPanel
      {...form}
      providers={[]}
      error="the Gateway is not reachable"
      onRetry={noop}
    />
  ),
};
export const ModelCheckRunningSmallMac: Story = {
  render: () => (
    <ModelProvidersPanel
      {...form}
      ramGb={8}
      providers={sampleProviders().map((p) =>
        p.id === "ollama"
          ? { ...p, models: p.models.map((m) => ({ ...m, toolCheck: "running" as const })) }
          : p,
      )}
      onRunCheck={noop}
    />
  ),
};
export const ModelNeedsApproval: Story = {
  render: () => (
    <ModelProvidersPanel {...form} providers={sampleProviders()} needsApproval={forbidden} />
  ),
};

// --- Persona -----------------------------------------------------------------------------------

export const PersonaLoading: Story = { render: () => <PersonaPanel {...form} loading /> };
export const PersonaError: Story = {
  render: () => <PersonaPanel {...form} error="timeout" onRetry={noop} />,
};
export const PersonaWithImageModel: Story = {
  render: () => (
    <PersonaPanel
      {...form}
      values={{ ...values, "persona.creatureId": "owl", "persona.emoji": "🦉" }}
      hasImageModel
    />
  ),
};

// --- Connectors --------------------------------------------------------------------------------

const connectorProps = {
  persona: PERSONA.name,
  now: STORY_NOW,
  onConnect: noop,
  onReconnect: noop,
  onDisconnect: noop,
  onRemove: noop,
};
export const ConnectorsLoading: Story = {
  render: () => <ConnectorsPanel {...connectorProps} connectors={[]} loading />,
};
export const ConnectorsEmpty: Story = {
  render: () => <ConnectorsPanel {...connectorProps} connectors={[]} />,
};
export const ConnectorsError: Story = {
  render: () => (
    <ConnectorsPanel {...connectorProps} connectors={[]} error="unavailable" onRetry={noop} />
  ),
};
export const ConnectorsConnectFlow: Story = {
  render: () => <ConnectorsPanel {...connectorProps} connectors={world.connectors} defaultAdding />,
};

// --- Permissions -------------------------------------------------------------------------------

const permissionProps = {
  ...form,
  connectors: world.connectors,
  grants: world.grants,
  folders: sampleFolders(),
  now: STORY_NOW,
  onRevoke: noop,
  onRuleChange: noop,
  onOpenFiles: noop,
};
export const PermissionsLoading: Story = {
  render: () => <PermissionsPanel {...permissionProps} loading />,
};
export const PermissionsError: Story = {
  render: () => <PermissionsPanel {...permissionProps} error="forbidden" onRetry={noop} />,
};
export const PermissionsEmpty: Story = {
  render: () => <PermissionsPanel {...permissionProps} connectors={[]} grants={[]} folders={[]} />,
};
export const PermissionsGrantsRevoked: Story = {
  render: () => (
    <PermissionsPanel
      {...permissionProps}
      connectors={world.connectors.map((c) =>
        c.id === IDS.connectors.notion
          ? { ...c, lastSync: { ...c.lastSync, toolsListChanged: true } }
          : c,
      )}
    />
  ),
};
export const PermissionsNeedsApproval: Story = {
  render: () => (
    <PermissionsPanel
      {...permissionProps}
      needsApproval={forbidden}
      revokeError="Psyche couldn't revoke “acme.com (rw)” (forbidden)."
    />
  ),
};

// --- Computer use ------------------------------------------------------------------------------

export const ComputerUseLoading: Story = {
  render: () => <ComputerUsePanel {...form} persona={PERSONA.name} tcc={{}} loading />,
};
export const ComputerUseDenied: Story = {
  render: () => (
    <ComputerUsePanel
      {...form}
      persona={PERSONA.name}
      tcc={{ accessibility: "denied", screenRecording: "denied" }}
      onOpenSystemSettings={noop}
    />
  ),
};
export const ComputerUseOffNoApps: Story = {
  render: () => (
    <ComputerUsePanel
      {...form}
      values={{ ...values, "computerUse.enabled": false, "computerUse.apps": [] }}
      persona={PERSONA.name}
      tcc={{ accessibility: "granted", screenRecording: "granted" }}
    />
  ),
};

// --- Browser -----------------------------------------------------------------------------------

const openProfile = async (profile: string) => ({
  path: `/Users/you/.psyche/browser/real-chrome/${profile}`,
});

export const BrowserLoading: Story = {
  render: () => <BrowserPanel {...form} persona={PERSONA.name} loading />,
};
/** Desktop: real-Chrome mode on with a named profile, and the button that opens it. */
export const BrowserOnDesktop: Story = {
  render: () => (
    <BrowserPanel
      {...form}
      values={{ ...values, "browser.realChrome": { enabled: true, profile: "work" } }}
      persona={PERSONA.name}
      onOpenProfile={openProfile}
    />
  ),
};
/** Web: off, and the profile can only be opened from the Mac that runs the Gateway. */
export const BrowserOffWeb: Story = {
  render: () => <BrowserPanel {...form} persona={PERSONA.name} />,
};

// --- File access -------------------------------------------------------------------------------

export const FileAccessEmpty: Story = {
  render: () => (
    <FileAccessPanel
      {...form}
      values={{ ...values, "permissions.policy": { folders: [] }, "vm.shares": [] }}
      persona={PERSONA.name}
    />
  ),
};
export const FileAccessVmMode: Story = {
  render: () => (
    <FileAccessPanel {...form} persona={PERSONA.name} vmMode needsApproval={forbidden} />
  ),
};
export const FileAccessError: Story = {
  render: () => (
    <FileAccessPanel {...form} persona={PERSONA.name} error="unavailable" onRetry={noop} />
  ),
};

// --- Devices & nodes ---------------------------------------------------------------------------

const deviceProps = {
  devices: world.devices,
  pairing: world.pairingRequests,
  nodes: world.nodes,
  now: STORY_NOW,
  thisDeviceId: IDS.devices.mac,
  onApprove: noop,
  onDeny: noop,
  onRevoke: noop,
};
export const DevicesPopulated: Story = { render: () => <DevicesPanel {...deviceProps} /> };
export const DevicesLoading: Story = { render: () => <DevicesPanel {...deviceProps} loading /> };
export const DevicesEmpty: Story = {
  render: () => <DevicesPanel {...deviceProps} devices={[]} pairing={[]} nodes={[]} />,
};
export const DevicesActionForbidden: Story = {
  render: () => (
    <DevicesPanel
      {...deviceProps}
      actionError="Approve pairing needs approval on this device. Use a device paired as admin."
    />
  ),
};

// --- Channels ----------------------------------------------------------------------------------

const channelProps = {
  channels: world.channels,
  pairing: channelPairing,
  identities: sampleIdentities(),
  persona: PERSONA.name,
  now: STORY_NOW,
  onPolicyChange: noop,
  onRequireMention: noop,
  onApprove: noop,
  onIgnore: noop,
};
export const ChannelsPopulated: Story = { render: () => <ChannelsPanel {...channelProps} /> };
export const ChannelsOpenPolicy: Story = {
  render: () => (
    <ChannelsPanel
      {...channelProps}
      channels={world.channels.map((c) => ({ ...c, dmPolicy: "open" as const }))}
    />
  ),
};
export const ChannelsEmpty: Story = {
  render: () => <ChannelsPanel {...channelProps} channels={[]} pairing={[]} identities={[]} />,
};
export const ChannelsLoading: Story = { render: () => <ChannelsPanel {...channelProps} loading /> };
export const ChannelsError: Story = {
  render: () => <ChannelsPanel {...channelProps} error="unavailable" onRetry={noop} />,
};

// --- Credentials -------------------------------------------------------------------------------

const credentialProps = {
  ...form,
  credentials: world.credentials,
  now: STORY_NOW,
  onAdd: noop,
  onConnectManager: noop,
  onUpdate: noop,
  onDelete: noop,
};
export const CredentialsPopulated: Story = {
  render: () => <CredentialsPanel {...credentialProps} />,
};
export const CredentialsAddItem: Story = {
  render: () => <CredentialsPanel {...credentialProps} defaultAdding />,
};
export const CredentialsRefused: Story = {
  render: () => (
    <CredentialsPanel
      {...credentialProps}
      addError="Psyche refused this item because it looks like a card, bank or ID number."
      needsApproval={forbidden}
    />
  ),
};
/** Editing a login: rename, bind more sites, replace a value (blank keeps it). */
export const CredentialsEditing: Story = {
  render: () => <CredentialsPanel {...credentialProps} defaultEditingId={IDS.credentials.github} />,
};
export const CredentialsSearchNoMatch: Story = {
  render: () => <CredentialsPanel {...credentialProps} defaultQuery="fastmail" />,
};
export const CredentialsEditFailed: Story = {
  render: () => (
    <CredentialsPanel
      {...credentialProps}
      itemError="The vault is locked. Unlock it with Touch ID, then change GitHub again."
    />
  ),
};
export const CredentialsEmpty: Story = {
  render: () => <CredentialsPanel {...credentialProps} credentials={[]} />,
};
export const CredentialsLoading: Story = {
  render: () => <CredentialsPanel {...credentialProps} loading />,
};

// --- Appearance --------------------------------------------------------------------------------

export const AppearanceDefault: Story = { render: () => <AppearancePanel {...form} /> };
export const AppearanceNudgedSeed: Story = {
  render: () => (
    <AppearancePanel
      {...form}
      values={{
        ...values,
        "appearance.accentSeed": "oklch(0.92 0.18 100)",
        "appearance.gray": "sand",
        "appearance.contrast": "high",
        "appearance.reduceMotion": true,
      }}
    />
  ),
};
export const AppearanceLoading: Story = { render: () => <AppearancePanel {...form} loading /> };

// --- Voice, data, server, usage, about ---------------------------------------------------------

export const VoiceToggleMode: Story = {
  render: () => (
    <VoicePanel {...form} values={{ ...values, "voice.mode": "toggle", "voice.engine": "cloud" }} />
  ),
};
export const VoiceError: Story = {
  render: () => <VoicePanel {...form} error="timeout" onRetry={noop} />,
};

const dataProps = {
  ...form,
  persona: PERSONA.name,
  memoryPaused: false,
  archivedThreads: 1,
  onPauseMemory: noop,
  onExport: noop,
  onDeleteArchived: noop,
  onReset: noop,
};
export const DataControlsPopulated: Story = { render: () => <DataControlsPanel {...dataProps} /> };
export const DataControlsResetConfirm: Story = {
  render: () => <DataControlsPanel {...dataProps} memoryPaused defaultResetting />,
};
export const DataControlsExportFailed: Story = {
  render: () => (
    <DataControlsPanel
      {...dataProps}
      archivedThreads={0}
      notice={{ kind: "error", text: "Psyche couldn't export (timeout). Nothing was changed." }}
    />
  ),
};

const serverProps = {
  ...form,
  status: sampleServerStatus(),
  onAddPasskey: noop,
  onStartVm: noop,
  onStopVm: noop,
  onSetUpRemote: noop,
};
export const ServerPopulated: Story = { render: () => <ServerPanel {...serverProps} /> };
export const ServerExposedNoSandbox: Story = {
  render: () => (
    <ServerPanel
      {...serverProps}
      values={{ ...values, "gateway.bind": "0.0.0.0:7979" }}
      needsApproval={forbidden}
      status={{
        ...sampleServerStatus(),
        remote: { kind: "none", status: "off" },
        sandbox: { backend: "none", available: false },
        vm: { state: "running", name: "wren-guest" },
      }}
    />
  ),
};
export const ServerUnknown: Story = {
  render: () => <ServerPanel {...serverProps} status={null} sandboxError="not_implemented" />,
};

export const UsagePopulated: Story = { render: () => <UsagePanel usage={world.usage} /> };
export const UsageLowBudget: Story = {
  render: () => <UsagePanel usage={{ ...world.usage, percentRemaining: 8, spentUsd: 18.4 }} />,
};
export const UsageEmpty: Story = { render: () => <UsagePanel usage={null} /> };
export const UsageLoading: Story = { render: () => <UsagePanel usage={null} loading /> };
export const UsageError: Story = {
  render: () => <UsagePanel usage={null} error="unavailable" onRetry={noop} />,
};

export const AboutPopulated: Story = {
  render: () => (
    <AboutPanel info={sampleAbout()} doctor={sampleDoctor()} onRunDoctor={noop} onOpenLogs={noop} />
  ),
};
export const AboutDoctorRunning: Story = {
  render: () => <AboutPanel info={null} doctor={null} doctorRunning onRunDoctor={noop} />,
};
