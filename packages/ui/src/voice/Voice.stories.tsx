import type { Meta, StoryObj } from "@storybook/react-vite";
import { MotionConfig } from "motion/react";
import type { ReactElement, ReactNode } from "react";
import { VoicePanel } from "../screens/settings/VoiceSection.tsx";
import { UiSlotsProvider } from "../slots.tsx";
import { STORY_NOW } from "../stories/harness.tsx";
import { Lantern, type LanternState } from "./Lantern.tsx";
import { IDLE_SESSION, type VoiceSession } from "./session.ts";
import { VoiceCapsule } from "./VoiceCapsule.tsx";
import { VoiceHudView } from "./VoiceHudView.tsx";

/**
 * Voice conversation (docs/voice/voice-mode-2026.md §6): the capsule in each phase, the HUD's
 * compact form, Settings → Voice conversation, and the lantern in every state (light and dark),
 * with a reduced-motion story where nothing animates a transform.
 */

const persona = { persona: { name: "Wren", creature: "moth" } };
const noop = () => {};

function Frame({ children, width = 640 }: { children: ReactNode; width?: number }): ReactElement {
  return (
    <UiSlotsProvider value={persona}>
      <div className="bg-canvas p-6" style={{ width }}>
        {children}
      </div>
    </UiSlotsProvider>
  );
}

const session = (s: Partial<VoiceSession>): VoiceSession => ({
  ...IDLE_SESSION,
  conversationId: "vc_story",
  phase: "listening",
  ...s,
});

function Capsule({
  s,
  mode = "push",
}: {
  s: VoiceSession;
  mode?: "push" | "tap" | "handsfree";
}): ReactElement {
  return (
    <VoiceCapsule
      session={s}
      settings={{ mode, captions: true }}
      onTalk={noop}
      onToggleMute={noop}
      onStopSpeaking={noop}
      onEnd={noop}
      levels={() => ({ input: 0.12, output: 0.15 })}
      now={STORY_NOW}
    />
  );
}

const meta = {
  title: "Chat/Voice",
  parameters: { layout: "fullscreen" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Listening: Story = {
  render: () => (
    <Frame>
      <Capsule
        s={session({
          listening: true,
          caption: { role: "owner", text: "Send Alice the notes from this morning", final: false },
        })}
      />
    </Frame>
  ),
};

export const ThinkingWithStep: Story = {
  render: () => (
    <Frame>
      <Capsule
        s={session({
          phase: "thinking",
          caption: { role: "owner", text: "Send Alice the notes from this morning", final: true },
          step: { label: "Reading your notes", status: "running" },
        })}
      />
    </Frame>
  ),
};

export const Speaking: Story = {
  render: () => (
    <Frame>
      <Capsule
        s={session({
          phase: "speaking",
          caption: {
            role: "agent",
            text: "I've drafted the email to Alice with this morning's notes.",
            final: false,
          },
        })}
      />
    </Frame>
  ),
};

export const ApprovalReadback: Story = {
  render: () => (
    <Frame>
      <Capsule
        s={session({
          phase: "waiting",
          reason: "approval",
          approvalId: "apr_story",
          listening: true,
          prompt: "Send an email to alice@example.org, subject 'Notes'. Say 'send it' or 'cancel'.",
          windowMs: 10_000,
          windowAt: STORY_NOW - 3_000,
        })}
      />
    </Frame>
  ),
};

export const HandsFreeMuted: Story = {
  render: () => (
    <Frame>
      <Capsule mode="handsfree" s={session({ muted: true, listening: false })} />
    </Frame>
  ),
};

export const PushReady: Story = {
  render: () => (
    <Frame>
      <Capsule s={session({ listening: false })} />
    </Frame>
  ),
};

/** The HUD outside the app (380 × 96 pt, §6.2): the compact capsule; clicking it opens Psyche. */
export const Hud: Story = {
  render: () => (
    <Frame width={420}>
      <VoiceHudView
        session={session({
          phase: "speaking",
          caption: { role: "agent", text: "You have two meetings after lunch.", final: false },
        })}
        settings={{ mode: "push", captions: true }}
        onTalk={noop}
        onToggleMute={noop}
        onStopSpeaking={noop}
        onEnd={noop}
        onOpen={noop}
        levels={() => ({ input: 0.12, output: 0.15 })}
        now={STORY_NOW}
      />
    </Frame>
  ),
};

/** Arabic captions run right to left (§4.8). */
export const RtlCaption: Story = {
  render: () => (
    <Frame>
      <Capsule
        s={session({
          phase: "speaking",
          caption: { role: "agent", text: "لديك اجتماعان بعد الغداء.", final: false },
        })}
      />
    </Frame>
  ),
};

export const SettingsGroup: Story = {
  render: () => (
    <Frame width={720}>
      <VoicePanel
        needsApproval={new Set()}
        values={{ "voice.conversation.enabled": true, "voice.pushToTalk": "fn" }}
        onChange={noop}
        voices={[
          { ref: "apple:ava-premium", name: "Ava (Premium)", local: true, engine: "apple" },
          { ref: "elevenlabs:rachel", name: "Rachel", local: false, engine: "ElevenLabs" },
        ]}
        onGetVoices={noop}
      />
    </Frame>
  ),
};

const STATES: LanternState[] = ["listening", "heard", "thinking", "speaking", "waiting", "off"];

/** Every lantern state side by side (§6.3). */
export const LanternStates: Story = {
  render: () => (
    <Frame>
      <div className="flex flex-wrap gap-10 p-4">
        {STATES.map((s) => (
          <div key={s} className="flex flex-col items-center gap-3">
            <Lantern
              state={s}
              name="Wren"
              levels={() => ({ input: 0.15, output: 0.15 })}
              windowMs={s === "waiting" ? 10_000 : null}
              windowAt={s === "waiting" ? STORY_NOW - 4_000 : null}
              now={STORY_NOW}
            />
            <span className="text-caption text-label-secondary">{s}</span>
          </div>
        ))}
      </div>
    </Frame>
  ),
};

/** Reduced motion: no scale, no level following, still opacities, the state in words. */
export const LanternReducedMotion: Story = {
  render: () => (
    <MotionConfig reducedMotion="always">
      <Frame>
        <div className="flex flex-wrap gap-10 p-4">
          {(["listening", "thinking", "speaking"] as const).map((s) => (
            <div key={s} className="flex items-center gap-2">
              <Lantern state={s} name="Wren" levels={() => ({ input: 0.3, output: 0.3 })} />
              <span className="text-callout text-label-secondary">{s}</span>
            </div>
          ))}
        </div>
      </Frame>
    </MotionConfig>
  ),
};
