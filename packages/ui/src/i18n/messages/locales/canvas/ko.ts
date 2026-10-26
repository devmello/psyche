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
  "canvas.map": "지도",
  "map.label": "지도: {title}",
  "map.untitled": "지도",
  "map.list": "장소",
  "map.openLink": "링크 열기",
  "map.empty": "표시할 장소가 없습니다.",
  "map.tilesOff": "설정에서 지도 타일이 꺼져 있습니다. 목록을 표시합니다.",
  "map.tilesFailed": "지도를 불러오지 못했습니다. 목록을 표시합니다.",
  "map.showMap": "지도 보기",
  "map.showList": "목록 보기",
  "map.card": "지도: {title}",
  "map.meta": "{count, plural, other {#개 장소}} · {date}",
  "map.openCanvas": "캔버스에서 열기",
  "map.invalid": "이 지도를 읽을 수 없습니다.",
  "map.gesture.windows": "Ctrl + 스크롤로 지도를 확대/축소하세요",
  "map.gesture.mac": "⌘ + 스크롤로 지도를 확대/축소하세요",
  "map.gesture.mobile": "두 손가락으로 지도를 움직이세요",
  "settings.map.title": "지도",
  "settings.map.privacy":
    "지도를 표시하면 보고 있는 영역을 타일 서버에 요청하므로 서버가 대략 어디를 보는지 알 수 있습니다. 타일을 끄면 장소를 목록으로만 보여 주며, 직접 운영하는 타일 서버를 쓸 수도 있습니다.",
  "settings.map.tiles": "지도 타일 표시",
  "settings.map.tilesHint": "끄면 지도 요청 없이 장소를 목록으로 보여 줍니다.",
  "settings.map.style": "타일 서버 스타일 URL",
  "settings.map.styleHint":
    "MapLibre 스타일 JSON URL(예: 내 서버). 비워 두면 무료 OpenFreeMap 타일을 사용합니다(https만, localhost는 http 가능).",
  "settings.map.styleDark": "스타일 URL(다크)",
  "settings.map.styleDarkHint":
    "선택 사항. 비워 두면 다크 모드에서도 위 스타일 또는 OpenFreeMap 다크 스타일을 사용합니다.",
};
