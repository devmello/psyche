import type { ApprovalRequest } from "@psyche/protocol";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { ApprovalCard } from "../../blocks/ApprovalCard.tsx";
import {
  appleConnectors,
  connectorCatalogue,
  createFixtureWorld,
  FIXTURE_NOW,
  IDS,
  inMinutes,
  PERSONA,
  stagedSkillProposal,
} from "../../fixtures/index.ts";
import { I18nProvider } from "../../i18n/I18nProvider.tsx";
import { STORY_NOW, withWorld } from "../../stories/harness.tsx";
import { AboutPanel } from "./AboutSection.tsx";
import { AppearancePanel } from "./AppearanceSection.tsx";
import { BrowserPanel } from "./BrowserSection.tsx";
import { ChannelsPanel } from "./ChannelsSection.tsx";
import { ComputerUsePanel } from "./ComputerUseSection.tsx";
import { ConnectorsPanel } from "./ConnectorsSection.tsx";
import { CredentialDetail } from "./CredentialDetail.tsx";
import { ImportCredentialsForm } from "./CredentialImport.tsx";
import { CredentialsPanel } from "./CredentialsSection.tsx";
import { DataControlsPanel } from "./DataControlsSection.tsx";
import { DevicesPanel } from "./DevicesSection.tsx";
import { FileAccessPanel } from "./FileAccessSection.tsx";
import { LanguageGroup } from "./LanguageSettings.tsx";
import { ModelProvidersPanel, providerInfoFromSummary } from "./ModelSection.tsx";
import { PermissionsPanel } from "./PermissionsSection.tsx";
import { PersonaPanel } from "./PersonaSection.tsx";
import { ServerPanel } from "./ServerSection.tsx";
import { SkillSuggestions } from "./SkillDraftCard.tsx";
import { SkillsPanel, SkillTrustCard } from "./SkillsSection.tsx";
import {
  sampleAbout,
  sampleDoctor,
  sampleEndpointProbes,
  sampleFolders,
  sampleIdentities,
  sampleModelProviders,
  sampleProviders,
  sampleServerStatus,
  sampleSettings,
} from "./sample-data.ts";
import { UsagePanel } from "./UsageSection.tsx";
import { VmPanel } from "./VmSection.tsx";
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
/** Local servers after the owner checked them: one reachable with its models, one down. */
export const ModelEndpointsProbed: Story = {
  render: () => {
    const probes = sampleEndpointProbes();
    const providers = sampleModelProviders().map((p) => {
      if (p.id === "lmstudio" && probes.lmstudio !== undefined) {
        const probe = probes.lmstudio;
        return providerInfoFromSummary({
          ...p,
          probe,
          models: probe.models.map((m) => ({
            ref: m.ref,
            capabilities: m.capabilities,
            toolCheck: "untested" as const,
          })),
        });
      }
      if (p.id === "llamacpp") {
        return providerInfoFromSummary({
          ...p,
          probe: {
            state: "unreachable",
            probedAt: "2026-10-19T20:00:00Z",
            models: [],
            error: "nothing answered at http://127.0.0.1:8080/v1",
          },
        });
      }
      return providerInfoFromSummary(p);
    });
    return (
      <ModelProvidersPanel
        {...form}
        ramGb={32}
        providers={providers}
        onProbe={noop}
        probing="anthropic"
        onRunCheck={noop}
      />
    );
  },
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
/** Apple apps on this Mac (#640): action groups, the macOS grant and "Try it". */
export const ConnectorsAppleApps: Story = {
  render: () => (
    <ConnectorsPanel
      {...connectorProps}
      connectors={appleConnectors()}
      catalogue={connectorCatalogue()}
      onRuleChange={noop}
      onTry={noop}
      defaultCapabilitiesOpen
    />
  ),
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

// --- VM mode ---------------------------------------------------------------------------------

const vmGuest = {
  name: "work-mac",
  phase: "running" as const,
  provisioned: true,
  cpus: 4,
  memoryGB: 8,
  diskGB: 80,
  guestOS: "27.0.1",
  username: "psyche",
  shares: [
    {
      name: "Documents",
      hostPath: "/Users/you/Documents",
      readOnly: true,
      guestPath: "/Volumes/Psyche Shares/Documents",
    },
  ],
  vsock: { hostCid: 2, gatewayNodePort: 7001 },
  agent: { connected: true, version: "0.3.0" },
  clipboard: "paste-only" as const,
  vault: "host" as const,
};
const vmProps = {
  ...form,
  persona: PERSONA.name,
  now: STORY_NOW,
  guestNodes: [{ id: "node_guest", name: "work-mac", status: "online" as const }],
  guests: [],
};
export const VmOffNoGuest: Story = {
  render: () => <VmPanel {...vmProps} guestNodes={[]} />,
};
export const VmRunning: Story = {
  render: () => (
    <VmPanel
      {...vmProps}
      values={{
        ...values,
        "vm.enabled": true,
        "vm.guestNodeId": "node_guest",
        "vm.defaultWorkspace": "vm",
      }}
      guests={[{ nodeId: "node_mac_helper", guest: vmGuest, at: "2026-10-18T10:10:00Z" }]}
    />
  ),
};
export const VmGuestFailed: Story = {
  render: () => (
    <VmPanel
      {...vmProps}
      values={{ ...values, "vm.enabled": true }}
      guests={[
        {
          nodeId: "node_mac_helper",
          guest: {
            ...vmGuest,
            phase: "failed",
            lastError: "disk_full",
            agent: { connected: false },
          },
          at: "2026-10-18T10:10:00Z",
        },
      ]}
    />
  ),
};
export const VmLoading: Story = { render: () => <VmPanel {...vmProps} loading /> };

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
  onOpen: noop,
  onImport: async () => ({ imported: [], skipped: [] }),
};
const paymentsView = {
  configured: true,
  methods: world.linkMethods ?? [],
  payments: world.payments ?? [],
};
export const CredentialsPopulated: Story = {
  render: () => <CredentialsPanel {...credentialProps} />,
};
/** Stripe Link: payment methods and recent spends (held, charged, refunded). */
export const CredentialsPayments: Story = {
  render: () => <CredentialsPanel {...credentialProps} payments={paymentsView} onOpenTask={noop} />,
};
export const CredentialsPaymentsNotSetUp: Story = {
  render: () => (
    <CredentialsPanel
      {...credentialProps}
      payments={{ configured: false, methods: [], payments: [] }}
    />
  ),
};
/** Linking an item held in 1Password by reference. */
export const CredentialsLinkOnePassword: Story = {
  render: () => (
    <CredentialsPanel
      {...credentialProps}
      credentials={[
        ...world.credentials,
        {
          id: "cred_op_fastmail",
          kind: "login",
          name: "Fastmail",
          slug: "fastmail-login",
          bindings: [{ origin: "https://app.fastmail.com" }],
          ownerConnectorId: null,
          lastUsedAt: null,
          useCount: 0,
          createdAt: "2026-10-18T09:00:00Z",
          updatedAt: "2026-10-18T09:00:00Z",
          backend: "1password",
        },
      ]}
      onLinkExternal={async () => {}}
      defaultLinking
    />
  ),
};
/** Linking a Bitwarden item by id or unique name; an item held in Bitwarden says so. */
export const CredentialsLinkBitwarden: Story = {
  render: () => (
    <CredentialsPanel
      {...credentialProps}
      credentials={[
        ...world.credentials,
        {
          id: "cred_bw_build",
          kind: "ssh_key",
          name: "Build box",
          slug: "build-box",
          bindings: [{ host: "build.example.com" }],
          ownerConnectorId: null,
          lastUsedAt: null,
          useCount: 0,
          createdAt: "2026-10-18T09:00:00Z",
          updatedAt: "2026-10-18T09:00:00Z",
          backend: "bitwarden",
        },
      ]}
      onLinkExternal={async () => {}}
      defaultLinking="bitwarden"
    />
  ),
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
export const CredentialsImporting: Story = {
  render: () => <CredentialsPanel {...credentialProps} defaultImporting />,
};
/** After an import: what came in and which rows the vault skipped. */
export const CredentialsImported: Story = {
  render: () => (
    <ImportCredentialsForm
      onImport={async () => ({ imported: [], skipped: [] })}
      onClose={noop}
      defaultOutcome={{
        imported: world.credentials.slice(0, 2),
        skipped: [
          { row: 4, reason: "looks like a card number" },
          { row: 9, reason: "no name or password" },
        ],
      }}
    />
  ),
};
const github = world.credentials.find((c) => c.id === IDS.credentials.github);
/** An item's detail (G14): metadata and its recent uses with task, approval and outcome. */
export const CredentialDetailRecentUses: Story = {
  render: () =>
    github ? (
      <CredentialDetail
        credential={github}
        uses={world.credentialUses.filter((u) => u.credentialId === github.id)}
        now={STORY_NOW}
        onOpenTask={noop}
      />
    ) : (
      <p>missing fixture</p>
    ),
};
export const CredentialDetailNotUsed: Story = {
  render: () =>
    github ? (
      <CredentialDetail
        credential={{ ...github, useCount: 0, lastUsedAt: null }}
        uses={[]}
        now={STORY_NOW}
      />
    ) : (
      <p>missing fixture</p>
    ),
};
export const CredentialDetailLoading: Story = {
  render: () =>
    github ? <CredentialDetail credential={github} uses={[]} now={STORY_NOW} loading /> : <p />,
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
/** Language and region (#608): English only, and the preview line in the chosen region. */
export const AppearanceLanguage: Story = {
  render: () => <LanguageGroup values={{}} onChange={() => {}} />,
};
export const AppearanceLanguageGermanRegion: Story = {
  render: () => (
    <I18nProvider locale="de-DE">
      <LanguageGroup values={{ "ui.locale": "de-DE" }} onChange={() => {}} />
    </I18nProvider>
  ),
};

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

// --- Skills ------------------------------------------------------------------------------------

const skillProposal = stagedSkillProposal();
const skillApproval: ApprovalRequest = {
  id: "apr_story_skill",
  kind: "skill_install",
  summary: 'Install skill "pdf-merge"',
  details: {
    name: "pdf-merge",
    source: skillProposal.source,
    hash: skillProposal.hash,
    permissions: ["file_write"],
    tools: ["list_dir", "read_file", "write_file"],
    prompts: ["prompts/naming.md"],
    scope: "home",
  },
  bindingHash: skillProposal.bindingHash,
  grantKey: skillProposal.grantKey,
  requestedBy: { runId: null, taskId: null, threadId: null },
  sideEffect: "destructive",
  surfaces: ["desktop", "web"],
  scopesOffered: ["once"],
  deviceOnly: true,
  requiresAuthentication: false,
  taint: false,
  status: "pending",
  scopeGranted: null,
  decidedBy: null,
  requestedAt: FIXTURE_NOW,
  expiresAt: inMinutes(30),
  decidedAt: null,
  grantId: null,
};
const skillProps = {
  skills: world.skills,
  onReview: noop,
  onToggle: noop,
  onRemove: noop,
  onCheckUpdates: noop,
  onReviewUpdate: noop,
};

export const SkillsPopulated: Story = { render: () => <SkillsPanel {...skillProps} /> };
export const SkillsEmpty: Story = { render: () => <SkillsPanel {...skillProps} skills={[]} /> };
export const SkillsLoading: Story = { render: () => <SkillsPanel {...skillProps} loading /> };
export const SkillsError: Story = {
  render: () => <SkillsPanel {...skillProps} error="the Gateway is not reachable" onRetry={noop} />,
};
export const SkillsRefusedByPolicy: Story = {
  render: () => (
    <SkillsPanel
      {...skillProps}
      actionError="Psyche won't install this skill: it asks for the exec_host permission, which skills may not use."
    />
  ),
};
export const SkillsTrustCard: Story = {
  render: () => (
    <SkillsPanel
      {...skillProps}
      review={
        <SkillTrustCard proposal={skillProposal} onCancel={noop}>
          <ApprovalCard
            approval={skillApproval}
            canAnswer
            persona={PERSONA.name}
            now={Date.parse(FIXTURE_NOW)}
            onAnswer={noop}
          />
        </SkillTrustCard>
      }
    />
  ),
};
export const SkillsTrustCardHighFindings: Story = {
  render: () => (
    <SkillTrustCard
      proposal={{
        ...skillProposal,
        findings: [
          {
            rule: "pipe-to-shell",
            severity: "high",
            message: "downloads a script and pipes it into a shell",
            file: "SKILL.md",
            line: 12,
          },
          {
            rule: "agent-directed-instruction",
            severity: "high",
            message: "addresses the AI assistant directly",
            file: "SKILL.md",
            line: 9,
          },
        ],
      }}
    />
  ),
};

const draftProps = {
  persona: PERSONA.name,
  onSave: async () => {},
  onAccept: noop,
  onDismiss: noop,
};
export const SkillsWithSuggestion: Story = {
  render: () => (
    <SkillsPanel
      {...skillProps}
      suggestions={<SkillSuggestions {...draftProps} drafts={world.skillDrafts} />}
    />
  ),
};
export const SkillSuggestionDoesNotReplay: Story = {
  render: () => (
    <SkillSuggestions
      {...draftProps}
      drafts={world.skillDrafts.map((d) => ({
        ...d,
        edited: true,
        tainted: true,
        replay: {
          ok: false,
          problems: ["declares tools the routine never used: send_email"],
          checkedAt: FIXTURE_NOW,
        },
      }))}
    />
  ),
};
