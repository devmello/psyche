import { t } from "@psyche/ui";
import { type ReactElement, useState } from "react";
import type { BrowserPromptAnswer, BrowserPromptView } from "../platform.ts";

/**
 * Sign-in questions under the browser pane (security §6, §4): "Stay signed in to <site>?" for a
 * clean tab and "Save login to Psyche vault?" with the real origin, the username and a masked
 * password. The password is never in the view data; the mask is a fixed string, so it does not
 * reveal the length.
 */

const MASK = "••••••••";

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

export function SignInPrompt(props: {
  prompt: BrowserPromptView;
  onAnswer: (id: string, answer: BrowserPromptAnswer) => Promise<void>;
}): ReactElement {
  const { prompt: p, onAnswer } = props;
  const [busy, setBusy] = useState(false);
  const answer = (a: BrowserPromptAnswer) => {
    setBusy(true);
    void onAnswer(p.id, a).finally(() => setBusy(false));
  };
  if (p.kind === "stay_signed_in") {
    const site = hostOf(p.origin);
    return (
      <fieldset
        className="dock"
        aria-label={t("web.browser.stay.question", { site })}
        data-testid="stay-signed-in-prompt"
      >
        <strong>{t("web.browser.stay.question", { site })}</strong>
        <div style={{ fontSize: 13 }}>{t("web.browser.stay.detail")}</div>
        <div className="row">
          <button type="button" disabled={busy} onClick={() => answer("dismiss")}>
            {t("web.browser.prompt.notNow")}
          </button>
          <button type="button" disabled={busy} onClick={() => answer("accept")}>
            {t("web.browser.stay.yes")}
          </button>
        </div>
      </fieldset>
    );
  }
  return (
    <fieldset
      className="dock"
      aria-label={t("web.browser.vault.question")}
      data-testid="save-login-prompt"
    >
      <strong>{t("web.browser.vault.question")}</strong>
      <div style={{ fontSize: 13 }}>
        {t("web.browser.vault.account", { username: p.username, origin: hostOf(p.origin) })}
      </div>
      <div style={{ fontSize: 13 }}>
        {t("web.browser.vault.passwordLabel")}: <span data-testid="password-mask">{MASK}</span>
      </div>
      {p.error ? (
        <div role="alert" style={{ fontSize: 13 }}>
          {t("web.browser.vault.error", { code: p.error })}
        </div>
      ) : null}
      <div className="row">
        <button type="button" disabled={busy} onClick={() => answer("never")}>
          {t("web.browser.vault.never")}
        </button>
        <button type="button" disabled={busy} onClick={() => answer("dismiss")}>
          {t("web.browser.prompt.notNow")}
        </button>
        <button type="button" disabled={busy} onClick={() => answer("accept")}>
          {t("web.browser.vault.save")}
        </button>
      </div>
    </fieldset>
  );
}
