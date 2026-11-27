import type { Catalogue } from "../../index.ts";

/** Windows variants of the sandbox PC, voice keys and platform terms, and Mac wording (ja); merged into `../ja.ts`. */
export const windowsPlatform202611: Partial<Catalogue> = {
  "blocks.details.runsNoHostSandbox":
    "このコンピュータ上・サンドボックスなし：ここではコマンド用のサンドボックスがありません",
  "blocks.execHost.noHostSandbox":
    "このコンピュータにはコマンド用のサンドボックスがないため、このコマンドはサンドボックスなしでのみ実行できます。今回だけ実行するには {word} と入力してください。",
  "blocks.execHost.mustTypeOnly": "許可するには {word} と入力してください。",
  "settings.uninstall.stopSandboxPc":
    "サンドボックスPCのサービスを削除します。Windowsが管理者の承認を一度求めます。",
  "settings.computerUse.tcc.microphone.name": "マイク",
  "settings.computerUse.tcc.microphone.why":
    "ディクテーションや会議メモのために、Psycheがあなたの声を聞けるようにします",
  "settings.sandbox.restart.reopen": "Psycheを終了して、もう一度開いてください。",
  "settings.sandbox.pc.title": "サンドボックスPCをオンにする",
  "settings.sandbox.pc.body":
    "コマンド用の軽量サンドボックスであるsrtは、Windowsでは動きません。代わりに、Psycheが作成するスクリプト、コマンドサーバー、コネクターはプライバシーとセキュリティ → コンピュータ操作 → VMモードで実行されます。サンドボックスPCは専用の小さなLinuxコンピュータで、あなたのファイルにはアクセスできません。設定 → サンドボックスPCでオンにしてから、もう一度確認してください。",
  "settings.sandbox.pc.notReady.title": "サンドボックスPCはまだ準備できていません",
  "settings.sandbox.pc.notReady.body":
    "オンにはなっていますが、まだ動いていないか、中のPsycheが古くなっています。設定 → プライバシーとセキュリティ → コンピュータ操作 → VMモードで起動または更新してから、もう一度確認してください。",
  "settings.sandbox.pc.ready":
    "サンドボックスPCはオンです。Psycheが作成するスクリプト、コマンドサーバー、コネクターはこの中で実行されます。",
  "settings.sandbox.pc.open": "サンドボックスPCの設定を開く",
  "settings.sandbox.pc.where":
    "設定 → プライバシーとセキュリティ → コンピュータ操作 → VMモード にあります。",
  "settings.devices.platform.windows": "Windows PC",
  "settings.devices.nodeKind.winHelper": "Windowsヘルパー",
  "settings.devices.thisPcAdmin":
    "このPCは管理用デバイスです。別の管理用デバイスがここから取り消せます。",
  "settings.devices.presenceKey.windowsHello":
    "Windows Helloキー（{algorithm}）。ヘルパーの報告によるもの",
  "settings.devices.presenceKey.windowsHelloNoAlgorithm":
    "Windows Helloキー。ヘルパーの報告によるもの",
  "settings.shortcut.reserved.windowsKey": "Windows（Windowsキーを使うショートカット）",
  "settings.shortcut.reserved.windowMenu": "ウィンドウメニュー",
  "settings.shortcut.reserved.closeApp": "アプリの終了",
  "settings.shortcut.reserved.taskManager": "タスクマネージャー",
  "settings.shortcut.reserved.startMenu": "スタートメニュー",
  "settings.shortcut.reserved.securityScreen": "Windowsのセキュリティ画面",
  "settings.shortcut.key.Super": "Windowsキー",
  "settings.shortcut.useDefault": "デフォルトを使う",
  "settings.quickEntry.title": "クイック入力",
  "settings.key.quickEntry.shortcut": "ショートカット",
  "settings.quickEntry.shortcutHint":
    "どのアプリからでもポップアップチャットを開きます。別のキーを選ばない限り、Psycheは {keys} を使い、他のアプリが使っているときは {fallback} を使います。",
  "settings.voice.key.rightCtrl": "右Ctrl",
  "settings.voice.key.rightAlt": "右Alt",
  "settings.voice.key.rightShift": "右Shift",
  "settings.voice.key.rightWin": "右Windowsキー",
  "settings.voice.key.capsLock": "Caps Lock",
  "settings.voice.key.scrollLock": "Scroll Lock",
  "settings.voice.key.pause": "Pause",
  "settings.voice.key.menu": "メニューキー",
  "settings.voice.key.insert": "Insert",
  "settings.voice.key.numLock": "Num Lock",
  "settings.voice.key.other": "別のキー",
  "settings.voice.key.press": "キーを押してください",
  "settings.voice.key.pressNow": "押し続けるキーを押してください…",
  "settings.voice.key.cantUse":
    "そのキーは文字を入力するため、話すために押し続けることはできません。右Ctrl、Caps Lock、Pause、メニューキー、またはF13〜F24を試してください。",
  "settings.voice.key.capsLockHint":
    "Caps Lockはオン・オフの状態を保ちます。話すために押し続けても状態は変わらず、短く押せば従来どおり切り替わります。",
  "settings.voice.key.altGrWarning":
    "お使いのキーボード配列では右Altは AltGr で、@ や € などの文字を入力します。話すために押し続けると、それらの入力の妨げになることがあります。右Ctrlの方が安全です。",
  "settings.voice.access.windowsWhy":
    "押しているキーを監視し、フォーカスのあるアプリに入力します。Windowsではこのための許可は不要です。管理者として実行されているアプリには、ディクテーションのテキストは届きません。",
  "settings.voice.model.title": "音声モデル",
  "settings.voice.model.usingHelper":
    "ディクテーションはヘルパーの音声認識を使います。音声モデルはより正確に文字起こしでき、このMacで動作します。",
  "settings.voice.model.download":
    "ディクテーションを改善するために音声モデル（{mb} MB）をダウンロード",
  "settings.voice.model.downloadHint":
    "whisper.cppプロジェクトから一度だけダウンロードし、使用前に検証します。音声がこのMacの外に出ることはありません。",
  "settings.voice.model.downloading": "音声モデルをダウンロード中：{total} MB のうち {received} MB",
  "settings.voice.model.ready": "このMac上のWhisper（{model}）",
  "settings.voice.model.readyHint":
    "ディクテーションと録音はここで文字起こしされます。音声がMacの外に出ることはありません。",
  "settings.voice.model.readyNotFirst":
    "インストール済みです。エンジンの順序で別のエンジンが先に来ているため、今はディクテーションで使われません。",
  "settings.voice.model.failed": "ダウンロードに失敗しました：{reason}",
  "settings.voice.model.retry": "再試行",
  "settings.voice.model.vcredist":
    "音声モデルには Microsoft Visual C++ Redistributable が必要です。インストールしてから、もう一度ディクテーションしてください。",
  "settings.voice.model.crashed":
    "音声エンジンが予期せず停止しました。再起動するまで、ディクテーションはヘルパーを使います。",
  "settings.sandboxPc.title": "サンドボックスPCをオンにする",
  "settings.sandboxPc.explain":
    "{persona} には、Windows内で動く小さな専用Linux PCが与えられます。タスクはあなたのPCではなくそこで実行され、共有したフォルダだけが見えます。",
  "settings.sandboxPc.oneTime":
    "初回のセットアップ：PCを動かすバックグラウンドサービスを追加するため、Windowsが管理者の承認を一度求めます。その後Psycheは PCイメージ（{download}、ディスク上で {disk}）をダウンロードします。ほかに管理者権限は必要ありません。",
  "settings.sandboxPc.oneTimeNoSize":
    "初回のセットアップ：PCを動かすバックグラウンドサービスを追加するため、Windowsが管理者の承認を一度求めます。その後Psycheは PCイメージをダウンロードします。ほかに管理者権限は必要ありません。",
  "settings.sandboxPc.turnOn": "サンドボックスPCをオンにする",
  "settings.sandboxPc.cancelDownload": "ダウンロードをキャンセル",
  "settings.sandboxPc.waitingAdmin": "管理者の確認を待っています…",
  "settings.sandboxPc.restarting": "セットアップを完了しています…",
  "settings.sandboxPc.downloading": "PCイメージをダウンロード中：{total} のうち {received}",
  "settings.sandboxPc.progressLabel": "PCイメージのダウンロード",
  "settings.sandboxPc.ready": "セットアップ済み",
  "settings.sandboxPc.readyText":
    "サンドボックスPCのセットアップが完了しました。バージョン {version}。",
  "settings.sandboxPc.unsupported": "ここではサンドボックスPCを利用できません：{reason}。",
  "settings.sandboxPc.failed": "サンドボックスPCをオンにできませんでした：{reason}",
  "settings.sandboxPc.failedDid": "ほかは変更されていません。もう一度試せます。",
  "settings.sandboxPc.gb": "{value, number} GB",
  "settings.sandboxPc.mb": "{value, number} MB",
  "settings.sandboxPc.loadLabel": "サンドボックスPC",
  "settings.sandboxPc.onboarding": "サンドボックスPC",
  "settings.sandboxPc.onboardingHint":
    "任意：ファイルに触れてほしくないタスク用の、専用のLinux PCです。あとで設定から用意できます。",
  "settings.sandboxPc.update.title": "サンドボックスPCのサービスを更新",
  "settings.sandboxPc.update.explainCompatible":
    "このバージョンのPsycheには、インストール済みのものより新しいサンドボックスPCサービスが含まれています。サンドボックスPCは今のまま動き続けます。",
  "settings.sandboxPc.update.explainRequired":
    "このバージョンのPsycheは、インストールされているサンドボックスPCサービスを使えません。更新するまでサンドボックスPCはオフのままです。",
  "settings.sandboxPc.update.available": "更新があります",
  "settings.sandboxPc.update.required": "更新が必要です",
  "settings.sandboxPc.update.versions":
    "インストール済み：{installed}。このバージョンのPsyche：{bundled}。",
  "settings.sandboxPc.update.oneStep":
    "Windowsが管理者の承認を一度求めます。サービスを入れ替える間、実行中のサンドボックスPCは停止します。",
  "settings.sandboxPc.update.button": "サンドボックスPCのサービスを更新",
  "settings.sandboxPc.update.failed": "サンドボックスPCのサービスは更新されませんでした：{reason}",
  "settings.sandboxPc.update.failedDid": "ほかは変更されていません。もう一度試せます。",
  "settings.sandboxPc.controls.title": "サンドボックスPC",
  "settings.sandboxPc.controls.hint": "一度作成したら、ここで起動と停止ができます。",
  "settings.sandboxPc.controls.create": "サンドボックスPCを作成",
  "settings.sandboxPc.controls.start": "起動",
  "settings.sandboxPc.controls.stop": "停止",
  "settings.sandboxPc.controls.resume": "再開",
  "settings.sandboxPc.controls.working": "処理中…",
  "settings.sandboxPc.controls.helperOffline":
    "Windowsヘルパーが動いていないか、まだサンドボックスPCがないため、操作できません。設定 → デバイスでヘルパーを再起動してください。",
  "settings.sandboxPc.controls.failed": "うまくいきませんでした：{reason}",
  "settings.sandboxPc.controls.waitForImage": "先に上でオンにする手順を完了してください。",
  "settings.sandboxPc.snapshots.title": "スナップショット",
  "settings.sandboxPc.snapshots.hint":
    "サンドボックスPCのディスクを保存して、あとで戻れるようにします。保存や復元をするには停止している必要があります。",
  "settings.sandboxPc.snapshots.none": "スナップショットはまだありません。",
  "settings.sandboxPc.snapshots.save": "スナップショットを保存",
  "settings.sandboxPc.snapshots.saveFresh": "新品のPCとして保存",
  "settings.sandboxPc.snapshots.reset": "新品のPCに戻す",
  "settings.sandboxPc.snapshots.restore": "復元",
  "settings.sandboxPc.snapshots.delete": "削除",
  "settings.sandboxPc.snapshots.fresh": "新品のPC",
  "settings.sandboxPc.snapshots.item": "{label}、{when}",
  "settings.sandboxPc.snapshots.stopFirst": "先にサンドボックスPCを停止してください。",
  "onboarding.connectors.windowsHint":
    "Windowsでは、{name} がMicrosoft、Google、IMAPのアカウント経由でメール、カレンダー、連絡先を読み取ります。",
  "web.about.windowsArm": "Arm64",
  "web.about.windowsX64": "x64",
  "web.about.windowsBuild": "ビルド {build}",
  "platform.term.os": "macOS",
  "platform.term.device": "Mac",
  "platform.term.thisDevice": "このMac",
  "platform.term.thisDeviceLower": "このMac",
  "platform.term.presence": "Touch ID",
  "platform.term.secretStore": "キーチェーン",
  "platform.term.systemSettings": "システム設定",
  "platform.term.fileManager": "Finder",
  "platform.term.trayArea": "メニューバー",
  "platform.term.taskbar": "Dock",
  "platform.term.systemSearch": "Spotlight",
  "platform.term.helper": "Macのヘルパー",
  "platform.term.terminal": "ターミナル",
  "platform.term.alt": "Option",
  "platform.term.mod": "Command",
  "platform.macOnly": "macOSでのみ利用できます",
  "platform.macOnlyHint": "{name} にはMacが必要です。macOS上のPsycheで利用できます。",
  "platform.windows.access.title": "Windowsのアクセス",
  "platform.windows.access.hint": "Windowsが Psyche に許可している操作と、あなたに求める許可です。",
  "platform.windows.access.noPermission": "許可は不要です",
  "platform.windows.access.uiAutomation.name": "アプリの操作",
  "platform.windows.access.uiAutomation.why":
    "{persona} は Windows UI オートメーションでアプリのウィンドウを読み取り、操作します。Windowsは管理者として実行されているアプリの操作を許可しません。",
  "platform.windows.access.screen.name": "画面キャプチャ",
  "platform.windows.access.screen.why":
    "Windowsは画面キャプチャに許可を必要としません。Psycheのウィンドウとパスワード欄はキャプチャから隠されます。",
  "platform.windows.access.microphone.name": "マイク",
  "platform.windows.access.microphone.why":
    "ディクテーションと会議メモのためです。Windowsでは 設定 → プライバシーとセキュリティ → マイク で、「デスクトップアプリがマイクにアクセスできるようにする」をオンにすると許可できます。",
  "platform.windows.access.openSettings": "設定を開く",
  "platform.windows.access.openSettingsFor": "{name} のWindowsの設定を開く",
  "platform.windows.access.state.granted": "オン",
  "platform.windows.access.state.denied": "Windowsの設定でオフ",
  "platform.windows.access.state.not_determined": "まだ確認していません",
  "platform.helper.restart": "ヘルパーを再起動",
  "platform.helper.restarting": "再起動しています…",
  "platform.helper.restartFailed": "ヘルパーを起動できませんでした（{reason}）。",
};
