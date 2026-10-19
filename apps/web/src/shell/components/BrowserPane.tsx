import type { ApprovalRequest } from "@psyche/protocol";
import { type ReactElement, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useShell, useShellState } from "../context.tsx";
import type { BrowserHostState, BrowserPort, BrowserTabView } from "../platform.ts";

/**
 * Browser pane chrome (docs/06 §3.5; features I1, I5, I6, I11). The live page is a native
 * `WebContentsView` that main lays over `.browser-viewport`; this component reports that
 * rectangle and renders everything around it. While an overlay covers the window, `covered`
 * hides the native view so it cannot sit above the dialog.
 */

function useBrowserState(port: BrowserPort): BrowserHostState {
  const [state, setState] = useState<BrowserHostState>({
    tabs: [],
    activeTabId: null,
    bridgeConnected: false,
  });
  useEffect(() => {
    let live = true;
    void port.getState().then((s) => live && setState(s));
    const off = port.onState(setState);
    return () => {
      live = false;
      off();
    };
  }, [port]);
  return state;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Site-permission prompt for `new_origin` approvals (Allow once / Always allow / Deny). */
function SitePrompt({ approval }: { approval: ApprovalRequest }): ReactElement {
  const { store } = useShell();
  const origin = String(
    (approval.details as { origin?: unknown }).origin ?? approval.target ?? "this site",
  );
  const answer = (decision: "approve" | "deny", scope?: string) =>
    void store
      .answerApproval(approval.id, decision, scope)
      .catch(() => store.toast("Psyche couldn't send that answer.", "error"));
  return (
    <fieldset
      className="dock"
      aria-label={`Let Psyche act on ${origin}?`}
      data-testid="site-prompt"
    >
      <strong>Let Psyche act on {origin}?</strong>
      <div className="row">
        <button type="button" onClick={() => answer("deny")}>
          Deny
        </button>
        <button type="button" onClick={() => answer("approve", "once")}>
          Allow once
        </button>
        {approval.scopesOffered.includes("site") || approval.scopesOffered.includes("always") ? (
          <button
            type="button"
            onClick={() =>
              answer("approve", approval.scopesOffered.includes("site") ? "site" : "always")
            }
          >
            Always allow
          </button>
        ) : null}
      </div>
    </fieldset>
  );
}

/** Credential fill (docs/06 §3.5): "I'll type it myself" is the default and takes control. */
function CredentialPrompt(props: {
  approval: ApprovalRequest;
  onTypeMyself: () => void;
}): ReactElement {
  const { store } = useShell();
  const d = props.approval.details as {
    item?: unknown;
    boundOrigin?: unknown;
    currentOrigin?: unknown;
  };
  const answer = (decision: "approve" | "deny", scope?: string) =>
    void store
      .answerApproval(props.approval.id, decision, scope)
      .catch(() => store.toast("Psyche couldn't send that answer.", "error"));
  return (
    <fieldset className="dock" aria-label="Login needed" data-testid="credential-prompt">
      <strong>{props.approval.summary}</strong>
      <div style={{ fontSize: 13 }}>
        Item {String(d.item ?? "—")} · bound to {String(d.boundOrigin ?? "—")} · this page{" "}
        {String(d.currentOrigin ?? "—")}
      </div>
      <div className="row">
        <button type="button" onClick={() => answer("deny")}>
          Deny
        </button>
        <button type="button" onClick={() => answer("approve", "once")}>
          Fill from vault once
        </button>
        {props.approval.scopesOffered.includes("site") ? (
          <button type="button" onClick={() => answer("approve", "site")}>
            Fill from vault for this site
          </button>
        ) : null}
        {/* biome-ignore lint/a11y/noAutofocus: the default choice */}
        <button type="button" autoFocus onClick={props.onTypeMyself}>
          I'll type it myself
        </button>
      </div>
    </fieldset>
  );
}

export function BrowserPane(props: { covered: boolean; onClose: () => void }): ReactElement {
  const { platform, store } = useShell();
  const port = platform.browser;
  if (!port)
    return (
      <p style={{ padding: 16, color: "var(--shell-muted)" }}>
        The browser pane shows the agent's browser in the desktop app, or the server's browser
        sidecar.
      </p>
    );
  return (
    <DesktopBrowserPane port={port} covered={props.covered} onClose={props.onClose} store={store} />
  );
}

function DesktopBrowserPane(props: {
  port: BrowserPort;
  covered: boolean;
  onClose: () => void;
  store: ReturnType<typeof useShell>["store"];
}): ReactElement {
  const { port, store } = props;
  const state = useBrowserState(port);
  const viewport = useRef<HTMLDivElement>(null);
  const [findText, setFindText] = useState<string | null>(null);
  const approvals = useShellState((s) => s.approvals);
  const tab: BrowserTabView | undefined = state.tabs.find((t) => t.tabId === state.activeTabId);

  useLayoutEffect(() => {
    const el = viewport.current;
    if (!el || props.covered || !tab) {
      port.setViewport(null);
      return;
    }
    const report = () => {
      const r = el.getBoundingClientRect();
      port.setViewport({ x: r.left, y: r.top, width: r.width, height: r.height });
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    window.addEventListener("resize", report);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", report);
      port.setViewport(null);
    };
  }, [port, props.covered, tab]);

  useEffect(
    () =>
      port.onDownload((d) => {
        if (d.state === "completed")
          store.toast(
            `Downloaded ${d.filename} to Library → Downloads (quarantined)`,
            "info",
            8_000,
          );
        if (d.state === "failed") store.toast(`The download of ${d.filename} failed.`, "warn");
      }),
    [port, store],
  );

  const close = () => {
    const title = tab?.taskTitle;
    store.toast(
      title ? `Browser closed. “${title}” keeps running` : "Browser closed. Tasks keep running",
      "info",
    );
    props.onClose();
  };
  const takeOver = () => tab && void port.setControl(tab.tabId, true);
  const sitePrompt = approvals.find((a) => a.kind === "new_origin");
  const credPrompt = approvals.find((a) => a.kind === "credential_fill");
  const userHasControl = tab?.controller === "user";

  return (
    <div
      style={{ display: "flex", flexDirection: "column", height: "100%" }}
      data-testid="browser-pane"
    >
      <div
        role="tablist"
        aria-label="Browser tabs"
        style={{ display: "flex", gap: 2, padding: 4, overflowX: "auto" }}
      >
        {state.tabs.map((t) => (
          <span key={t.tabId} className="pill" style={{ display: "inline-flex", gap: 2 }}>
            <button
              type="button"
              role="tab"
              aria-selected={t.tabId === state.activeTabId}
              onClick={() => void port.activateTab(t.tabId)}
              data-testid="browser-tab"
              data-tab-id={t.tabId}
              style={{ border: 0, background: "transparent" }}
            >
              {t.title || hostOf(t.url)}
            </button>
            <button
              type="button"
              aria-label={`Close ${t.title || hostOf(t.url)}`}
              onClick={() => void port.closeTab(t.tabId)}
              data-testid="browser-tab-close"
              style={{ border: 0, background: "transparent" }}
            >
              ×
            </button>
          </span>
        ))}
        <button
          type="button"
          className="pill"
          aria-label="New tab"
          onClick={() => {
            const url = window.prompt("Open URL", "https://");
            if (url)
              void port
                .openTab(url)
                .catch(() => store.toast("Only http and https addresses open here.", "warn"));
          }}
        >
          +
        </button>
        <span style={{ flex: 1 }} />
        <button type="button" className="pill" onClick={close} aria-label="Close browser pane">
          ×
        </button>
      </div>
      {tab ? (
        <>
          <div
            style={{
              display: "flex",
              gap: 4,
              padding: "0 4px",
              alignItems: "center",
              fontSize: 13,
            }}
          >
            <button
              type="button"
              disabled={!tab.canGoBack}
              onClick={() => void port.navigate(tab.tabId, "back")}
              aria-label="Back"
            >
              ‹
            </button>
            <button
              type="button"
              disabled={!tab.canGoForward}
              onClick={() => void port.navigate(tab.tabId, "forward")}
              aria-label="Forward"
            >
              ›
            </button>
            <button
              type="button"
              onClick={() => void port.navigate(tab.tabId, tab.loading ? "stop" : "reload")}
              aria-label={tab.loading ? "Stop loading" : "Reload"}
            >
              {tab.loading ? "■" : "↻"}
            </button>
            <output
              aria-label="Address"
              style={{
                flex: 1,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              data-testid="browser-address"
            >
              {tab.url}
            </output>
            <span className="chip" title="Browser profile" data-testid="browser-profile">
              {tab.profile === "clean" ? "logged-out profile" : "agent profile"}
            </span>
            <button
              type="button"
              onClick={() => void port.navigate(tab.tabId, "zoomOut")}
              aria-label="Zoom out"
            >
              −
            </button>
            <button
              type="button"
              onClick={() => void port.navigate(tab.tabId, "zoomReset")}
              aria-label="Reset zoom"
            >
              {Math.round(tab.zoomFactor * 100)}%
            </button>
            <button
              type="button"
              onClick={() => void port.navigate(tab.tabId, "zoomIn")}
              aria-label="Zoom in"
            >
              +
            </button>
            <button
              type="button"
              onClick={() => setFindText((f) => (f === null ? "" : null))}
              aria-label="Find in page"
            >
              Find
            </button>
          </div>
          {findText !== null ? (
            <input
              // biome-ignore lint/a11y/noAutofocus: opened on demand
              autoFocus
              value={findText}
              aria-label="Find in page"
              onChange={(e) => {
                setFindText(e.target.value);
                if (e.target.value) void port.find(tab.tabId, e.target.value);
                else void port.stopFind(tab.tabId);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && findText)
                  void port.find(tab.tabId, findText, { forward: !e.shiftKey });
                if (e.key === "Escape") {
                  setFindText(null);
                  void port.stopFind(tab.tabId);
                }
              }}
              style={{ margin: "0 4px" }}
            />
          ) : null}
          <span className="status-pill" aria-live="polite" data-testid="browser-status">
            {userHasControl
              ? "Paused: you have control"
              : (tab.status ?? (state.bridgeConnected ? "Idle" : "Agent browser not connected"))}
          </span>
        </>
      ) : null}
      {sitePrompt ? <SitePrompt approval={sitePrompt} /> : null}
      {credPrompt ? <CredentialPrompt approval={credPrompt} onTypeMyself={takeOver} /> : null}
      <div style={{ flex: 1, position: "relative", minHeight: 120 }}>
        <div
          ref={viewport}
          className="browser-viewport"
          data-control={tab?.controller ?? "agent"}
          data-testid="browser-viewport"
        >
          {tab ? null : (
            <p style={{ padding: 16, color: "var(--shell-muted)" }}>
              No tabs. The agent opens tabs here as it works.
            </p>
          )}
        </div>
      </div>
      {tab ? (
        <div style={{ display: "flex", gap: 8, padding: 4, alignItems: "center" }}>
          <button
            type="button"
            className="pill"
            aria-pressed={userHasControl}
            onClick={() => void port.setControl(tab.tabId, !userHasControl)}
            data-testid="take-control"
          >
            {userHasControl ? "Return control" : "Take control"}
          </button>
          {tab.taskId ? (
            <button
              type="button"
              className="pill"
              onClick={() =>
                void store
                  .call("tasks.cancel", { taskId: tab.taskId })
                  .catch(() => store.toast("Psyche couldn't stop the task.", "error"))
              }
              data-testid="stop-task"
            >
              Stop the task
            </button>
          ) : null}
          <span style={{ flex: 1 }} />
          <button type="button" className="pill" onClick={() => void port.popOut(tab.tabId)}>
            Open in window
          </button>
          <button type="button" className="pill" onClick={() => void port.popOut(tab.tabId, true)}>
            Full
          </button>
          <button
            type="button"
            className="pill"
            onClick={() => {
              if (
                window.confirm(
                  `Clear cookies and site data for the ${tab.profile === "clean" ? "logged-out" : "agent"} profile?`,
                )
              )
                void port
                  .clearBrowsingData(tab.profile)
                  .then(() => store.toast("Browsing data cleared."));
            }}
          >
            Clear browsing data
          </button>
        </div>
      ) : null}
    </div>
  );
}
