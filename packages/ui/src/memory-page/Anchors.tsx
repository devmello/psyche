import type { GraphAnchor, GraphAnchorKind } from "@psyche/protocol";
import {
  Bell,
  Calendar,
  FileText,
  Folder,
  GitBranch,
  type LucideIcon,
  Mail,
  MessageCircle,
  Plus,
  StickyNote,
  X,
} from "lucide-react";
import { type ReactElement, useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "../components/ui/button.tsx";
import { Input } from "../components/ui/input.tsx";
import { NativeSelect } from "../components/ui/native-select.tsx";
import { useCall, useGatewayQuery, useLibrary, useThreads } from "../data/hooks.ts";
import { t } from "../i18n/core.ts";
import { describeError } from "../i18n/errors.ts";
import { SegmentedRadio } from "../screens/settings/SegmentedRadio.tsx";
import { usePersona, useSlots } from "../slots.tsx";

const ANCHOR_ICON: Record<GraphAnchorKind, LucideIcon> = {
  folder: Folder,
  file: FileText,
  mail_thread: Mail,
  calendar_series: Calendar,
  calendar: Calendar,
  reminder_list: Bell,
  reminder: Bell,
  note: StickyNote,
  note_folder: Folder,
  chat_thread: MessageCircle,
  library_item: FileText,
  repo: GitBranch,
};

/** What the owner can link by hand (W5, §6.3): a folder, a chat thread, a document. */
export const LINKABLE = ["folder", "chat_thread", "library_item"] as const;
export type Linkable = (typeof LINKABLE)[number];

export interface NewAnchor {
  kind: GraphAnchorKind;
  ref: string;
  label: string;
}

/** Who linked it, in words: the owner, a rule, or a suggestion that routes nothing yet. */
function origin(anchor: GraphAnchor): string {
  if (anchor.addedBy === "model" && !anchor.confirmed) return t("work.anchors.suggested");
  return t(`work.anchors.by.${anchor.addedBy}`);
}

function AnchorRow({
  anchor,
  busy,
  onRemove,
}: {
  anchor: GraphAnchor;
  busy: boolean;
  onRemove?: (anchor: GraphAnchor) => void;
}): ReactElement {
  const Icon = ANCHOR_ICON[anchor.kind];
  const kind = t(`work.anchors.kind.${anchor.kind}`);
  return (
    <div
      data-testid="anchor-row"
      className="group/row relative flex min-h-9 items-center gap-3 px-3 py-1.5 before:absolute before:inset-x-3 before:top-0 before:h-px before:bg-separator first:before:hidden"
    >
      <Icon className="size-4 shrink-0 text-label-secondary" aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-body text-label-primary">{anchor.label || anchor.ref}</span>
        <span className="truncate text-callout text-label-secondary">
          {kind}
          {anchor.label && anchor.label !== anchor.ref ? ` · ${anchor.ref}` : ""} · {origin(anchor)}
        </span>
      </div>
      {onRemove ? (
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          disabled={busy}
          className="shrink-0 text-label-secondary"
          aria-label={t("work.anchors.remove", { name: anchor.label || anchor.ref })}
          title={t("work.anchors.removeHint")}
          onClick={() => onRemove(anchor)}
        >
          <X aria-hidden="true" />
        </Button>
      ) : null}
    </div>
  );
}

/** The form behind "Add link": a folder (picked or typed), one of the owner's chats, or a document. */
function AddAnchor({
  busy,
  onAdd,
  onClose,
}: {
  busy: boolean;
  onAdd: (anchor: NewAnchor) => void;
  onClose: () => void;
}): ReactElement {
  const { pickFolder } = useSlots();
  const persona = usePersona();
  const fieldId = useId();
  const [kind, setKind] = useState<Linkable>("folder");
  const [path, setPath] = useState("");
  const [choice, setChoice] = useState("");
  const threads = useThreads();
  const library = useLibrary();

  const chats = threads.active.map((e) => ({ id: e.thread.id, name: e.thread.title }));
  const docs = library.items
    .filter((i) => i.quarantined !== true)
    .map((i) => ({ id: i.id, name: i.name }));
  const options = kind === "chat_thread" ? chats : docs;
  const picked = options.find((o) => o.id === choice);

  const ready = kind === "folder" ? path.trim() !== "" : picked !== undefined;
  const submit = () => {
    if (!ready) return;
    if (kind === "folder") {
      const ref = path.trim();
      const name = ref.split("/").filter(Boolean).at(-1) ?? ref;
      onAdd({ kind, ref, label: name });
    } else if (picked) onAdd({ kind, ref: picked.id, label: picked.name });
  };

  return (
    <form
      aria-label={t("work.anchors.addLabel")}
      className="flex flex-col gap-2 px-3 py-2"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <SegmentedRadio
        label={t("work.anchors.kindLabel")}
        value={kind}
        onChange={(k) => {
          setKind(k);
          setChoice("");
        }}
        className="self-start"
        options={LINKABLE.map((k) => ({ value: k, label: t(`work.anchors.kind.${k}`) }))}
      />
      <label htmlFor={fieldId} className="sr-only">
        {t(`work.anchors.field.${kind}`)}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        {kind === "folder" ? (
          <>
            <Input
              id={fieldId}
              autoFocus
              value={path}
              placeholder={t("work.anchors.pathPlaceholder")}
              onChange={(e) => setPath(e.target.value)}
              className="min-w-48 flex-1"
            />
            {pickFolder ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  void pickFolder({ title: t("work.anchors.pickTitle") }).then((p) => {
                    if (p) setPath(p);
                  });
                }}
              >
                {t("work.anchors.choose")}
              </Button>
            ) : null}
          </>
        ) : (
          <NativeSelect
            id={fieldId}
            size="sm"
            value={choice}
            onChange={(e) => setChoice(e.target.value)}
            className="min-w-48 flex-1"
          >
            <option value="">{t(`work.anchors.pick.${kind}`)}</option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </NativeSelect>
        )}
        <Button type="submit" size="sm" disabled={busy || !ready}>
          {t("work.anchors.link")}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onClose}>
          {t("people.fact.cancel")}
        </Button>
      </div>
      <p className="text-callout text-label-secondary">
        {kind === "folder"
          ? t("work.anchors.folderHint", { persona: persona.name })
          : t("work.anchors.routeHint")}
      </p>
    </form>
  );
}

export interface AnchorsProps {
  anchors: readonly GraphAnchor[];
  busy?: boolean;
  onAdd?: (anchor: NewAnchor) => void;
  onRemove?: (anchor: GraphAnchor) => void;
}

/**
 * Linked (§2.5, §6.3): what signals belong to this item, with Remove and Add link. Only linked
 * folders count as work (W5): a folder nobody linked is never read for progress. A suggestion a
 * model made says so and routes nothing until the owner links it.
 */
export function Anchors({ anchors, busy = false, onAdd, onRemove }: AnchorsProps): ReactElement {
  const [adding, setAdding] = useState(false);
  return (
    <>
      {anchors.length === 0 ? (
        <p className="px-3 py-2 text-body text-label-secondary">{t("work.anchors.empty")}</p>
      ) : (
        anchors.map((a) => (
          <AnchorRow key={a.id} anchor={a} busy={busy} {...(onRemove ? { onRemove } : {})} />
        ))
      )}
      {onAdd ? (
        adding ? (
          <div className="relative before:absolute before:inset-x-3 before:top-0 before:h-px before:bg-separator">
            <AddAnchor
              busy={busy}
              onAdd={(a) => {
                onAdd(a);
                setAdding(false);
              }}
              onClose={() => setAdding(false)}
            />
          </div>
        ) : (
          <div className="relative flex min-h-9 items-center px-3 py-1.5 before:absolute before:inset-x-3 before:top-0 before:h-px before:bg-separator first:before:hidden">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="-ms-2.5 text-accent-11"
              onClick={() => setAdding(true)}
            >
              <Plus aria-hidden="true" />
              {t("work.anchors.add")}
            </Button>
          </div>
        )
      ) : null}
    </>
  );
}

/** The anchors of one item from `memory.anchors.*`; the owner links and unlinks. */
export function ConnectedAnchors({ entityId }: { entityId: string }): ReactElement {
  const call = useCall();
  const list = useGatewayQuery("memory.anchors.list", { entityId });
  const [busy, setBusy] = useState(false);
  const write = (work: () => Promise<unknown>) => {
    setBusy(true);
    work()
      .then(() => list.reload())
      .catch((err: unknown) => {
        toast.error(t("people.writeFailed", { reason: describeError(err) }));
      })
      .finally(() => setBusy(false));
  };
  return (
    <Anchors
      anchors={list.data?.anchors ?? []}
      busy={busy}
      onAdd={(a) =>
        write(() =>
          call("memory.anchors.add", { entityId, kind: a.kind, ref: a.ref, label: a.label }),
        )
      }
      onRemove={(a) => write(() => call("memory.anchors.remove", { id: a.id }))}
    />
  );
}
