import type { Catalogue } from "../../index.ts";

/** Native dialogs and notifications (ja); merged into `../ja.ts`. */
export const desktopDialog: Partial<Catalogue> = {
  "desktop.dialog.notificationsOn": "通知はオンになっています。",
  "desktop.dialog.anotherCopyTitle": "Psyche の別のコピーがすでに実行中です",
  "desktop.dialog.anotherCopyDetail":
    "{path} から実行されています。このコピーを使うと Psyche はこのアプリに切り替わり、もう一方のコピーはこちらに接続します。",
  "desktop.dialog.keepOtherCopy": "もう一方のコピーを維持",
  "desktop.dialog.useThisCopy": "このコピーを使う",
  "desktop.dialog.cancel": "キャンセル",
  "desktop.dialog.ok": "OK",
  "desktop.dialog.shareFolderTitle": "Psyche とフォルダを共有",
  "desktop.dialog.share": "共有",
  "desktop.dialog.gatewaysFileTitle": "Psyche が保存済みのゲートウェイを読み取れません",
  "desktop.dialog.gatewaysFileDetail":
    "{problem}。Psyche は{os, select, macos {この Mac} windows {この PC} other {このコンピュータ}}で起動し、ファイルはそのまま残すので、固定された ID は失われません。他のコンピュータのゲートウェイを使うには、Psyche のデータフォルダーでファイルを修正するか削除してください。",
  "desktop.dialog.stillRunningTitle": "Psyche は実行中です",
  "desktop.dialog.stillRunningBody":
    "タスクと自動化は動き続けます。通知領域の Psyche のアイコンから開き、右クリックで終了できます。",
  "desktop.dialog.manualStepsTitle": "Psyche の削除を完了するためのあと一手順",
  "desktop.dialog.uninstallTitle": "Psyche をアンインストールしますか？",
  "desktop.dialog.uninstall": "アンインストール",
  "desktop.dialog.uninstallAndDelete": "データを削除してアンインストール",
  "desktop.dialog.uninstallItems":
    "Psyche.app を含む {count, plural, one {# 個の項目} other {# 個の項目}}をゴミ箱に移動します。",
  "desktop.dialog.uninstallDataFolder": "データフォルダー {folder} もゴミ箱に移動されます。",
  "desktop.dialog.uninstallDataKept": "データフォルダーは残ります。",
  "desktop.dialog.uninstallKeychain": "Psyche が保持しているキーチェーン項目は削除されます。",
  "desktop.dialog.uninstallKeychainKept":
    "キーチェーン項目は残ります。必要ならキーチェーンアクセスで削除してください。",
  "desktop.dialog.stopTitle":
    "{os, select, macos {この Mac} windows {この PC} other {このコンピュータ}}の Psyche を停止しますか？",
  "desktop.dialog.stopDetail":
    "切り替えて戻るまで、その自動化と予定されたタスクは止まります。動かし続けるには実行したままにしてください。",
  "desktop.dialog.stopButton":
    "{os, select, macos {この Mac} windows {この PC} other {このコンピュータ}}の Psyche を停止",
  "desktop.dialog.keepRunning": "実行したままにする",
  "desktop.dialog.forgetTitle": "{name} を削除しますか？",
  "desktop.dialog.forgetDetail":
    "{origin}\n\nこの操作で、このコンピュータのこのゲートウェイ用の鍵と、Psyche がここに保存したそのゲートウェイのすべての情報が削除されます。向こう側で誰かがこのコンピュータを削除するまで、{name} にはこのコンピュータが表示され続けます。",
  "desktop.dialog.forgetButton": "削除",
  "desktop.dialog.repairTitle": "{name} と再度ペアリングしますか？",
  "desktop.dialog.repairDetail":
    "{origin}\n\nこの操作で、Psyche がそのゲートウェイ用に固定した ID と、このコンピュータの鍵を忘れます。次の接続では、そのアドレスで応答したものを固定し、新しいコンピュータとしてペアリングを求めます。ID が変わった理由が分かっている場合にだけ実行してください。",
  "desktop.dialog.repairButton": "再ペアリング",
  "desktop.dialog.claimTitle": "{origin} の Psyche サーバーを設定しますか？",
  "desktop.dialog.claimDetail":
    "Psyche は、入力したセットアップコードをサーバーが知っていることを確認してから信頼します。サーバーも、このコンピュータがそのコードを知っていることを確認してから管理者にします。そのサーバーを自分で今インストールした場合にだけ続けてください。",
  "desktop.dialog.setUp": "設定",
  "desktop.dialog.addLanTitle": "{origin} はこのネットワーク上の Psyche ですか？",
  "desktop.dialog.addLanDetail":
    "名前: {name}\n\nこのネットワーク上の Psyche は、システムの証明書を信頼する代わりに、独自の証明書を使い、Psyche がそれを固定します。最初の接続でゲートウェイの証明書と鍵を確認し、以後はそれ以外を拒否します。「プレーン https」は、通常の証明書を持つサーバー（例: 自分の CA を持つリバースプロキシ）の場合にだけ選んでください。所有者がこのコンピュータを承認するまで、何も共有されません。",
  "desktop.dialog.psycheOnNetwork": "このネットワーク上の Psyche",
  "desktop.dialog.plainHttps": "プレーン https",
  "desktop.dialog.addLinkTitleLan": "このネットワーク上の {origin} に Psyche を接続しますか？",
  "desktop.dialog.addLinkTitle": "{origin} に Psyche を接続しますか？",
  "desktop.dialog.addLinkDetail":
    "{external, select, yes {このリンクは、あなたが貼り付けたのではなく、別のアプリや Web サイトから開かれました。Psyche を実行している{os, select, macos {Mac} windows {PC} other {コンピュータ}}で自分で作成したものだけ続けてください。\n\n} other {}}Psyche は、そのゲートウェイがこの ID を証明した場合にのみ接続します:\n{fingerprint}\n\n{lan, select, yes {このゲートウェイはシステムが信頼する証明書ではなく独自の証明書を使います。Psyche は、何かを送信する前にリンクが示す証明書（{pin}…）に固定し、それ以外を拒否します。このネットワーク上にある自分の{os, select, macos {Mac} windows {PC} other {コンピュータ}}から届いたリンクの場合にだけ続けてください。\n\n} other {}}リンクのワンタイムコードにより、そのゲートウェイは、作成時に所有者が選んだアクセス権で、再度確認せずにこのコンピュータを承認できるようになります。",
  "desktop.dialog.addDetailKey":
    "名前: {name}\n通知された鍵: {key}…\n\nこのコンピュータはそのゲートウェイにペアリングを求めます。所有者がこのコンピュータを承認するまで何も共有されず、Psyche は最初の接続でゲートウェイの ID を固定します。",
  "desktop.dialog.addDetailPlain":
    "名前: {name}\n\nこのコンピュータはそのゲートウェイにペアリングを求めます。所有者がこのコンピュータを承認するまで何も共有されず、Psyche は最初の接続でゲートウェイの ID を固定します。",
  "desktop.dialog.addGatewayButton": "ゲートウェイを追加",
};
