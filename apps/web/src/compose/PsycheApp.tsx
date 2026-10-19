import {
  AgentHeader,
  AgentSheet,
  AgentSheetBody,
  type AgentTab,
  ChatThread,
  GatewayProvider,
  OnboardingFlow,
  type OnboardingResult,
} from "@psyche/ui";
import { type ReactElement, type ReactNode, useEffect, useMemo, useState } from "react";
import type { ShellPlatform } from "../shell/platform.ts";
import { ShellApp, type ShellSlots } from "../shell/ShellApp.tsx";
import { kitClient } from "./kit-client.ts";
import { writeOnboarding } from "./onboarding.ts";

/**
 * The composed Psyche app (INT-1): S11's shell (rail, threads, panes, browser, keyboard, `view.*`)
 * with the UI kit's screens in it (docs/06): onboarding on first run, the chat column with
 * message blocks, approval dock and question cards, and the agent sheet (Activity, Approvals,
 * Upcoming, Soul & Memory) behind the avatar and at `/agent/*`. One Gateway connection serves both.
 */

/** Cosmetic key (no admin needed) recording that onboarding finished on this Gateway. */
export const ONBOARDED_KEY = "ui.onboarding.completedAt";

const TABS: readonly AgentTab[] = ["activity", "approvals", "upcoming", "soul"];

function KitChat({ threadId }: { threadId: string }): ReactElement {
  const [sheet, setSheet] = useState<{ open: boolean; tab: AgentTab; taskId?: string }>({
    open: false,
    tab: "activity",
  });
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="kit-chat">
      <AgentHeader
        onOpenSheet={() => setSheet((s) => ({ ...s, open: true }))}
        onOpenTask={(taskId) => setSheet({ open: true, tab: "activity", taskId })}
      />
      <ChatThread threadId={threadId} />
      <AgentSheet
        open={sheet.open}
        onOpenChange={(open) => setSheet((s) => ({ ...s, open }))}
        tab={sheet.tab}
        onTabChange={(tab) => setSheet((s) => ({ ...s, tab }))}
        {...(sheet.taskId === undefined ? {} : { taskId: sheet.taskId })}
      />
    </div>
  );
}

function agentRoute(route: string, navigate: (to: string) => void): ReactNode | null {
  const m = /^\/agent\/(activity|approvals|upcoming|soul)(?:\/([^/?]+))?/.exec(route);
  if (m === null) return null;
  const tab = (TABS.find((t) => t === m[1]) ?? "activity") as AgentTab;
  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-auto" aria-label="Agent">
      <AgentSheetBody
        tab={tab}
        onTabChange={(t) => navigate(`/agent/${t}`)}
        {...(m[2] === undefined ? {} : { taskId: m[2] })}
      />
    </section>
  );
}

/** Turns the onboarding answers into workspace writes and remembers that onboarding is done. */
export async function completeOnboarding(
  platform: ShellPlatform,
  result: OnboardingResult,
  now: () => Date = () => new Date(),
): Promise<void> {
  const call = (m: string, p: unknown, o?: { idempotencyKey?: string }) =>
    platform.gateway.call(m, p, o ?? {});
  await writeOnboarding(call, {
    name: result.persona.name,
    creature: result.persona.creatureDescription || result.persona.creatureId,
    tagline: result.persona.tagline,
  });
  await call(
    "settings.set",
    { key: ONBOARDED_KEY, value: now().toISOString() },
    { idempotencyKey: `onboarding:done:${now().getTime()}` },
  );
}

type Gate = "loading" | "onboarding" | "ready";

export function PsycheApp({ platform }: { platform: ShellPlatform }): ReactElement {
  const client = useMemo(() => kitClient(platform.gateway), [platform]);
  const [gate, setGate] = useState<Gate>("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      const status = await platform.gateway.getStatus();
      if (status.phase !== "paired") return;
      const res = (await platform.gateway.call("settings.get", { keys: [ONBOARDED_KEY] })) as {
        settings: Record<string, unknown>;
      };
      if (!cancelled) setGate(res.settings[ONBOARDED_KEY] ? "ready" : "onboarding");
    };
    const retry = () => void check().catch(() => undefined);
    retry();
    const off = platform.gateway.onStatus((s) => {
      if (s.phase === "paired") retry();
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [platform]);

  const slots = useMemo<ShellSlots>(
    () => ({
      chat: (threadId) => <KitChat threadId={threadId} />,
      section: agentRoute,
    }),
    [],
  );

  let body: ReactNode;
  if (gate === "onboarding") {
    body = (
      <div className="h-dvh overflow-auto" data-testid="onboarding">
        {error ? <p role="alert">{error}</p> : null}
        <OnboardingFlow
          onComplete={(result) => {
            completeOnboarding(platform, result).then(
              () => setGate("ready"),
              (err: unknown) => setError(`Could not save your agent: ${String(err)}`),
            );
          }}
        />
      </div>
    );
  } else {
    // While the Gateway is unreachable the shell shows its offline banner; it is the same app.
    body = <ShellApp platform={platform} slots={slots} />;
  }
  return <GatewayProvider client={client}>{body}</GatewayProvider>;
}
