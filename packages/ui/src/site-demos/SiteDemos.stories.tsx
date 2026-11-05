import type { EntitySummary, LifeAnswerPassage, LifeFactHit } from "@psyche/protocol";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { AgentSheet } from "../agent/AgentSheet.tsx";
import type { MockGateway } from "../data/mock-gateway.ts";
import { createFixtureWorld, IDS } from "../fixtures/index.ts";
import { withCatchUp } from "../fixtures/work.ts";
import { HomeScreen } from "../home/HomeScreen.tsx";
import { SettingsScreen } from "../screens/settings/SettingsScreen.tsx";
import {
  sampleAbout,
  sampleDoctor,
  sampleServerStatus,
  sampleSettings,
} from "../screens/settings/sample-data.ts";
import { CommandPalette } from "../shell/CommandPalette.tsx";
import { STORY_NOW, StoryWorld } from "../stories/harness.tsx";

/**
 * Takes for the public site's landing page (apps/site), recorded from these stories on fictional
 * fixture data. They script a little more than the screens' own stories (an answer with passages,
 * catch-up lines with their sources), so they live apart and have no visual baseline.
 */
const meta = {
  title: "Site demos",
  tags: ["no-visual"],
  parameters: { layout: "fullscreen" },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const SAM: EntitySummary = {
  id: "ent_sam_lee",
  kind: "person",
  name: "Sam Lee",
  subtitle: "Acme",
  summary: null,
  status: "active",
  openLoops: 0,
  pinned: true,
  isOwner: false,
};

const DOCS: Record<
  string,
  { source: "mail" | "calendar" | "messages"; title: string; text: string; at: string }
> = {
  "mail:launch-checklist": {
    source: "mail",
    title: "Re: Q4 launch checklist",
    at: "2026-10-16T15:30:00Z",
    text: "Hi Alex,\n\nBefore Tuesday's call, could you read through the launch checklist and mark anything you can't own? Pricing copy is the big one. I'd rather settle it on mail than on the call.\n\nThanks,\nSam Lee · Head of Product · Acme",
  },
  "calendar:weekly-sam": {
    source: "calendar",
    title: "Weekly with Sam",
    at: "2026-10-20T15:00:00Z",
    text: "Tue Oct 20, 3:00–3:30 pm\nMoved from 2:00 pm by Sam Lee\nAgenda: launch checklist, pricing copy",
  },
  "mail:signoff-copy": {
    source: "mail",
    title: "Launch copy: final draft",
    at: "2026-10-15T09:12:00Z",
    text: "Final draft attached. Sign-off by Friday keeps the print slot. Two open notes on the pricing page.\n\nDana",
  },
  "messages:hardware": {
    source: "messages",
    title: "Rivera Build",
    at: "2026-10-16T18:40:00Z",
    text: "We can install Tuesday if the cabinet hardware is here by Monday. Brushed brass, 34 pulls.",
  },
};

const PASSAGES: LifeAnswerPassage[] = [
  {
    id: "mail:launch-checklist",
    source: "mail",
    title: "Re: Q4 launch checklist",
    createdAt: Date.parse("2026-10-16T15:30:00Z"),
  },
  {
    id: "calendar:weekly-sam",
    source: "calendar",
    title: "Weekly with Sam",
    createdAt: Date.parse("2026-10-14T10:00:00Z"),
  },
];

const FACTS: LifeFactHit[] = [
  {
    factId: "fact_sam_mail",
    entity: SAM,
    attribute: "email_pref",
    value: "Mail, for anything that needs a decision",
    provenance: "untrusted",
    review: "accepted",
    quote: "I'd rather settle it on mail than on the call.",
    source: "mail",
    docId: "mail:launch-checklist",
    docIds: ["mail:launch-checklist"],
    sources: ["mail"],
    observedAt: "2026-10-16T15:30:00Z",
    learnedAt: "2026-10-16T16:02:00Z",
  },
];

/** The answer, the passages it cites and the source viewer's text, on top of the fixture world. */
function scriptAnswers(g: MockGateway): void {
  const handlers = (g as unknown as { handlers: Record<string, (p: never) => unknown> }).handlers;
  Object.assign(handlers, {
    "memory.life.search": () => ({ entities: [SAM], facts: FACTS, intent: null }),
    "memory.life.answer": () => ({
      answer:
        "Sam wants you to read the launch checklist and mark anything you can't own [P1]. The call moved to 3:00 pm on Tuesday [P2]. Sam prefers to settle decisions like pricing copy on mail [1].",
      facts: FACTS,
      passages: PASSAGES,
      reason: null,
    }),
    "search.document": (p: { id: string }) => {
      const d = DOCS[p.id];
      if (d === undefined) throw new Error("no such passage");
      return {
        id: p.id,
        source: d.source,
        title: d.title,
        text: d.text,
        truncated: false,
        createdAt: Date.parse(d.at),
        provenance: "untrusted",
        open: d.source === "mail" ? "mail" : null,
      };
    },
  });
}

/** Search (⌘K): a question typed in, answered from memory with chips that open their sources. */
export const CitedAnswer: Story = {
  render: () => (
    <StoryWorld onGateway={scriptAnswers}>
      <CommandPalette open onOpenChange={() => {}} onNavigate={() => {}} />
    </StoryWorld>
  ),
};

/** Home's catch-up with the passages behind each line, which open in the source viewer. */
export const CatchUpSources: Story = {
  render: () => (
    <StoryWorld
      onGateway={scriptAnswers}
      edit={(w) => {
        withCatchUp(w);
        const [signoff, hardware] = w.graph.catchUp ?? [];
        if (signoff) signoff.sources = [{ docId: "mail:signoff-copy", sourceKind: "mail" }];
        if (hardware) hardware.sources = [{ docId: "messages:hardware", sourceKind: "messages" }];
      }}
      slots={{ prefillComposer: () => {} }}
    >
      <HomeScreen />
    </StoryWorld>
  ),
};

/** The agent sheet's files, with MEMORY.md saying what the other takes show about Sam Lee. */
export const MemoryFiles: Story = {
  render: () => (
    <StoryWorld
      edit={(w) => {
        const md = w.memoryFiles["MEMORY.md"];
        if (md !== undefined)
          w.memoryFiles["MEMORY.md"] = md.replace(
            /^- Sam: prefers Telegram;.*$/m,
            "- Sam Lee (Acme): settles decisions on mail, not on calls. [2026-10-16]",
          );
      }}
    >
      <AgentSheet
        open
        side="right"
        onOpenChange={() => {}}
        tab="soul"
        onTabChange={() => {}}
        now={STORY_NOW}
      />
    </StoryWorld>
  ),
};

const settingsWorld = createFixtureWorld();
const noop = () => {};

/** Settings → Skills, where a shared `.psyche-skill` file is imported: who signed it and what it asks for. */
export const SharedSkill: Story = {
  render: () => (
    <StoryWorld
      edit={(w) => {
        Object.assign(w.settings, sampleSettings());
      }}
    >
      <SettingsScreen
        defaultSection="skills"
        now={STORY_NOW}
        ramGb={32}
        thisDeviceId={IDS.devices.mac}
        tcc={{ accessibility: "granted", screenRecording: "denied", notifications: "granted" }}
        usage={settingsWorld.usage}
        server={sampleServerStatus()}
        about={sampleAbout()}
        doctor={sampleDoctor()}
        onOpenSystemSettings={noop}
        onConnect={noop}
        onReconnect={noop}
        onDisconnect={noop}
        onRemove={noop}
        onRunModelCheck={noop}
        onAddProvider={noop}
        onEditProviderKey={noop}
        onConnectManager={noop}
        onRunDoctor={noop}
        onOpenLogs={noop}
        onAddPasskey={noop}
      />
    </StoryWorld>
  ),
};
