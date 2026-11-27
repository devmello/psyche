import type { PasskeyInfo } from "@psyche/protocol";
import { activeI18n, t, useCall } from "@psyche/ui";
import { type ReactElement, useCallback, useEffect, useId, useState } from "react";
import {
  type PasskeyCall,
  type PasskeyHost,
  passkeyErrorText,
  reauthenticate,
} from "../lib/webauthn.ts";

/**
 * Passkeys (security §10, issue #79; docs/guides/server-mode.md "Passkeys"), in Settings →
 * Devices & nodes on the web client: this browser's passkeys from `passkeys.list`, add
 * (`passkeys.register.*`) and remove (`passkeys.remove`). Once this device has one, adding or
 * removing another first asks for an existing one (`passkeys.reauth.begin`), so a stolen device
 * key cannot swap in someone else's. A passkey then approves cards that need Touch ID or a
 * passkey (purchases, credential fills, host commands, security settings).
 */

/** Shown when the Gateway has no https origin for passkeys. */
export function passkeysUnavailableText(): string {
  return t("web.passkeys.unavailable");
}
/** Shown when this page isn't a secure context or the browser lacks WebAuthn. */
export function passkeysInsecureText(): string {
  return t("web.passkeys.insecure");
}

const button =
  "inline-flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-sm font-medium shadow-xs hover:bg-gray-3 disabled:opacity-50";
const input = "h-8 rounded-md border border-input bg-background px-2 text-sm";

/** Asks for the owner's approval of this device's first passkey. */
export function firstPasskeyApprovalText(): string {
  return t("web.passkeys.firstApproval");
}

/** `details.approvalId` when the Gateway asks for the owner's approval of a first passkey. */
function firstPasskeyApproval(err: unknown): string | null {
  if (codeOf(err) !== "approval_required") return null;
  const id = (err as { details?: { approvalId?: unknown } }).details?.approvalId;
  return typeof id === "string" && id !== "" ? id : null;
}

function codeOf(err: unknown): unknown {
  return typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
}

type ListState =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "error"; text: string }
  | { kind: "ready"; passkeys: PasskeyInfo[] };

export function PasskeysPanel({ host }: { host: PasskeyHost | undefined }): ReactElement {
  const id = useId();
  const kitCall = useCall();
  const call: PasskeyCall = useCallback(
    (method, params) => kitCall(method as never, params as never),
    [kitCall],
  );
  const [list, setList] = useState<ListState>({ kind: "loading" });
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  // A device's first passkey needs the owner's approval from a device that already has one
  // (or the Mac's Touch ID); the next "Add" retries with that approval.
  const [approvalId, setApprovalId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = (await call("passkeys.list", {})) as { passkeys: PasskeyInfo[] };
      if (res.passkeys.length === 0) {
        // `passkeys.list` answers without an https origin too; `passkeys.reauth.begin` checks
        // it first and, for a device without passkeys, fails `not_found` without a ceremony.
        await call("passkeys.reauth.begin", {}).catch((err: unknown) => {
          if (codeOf(err) === "unavailable") throw err;
        });
      }
      setList({ kind: "ready", passkeys: res.passkeys });
    } catch (err) {
      setList(
        codeOf(err) === "unavailable"
          ? { kind: "unavailable" }
          : {
              kind: "error",
              text: t("web.passkeys.loadError", { error: passkeyErrorText(err) }),
            },
      );
    }
  }, [call]);

  useEffect(() => {
    void load();
  }, [load]);

  const passkeys = list.kind === "ready" ? list.passkeys : [];

  const run = async (what: string, fn: (h: PasskeyHost) => Promise<string>) => {
    if (!host) return;
    setBusy(what);
    setNotice(null);
    try {
      setNotice({ kind: "ok", text: await fn(host) });
    } catch (err) {
      if (codeOf(err) === "unavailable") setList({ kind: "unavailable" });
      else setNotice({ kind: "error", text: passkeyErrorText(err) });
    } finally {
      setBusy(null);
      void load();
    }
  };

  const add = () =>
    run("add", async (h) => {
      // A device that already has a passkey confirms with it first (security §10).
      const reauth = passkeys.length > 0 ? await reauthenticate(call, h.authenticator) : undefined;
      const begin = (await call("passkeys.register.begin", {})) as {
        ceremonyId: string;
        options: Record<string, unknown>;
      };
      const response = await h.authenticator.create(begin.options);
      const label = name.trim();
      let res: { passkey: PasskeyInfo };
      try {
        res = (await call("passkeys.register.finish", {
          ceremonyId: begin.ceremonyId,
          response,
          ...(label ? { name: label } : {}),
          ...(reauth ? { reauth } : {}),
          ...(approvalId ? { approvalId } : {}),
        })) as { passkey: PasskeyInfo };
      } catch (err) {
        const pending = firstPasskeyApproval(err);
        if (pending === null) throw err;
        setApprovalId(pending);
        throw new Error(firstPasskeyApprovalText());
      }
      setApprovalId(null);
      setName("");
      return t("web.passkeys.added", { name: res.passkey.name });
    });

  const remove = (p: PasskeyInfo) =>
    run(`remove:${p.id}`, async (h) => {
      const reauth = await reauthenticate(call, h.authenticator);
      await call("passkeys.remove", { passkeyId: p.id, reauth });
      return t("web.passkeys.removed", { name: p.name });
    });

  return (
    <section
      aria-labelledby={`${id}-title`}
      className="flex flex-col gap-3 rounded-lg border border-gray-6 bg-gray-2 p-4 text-sm"
      data-testid="settings-passkeys"
    >
      <div>
        <h3 id={`${id}-title`} className="text-base font-semibold text-foreground">
          {t("web.passkeys.title")}
        </h3>
        <p className="text-muted-foreground">{t("web.passkeys.description")}</p>
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
      {list.kind === "unavailable" ? (
        <p role="status" className="text-muted-foreground" data-testid="passkeys-unavailable">
          {passkeysUnavailableText()}
        </p>
      ) : !host ? (
        <p role="status" className="text-muted-foreground" data-testid="passkeys-unavailable">
          {passkeysInsecureText()}
        </p>
      ) : null}
      {list.kind === "error" ? (
        <p role="alert" className="text-danger-text">
          {list.text}
        </p>
      ) : null}
      {list.kind === "loading" ? (
        <p role="status" className="text-muted-foreground">
          {t("web.passkeys.loading")}
        </p>
      ) : list.kind === "ready" ? (
        passkeys.length === 0 ? (
          <p className="rounded-lg border border-dashed border-gray-6 p-3 text-muted-foreground">
            {t("web.passkeys.empty")}
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-gray-6" aria-label={t("web.passkeys.title")}>
            {passkeys.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-3 py-1.5">
                <span className="min-w-0 flex-1 font-medium text-foreground">{p.name}</span>
                <span className="text-xs text-muted-foreground">
                  {t("web.passkeys.addedOn", { date: activeI18n().date(p.createdAt) })}
                  {p.lastUsedAt
                    ? t("web.passkeys.usedOn", { date: activeI18n().date(p.lastUsedAt) })
                    : ""}
                  {p.backedUp ? t("web.passkeys.synced") : ""}
                </span>
                <button
                  type="button"
                  className={button}
                  disabled={busy !== null || !host}
                  onClick={() => void remove(p)}
                  aria-label={t("web.passkeys.removeName", { name: p.name })}
                >
                  {busy === `remove:${p.id}` ? t("web.passkeys.removing") : t("common.remove")}
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}
      {host && list.kind === "ready" ? (
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1">
            <span className="font-medium text-foreground">{t("web.passkeys.name")}</span>
            <input
              className={input}
              maxLength={64}
              placeholder={t("web.passkeys.namePlaceholder")}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <button
            type="button"
            className={button}
            disabled={busy !== null}
            onClick={() => void add()}
          >
            {busy === "add" ? t("web.passkeys.waiting") : t("web.passkeys.add")}
          </button>
          {passkeys.length > 0 ? (
            <span className="pb-1.5 text-xs text-muted-foreground">
              {t("web.passkeys.confirmFirst")}
            </span>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
