import type { Catalogue } from "../../index.ts";

/** Simplify batch B4: devices and pairing (ja); merged into `../ja.ts`. */
export const simplifyB4: Partial<Catalogue> = {
  "simplifyB4.devices.title": "デバイス",
  "simplifyB4.devices.description": "Psycheを使えるコンピュータとiPhone。",
  "simplifyB4.devices.details": "詳細",
  "simplifyB4.devices.canDo": "できること",
  "simplifyB4.devices.canDoOf": "{name}ができること",
  "simplifyB4.devices.hostKey": "このコンピュータのキー: {fingerprint}",
  "simplifyB4.devices.helpers": "ヘルパー",
  "simplifyB4.devices.helpersHint": "Psycheがコンピュータで作業するための小さなアプリ。",
  "simplifyB4.devices.noHelpers":
    "ヘルパーはまだありません。コンピュータでPsycheが動くと、ヘルパーがここに表示されます。",
  "simplifyB4.server.title": "ネットワークとリモートアクセス",
  "simplifyB4.server.description":
    "ほかのデバイスがこのコンピュータにつなぐ方法と、外出先でPsycheを使う方法。",
  "simplifyB4.server.away": "外出先で使う",
  "simplifyB4.pairIphone.title": "iPhoneを接続",
  "simplifyB4.pairIphone.description":
    "iPhoneのPsycheでコードをスキャンします。iPhoneとこのコンピュータは同じWi-Fiに接続してください。",
  "simplifyB4.pairIphone.button": "iPhoneを接続",
  "simplifyB4.pairIphone.scan":
    "iPhoneでPsycheを開き、このコードをスキャンしてください。コードは1回だけ使えます。",
  "simplifyB4.pairIphone.lanOn":
    "接続のためにネットワークアクセスをオンにしました。iPhoneがこのコンピュータを見つけられます。",
  "simplifyB4.pairIphone.lanOff": "ネットワークアクセスをオフに戻しました。",
  "simplifyB4.pairIphone.turnOff": "ネットワークアクセスをオフにする",
  "simplifyB4.pairIphone.enableFailed": "ネットワークアクセスをオンにできませんでした: {reason}",
  "simplifyB4.pairIphone.turnOffFailed": "ネットワークアクセスをオフにできませんでした: {reason}",
  "simplifyB4.pairIphone.noNetwork":
    "現在、このコンピュータにはネットワーク経由で接続できません。Wi-Fiがオンか確認して、もう一度お試しください。",
};
