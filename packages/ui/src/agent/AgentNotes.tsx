import { Trash2 } from "lucide-react";
import type { ReactElement } from "react";
import { useState } from "react";
import { GroupedList, GroupedRow } from "../components/page.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../components/ui/alert-dialog.tsx";
import { Button } from "../components/ui/button.tsx";
import { useCall, useGatewayQuery } from "../data/index.ts";
import { activeI18n, t } from "../i18n/core.ts";
import { describeError } from "../i18n/errors.ts";
import { usePersona } from "../slots.tsx";

/** What Psyche noted for its own future use (`memory/agent/`), with a delete per note. */
export function AgentNotes(): ReactElement | null {
  const persona = usePersona();
  const call = useCall();
  const list = useGatewayQuery("memory.notes.list", {});
  const [error, setError] = useState<string | null>(null);
  const notes = list.data?.notes ?? [];
  if (list.data === undefined) return null;
  const remove = async (path: string) => {
    try {
      await call("memory.notes.delete", { path });
      setError(null);
    } catch (err) {
      setError(describeError(err));
    }
    list.reload();
  };
  return (
    <section
      aria-label={t("agent.notes.title", { name: persona.name })}
      className="flex flex-col gap-1"
    >
      <GroupedList title={t("agent.notes.title", { name: persona.name })}>
        {notes.length === 0 ? (
          <GroupedRow label={t("agent.notes.empty")} />
        ) : (
          notes.map((n) => (
            <GroupedRow
              key={n.path}
              label={<span className="line-clamp-3 whitespace-pre-line">{n.text}</span>}
              description={
                <>
                  <span className="text-mono">{n.path}</span>
                  {" · "}
                  {t("agent.notes.updated", {
                    date: activeI18n().date(Date.parse(n.updatedAt), {
                      month: "short",
                      day: "numeric",
                    }),
                  })}
                  {" · "}
                  {t(`agent.notes.source.${n.provenance}`)}
                </>
              }
              control={
                <DeleteNote path={n.path} name={persona.name} onDelete={() => remove(n.path)} />
              }
            />
          ))
        )}
      </GroupedList>
      <p className="px-3 text-callout text-label-secondary">
        {t("agent.notes.hint", { name: persona.name })}
      </p>
      {error ? (
        <p className="text-sm text-danger-text" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function DeleteNote({
  path,
  name,
  onDelete,
}: {
  path: string;
  name: string;
  onDelete: () => void;
}): ReactElement {
  return (
    <AlertDialog>
      <AlertDialogTrigger
        render={
          <Button
            size="icon"
            variant="ghost"
            className="text-danger-text"
            aria-label={t("agent.notes.delete", { file: path })}
          />
        }
      >
        <Trash2 aria-hidden="true" />
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("agent.notes.deleteTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("agent.notes.deleteBody", { file: path, name })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onDelete}>
            {t("common.delete")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
