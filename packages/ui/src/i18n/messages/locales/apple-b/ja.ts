import type { Catalogue } from "../../index.ts";

/** Apple-design batch B (ja): plain approval cards and tool rows; merged into `../ja.ts`. */
export const appleB: Partial<Catalogue> = {
  "approvals.plain.run":
    "{who}が`{command}`を実行しようとしています{hasFolder, select, true {（{folder}内）} other {}}。",
  "approvals.plain.save":
    "{who}が{file}{hasFolder, select, true {（{folder}内）} other {}}を{mode, select, create {保存} other {変更}}しようとしています。",
  "approvals.plainWhy.commands": "コマンドは実行前に承認する設定になっています。",
  "approvals.plainWhy.yourRule": "先に確認するルールを設定しています。",
  "approvals.plainWhy.noSandbox": "安全なサンドボックスがまだ設定されていません。",
  "approvals.plainWhy.protectedFiles":
    "これらのファイルは保護されているため、Psycheは必ず確認します。",
  "approvals.plainWhy.push": "作業内容を公開するときは、必ずあなたの確認が必要です。",
  "approvals.plainWhy.machineFiles":
    "別のコンピュータ上のファイルを変更するときは、必ずあなたの確認が必要です。",
  "approvals.plainWhy.unknownTool": "このツールは、まだ承認していないコネクタのものです。",
  "approvals.plainWhy.connector": "このコネクタは、操作の前に確認します。",
  "approvals.plainWhy.outsideNew": "外部の内容を読んだ直後で、これは初めての操作です。",
  "approvals.plainWhy.outsideCommand":
    "外部の内容を読んだ直後で、このコマンドはフォルダの外に影響する可能性があります。",
  "blocks.toolRun.familyName":
    "{kind, select, command {コマンド} file {ファイル} web {ウェブ} mail {メール} calendar {カレンダー} drive {Drive} memory {メモリ} task {タスク} other {{name}}}",
  "blocks.toolRun.spoken":
    "{kind, select, command {コマンドを実行} write {ファイルを保存} edit {ファイルを編集} read {ファイルを読み込み} web {ウェブを検索} mail {メールを使用} calendar {カレンダーを使用} memory {メモリを使用} other {ツールを使用}}",
  "blocks.toolRun.line.save": "{file}{hasFolder, select, true {（{folder}内）} other {}}を保存",
  "approvals.plainWhy.outsideWorkspace": "Psycheが作業しているフォルダの外です。",
};
