import { CloudOff } from "lucide-react";
import type { ReactElement } from "react";
import type { ConnectionState } from "../data/client.ts";
import { t } from "../i18n/core.ts";

/** Offline state (UI design §3.0): composer disabled; tasks keep running on the Gateway. */
export function OfflineBanner({ state }: { state: ConnectionState }): ReactElement {
  return (
    <div
      role="status"
      className="flex items-center gap-2 border-b border-gray-6 bg-gray-3 px-4 py-2 text-sm text-foreground"
    >
      <CloudOff className="size-4 text-gray-11" aria-hidden="true" />
      {state === "connecting" ? t("chat.offline.connecting") : t("chat.offline.unreachable")}
    </div>
  );
}
