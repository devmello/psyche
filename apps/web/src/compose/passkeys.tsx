import type { PasskeyInfo } from "@psyche/protocol";
import { useCall } from "@psyche/ui";
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

export const PASSKEYS_UNAVAILABLE =
  "Passkeys need the server's https address. Set gateway.publicOrigin (or PSYCHE_PUBLIC_ORIGIN) to the https:// address you open Psyche at, restart the Gateway, then add one here.";
export const PASSKEYS_INSECURE =
  "Passkeys work only when Psyche is open at its https:// address, in a browser that supports them. Open it there to add one.";

const button =
  "inline-flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-sm font-medium shadow-xs hover:bg-gray-3 disabled:opacity-50";
const input = "h-8 rounded-md border border-input bg-background px-2 text-sm";

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
              text: `Psyche couldn't load your passkeys (${passkeyErrorText(err)}).`,
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
      const res = (await call("passkeys.register.finish", {
        ceremonyId: begin.ceremonyId,
        response,
        ...(label ? { name: label } : {}),
        ...(reauth ? { reauth } : {}),
      })) as { passkey: PasskeyInfo };
      setName("");
      return `Added ${res.passkey.name}. It now approves changes that need Touch ID or a passkey.`;
    });

  const remove = (p: PasskeyInfo) =>
    run(`remove:${p.id}`, async (h) => {
      const reauth = await reauthenticate(call, h.authenticator);
      await call("passkeys.remove", { passkeyId: p.id, reauth });
      return `Removed ${p.name}.`;
    });

  return (
    <section
      aria-labelledby={`${id}-title`}
      className="flex flex-col gap-3 rounded-lg border border-gray-6 bg-gray-2 p-4 text-sm"
      data-testid="settings-passkeys"
    >
      <div>
        <h3 id={`${id}-title`} className="text-base font-semibold text-foreground">
          Passkeys
        </h3>
        <p className="text-muted-foreground">
          A passkey on this browser proves it's you when you approve purchases, credential fills,
          commands on the server and security settings.
        </p>
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
          {PASSKEYS_UNAVAILABLE}
        </p>
      ) : !host ? (
        <p role="status" className="text-muted-foreground" data-testid="passkeys-unavailable">
          {PASSKEYS_INSECURE}
        </p>
      ) : null}
      {list.kind === "error" ? (
        <p role="alert" className="text-danger-text">
          {list.text}
        </p>
      ) : null}
      {list.kind === "loading" ? (
        <p role="status" className="text-muted-foreground">
          Loading passkeys…
        </p>
      ) : list.kind === "ready" ? (
        passkeys.length === 0 ? (
          <p className="rounded-lg border border-dashed border-gray-6 p-3 text-muted-foreground">
            No passkeys on this browser yet.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-gray-6" aria-label="Passkeys">
            {passkeys.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-3 py-1.5">
                <span className="min-w-0 flex-1 font-medium text-foreground">{p.name}</span>
                <span className="text-xs text-muted-foreground">
                  Added {new Date(p.createdAt).toLocaleDateString()}
                  {p.lastUsedAt ? ` · used ${new Date(p.lastUsedAt).toLocaleDateString()}` : ""}
                  {p.backedUp ? " · synced" : ""}
                </span>
                <button
                  type="button"
                  className={button}
                  disabled={busy !== null || !host}
                  onClick={() => void remove(p)}
                  aria-label={`Remove ${p.name}`}
                >
                  {busy === `remove:${p.id}` ? "Removing…" : "Remove"}
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}
      {host && list.kind === "ready" ? (
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1">
            <span className="font-medium text-foreground">Name</span>
            <input
              className={input}
              maxLength={64}
              placeholder="Passkey"
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
            {busy === "add" ? "Waiting for the passkey…" : "Add a passkey"}
          </button>
          {passkeys.length > 0 ? (
            <span className="pb-1.5 text-xs text-muted-foreground">
              You'll confirm with an existing passkey first.
            </span>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
