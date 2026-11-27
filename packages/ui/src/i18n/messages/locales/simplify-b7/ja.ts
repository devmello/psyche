import type { Catalogue } from "../../index.ts";

/** Privacy, Browser and About simplified copy (ja); merged into `../ja.ts`. */
export const simplifyB7: Partial<Catalogue> = {
  "simplify.b7.about.doctorDescription":
    "Psyche、サンドボックス、権限、保管庫が動作しているか確認します。",
  "simplify.b7.doctor.psyche": "Psyche",
  "simplify.b7.browser.fromSetup": "セットアップで設定されているため、ここでは変更できません。",
  "simplify.b7.browser.advancedHint":
    "Chrome プロファイル、他のブラウザのサインイン、録画、プレビューポート",
  "simplify.b7.permissions.advancedHint": "Auto モードでのコマンド確認",
  "simplify.b7.updates.off":
    "このビルドでは更新がオフです。更新するには、Psyche を再ビルドして pnpm app:install を実行してください。",
};
