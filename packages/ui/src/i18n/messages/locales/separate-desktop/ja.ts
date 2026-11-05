import type { Catalogue } from "../../index.ts";

/** Settings > Computer use > Separate desktop (ja); merged into `../ja.ts`. */
export const separateDesktop: Partial<Catalogue> = {
  "settings.separateDesktop.title": "別のデスクトップ",
  "settings.separateDesktop.description":
    "コンテナー内の専用デスクトップで、独自のアプリとファイルを持ちます。タスクのために共有したフォルダーだけが見え、そのタスクで許可しない限りインターネットは使えず、タスクが終わると停止します。",
  "settings.separateDesktop.state.off": "停止中",
  "settings.separateDesktop.state.starting": "起動中",
  "settings.separateDesktop.state.running": "実行中",
  "settings.separateDesktop.state.stopping": "停止しています",
  "settings.separateDesktop.state.failed": "起動できませんでした",
  "settings.separateDesktop.engine": "コンテナーエンジン: {engine}",
  "settings.separateDesktop.rootful":
    "このコンテナーエンジンは root で動作します。別のデスクトップにはルートレスの Podman を使ってください。",
  "settings.separateDesktop.memory": "メモリ上限",
  "settings.separateDesktop.memoryHint": "別のデスクトップが実行中に使えるメモリの最大量です。",
  "settings.separateDesktop.memoryOption": "{gb} GB",
  "settings.separateDesktop.shares": "共有フォルダー: {names}",
  "settings.separateDesktop.internet": "このタスクではインターネットがオンです",
  "settings.separateDesktop.reset": "別のデスクトップをリセット",
  "settings.separateDesktop.resetHint":
    "コンテナーとその中に保存されたものをすべて削除します。共有したフォルダーには影響しません。",
  "blocks.folder.sd.explain.ro":
    "{persona} が、別のデスクトップにフォルダー内のファイルを読ませようとしています。",
  "blocks.folder.sd.explain.rw":
    "{persona} が、別のデスクトップにフォルダー内のファイルを読み書きさせようとしています。",
  "blocks.folder.sd.scope":
    "別のデスクトップは、このタスクの間だけこのフォルダーを見られます。このコンピューターの他のものは共有されず、他のツールにもこのフォルダーは渡りません。",
  "blocks.folder.sd.scope.once": "このタスクのみ",
  "settings.separateDesktop.limitMemory": "このシステムではメモリ上限が適用されません",
  "settings.separateDesktop.limitPids": "このシステムではプロセス数の上限が適用されません",
  "blocks.details.sdUnverified":
    "別のデスクトップでは、このページが本当に {origin} かどうか確認できません。タスクが開いた場所を信頼できる場合のみ続けてください。",
};
