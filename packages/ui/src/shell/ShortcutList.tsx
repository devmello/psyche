import type { ReactElement } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog.tsx";
import { Kbd } from "../components/ui/kbd.tsx";
import { t } from "../i18n/core.ts";
import { CARD_SHORTCUTS, SHORTCUTS } from "./shortcuts.ts";

/** ⌘/: the keyboard map (UI design §4.11); † marks Psyche additions. */
export function ShortcutTable(): ReactElement {
  const rows = [
    ...SHORTCUTS.map((s) => ({ keys: s.keys, label: s.label, psyche: s.psyche === true })),
    ...CARD_SHORTCUTS.map((s) => ({ keys: s.keys, label: s.label, psyche: "psyche" in s })),
  ];
  return (
    <table className="w-full text-sm">
      <caption className="sr-only">{t("shell.shortcuts.title")}</caption>
      <thead>
        <tr className="text-start text-muted-foreground">
          <th scope="col" className="w-28 py-1 font-normal">
            {t("shell.shortcuts.shortcut")}
          </th>
          <th scope="col" className="py-1 font-normal">
            {t("shell.shortcuts.action")}
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.keys + r.label} className="border-t border-gray-4">
            <td className="py-1">
              <Kbd>{r.keys}</Kbd>
            </td>
            <td className="py-1">
              {r.label}
              {r.psyche ? (
                <span className="text-muted-foreground" title={t("shell.shortcuts.addition")}>
                  {" "}
                  †
                </span>
              ) : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ShortcutList({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): ReactElement {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("shell.shortcuts.title")}</DialogTitle>
          <DialogDescription>{t("shell.shortcuts.description")}</DialogDescription>
        </DialogHeader>
        <ShortcutTable />
      </DialogContent>
    </Dialog>
  );
}
