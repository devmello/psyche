import type { Catalogue } from "../../index.ts";

/** Overview Growth and People & projects strings (ko); merged into `../ko.ts`. */
export const overviewGrowth: Partial<Catalogue> = {
  "overview.meta.7d": "최근 7일",
  "overview.meta.30d": "최근 30일",
  "overview.meta.all": "전체 기간",
  "overview.growth.loading": "성장 불러오는 중",
  "overview.growth.loadFailed": "성장을 불러오지 못했습니다",
  "overview.growth.empty": "이 기간에는 아직 배운 것이 없습니다.",
  "overview.growth.counts": "이 기간의 레슨",
  "overview.growth.learned": "{n, plural, other {레슨 #개 학습}}",
  "overview.growth.refined": "{n, plural, other {#개 개선}}",
  "overview.growth.confirmed": "{n, plural, other {#개 확인}}",
  "overview.growth.forgotten": "{n, plural, other {#개 잊음}}",
  "overview.growth.milestones": "이정표",
  "overview.growth.seeAll": "모든 레슨 보기",
  "overview.growth.sheetTitle": "{agent}이(가) 배운 것",
  "overview.growth.evidenceTitle": "“{metric}”의 근거가 된 이벤트",
  "overview.growth.card.thisWeek": "이번 주 레슨 ({n})",
  "overview.growth.card.week": "{date} 주간의 레슨 ({n})",
  "overview.growth.card.review": "검토",
  "overview.growth.card.sheetTitle": "이번 주 {agent}이(가) 배운 것",
  "overview.growth.card.sheetDescription":
    "{agent}이(가) 알게 된 것을 유지하거나 편집하거나 잊게 하세요.",
  "overview.people.loading": "사람과 프로젝트 불러오는 중",
  "overview.people.loadFailed": "사람과 프로젝트를 불러오지 못했습니다",
  "overview.people.paused":
    "사람과 프로젝트 그래프가 일시 중지되어 아무것도 기록되지 않습니다. 여기에 표시하려면 설정에서 켜세요.",
  "overview.people.empty":
    "이 기간에는 아직 아무도 없습니다. {agent}이(가) 나를 대신해 함께 일하면 사람과 프로젝트가 여기에 나타납니다.",
  "overview.people.map": "사람 및 프로젝트 지도",
  "overview.people.mapHint":
    "화살표 키로 상호작용이 많은 순서대로 사람과 프로젝트 사이를 이동합니다. Enter로 엽니다.",
  "overview.people.caption":
    "가운데에서부터 이번 주, 이번 달, 그 이전 순의 고리입니다. 클수록 상호작용이 많습니다. 원은 사람, 사각형은 프로젝트와 조직입니다.",
  "overview.people.you": "나",
  "overview.people.kind.person": "사람",
  "overview.people.kind.org": "조직",
  "overview.people.kind.project": "프로젝트",
  "overview.people.kind.place": "장소",
  "overview.people.interactions": "{n, plural, other {상호작용 #회}}",
  "overview.people.openLoops": "{n, plural, other {열린 항목 #개}}",
  "overview.people.last": "마지막 상호작용 {when}",
  "overview.people.node": "{name}, {kind}. {interactions}. 마지막 상호작용 {when}. {loops}.",
  "overview.people.detailHint":
    "사람이나 프로젝트에 포인터를 올리거나 포커스하면 자세한 내용이 표시됩니다.",
  "overview.people.counts":
    "{people, plural, other {사람 #명}} · {projects, plural, other {프로젝트 #개}} · {loops, plural, other {열린 항목 #개}}",
  "overview.people.ranked": "{name} {n}",
  "overview.people.showList": "목록으로 보기",
  "overview.people.showMap": "지도 보기",
  "overview.people.seeAll": "모두 보기",
  "overview.people.list": "사람과 프로젝트 (상호작용 많은 순)",
  "overview.people.table.name": "이름",
  "overview.people.table.kind": "종류",
  "overview.people.table.interactions": "상호작용",
  "overview.people.table.last": "마지막 상호작용",
  "overview.people.table.loops": "열린 항목",
};
