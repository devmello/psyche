import type { Catalogue } from "../../index.ts";

/** App update strings (ja); merged into `../ja.ts`. */
export const update: Partial<Catalogue> = {
  "shell.update.ready": "Psyche {version} の準備ができました",
  "shell.update.readyRequired": "Psyche {version} の準備ができました。この更新は必須です。",
  "shell.update.restart": "再起動して更新",
  "shell.update.dismiss": "更新のお知らせを閉じる",
  "settings.updates.status": "状態",
  "settings.updates.checking": "更新を確認しています…",
  "settings.updates.upToDate": "最新です",
  "settings.updates.ready": "Psyche {version} の準備ができました",
  "settings.updates.readyRequired": "Psyche {version} の準備ができました（必須）",
  "settings.updates.refused": "更新を拒否しました：{reason}",
  "settings.updates.installFailed":
    "Psyche は更新をインストールできませんでした。後でもう一度お試しください。",
};
