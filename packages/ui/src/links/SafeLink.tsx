import type { MouseEvent, ReactElement, ReactNode } from "react";
import { useCallback, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover.tsx";
import { useSettings } from "../data/hooks.ts";
import { t } from "../i18n/core.ts";
import { copyText } from "../lib/clipboard.ts";
import { useSlots } from "../slots.tsx";
import {
  classifyLink,
  LINK_OPEN_SETTING,
  type LinkAction,
  linkOpenMode,
  type OpenableLink,
  resolveLinkAction,
} from "./link-policy.ts";

/** Opens a link the way the owner chose; never navigates the app window itself. */
export function useLinkOpener(): {
  mode: ReturnType<typeof linkOpenMode>;
  open: (url: string, where: "browser" | "psyche") => void;
  copy: (url: string) => Promise<boolean>;
} {
  const { openExternal, openInPsyche, writeClipboard } = useSlots();
  const { settings } = useSettings();
  const open = useCallback(
    (url: string, where: "browser" | "psyche") => {
      const viaBrowser = () => {
        if (openExternal) void openExternal(url).catch(() => {});
        else globalThis.open?.(url, "_blank", "noopener,noreferrer");
      };
      if (where === "psyche" && openInPsyche)
        void Promise.resolve(openInPsyche(url)).catch(() => {});
      else viaBrowser();
    },
    [openExternal, openInPsyche],
  );
  const copy = useCallback((url: string) => copyText(url, writeClipboard), [writeClipboard]);
  return { mode: linkOpenMode(settings[LINK_OPEN_SETTING]), open, copy };
}

/**
 * An anchor whose click goes through the link policy: allowlisted schemes only, the owner's
 * "Open links in" choice (or a small menu when it is Ask), ⌘-click to the default browser.
 * The menu shows the real host so a lookalike link cannot hide where it goes.
 */
export function SafeLink({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children?: ReactNode;
}): ReactElement {
  const { navigate } = useSlots();
  const { mode, open, copy } = useLinkOpener();
  const [menu, setMenu] = useState(false);
  const link = classifyLink(href);
  const internal = href.startsWith("#") ? "hash" : href.startsWith("/") ? "route" : null;

  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (internal === "hash") return;
    e.preventDefault();
    if (internal === "route") {
      navigate?.(href);
      return;
    }
    const action: LinkAction = resolveLinkAction(link, mode, e.metaKey || e.ctrlKey);
    if (action === "menu") setMenu(true);
    else if (link && (action === "browser" || action === "psyche")) open(link.url, action);
  };

  const anchor = (
    <a
      href={href}
      // biome-ignore lint/a11y/noRedundantRoles: the popover trigger would otherwise make it role=button
      role="link"
      target="_blank"
      rel="noreferrer noopener"
      className={className}
      onClick={onClick}
    >
      {children}
    </a>
  );
  if (!link) return anchor;
  return (
    <Popover open={menu} onOpenChange={(o) => !o && setMenu(false)}>
      <PopoverTrigger render={anchor} nativeButton={false} />
      <PopoverContent align="start" className="w-64" role="menu" aria-label={t("links.menu.label")}>
        <LinkMenuBody
          link={link}
          onOpen={(where) => {
            setMenu(false);
            open(link.url, where);
          }}
          onCopy={() => {
            setMenu(false);
            void copy(link.url);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

/** The three choices and the real host, shared by the anchor popover and the prompt dialog. */
export function LinkMenuBody({
  link,
  onOpen,
  onCopy,
}: {
  link: OpenableLink;
  onOpen: (where: "browser" | "psyche") => void;
  onCopy: () => void;
}): ReactElement {
  return (
    <>
      <div className="px-1.5 pt-0.5 text-xs">
        <div className="text-muted-foreground">{t("links.menu.goesTo")}</div>
        <div className="break-all font-medium" data-testid="link-host">
          {link.host}
        </div>
        {link.punycode ? (
          <div className="text-muted-foreground">{t("links.menu.punycode")}</div>
        ) : null}
      </div>
      {link.scheme !== "mailto:" ? (
        <MenuItem onClick={() => onOpen("psyche")}>{t("links.menu.openInPsyche")}</MenuItem>
      ) : null}
      <MenuItem onClick={() => onOpen("browser")}>{t("links.menu.openInBrowser")}</MenuItem>
      <MenuItem onClick={onCopy}>{t("links.menu.copy")}</MenuItem>
    </>
  );
}

function MenuItem({
  onClick,
  children,
}: {
  onClick: () => void;
  children: ReactNode;
}): ReactElement {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="rounded-md px-1.5 py-1 text-start hover:bg-accent-3 focus-visible:bg-accent-3 focus-visible:outline-none"
    >
      {children}
    </button>
  );
}
