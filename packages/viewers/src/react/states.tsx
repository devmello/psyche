import type { ReactNode } from "react";

/** Shared empty / loading / error states (docs/06 §3.0, §4.13). Styled by `psy-viewer-*` classes. */
export function ViewerMessage(props: {
  kind: "loading" | "error" | "empty" | "unsupported";
  title: string;
  detail?: string;
  action?: ReactNode;
}) {
  return (
    <div
      className={`psy-viewer-state psy-viewer-state--${props.kind}`}
      role={props.kind === "error" ? "alert" : "status"}
    >
      <p className="psy-viewer-state__title">{props.title}</p>
      {props.detail === undefined ? null : (
        <p className="psy-viewer-state__detail">{props.detail}</p>
      )}
      {props.action ?? null}
    </div>
  );
}

export function Toolbar(props: { label: string; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a button row, not a form group
    <div className="psy-viewer-toolbar" role="group" aria-label={props.label}>
      {props.children}
    </div>
  );
}
