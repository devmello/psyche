import type { ReactElement } from "react";
import { Badge } from "../components/ui/badge.tsx";
import { t } from "../i18n/core.ts";
import { type ItemPreview, isTruncated } from "./model.ts";

/**
 * A prepared change as the server described it: rows of label and value, or label and
 * before to after. Every value is a React text node, so a draft that contains markup shows the
 * markup as words; nothing here is ever set as HTML. A recipient the owner has never written to
 * carries a "New recipient" badge on its own line.
 */
export function Preview({ preview }: { preview: ItemPreview }): ReactElement {
  return (
    <div className="flex flex-col gap-2" data-testid="night-shift-preview">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-callout">
        {preview.rows.map((row, i) => (
          // The rows are a fixed server list for this item; position is its identity.
          // biome-ignore lint/suspicious/noArrayIndexKey: rows have no id
          <div key={i} className="contents">
            <dt className="text-label-secondary">{row.label}</dt>
            <dd className="min-w-0 break-words whitespace-pre-wrap text-label-primary">
              {row.value}
              {row.newRecipient ? (
                <Badge variant="approval" className="ms-2 align-middle">
                  {t("nightShift.badge.newRecipient")}
                </Badge>
              ) : null}
            </dd>
          </div>
        ))}
      </dl>
      {isTruncated(preview) ? (
        <p className="text-callout text-label-secondary">{t("nightShift.row.cut")}</p>
      ) : null}
    </div>
  );
}
