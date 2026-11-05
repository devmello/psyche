import { type ReactElement, useContext, useEffect, useId, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog.tsx";
import { Input } from "../../components/ui/input.tsx";
import { t } from "../../i18n/core.ts";
import { presenceUnavailable } from "./SettingsApproval.tsx";
import { approvalIdOf, messageOf, SettingsApprovalContext } from "./shared.tsx";
import type { UninstallPlanInfo, UninstallPort } from "./types.ts";

/**
 * Settings → About → Uninstall Psyche (docs/design/updates-and-install-2026.md §3.5). One honest
 * sheet: it stops the Gateway agent and the helper, lists exactly what goes to the Trash, and
 * keeps the data in `~/.psyche` unless the owner picks "Delete my data". Deleting data also needs
 * a typed word and fresh presence (the approval banner above the section), then the same call
 * runs again with the approved card. Only the desktop shell on this Mac passes an `UninstallPort`.
 */

const KIND_HEADINGS = {
  agent: "settings.uninstall.kind.agent",
  support: "settings.uninstall.kind.support",
  cache: "settings.uninstall.kind.cache",
  data: "settings.uninstall.kind.data",
  app: "settings.uninstall.kind.app",
} as const;

export function UninstallSheet({
  port,
  open,
  onOpenChange,
}: {
  port: UninstallPort;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): ReactElement {
  const requestApproval = useContext(SettingsApprovalContext);
  const nameId = useId();
  const [deleteData, setDeleteData] = useState(false);
  const [plan, setPlan] = useState<UninstallPlanInfo | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setError(null);
    port.plan(deleteData).then(
      (p) => live && setPlan(p),
      (err: unknown) => live && setError(messageOf(err)),
    );
    return () => {
      live = false;
    };
  }, [open, deleteData, port]);

  useEffect(() => {
    if (!open) {
      setDeleteData(false);
      setTyped("");
      setBusy(false);
      setError(null);
    }
  }, [open]);

  const word = plan?.confirmWord ?? "";
  const typedOk = !deleteData || (word !== "" && typed === word);

  const go = () => {
    setBusy(true);
    setError(null);
    const req = { deleteData, ...(deleteData ? { confirm: typed } : {}) };
    port.uninstall(req).then(
      () => undefined, // The app quits.
      (err: unknown) => {
        const approvalId = approvalIdOf(err);
        if (approvalId === null) {
          setBusy(false);
          setError(messageOf(err));
          return;
        }
        if (requestApproval === null) {
          setBusy(false);
          setError(presenceUnavailable());
          return;
        }
        // The sheet gets out of the way so the approval card above the section can be answered.
        setBusy(false);
        onOpenChange(false);
        requestApproval({
          key: "app.uninstall",
          label: t("settings.uninstall.approvalLabel"),
          approvalId,
          retry: (id) => port.uninstall({ ...req, approvalId: id }),
        });
      },
    );
  };

  const groups = (["agent", "support", "cache", "data", "app"] as const)
    .map((kind) => ({ kind, items: plan?.trash.filter((i) => i.kind === kind) ?? [] }))
    .filter((g) => g.items.length > 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[85vh] overflow-y-auto sm:max-w-lg"
        data-testid="uninstall-sheet"
      >
        <DialogHeader>
          <DialogTitle>{t("settings.uninstall.title")}</DialogTitle>
          <DialogDescription>{t("settings.uninstall.description")}</DialogDescription>
        </DialogHeader>
        <fieldset className="flex flex-col gap-2" disabled={busy}>
          <legend className="text-headline">{t("settings.uninstall.dataChoice")}</legend>
          <label className="flex items-start gap-2">
            <input
              type="radio"
              name={nameId}
              checked={!deleteData}
              onChange={() => setDeleteData(false)}
              className="mt-1"
            />
            <span>
              <span className="font-medium">{t("settings.uninstall.keep")}</span>{" "}
              <span className="text-label-secondary">{t("settings.uninstall.keepHint")}</span>
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input
              type="radio"
              name={nameId}
              checked={deleteData}
              onChange={() => setDeleteData(true)}
              className="mt-1"
            />
            <span>
              <span className="font-medium">{t("settings.uninstall.delete")}</span>{" "}
              <span className="text-label-secondary">{t("settings.uninstall.deleteHint")}</span>
            </span>
          </label>
        </fieldset>
        <div className="flex flex-col gap-2" data-testid="uninstall-plan">
          <h3 className="text-headline">{t("settings.uninstall.willDo")}</h3>
          <ul className="list-disc pl-5 text-label-secondary">
            <li>{t("settings.uninstall.stopAgent")}</li>
            <li>{t("settings.uninstall.stopHelper")}</li>
          </ul>
          {groups.length === 0 ? null : (
            <>
              <h3 className="text-headline">{t("settings.uninstall.trash")}</h3>
              {groups.map((g) => (
                <div key={g.kind} className="flex flex-col gap-0.5">
                  <p className="text-callout text-label-primary">{t(KIND_HEADINGS[g.kind])}</p>
                  <ul className="flex flex-col gap-0.5 text-label-secondary">
                    {g.items.map((i) => (
                      <li key={i.path}>
                        <code className="font-mono text-callout break-all">{i.path}</code>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </>
          )}
          {deleteData ? null : (
            <p className="text-callout text-label-secondary">{t("settings.uninstall.dataStays")}</p>
          )}
        </div>
        {deleteData ? (
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${nameId}-word`} className="text-callout">
              {t("settings.uninstall.typeWord", { word })}
            </label>
            <Input
              id={`${nameId}-word`}
              value={typed}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setTyped(e.target.value)}
              disabled={busy}
            />
            <p className="text-callout text-label-secondary">{t("settings.uninstall.presence")}</p>
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-danger-text">
            {t("settings.uninstall.failed", { reason: error })}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            {t("settings.uninstall.cancel")}
          </Button>
          <Button
            variant="destructive"
            onClick={go}
            disabled={busy || plan === null || !typedOk}
            data-testid="uninstall-go"
          >
            {t(deleteData ? "settings.uninstall.goDelete" : "settings.uninstall.go")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The Uninstall Psyche row for About. */
export function UninstallGroupAction({ port }: { port: UninstallPort }): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
        {t("settings.uninstall.open")}
      </Button>
      <UninstallSheet port={port} open={open} onOpenChange={setOpen} />
    </>
  );
}
