import { ChevronDown } from "lucide-react";
import type { ReactElement } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.tsx";
import { t } from "../i18n/core.ts";
import { useSavedGateways } from "../screens/settings/GatewaysGroup.tsx";
import { useSlots } from "../slots.tsx";

/**
 * Where this window is connected (remote-gateway design §1.3): the Host's name beside the avatar
 * when the app is a client of another computer, with a menu to switch. On a Mac that has saved
 * Gateways it names This Mac; with none saved there is nothing to say and nothing is drawn, so
 * the toolbar stays as it was. Switching and adding happen in Settings → Server & remote access,
 * where the confirmation lives.
 */
export function GatewayChip(): ReactElement | null {
  const { remoteHost, gateways, openSettings } = useSlots();
  const { entries } = useSavedGateways();
  if (!gateways) return null;
  const hasRemote = entries?.some((e) => e.remote) === true;
  if (remoteHost === undefined && !hasRemote) return null;
  const name = remoteHost ?? t("web.remote.thisMac");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="inline-flex h-6 shrink-0 cursor-default items-center gap-1 rounded-full border border-separator px-2 text-subheadline text-label-secondary outline-none hover:bg-fill-tertiary focus-visible:ring-2 focus-visible:ring-ring aria-expanded:bg-fill-secondary [&_svg]:size-3"
        aria-label={t("web.remote.switcherLabel", { host: name })}
        data-testid="gateway-chip"
      >
        <span className="max-w-[16ch] truncate">{name}</span>
        <ChevronDown aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>{t("web.remote.connectedTo", { host: name })}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => openSettings?.("server")}>
          {t("web.remote.switch")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
