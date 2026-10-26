import { createContext, type ReactElement, type ReactNode, useContext, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "../components/ui/dialog.tsx";
import { t } from "../i18n/core.ts";
import { classifyLink, type OpenableLink, resolveLinkAction } from "./link-policy.ts";
import { LinkMenuBody, useLinkOpener } from "./SafeLink.tsx";

const PromptContext = createContext<((url: string, modifier?: boolean) => void) | null>(null);

/**
 * For links opened from code rather than an anchor (cards, people, HTML artifacts): the same
 * policy as `SafeLink`. A refused scheme does nothing; with "Ask each time" a small menu shows.
 * Without a provider, an allowlisted link goes to the default browser.
 */
export function LinkPromptProvider({ children }: { children?: ReactNode }): ReactElement {
  const { mode, open, copy } = useLinkOpener();
  const [pending, setPending] = useState<OpenableLink | null>(null);
  const request = (url: string, modifier = false) => {
    const link = classifyLink(url);
    const action = resolveLinkAction(link, mode, modifier);
    if (!link || action === "blocked") return;
    if (action === "menu") setPending(link);
    else open(link.url, action);
  };
  return (
    <PromptContext.Provider value={request}>
      {children}
      <Dialog open={pending !== null} onOpenChange={(o) => !o && setPending(null)}>
        <DialogContent showCloseButton={false} className="max-w-xs gap-2" role="menu">
          <DialogTitle className="sr-only">{t("links.menu.label")}</DialogTitle>
          {pending ? (
            <LinkMenuBody
              link={pending}
              onOpen={(where) => {
                open(pending.url, where);
                setPending(null);
              }}
              onCopy={() => {
                void copy(pending.url);
                setPending(null);
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </PromptContext.Provider>
  );
}

/** Opens a link by the owner's "Open links in" choice; see `LinkPromptProvider`. */
export function useOpenLink(): (url: string, modifier?: boolean) => void {
  const request = useContext(PromptContext);
  const { open } = useLinkOpener();
  return (
    request ??
    ((url) => {
      const link = classifyLink(url);
      if (link) open(link.url, "browser");
    })
  );
}
