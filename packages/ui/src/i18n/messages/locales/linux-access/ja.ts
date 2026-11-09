import type { Catalogue } from "../../index.ts";

/** Linux access in Settings → Computer use (ja); merged into `../ja.ts`. */
export const linuxAccess: Partial<Catalogue> = {
  "settings.computerUse.linux.screen.name": "画面と入力へのアクセス",
  "settings.computerUse.linux.screen.allowed": "取り消すまで許可",
  "settings.computerUse.linux.screen.asks": "初めて使うときに確認します",
  "settings.computerUse.linux.screen.notNeeded": "X11 では不要",
  "settings.computerUse.linux.screen.unavailable": "利用できません",
  "settings.computerUse.linux.screen.why":
    "{persona}は、デスクトップの許可ダイアログを通じて画面を見て、マウスとキーボードを使います。許可は一度だけです。",
  "settings.computerUse.linux.revoke": "取り消す",
  "settings.computerUse.linux.revokeLabel": "画面と入力へのアクセスを取り消す",
  "settings.computerUse.linux.warning.x11":
    "X11 では、どのアプリも画面とキー入力を読み取れます。何かを承認するときに入力するパスワードも含まれます。",
  "settings.computerUse.linux.warning.wlroots":
    "このデスクトップでは、どのアプリも確認なしで画面を読み取り、代わりに入力できます。Psyche が確認の手順を加えることはできません。",
  "settings.computerUse.linux.accessibility":
    "今後起動するアプリは、その構造を Psyche に公開します。すでに開いているアプリは再起動が必要な場合があります。",
  "settings.computerUse.linux.headless":
    "このコンピューターでグラフィカルセッションが必要です。デスクトップにログインして、もう一度お試しください。",
};
