import type { PermissionMode } from "@psyche/protocol";
import { Ellipsis, PanelLeft } from "lucide-react";
import type { ReactElement } from "react";
import { MODE_LABEL } from "../agent/AgentHeader.tsx";
import { Avatar } from "../avatar/Avatar.tsx";
import { Button } from "../components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.tsx";
import { t } from "../i18n/core.ts";
import { usePersona } from "../slots.tsx";

export interface CompactTopBarProps {
  /** Opens the threads drawer. */
  onOpenThreads: () => void;
  /** The thread's permission mode, when a chat is open. */
  mode?: PermissionMode;
  onModeChange?: (mode: PermissionMode) => void;
  /** The thread's model reference, when a chat is open. */
  model?: string | null;
  onOpenModelPicker?: () => void;
  onOpenSearch?: () => void;
  /** The current screen's title when it isn't the chat (Feed, Goals…). */
  title?: string;
}

/**
 * The compact top bar (redesign §5.11, under 720 px): 44 px with the threads-drawer button, the
 * persona's 28 px avatar and name (truncated before anything wraps), and ⋯ holding search and the
 * mode and model pickers, which have no room as pills.
 */
export function CompactTopBar({
  onOpenThreads,
  mode,
  onModeChange,
  model,
  onOpenModelPicker,
  onOpenSearch,
  title,
}: CompactTopBarProps): ReactElement {
  const persona = usePersona();
  return (
    <header
      className="flex h-11 shrink-0 items-center gap-2 bg-canvas px-2"
      data-testid="compact-top-bar"
    >
      <Button
        variant="ghost"
        size="icon"
        className="size-11 text-label-secondary"
        aria-label={t("shell.compact.threads")}
        onClick={onOpenThreads}
      >
        <PanelLeft aria-hidden="true" strokeWidth={1.75} />
      </Button>
      <Avatar
        name={persona.name}
        creature={persona.creature}
        {...(persona.imageSrc ? { imageSrc: persona.imageSrc } : {})}
        size={28}
        decorative
      />
      <span className="min-w-0 flex-1 truncate text-headline text-label-primary">
        {title ?? persona.name}
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              className="size-11 text-label-secondary"
              aria-label={t("shell.compact.more")}
            />
          }
        >
          <Ellipsis aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          {onOpenSearch ? (
            <DropdownMenuItem onClick={onOpenSearch}>{t("shell.rail.search")}</DropdownMenuItem>
          ) : null}
          {mode && onModeChange ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuLabel>{t("shell.compact.mode")}</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={mode}
                  onValueChange={(v) => onModeChange(v as PermissionMode)}
                >
                  {(Object.keys(MODE_LABEL) as PermissionMode[]).map((m) => (
                    <DropdownMenuRadioItem key={m} value={m}>
                      {MODE_LABEL[m]}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>
            </>
          ) : null}
          {onOpenModelPicker ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={onOpenModelPicker}>
                {model ? t("shell.compact.modelCurrent", { model }) : t("shell.compact.model")}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}
