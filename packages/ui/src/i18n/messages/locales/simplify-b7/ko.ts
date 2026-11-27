import type { Catalogue } from "../../index.ts";

/** Privacy, Browser and About simplified copy (ko); merged into `../ko.ts`. */
export const simplifyB7: Partial<Catalogue> = {
  "simplify.b7.about.doctorDescription":
    "Psyche, 샌드박스, 권한, 보관함이 제대로 작동하는지 확인합니다.",
  "simplify.b7.doctor.psyche": "Psyche",
  "simplify.b7.browser.fromSetup": "설정에서 지정되어 있어 여기서는 변경할 수 없습니다.",
  "simplify.b7.browser.advancedHint": "Chrome 프로필, 다른 브라우저의 로그인, 녹화, 미리보기 포트",
  "simplify.b7.permissions.advancedHint": "Auto 모드의 명령 검토",
  "simplify.b7.updates.off":
    "이 빌드에서는 업데이트가 꺼져 있습니다. 업데이트하려면 Psyche를 다시 빌드하고 pnpm app:install을 실행하세요.",
};
