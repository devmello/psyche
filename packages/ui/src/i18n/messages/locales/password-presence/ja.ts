import type { Catalogue } from "../../index.ts";

/** Password presence on Linux (ja); merged into `../ja.ts`. */
export const passwordPresence: Partial<Catalogue> = {
  "blocks.approval.password.needsAuth": "承認にはパスワードまたはパスキーが必要です。",
  "blocks.approval.password.waiting":
    "{code} を承認するには、システムのダイアログにパスワードを入力してください",
  "blocks.approval.password.waitingShort": "パスワードの入力を待っています…",
  "blocks.approval.password.onceOnly": "このウィンドウからのパスワード承認は1回限りです。",
  "blocks.approval.status.allowedOncePassword":
    "1回だけ許可しました（このウィンドウからのパスワード承認は1回限りです）",
  "blocks.approval.password.noUnsandboxed":
    "サンドボックスなしでコマンドを実行する操作は、このウィンドウからパスワードで承認できません。代わりにサンドボックスを設定してください",
  "blocks.approval.password.failed":
    "パスワードが受け付けられなかったため、何も承認されませんでした。もう一度お試しください。",
  "blocks.approval.password.unavailableHere":
    "このコンピュータで承認するか、別のデバイスのパスキーで承認してください。",
  "blocks.approval.password.agentMissing":
    "このデスクトップにはパスワードのダイアログがありません。polkit-gnome や lxpolkit などの polkit エージェントをインストールするか、パスキーを使ってください。",
  "blocks.approval.password.policyMissing":
    "Psyche のパスワードポリシーがこのコンピュータにインストールされていません。Psyche の初回セットアップを実行するか、パスキーを使ってください。",
  "blocks.approval.password.notEnforced":
    "このコンピュータの polkit ルールが Psyche をパスワードなしで承認するため、あなた本人であることを確認できません。ルールを削除するか、パスキーを使ってください。",
  "blocks.approval.password.unreachable":
    "システムのパスワードサービスを利用できません。もう一度お試しいただくか、パスキーを使ってください。",
  "settings.devices.password.title": "パスワードによる承認",
  "settings.devices.password.description":
    "重要な操作を承認する前に、Psyche はシステム自身のダイアログでパスワードを求めます。パスワードが Psyche に渡ることはありません。",
  "settings.devices.password.state.ready": "準備完了",
  "settings.devices.password.state.policyMissing": "ポリシー未インストール",
  "settings.devices.password.state.notEnforced": "オフ",
  "settings.devices.password.state.noSession": "デスクトップセッションなし",
  "settings.devices.password.state.agentMissing": "パスワードのダイアログなし",
  "settings.devices.password.state.unavailable": "利用不可",
  "settings.devices.password.detail.ready":
    "重要な操作を承認するとき、Psyche はシステムのダイアログでパスワードを求めます。",
  "settings.devices.password.detail.policyMissing":
    "Psyche のパスワードポリシーがこのコンピュータにインストールされていません。Psyche の初回セットアップを実行してください。",
  "settings.devices.password.detail.notEnforced":
    "このコンピュータの polkit ルールが Psyche をパスワードなしで承認します。ルールが削除されるまで、パスワードによる承認はオフです。",
  "settings.devices.password.detail.noSession":
    "パスワードによる承認には、このコンピュータでアクティブなデスクトップセッションが必要です。そこで Psyche を開いてください。",
  "settings.devices.password.detail.agentMissing":
    "このデスクトップにはパスワードのダイアログがありません。polkit-gnome や lxpolkit などの polkit エージェントをインストールしてください。",
  "settings.devices.password.detail.unavailable":
    "Psyche はシステムのパスワードサービスに接続できませんでした。",
  "settings.devices.password.x11Warning":
    "これは X11 セッションです。他のプログラムが入力内容を読み取れるため、パスワードは歯止めにはなっても防壁にはなりません。Wayland セッションの方が安全です。",
};
