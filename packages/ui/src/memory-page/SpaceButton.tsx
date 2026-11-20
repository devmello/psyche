import { Layers } from "lucide-react";
import { type ReactElement, useState } from "react";
import { toast } from "sonner";
import { Button } from "../components/ui/button.tsx";
import { useCall } from "../data/index.ts";
import { t } from "../i18n/core.ts";
import { describeError } from "../i18n/errors.ts";
import { spaceHref, useSpaces } from "../spaces/use-spaces.ts";

/**
 * "Open Space" or "Make a Space" on a project's page (docs/design/spaces-2026.md §3, SP1). One
 * tap links a new Space to the project; a project that already has one opens it. A Keep-private
 * project gets no button: a Space would show on Home and in the Spaces list.
 */
export function SpaceButton({
  entity,
  onNavigate,
}: {
  entity: { id: string; name: string; kind: string; private?: boolean | undefined };
  onNavigate: (to: string) => void;
}): ReactElement | null {
  const call = useCall();
  const { spaces, loading } = useSpaces();
  const [busy, setBusy] = useState(false);
  if (entity.kind !== "project" || entity.private === true) return null;
  const linked = spaces.find((s) => s.entityId === entity.id);
  if (linked === undefined && loading) return null;
  const make = () => {
    setBusy(true);
    call("spaces.create", {
      name: entity.name.trim().slice(0, 60) || entity.id,
      entityId: entity.id,
    }).then(
      ({ space }) => onNavigate(spaceHref(space.id)),
      (err: unknown) => {
        setBusy(false);
        toast.error(t("spaces.make.failed", { reason: describeError(err) }));
      },
    );
  };
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={busy}
      onClick={linked === undefined ? make : () => onNavigate(spaceHref(linked.id))}
    >
      <Layers aria-hidden="true" />
      {linked === undefined ? t("spaces.make") : t("spaces.openLinked")}
    </Button>
  );
}
