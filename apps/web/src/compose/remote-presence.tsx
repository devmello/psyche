import type { PasskeyInfo } from "@psyche/protocol";
import { t } from "@psyche/ui";
import { type ReactElement, useCallback, useEffect, useId, useMemo, useState } from "react";
import { notifyPasskeysChanged, onPasskeysChanged } from "../lib/passkey-state.ts";
import { type PasskeyCall, passkeyErrorText, reauthenticate } from "../lib/webauthn.ts";
import type { ShellPlatform } from "../shell/platform.ts";

/**
 * Touch ID for approvals on a client of another computer's Gateway (remote-gateway design §6.2,
 * R2). A card that needs presence (a purchase, a credential fill, a host command, a security
 * change) is approved here with a passkey made on this computer, whose Touch ID prompt the
 * Gateway's own site shows. Without one the card says "Answer on <host>". Ordinary approvals
 * never need it (owner decision G3).
 */

const codeOf = (err: unknown): unknown =>
  typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;

function call(platform: ShellPlatform): PasskeyCall {
  return (method, params) => platform.gateway.call(method, params);
}

/** What the approval card needs to know: the Host's name and whether this computer has a passkey. */
export function useRemotePresence(
  platform: ShellPlatform,
): { hostName: string; hasPasskey: boolean } | undefined {
  const hostName = platform.chrome?.remote?.hostName;
  const supported = hostName !== undefined && platform.passkeys !== undefined;
  const [hasPasskey, setHasPasskey] = useState(false);
  useEffect(() => {
    if (!supported) return;
    let live = true;
    const load = () => {
      void call(platform)("passkeys.list", {}).then(
        (r) => live && setHasPasskey(((r as { passkeys?: unknown[] }).passkeys ?? []).length > 0),
        () => live && setHasPasskey(false),
      );
    };
    load();
    const offStatus = platform.gateway.onStatus((s) => {
      if (s.phase === "paired") load();
    });
    const offChange = onPasskeysChanged(load);
    window.addEventListener("focus", load);
    return () => {
      live = false;
      offStatus();
      offChange();
      window.removeEventListener("focus", load);
    };
  }, [platform, supported]);
  return useMemo(
    () => (hostName === undefined ? undefined : { hostName, hasPasskey: supported && hasPasskey }),
    [hostName, hasPasskey, supported],
  );
}

type State =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "ready"; passkeys: PasskeyInfo[] };

const button =
  "inline-flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-sm font-medium shadow-xs hover:bg-gray-3 disabled:opacity-50";

/** Settings → Devices on a remote window: "Use Touch ID for approvals on this computer". */
export function RemotePresencePanel({ platform }: { platform: ShellPlatform }): ReactElement {
  const id = useId();
  const host = platform.chrome?.remote?.hostName ?? "";
  const passkeys = platform.passkeys;
  const [state, setState] = useState<State>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  // The first passkey of a device is approved on the Host (or another device with Touch ID),
  // then added again with that approval.
  const [approvalId, setApprovalId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = (await call(platform)("passkeys.list", {})) as { passkeys: PasskeyInfo[] };
      if (res.passkeys.length === 0) {
        // Without an https origin the Gateway answers `unavailable` here, before any ceremony.
        await call(platform)("passkeys.reauth.begin", {}).catch((err: unknown) => {
          if (codeOf(err) === "unavailable") throw err;
        });
      }
      setState({ kind: "ready", passkeys: res.passkeys });
    } catch (err) {
      if (codeOf(err) === "unavailable") setState({ kind: "unavailable" });
      else setState({ kind: "ready", passkeys: [] });
    }
  }, [platform]);

  useEffect(() => {
    void load();
  }, [load]);

  const enable = async () => {
    if (!passkeys) return;
    setBusy(true);
    setNotice(null);
    try {
      const begin = (await call(platform)("passkeys.register.begin", {})) as {
        ceremonyId: string;
        options: Record<string, unknown>;
      };
      const response = await passkeys.authenticator.create(begin.options);
      try {
        await call(platform)("passkeys.register.finish", {
          ceremonyId: begin.ceremonyId,
          response,
          name: t("web.remotePresence.passkeyName"),
          ...(approvalId ? { approvalId } : {}),
        });
      } catch (err) {
        const pending = codeOf(err) === "approval_required" ? approvalOf(err) : null;
        if (pending === null) throw err;
        setApprovalId(pending);
        setNotice({ kind: "ok", text: t("web.remotePresence.approveOnHost", { host }) });
        return;
      }
      setApprovalId(null);
      setNotice({ kind: "ok", text: t("web.remotePresence.enabled") });
      notifyPasskeysChanged();
    } catch (err) {
      if (codeOf(err) === "unavailable") setState({ kind: "unavailable" });
      else setNotice({ kind: "error", text: passkeyErrorText(err) });
    } finally {
      setBusy(false);
      void load();
    }
  };

  const disable = async () => {
    if (!passkeys || state.kind !== "ready") return;
    setBusy(true);
    setNotice(null);
    try {
      for (const p of state.passkeys) {
        const reauth = await reauthenticate(call(platform), passkeys.authenticator);
        await call(platform)("passkeys.remove", { passkeyId: p.id, reauth });
      }
      setNotice({ kind: "ok", text: t("web.remotePresence.disabled") });
      notifyPasskeysChanged();
    } catch (err) {
      setNotice({ kind: "error", text: passkeyErrorText(err) });
    } finally {
      setBusy(false);
      void load();
    }
  };

  const on = state.kind === "ready" && state.passkeys.length > 0;
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="flex flex-col gap-3 rounded-lg border border-gray-6 bg-gray-2 p-4 text-sm"
      data-testid="settings-remote-presence"
    >
      <div>
        <h3 id={`${id}-title`} className="text-base font-semibold text-foreground">
          {t("web.remotePresence.title")}
        </h3>
        <p className="text-muted-foreground">{t("web.remotePresence.description", { host })}</p>
      </div>
      {notice ? (
        <p
          role={notice.kind === "error" ? "alert" : "status"}
          className={
            notice.kind === "error"
              ? "text-danger-text"
              : "rounded-md bg-gray-3 px-3 py-2 text-foreground"
          }
        >
          {notice.text}
        </p>
      ) : null}
      {state.kind === "unavailable" || !passkeys ? (
        <p
          role="status"
          className="text-muted-foreground"
          data-testid="remote-presence-unavailable"
        >
          {t("web.remotePresence.unavailable", { host })}
        </p>
      ) : state.kind === "loading" ? (
        <p role="status" className="text-muted-foreground">
          {t("web.passkeys.loading")}
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-foreground" data-testid="remote-presence-state">
            {on ? t("web.remotePresence.on") : t("web.remotePresence.off")}
          </p>
          {on ? (
            <button type="button" className={button} disabled={busy} onClick={() => void disable()}>
              {t("web.remotePresence.disable")}
            </button>
          ) : (
            <button type="button" className={button} disabled={busy} onClick={() => void enable()}>
              {busy ? t("web.remotePresence.waiting") : t("web.remotePresence.enable")}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function approvalOf(err: unknown): string | null {
  const id = (err as { details?: { approvalId?: unknown } }).details?.approvalId;
  return typeof id === "string" && id !== "" ? id : null;
}
