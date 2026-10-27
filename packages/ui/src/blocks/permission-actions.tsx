import type { MissingPermission } from "@psyche/protocol";
import { type ReactElement, type ReactNode, useCallback, useMemo, useRef, useState } from "react";
import { useCall } from "../data/index.ts";
import { SandboxSetupDialog } from "../screens/settings/SandboxNotice.tsx";
import { UiSlotsProvider, useSlots } from "../slots.tsx";

/**
 * The fix-it buttons of `permission_request` cards (security §3.13), built on the Gateway calls
 * Settings already uses: Connectors opens in Settings, the sandbox setup is its walkthrough
 * dialog (`SandboxSetupDialog`, #966), and macOS access goes through the connector's own grant
 * flow (`connectors.connect` with `permissionAction`), where the Mac helper opens the right
 * System Settings pane and re-checks. A host's own `permissionAction` slot wins.
 */
export function usePermissionAction(
  openSandboxSetup?: () => Promise<boolean>,
): (need: MissingPermission, action: "open" | "check") => Promise<boolean | undefined> {
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
      if (need.need === "sandbox" && openSandboxSetup !== undefined) return openSandboxSetup();
      navigate?.("/settings/connectors");
    },
    [call, navigate, openSandboxSetup],
  );
}

/**
 * Supplies `permissionAction` to the approval cards inside, unless the host already does, and
 * hosts the sandbox setup dialog the exec_host and sandbox cards open.
 */
export function PermissionActionsProvider({ children }: { children?: ReactNode }): ReactElement {
  const host = useSlots().permissionAction;
  const [sandboxOpen, setSandboxOpen] = useState(false);
  // Settles when the dialog closes: true when srt became ready in it.
  const settle = useRef<((ready: boolean) => void) | undefined>(undefined);
  const openSandboxSetup = useCallback(
    () =>
      new Promise<boolean>((resolve) => {
        settle.current?.(false);
        settle.current = resolve;
        setSandboxOpen(true);
      }),
    [],
  );
  const close = (ready: boolean) => {
    settle.current?.(ready);
    settle.current = undefined;
  };
  const built = usePermissionAction(openSandboxSetup);
  const value = useMemo(() => ({ permissionAction: host ?? built }), [host, built]);
  return (
    <UiSlotsProvider value={value}>
      {children}
      {host === undefined ? (
        <SandboxSetupDialog
          open={sandboxOpen}
          onOpenChange={(open) => {
            setSandboxOpen(open);
            if (!open) close(false);
          }}
          onReady={() => close(true)}
        />
      ) : null}
    </UiSlotsProvider>
  );
}
