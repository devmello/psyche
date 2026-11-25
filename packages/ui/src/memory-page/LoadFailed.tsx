import type { ReactElement } from "react";
import { Button } from "../components/ui/button.tsx";
import { t } from "../i18n/core.ts";

/** A failed read: says so and offers a retry, instead of looking like an empty list. */
export function LoadFailed({ onRetry }: { onRetry: () => void }): ReactElement {
  return (
    <div className="flex flex-wrap items-center gap-3 px-3 py-2">
      <p role="alert" className="text-body text-danger-text">
        {t("memory.page.loadFailed")}
      </p>
      <Button type="button" size="sm" variant="outline" onClick={onRetry}>
        {t("common.retry")}
      </Button>
    </div>
  );
}
