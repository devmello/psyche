import { ConnectServerEntry, KeepOnNetworkChoice, UiSlotsProvider, useSlots } from "@psyche/ui";
import { type ReactElement, useEffect, useState } from "react";
import type { ShellPlatform } from "../shell/platform.ts";

/**
 * First run, on This Mac: "Connect to a Psyche server" (remote-gateway design §3.6). Shown only
 * when the window can claim a server (the desktop) and is on this computer's own Gateway. Setting
 * one up saves it pinned; switching to it relaunches the app there, and onboarding runs on the
 * server because its onboarding isn't done yet.
 */
export function ServerSetupEntry({ platform }: { platform: ShellPlatform }): ReactElement | null {
  const slots = useSlots();
  const gateways = platform.gateways;
  const [local, setLocal] = useState(false);
  useEffect(() => {
    if (!gateways?.claim) return;
    let live = true;
    void gateways.list().then(
      (list) => live && setLocal(list.some((g) => g.active && !g.remote)),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [gateways]);
  if (!gateways?.claim || !local) return null;
  return (
    <UiSlotsProvider value={{ ...slots, gateways }}>
      <div className="mx-auto mt-4 w-full max-w-4xl px-6 sm:px-10">
        <ConnectServerEntry />
      </div>
    </UiSlotsProvider>
  );
}

/**
 * On a server this computer just claimed: whether the owner still has to say if its network
 * listener stays on. `null` until known, or when there is nothing to answer.
 */
export function useClaimLanChoice(
  platform: ShellPlatform,
  /** Asked once onboarding shows, when the Gateway is connected. */
  enabled: boolean,
): {
  keepLan: boolean | null;
  setKeepLan: (keep: boolean) => void;
} {
  const [keepLan, setKeepLan] = useState<boolean | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    platform.gateway.call("gateway.info", {}).then(
      (info) => {
        const pending = (info as { claim?: { lanChoicePending?: unknown } } | null)?.claim
          ?.lanChoicePending;
        if (live && pending === true) setKeepLan(true);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [platform, enabled]);
  return { keepLan, setKeepLan };
}

export function ClaimLanChoice({
  keepLan,
  onChange,
}: {
  keepLan: boolean | null;
  onChange: (keep: boolean) => void;
}): ReactElement | null {
  if (keepLan === null) return null;
  return (
    <div className="mx-auto mt-4 w-full max-w-4xl px-6 sm:px-10">
      <KeepOnNetworkChoice checked={keepLan} onChange={onChange} />
    </div>
  );
}

/**
 * Answers the claimed server's network question, last: turning the listener off can end this
 * computer's connection, so everything else onboarding writes goes first. Best effort; the owner
 * can change it later in Settings → Server & remote access.
 */
export async function finishClaim(
  call: (m: string, p: unknown, o?: { idempotencyKey?: string }) => Promise<unknown>,
  keepLan: boolean,
  now: () => Date = () => new Date(),
): Promise<void> {
  try {
    await call(
      "gateway.claim.finish",
      { keepLan },
      { idempotencyKey: `onboarding:claim:${now().getTime()}` },
    );
  } catch {
    // See above.
  }
}
