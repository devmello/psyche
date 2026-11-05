import type { Catalogue } from "../../index.ts";

/** The Linux helper check in Settings → Devices (ja); merged into `../ja.ts`. */
export const helperCheck: Partial<Catalogue> = {
  "settings.devices.helperCheck.title": "Linux ヘルパーの確認",
  "settings.devices.helperCheck.description":
    "Linux ヘルパーが接続すると、Psyche はそれが実際にどのプログラムかを確認します。",
  "settings.devices.helperCheck.state.verified": "確認済み: システムにインストールされたヘルパー",
  "settings.devices.helperCheck.state.userOwned": "未確認: ホームフォルダのヘルパー",
  "settings.devices.helperCheck.state.unverified":
    "未確認: Psyche はヘルパーを確認できませんでした",
  "settings.devices.helperCheck.detail.verified":
    "Psyche と一緒にインストールされたヘルパーです。変更できるのはシステムだけです。",
  "settings.devices.helperCheck.detail.userOwned":
    "あなたが所有するファイル（AppImage やホームフォルダ内のビルドなど）から実行されています。Psyche は受け入れますが、あなたの別のプログラムが置き換えた可能性は否定できません。",
  "settings.devices.helperCheck.detail.unverified":
    "今のところ Psyche は受け入れていますが、どのプログラムかは確認できませんでした。",
  "settings.devices.helperCheck.refused": "拒否: {reason}",
  "settings.devices.helperCheck.reason.unclear": "Psyche はヘルパーを確認できませんでした",
  "settings.devices.helperCheck.reason.notHelper":
    "このプログラムは Psyche のヘルパーではありません",
  "settings.devices.helperCheck.reason.userCopy":
    "システムのインストール外のコピーで、インストール済みのヘルパーが必要です",
  "settings.devices.helperCheck.reason.loaderEnv":
    "ライブラリのパスまたは事前読み込みのライブラリを付けて起動されました",
  "settings.devices.helperCheck.reason.foreignCode": "システム外から読み込まれたコードがあります",
  "settings.devices.helperCheck.reason.severalPrograms": "複数のプログラムが接続を共有しています",
  "settings.devices.helperCheck.reason.handedOver": "別のプログラムから接続を渡されました",
  "settings.devices.helperCheck.reason.stillStarting": "まだ起動中でした",
  "settings.devices.helperCheck.reason.debugged": "停止中、またはデバッグされています",
  "settings.devices.helperCheck.reason.restartNeeded":
    "起動後に置き換えられたか、システムライブラリが更新されました。ヘルパーを再起動してください",
  "settings.devices.helperCheck.reason.filesNotLocked":
    "システム以外の誰かがファイルを変更できる状態です",
  "settings.devices.helperCheck.reason.otherNamespace":
    "このコンピュータの別のサンドボックス内で動いています",
  "settings.devices.helperCheck.reason.busy":
    "Psyche は他の接続を確認中でした。ヘルパーは再試行します",
};
