import { type ReactElement, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog.tsx";
import { t } from "../../i18n/core.ts";
import { SandboxSetup } from "./SandboxSetup.tsx";

/**
 * The guided sandbox setup in a dialog, over whatever opened it (a connector form, an approval
 * card's "Set up sandbox"). Once srt is ready, `onReady` runs and the dialog closes.
 */
export function SandboxSetupDialog({
  open,
  onOpenChange,
  onReady,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReady?: (() => void) | undefined;
}): ReactElement {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("settings.sandbox.title")}</DialogTitle>
          <DialogDescription className="sr-only">{t("settings.sandbox.why")}</DialogDescription>
        </DialogHeader>
        <SandboxSetup
          onReady={() => {
            onReady?.();
            onOpenChange(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

/**
 * "This Gateway has no sandbox for commands" with the way out: a "Set up sandbox" button that
 * opens the walkthrough over the form, so nothing typed there is lost. Once the sandbox is
 * ready, `onReady` lets the form reload what the Gateway allows and the dialog closes.
 */
export function SandboxNotice({
  message,
  onReady,
}: {
  message: string;
  onReady: () => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <>
      <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <span>{message}</span>
        <Button type="button" size="sm" variant="secondary" onClick={() => setOpen(true)}>
          {t("settings.sandbox.setUp")}
        </Button>
      </p>
      <SandboxSetupDialog open={open} onOpenChange={setOpen} onReady={onReady} />
    </>
  );
}
