import type { GitSyncResult } from "@psyche/protocol";
import { type ReactElement, useEffect, useId, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Label } from "../../components/ui/label.tsx";
import { useCall, useGatewayQuery } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { Group, hasCode, messageOf, SwitchField } from "./shared.tsx";

/**
 * Settings › Data › "Back up to git" (`memory.gitSync.*`). The Gateway decides who may change it:
 * a device without admin gets `forbidden` on save and sync, and the block says so. The block
 * renders nothing until the Gateway answers, so it is only shown when connected.
 */

/** The outcome line under "Sync now", from the last result. */
export function gitOutcomeText(r: GitSyncResult): string {
  if (!r.ok) {
    switch (r.errorCode) {
      case "no_git":
        return t("settings.data.git.noGit");
      case "no_remote":
        return t("settings.data.git.noRemote");
      case "not_enabled":
        return t("settings.data.git.notEnabled");
      case "auth_failed":
        return t("settings.data.git.authFailed");
      case "remote_failed":
        return t("settings.data.git.remoteFailed");
      case "conflict":
        return t("settings.data.git.conflict");
      case "blocked_secret":
        return t("settings.data.git.blocked", { files: (r.blocked ?? []).join(", ") });
      default:
        return t("settings.data.git.failed");
    }
  }
  if (r.committed && r.pushed) return t("settings.data.git.backedUp", { files: r.files });
  if (r.pulled && !r.committed) return t("settings.data.git.pulled");
  return t("settings.data.git.upToDate");
}

export function GitBackupGroup(): ReactElement | null {
  const id = useId();
  const call = useCall();
  const state = useGatewayQuery("memory.gitSync.get", {});
  const [remote, setRemote] = useState("");
  const [branch, setBranch] = useState("main");
  const [enabled, setEnabled] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [last, setLast] = useState<GitSyncResult | null>(null);
  const [busy, setBusy] = useState<"save" | "sync" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsAdmin, setNeedsAdmin] = useState(false);

  useEffect(() => {
    if (loaded || !state.data) return;
    setRemote(state.data.config.remote);
    setBranch(state.data.config.branch);
    setEnabled(state.data.config.enabled);
    setLast(state.data.last);
    setLoaded(true);
  }, [loaded, state.data]);

  // Not connected yet (or the Gateway refused the read): nothing to show.
  if (!state.data) return null;

  const locked = needsAdmin || busy !== null;

  const fail = (err: unknown) => {
    if (hasCode(err, "forbidden")) {
      setNeedsAdmin(true);
      setError(null);
      return;
    }
    setError(messageOf(err));
  };

  const save = async () => {
    setBusy("save");
    setError(null);
    try {
      const config = await call("memory.gitSync.set", {
        remote: remote.trim(),
        branch: branch.trim(),
        enabled,
      });
      setRemote(config.remote);
      setBranch(config.branch);
      setEnabled(config.enabled);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  };

  const sync = async () => {
    setBusy("sync");
    setError(null);
    try {
      const result = await call("memory.gitSync.run", {});
      setLast(result);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Group title={t("settings.data.git.title")} description={t("settings.data.git.description")}>
      <div className="flex flex-col gap-4">
        {needsAdmin ? (
          <p role="note" className="px-1 text-footnote text-label-tertiary">
            {t("settings.data.git.needsAdmin")}
          </p>
        ) : null}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-remote`}>{t("settings.data.git.remote")}</Label>
          <Input
            id={`${id}-remote`}
            value={remote}
            disabled={locked}
            aria-describedby={`${id}-remote-hint`}
            onChange={(e) => setRemote(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <p id={`${id}-remote-hint`} className="px-1 text-footnote text-label-tertiary">
            {t("settings.data.git.remoteHint")}
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-branch`}>{t("settings.data.git.branch")}</Label>
          <Input
            id={`${id}-branch`}
            value={branch}
            disabled={locked}
            onChange={(e) => setBranch(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <SwitchField
          label={t("settings.data.git.enabled")}
          description={t("settings.data.git.enabledHint")}
          checked={enabled}
          disabled={locked}
          onChange={setEnabled}
        />
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" disabled={locked} onClick={save}>
            {t("settings.data.git.save")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={locked || remote.trim() === "" || !enabled}
            onClick={sync}
          >
            {t("settings.data.git.sync")}
          </Button>
        </div>
        <p className="px-1 text-footnote text-label-tertiary">
          {t("settings.data.git.historyNote")}
        </p>
        {last ? (
          <div className="flex flex-col gap-1 px-1 text-footnote text-label-tertiary">
            <p>{t("settings.data.git.lastSync", { when: new Date(last.at).toLocaleString() })}</p>
            <p role="status">{gitOutcomeText(last)}</p>
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="px-1 text-footnote text-danger-text">
            {error}
          </p>
        ) : null}
      </div>
    </Group>
  );
}
