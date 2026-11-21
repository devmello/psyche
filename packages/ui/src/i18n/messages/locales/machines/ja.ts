import type { Catalogue } from "../../index.ts";

/** Computers Psyche can use (ja); merged into `../ja.ts`. */
export const machines: Partial<Catalogue> = {
  "machines.title": "Psycheが使えるコンピューター",
  "machines.description":
    "ペアリングしたLinuxコンピューター。このコンピューターを使い続けている間に、Psycheがそちらのアプリ、コマンド、ファイルを使えます。",
  "machines.empty":
    "PsycheにLinuxコンピューターを渡すと、このコンピューターを使い続けている間に、そちらのアプリ、コマンド、ファイルを使えます。",
  "machines.add": "Linuxコンピューターを追加",
  "machines.add.description":
    "このコンピューターを使い続けている間も、Psycheはそのコンピューターで作業します。そこでの操作は、承認の設定に従います。",
  "machines.add.account": "Psycheはそちらでどのアカウントを使いますか？",
  "machines.add.account.own": "あなたのアカウント（推奨）",
  "machines.add.account.ownHint":
    "Psycheは、あなたと同じようにそちらのファイル、アプリ、ログインを使えます。rootは取得しません。",
  "machines.add.account.dedicated": "専用のpsycheアカウント",
  "machines.add.account.dedicatedHint":
    "Psycheにはそのアカウントのファイルとアプリだけが見えます。sudoもパスワードもありません。",
  "machines.add.needsNetwork":
    "ほかのコンピューターからこのコンピューターにまだ接続できません。まず「設定」→「サーバーとリモートアクセス」で、リモートアクセスまたはローカルネットワークアクセスをオンにしてください。",
  "machines.add.make": "コマンドを表示",
  "machines.add.again": "新しいコマンドを作成",
  "machines.add.commands": "Linuxコンピューター用のコマンド",
  "machines.add.installStep": "1. Linuxコンピューターで、ヘルパーをインストールします",
  "machines.add.pairStep": "2. そちらでペアリングを開始します",
  "machines.add.expires": "リンクは1回だけ使え、{when}に失効します。",
  "machines.add.waiting": "コンピューターのペアリングを待っています…",
  "machines.add.paired": "{name}をペアリングしました。Psycheはこれを使えます。",
  "machines.add.pairedToast": "{name}を追加しました",
  "machines.add.done": "完了",
  "machines.copy": "コピー",
  "machines.status.online": "オンライン",
  "machines.status.offline": "オフライン",
  "machines.status.degraded": "確認が必要",
  "machines.display.headless": "専用画面",
  "machines.display.desktopSession": "独自のデスクトップ",
  "machines.display.container": "コンテナ",
  "machines.thisComputer": "このコンピューター",
  "machines.watch": "見る",
  "machines.watchNamed": "{name}を見る",
  "machines.apps": "アプリのアクセス",
  "machines.appsNamed": "{name}のアプリのアクセス",
  "machines.folders": "フォルダ",
  "machines.foldersNamed": "{name}のフォルダ",
  "machines.rename.action": "名前を変更",
  "machines.rename.named": "{name}の名前を変更",
  "machines.rename.label": "{name}の新しい名前",
  "machines.rename.save": "保存",
  "machines.rename.cancel": "キャンセル",
  "machines.remove": "削除",
  "machines.removeTitle": "{name}を削除しますか？",
  "machines.removeDescription":
    "Psycheは{name}の使用をすぐにやめ、ペアリングは取り消されます。もう一度使うには、ペアリングし直してください。",
  "machines.err.nameTaken":
    "その名前はすでに別のコンピューターが使っているか、予約されています。別の名前にしてください。",
  "machines.err.nameInvalid":
    "その名前は使えません。通常の文字、数字、記号を64文字以内で使い、似た文字を混ぜないでください。",
  "machines.err.forbidden":
    "名前の変更には管理者のデバイスが必要です。管理者のデバイスからもう一度お試しください。",
  "machines.err.failed": "うまくいきませんでした（{reason}）。何も変更されていません。",
  "machines.account.own":
    "{name}では、あなた自身のアカウントで動きます。Psycheは、あなたと同じようにそちらのファイル、アプリ、ログインを使えます。もしPsycheが侵害されたら、攻撃者も同じことができます。ただしPsycheが決して得られないrootは除きます。",
  "machines.account.dedicated":
    "{name}では、別のアカウントで動きます。Psycheにはそのアカウントのファイルとアプリだけが見えます。",
  "machines.account.useSeparate": "代わりに別のアカウントを使う…",
  "machines.account.useSeparateHint":
    "{name}で、別アカウントのオプションを付けてインストーラーをもう一度実行し、ペアリングし直してください。",
  "machines.shell.contained": "コマンドは隔離されたシェルで実行されます",
  "machines.shell.full": "コマンドはアカウントのフルシェルで実行されます",
  "machines.shell.off": "コマンドはオフです",
  "machines.limits.folders":
    "{count, plural, =0 {許可したフォルダなし} other {許可したフォルダ#件}}",
  "machines.helperVersion": "ヘルパー {version}",
  "machines.helperVersionUnknown": "ヘルパーのバージョン不明",
  "machines.update": "新しいヘルパーがあります。{name}のヘルパーを更新してください。",
  "machines.warnings": "{name}の警告",
  "machines.warn.fullShell":
    "アカウントのフルシェルです。コマンドは隔離されないため、このアカウントが届くすべてに届きます。",
  "machines.warn.userLimits":
    "制限はユーザーが管理しています。このアカウントで動くプログラムなら、{name}でPsycheに許可することを変更できます。",
  "machines.warn.sudo":
    "このアカウントはパスワードなしのsudoを持っています。Psycheはここでsudoを使えませんが、このアカウントで実行するほかのプログラムは使えます。",
  "machines.paired": "{when}にペアリング",
  "machines.line": "「{name}」で · Linux · {place}",
  "machines.place.screen": "専用画面",
  "machines.place.desktop": "そのデスクトップ",
  "machines.place.command": "コマンド",
  "machines.place.files": "ファイル",
  "machines.step.on": "{name}で{label}",
  "machines.picker.title": "コンピューター",
  "machines.picker.description":
    "この設定の対象のコンピューターと、特定のコンピューターを見ていないときにPsycheが作業する場所を選びます。",
  "machines.picker.show": "アプリのアクセスを表示する対象",
  "machines.picker.default": "バックグラウンド作業の既定のコンピューター",
  "machines.picker.defaultHint":
    "タスクと自動化は、コンピューターを指定しない限りそこで実行されます。Linuxコンピューターを選ぶと、こちらで作業している間にPsycheがあちらで作業します。",
  "machines.picker.appsOn": "{name}のアプリ",
  "machines.picker.appsHint":
    "Psycheはこれらを{name}と同期し、そのコンピューター自身の制限を超えることはありません。",
  "machines.picker.noApps":
    "Psycheは{name}のアプリをまだ見ていません。見えるようになるとここに表示されます。",
  "machines.picker.offline": "{name}はオフラインです。再接続すると変更が届きます。",
  "computerWatch.titleMachine": "{name} · 専用画面",
  "computerWatch.machineOffline": "{name}に接続できません。再試行しています…",
  "computerWatch.empty.bodyMachine":
    "エージェントが{name}の画面を必要とするとき、ここで見られます。",
  "notice.machine.working.title": "Psycheは{name}で作業しています",
  "notice.machine.working.body":
    "そのコンピューターの画面、アプリ、ファイルを使っています。「設定」→「デバイス」から見られます。",
  "notice.machine.offline.title": "{name}がオフラインになりました",
  "notice.machine.offline.body":
    "再接続するまでPsycheは使えません。必要とするタスクは、あなたを待ちます。",
  "machines.add.linkStep": "3. リンクを求められたら、これを貼り付けます",
  "machines.add.installSource":
    "{url} からヘルパーのパッケージを入手して展開し、Linuxコンピューターで次を実行してください。",
  "machines.reports": "{name}の報告：",
  "computerWatch.machineLoading": "コンピューターを読み込み中…",
  "computerWatch.machineMissing": "そのコンピューターは利用できません。",
  "settings.key.computerUse.defaultMachine": "バックグラウンド作業の既定のコンピューター",
  "settings.key.computerUse.machineApps": "Linuxコンピューターのアプリのアクセス",
  "machines.card.folder": "フォルダー",
  "machines.card.runsContained": "隔離して、許可したフォルダーだけで実行: 鍵、ブラウザーのプロファイル、他のフォルダーには触れません",
  "machines.card.runsFullAccount": "アカウント全体の権限で実行: そのアカウントにできることは何でもできます",
  "machines.card.networkOff": "オフ",
  "machines.card.networkOn": "オン",
  "machines.card.folderReadOnly": "{path}、読み取り専用",
  "machines.card.folderReadWrite": "{path}、読み書き",
  "machines.card.folderNotEnforced": "{path}、アカウント全体の権限では読み取り専用は守られません",
};
