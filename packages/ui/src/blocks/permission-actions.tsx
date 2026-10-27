import type { MissingPermission } from "@psyche/protocol";
import { type ReactElement, type ReactNode, useCallback, useMemo } from "react";
import { useCall } from "../data/index.ts";
import { UiSlotsProvider, useSlots } from "../slots.tsx";

/**
 * The fix-it buttons of `permission_request` cards (security §3.13), built on the Gateway calls
 * Settings → Connectors already uses: Connectors and the sandbox setup open in Settings, and
 * macOS access goes through the connector's own grant flow (`connectors.connect` with
 * `permissionAction`), where the Mac helper opens the right System Settings pane and re-checks.
 * A host's own `permissionAction` slot wins.
 */
export function usePermissionAction(): (
  need: MissingPermission,
  action: "open" | "check",
) => Promise<void> {
  const call = useCall();
  const { navigate } = useSlots();
  return useCallback(
    async (need, action) => {
      if (need.need === "macos_access") {
        const list = await call("connectors.list", {});
        const c = list.connectors.find((x) => x.id === need.connector);
        if (c === undefined) {
          navigate?.("/settings/connectors");
          return;
        }
        const catalogueId = await call("connectors.catalogue", {})
          .then((r) => r.entries.find((e) => e.type === c.type)?.id ?? c.type)
          .catch(() => c.type);
        await call("connectors.connect", {
          catalogueId,
          scopeMode: c.scopeMode,
          label: c.label,
          connectorId: c.id,
          config: { permissionAction: action === "open" ? "open_settings" : "check" },
        });
        return;
      }
      if (action === "check") return;
      // Connecting and the sandbox setup both live in Settings → Connectors (#966).
      navigate?.("/settings/connectors");
    },
    [call, navigate],
  );
}

/** Supplies `permissionAction` to the approval cards inside, unless the host already does. */
export function PermissionActionsProvider({ children }: { children?: ReactNode }): ReactElement {
  const host = useSlots().permissionAction;
  const built = usePermissionAction();
  const value = useMemo(() => ({ permissionAction: host ?? built }), [host, built]);
  return <UiSlotsProvider value={value}>{children}</UiSlotsProvider>;
}
