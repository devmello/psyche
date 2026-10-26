import type { Catalogue } from "../../index.ts";

/** Output canvas strings (ko); merged into `../ko.ts`. */
export const canvas: Partial<Catalogue> = {
  "canvas.chart": "차트",
  "canvas.htmlOff":
    "신뢰할 수 없는 콘텐츠에서 온 것이라 미리보기가 꺼져 있습니다. 신뢰할 때만 실행하세요. 네트워크가 없는 샌드박스에서 실행됩니다.",
  "canvas.htmlRun": "실행",
  "canvas.htmlNoPreview": "이 호스트에서는 HTML을 미리 볼 수 없어 소스를 표시합니다.",
  "canvas.label": "캔버스: {title}",
  "canvas.recents": "최근 결과물",
  "canvas.loading": "불러오는 중…",
  "canvas.missing": "Psyche에서 이 결과물을 불러오지 못했습니다.",
  "canvas.untrusted": "신뢰할 수 없는 콘텐츠에서 생성됨",
  "canvas.version": "버전",
  "canvas.versionOption":
    "v{version} · {author, select, user {나} specialist {전문가} other {Psyche}} · {time}",
  "canvas.copy": "복사",
  "canvas.copied": "복사됨",
  "canvas.download": "다운로드",
  "canvas.restore": "새 버전으로 복원",
  "canvas.oldVersion": "버전 {version}(읽기 전용).",
  "canvas.conflict":
    "편집하는 동안 변경되어 편집 내용이 저장되지 않았습니다. 최신 버전에서 다시 시도하세요.",
  "canvas.saveFailed": "저장하지 못했습니다: {message}",
};
