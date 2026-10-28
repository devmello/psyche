import { type ReactElement, useState } from "react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../components/ui/alert-dialog.tsx";
import { Button } from "../components/ui/button.tsx";
import { t } from "../i18n/core.ts";

/**
 * Lifting a floor (security §3.12): sends, destructive and financial actions ask by default, and
 * the owner lets one through without asking only after this confirm, from Settings → Connectors'
 * action matrix or a card's Always allow. Taint and Manual mode still ask.
 */

export type FloorClass = "send" | "destructive" | "financial";

/** Mirrors the broker's `DEVICE_ONLY_KINDS` and `AUTH_KINDS`: their floors never lift. */
const UNLIFTABLE_KINDS: readonly string[] = [
  "credential_fill",
  "exec_host",
  "purchase",
  "pairing",
  "policy_change",
  "skill_install",
  "apple_script",
  "folder_access",
  "permission_request",
];
const SEND_KINDS: readonly string[] = ["send_email", "message_send"];

/** The broker's `floorClass`: which liftable floor an action falls under, or null. */
export function floorClassOf(
  kind: string | undefined,
  sideEffect: string | undefined,
): FloorClass | null {
  if (kind !== undefined && UNLIFTABLE_KINDS.includes(kind)) return null;
  if (kind !== undefined && SEND_KINDS.includes(kind)) return "send";
  if (sideEffect === "financial") return "financial";
  if (sideEffect === "destructive") return "destructive";
  return null;
}

/** Device-only and authentication kinds: no override, whatever the side effect. */
export function unliftable(kind: string | undefined): boolean {
  return kind !== undefined && UNLIFTABLE_KINDS.includes(kind);
}

export interface LiftFloorDialogProps {
  open: boolean;
  floor: FloorClass;
  persona: string;
  /** What will run without asking, in plain words ("delete notes in Notes"). */
  what: string;
  /** `matrix`: Settings' Allow; `card`: a card's Always allow. */
  source: "matrix" | "card";
  onConfirm: () => void;
  onCancel: () => void;
}

export function LiftFloorDialog({
  open,
  floor,
  persona,
  what,
  source,
  onConfirm,
  onCancel,
}: LiftFloorDialogProps): ReactElement {
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <AlertDialogContent data-testid="lift-floor-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{t("blocks.liftFloor.title")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("blocks.liftFloor.what", { persona, what })}{" "}
            {t(`blocks.liftFloor.consequence.${floor}`)}
          </AlertDialogDescription>
          <AlertDialogDescription>
            {t("blocks.liftFloor.still", { persona })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
          <Button type="button" variant="destructive" onClick={onConfirm}>
            {source === "card" ? t("blocks.approval.scope.always") : t("blocks.liftFloor.confirm")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

interface PendingLift {
  floor: FloorClass;
  what: string;
  onConfirm: () => void;
}

/**
 * The confirm step as a hook: `ask(floor, what, onConfirm)` opens the dialog and runs `onConfirm`
 * only when the owner confirms; `dialog` is rendered once by the caller.
 */
export function useLiftFloorConfirm(
  persona: string,
  source: "matrix" | "card",
): { ask: (floor: FloorClass, what: string, onConfirm: () => void) => void; dialog: ReactElement } {
  const [pending, setPending] = useState<PendingLift | null>(null);
  const dialog = (
    <LiftFloorDialog
      open={pending !== null}
      floor={pending?.floor ?? "destructive"}
      persona={persona}
      what={pending?.what ?? ""}
      source={source}
      onCancel={() => setPending(null)}
      onConfirm={() => {
        pending?.onConfirm();
        setPending(null);
      }}
    />
  );
  return { ask: (floor, what, onConfirm) => setPending({ floor, what, onConfirm }), dialog };
}
