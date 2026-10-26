import type { ApprovalRequest } from "@psyche/protocol";
import { activeI18n, t } from "@psyche/ui";
import { type ReactElement, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useShell, useShellState } from "../context.tsx";
import type { BrowserHostState, BrowserPort, BrowserTabView } from "../platform.ts";
import { openNewTab } from "./browser-new-tab.ts";

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
    (approval.details as { origin?: unknown }).origin ??
      approval.target ??
      t("web.browser.thisSite"),
  );
  const answer = (decision: "approve" | "deny", scope?: string) =>
    void store
      .answerApproval(approval.id, decision, scope)
      .catch(() => store.toast(t("web.browser.answerFailed"), "error"));
  return (
    <fieldset
      className="dock"
      aria-label={t("web.browser.siteQuestion", { origin })}
      data-testid="site-prompt"
    >
      <strong>{t("web.browser.siteQuestion", { origin })}</strong>
      <div className="row">
        <button type="button" onClick={() => answer("deny")}>
          {t("web.approval.deny")}
        </button>
        <button type="button" onClick={() => answer("approve", "once")}>
          {t("web.approval.allowOnce")}
        </button>
        {approval.scopesOffered.includes("site") || approval.scopesOffered.includes("always") ? (
          <button
            type="button"
            onClick={() =>
              answer("approve", approval.scopesOffered.includes("site") ? "site" : "always")
            }
          >
            {t("web.approval.alwaysAllow")}
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
      .catch(() => store.toast(t("web.browser.answerFailed"), "error"));
  return (
    <fieldset
      className="dock"
      aria-label={t("web.browser.loginNeeded")}
      data-testid="credential-prompt"
    >
      <strong>{props.approval.summary}</strong>
      <div style={{ fontSize: 13 }}>
        {t("web.browser.credentialDetails", {
          item: String(d.item ?? "—"),
          bound: String(d.boundOrigin ?? "—"),
          current: String(d.currentOrigin ?? "—"),
        })}
      </div>
      <div className="row">
        <button type="button" onClick={() => answer("deny")}>
          {t("web.approval.deny")}
        </button>
        <button type="button" onClick={() => answer("approve", "once")}>
          {t("web.browser.fillOnce")}
        </button>
        {props.approval.scopesOffered.includes("site") ? (
          <button type="button" onClick={() => answer("approve", "site")}>
            {t("web.browser.fillForSite")}
          </button>
        ) : null}
        {/* biome-ignore lint/a11y/noAutofocus: the default choice */}
        <button type="button" autoFocus onClick={props.onTypeMyself}>
          {t("web.browser.typeMyself")}
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
      <p style={{ padding: 16, color: "var(--shell-muted)" }}>{t("web.browser.unavailable")}</p>
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
  // The new-tab address field; null while closed. Electron has no window.prompt().
  const [newTabText, setNewTabText] = useState<string | null>(null);
  const approvals = useShellState((s) => s.approvals);
  const tab: BrowserTabView | undefined = state.tabs.find((x) => x.tabId === state.activeTabId);

  useLayoutEffect(() => {
    const el = viewport.current;
    if (!el || props.covered || !tab) {
      port.setViewport(null);
      return;
    }
    const report = () => {
      const r = el.getBoundingClientRect();
      // Physical on purpose: the native view is placed in window pixels.
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
          store.toast(t("web.browser.downloaded", { file: d.filename }), "info", 8_000);
        if (d.state === "failed")
          store.toast(t("web.browser.downloadFailed", { file: d.filename }), "warn");
      }),
    [port, store],
  );

  const close = () => {
    const title = tab?.taskTitle;
    store.toast(
      title ? t("web.browser.closedTask", { title }) : t("web.browser.closedTasks"),
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
        aria-label={t("web.browser.tabs")}
        style={{ display: "flex", gap: 2, padding: 4, overflowX: "auto" }}
      >
        {state.tabs.map((x) => (
          <span key={x.tabId} className="pill" style={{ display: "inline-flex", gap: 2 }}>
            <button
              type="button"
              role="tab"
              aria-selected={x.tabId === state.activeTabId}
              onClick={() => void port.activateTab(x.tabId)}
              data-testid="browser-tab"
              data-tab-id={x.tabId}
              style={{ border: 0, background: "transparent" }}
            >
              {x.title || hostOf(x.url)}
            </button>
            <button
              type="button"
              aria-label={t("web.browser.closeTab", { title: x.title || hostOf(x.url) })}
              onClick={() => void port.closeTab(x.tabId)}
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
          aria-label={t("web.browser.newTab")}
          aria-expanded={newTabText !== null}
          data-testid="browser-new-tab"
          onClick={() => setNewTabText((x) => (x === null ? "" : null))}
        >
          +
        </button>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="pill"
          onClick={close}
          aria-label={t("web.browser.closePane")}
        >
          ×
        </button>
      </div>
      {newTabText !== null ? (
        <form
          style={{ display: "flex", gap: 4, padding: "0 4px 4px" }}
          data-testid="browser-new-tab-form"
          onSubmit={(e) => {
            e.preventDefault();
            void openNewTab(port, newTabText).then((r) => {
              if (r.ok) setNewTabText(null);
              else store.toast(t("web.browser.httpOnly"), "warn");
            });
          }}
        >
          <input
            // biome-ignore lint/a11y/noAutofocus: opened on demand
            autoFocus
            value={newTabText}
            aria-label={t("web.browser.openUrl")}
            placeholder={t("web.browser.openUrl")}
            onChange={(e) => setNewTabText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setNewTabText(null);
            }}
            style={{ flex: 1 }}
          />
        </form>
      ) : null}
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
              aria-label={t("web.browser.back")}
            >
              {/* Mirrored in right-to-left, like Chrome's own Back and Forward. */}
              <span className="rtl-mirror" aria-hidden="true">
                ‹
              </span>
            </button>
            <button
              type="button"
              disabled={!tab.canGoForward}
              onClick={() => void port.navigate(tab.tabId, "forward")}
              aria-label={t("web.browser.forward")}
            >
              <span className="rtl-mirror" aria-hidden="true">
                ›
              </span>
            </button>
            <button
              type="button"
              onClick={() => void port.navigate(tab.tabId, tab.loading ? "stop" : "reload")}
              aria-label={tab.loading ? t("web.browser.stopLoading") : t("web.browser.reload")}
            >
              {tab.loading ? "■" : "↻"}
            </button>
            <output
              aria-label={t("web.browser.address")}
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
            <span className="chip" title={t("web.browser.profile")} data-testid="browser-profile">
              {tab.profile === "clean"
                ? t("web.browser.profileClean")
                : t("web.browser.profileAgent")}
            </span>
            <button
              type="button"
              onClick={() => void port.navigate(tab.tabId, "zoomOut")}
              aria-label={t("web.zoom.out")}
            >
              −
            </button>
            <button
              type="button"
              onClick={() => void port.navigate(tab.tabId, "zoomReset")}
              aria-label={t("web.browser.resetZoom")}
            >
              {activeI18n().percent(tab.zoomFactor, { maximumFractionDigits: 0 })}
            </button>
            <button
              type="button"
              onClick={() => void port.navigate(tab.tabId, "zoomIn")}
              aria-label={t("web.zoom.in")}
            >
              +
            </button>
            <button
              type="button"
              onClick={() => setFindText((f) => (f === null ? "" : null))}
              aria-label={t("web.browser.findInPage")}
            >
              {t("web.browser.find")}
            </button>
          </div>
          {findText !== null ? (
            <input
              // biome-ignore lint/a11y/noAutofocus: opened on demand
              autoFocus
              value={findText}
              aria-label={t("web.browser.findInPage")}
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
              ? t("web.browser.paused")
              : (tab.status ??
                (state.bridgeConnected ? t("web.browser.idle") : t("web.browser.notConnected")))}
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
            <p style={{ padding: 16, color: "var(--shell-muted)" }}>{t("web.browser.noTabs")}</p>
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
            {userHasControl ? t("web.browser.returnControl") : t("web.browser.takeControl")}
          </button>
          {tab.taskId ? (
            <button
              type="button"
              className="pill"
              onClick={() =>
                void store
                  .call("tasks.cancel", { taskId: tab.taskId })
                  .catch(() => store.toast(t("web.browser.stopFailed"), "error"))
              }
              data-testid="stop-task"
            >
              {t("web.browser.stopTask")}
            </button>
          ) : null}
          <span style={{ flex: 1 }} />
          <button type="button" className="pill" onClick={() => void port.popOut(tab.tabId)}>
            {t("web.panes.openInWindow")}
          </button>
          <button type="button" className="pill" onClick={() => void port.popOut(tab.tabId, true)}>
            {t("web.browser.full")}
          </button>
          <button
            type="button"
            className="pill"
            onClick={() => {
              if (
                window.confirm(
                  t("web.browser.clearConfirm", {
                    profile: tab.profile === "clean" ? "clean" : "agent",
                  }),
                )
              )
                void port
                  .clearBrowsingData(tab.profile)
                  .then(() => store.toast(t("web.browser.cleared")));
            }}
          >
            {t("web.browser.clearData")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
