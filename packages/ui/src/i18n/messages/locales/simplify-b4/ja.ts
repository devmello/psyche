import type { Catalogue } from "../../index.ts";

/** Simplify batch B4: devices and pairing (ja); merged into `../ja.ts`. */
export const simplifyB4: Partial<Catalogue> = {
  "simplify.b4.devices.title": "デバイス",
  "simplify.b4.devices.description": "Psycheを使えるコンピュータとiPhone。",
  "simplify.b4.devices.details": "詳細",
  "simplify.b4.devices.canDo": "できること",
  "simplify.b4.devices.canDoOf": "{name}ができること",
  "simplify.b4.devices.hostKey": "このコンピュータのキー: {fingerprint}",
  "simplify.b4.devices.helpers": "ヘルパー",
  "simplify.b4.devices.helpersHint": "Psycheがコンピュータで作業するための小さなアプリ。",
  "simplify.b4.devices.noHelpers":
    "ヘルパーはまだありません。コンピュータでPsycheが動くと、ヘルパーがここに表示されます。",
  "simplify.b4.server.title": "ネットワークとリモートアクセス",
  "simplify.b4.server.description":
    "ほかのデバイスがこのコンピュータにつなぐ方法と、外出先でPsycheを使う方法。",
  "simplify.b4.server.away": "外出先で使う",
  "simplify.b4.pairIphone.title": "iPhoneを接続",
  "simplify.b4.pairIphone.description":
    "iPhoneのPsycheでコードをスキャンします。iPhoneとこのコンピュータは同じWi-Fiに接続してください。",
  "simplify.b4.pairIphone.button": "iPhoneを接続",
  "simplify.b4.pairIphone.scan":
    "iPhoneでPsycheを開き、このコードをスキャンしてください。コードは1回だけ使えます。",
  "simplify.b4.pairIphone.lanOn":
    "接続のためにネットワークアクセスをオンにしました。iPhoneがこのコンピュータを見つけられます。",
  "simplify.b4.pairIphone.lanOff": "ネットワークアクセスをオフに戻しました。",
  "simplify.b4.pairIphone.turnOff": "ネットワークアクセスをオフにする",
  "simplify.b4.pairIphone.enableFailed": "ネットワークアクセスをオンにできませんでした: {reason}",
  "simplify.b4.pairIphone.turnOffFailed": "ネットワークアクセスをオフにできませんでした: {reason}",
  "simplify.b4.pairIphone.noNetwork":
    "現在、このコンピュータにはネットワーク経由で接続できません。Wi-Fiがオンか確認して、もう一度お試しください。",
};
