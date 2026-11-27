import type { Catalogue } from "../../index.ts";

/** Simplify B9 strings (ja); merged into `../ja.ts`. */
export const simplifyB9: Partial<Catalogue> = {
  "simplify.b9.approval.expiresAt": "{time} に期限切れ",
  "simplify.b9.execHost.sandboxed": "サンドボックス内で実行されます。",
  "simplify.b9.execHost.noSandbox":
    "サンドボックスが設定されていないため、このコマンドはサンドボックスなしでのみ実行できます。設定するか、今回だけサンドボックスなしで実行してください。",
  "simplify.b9.execHost.noHostSandbox":
    "このコンピュータにはコマンド用のサンドボックスがないため、このコマンドはサンドボックスなしでのみ実行できます。今回だけ実行できます。",
  "simplify.b9.execHost.runOnce": "今回だけサンドボックスなしで実行",
  "simplify.b9.library.madeBy": "{name} が作成",
  "simplify.b9.library.task": "タスク",
  "simplify.b9.library.more": "その他のフィルタ",
};
