import type { Catalogue } from "../../index.ts";

/** Simplify B9 strings (ja); merged into `../ja.ts`. */
export const simplifyB9: Partial<Catalogue> = {
  "simplifyB9.approval.expiresAt": "{time} に期限切れ",
  "simplifyB9.execHost.sandboxed": "サンドボックス内で実行されます。",
  "simplifyB9.execHost.noSandbox":
    "サンドボックスが設定されていないため、このコマンドはサンドボックスなしでのみ実行できます。設定するか、今回だけサンドボックスなしで実行してください。",
  "simplifyB9.execHost.noHostSandbox":
    "このコンピュータにはコマンド用のサンドボックスがないため、このコマンドはサンドボックスなしでのみ実行できます。今回だけ実行できます。",
  "simplifyB9.execHost.runOnce": "今回だけサンドボックスなしで実行",
  "simplifyB9.library.madeBy": "{name} が作成",
  "simplifyB9.library.task": "タスク",
  "simplifyB9.library.more": "その他のフィルタ",
};
