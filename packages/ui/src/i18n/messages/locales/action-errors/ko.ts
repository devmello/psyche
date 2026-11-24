import type { Catalogue } from "../../index.ts";

/** Failure messages for user actions (ko); merged into `../ko.ts`. */
export const actionErrors: Partial<Catalogue> = {
  "actionError.exportPerson": "이 사람의 데이터를 내보내지 못했어요 ({reason}).",
  "actionError.revokeGrant": "이 승인을 취소하지 못했어요 ({reason}). 아직 유효합니다.",
  "actionError.reindex": "검색 색인을 다시 만들지 못했어요 ({reason}).",
  "actionError.rerun": "이 자동화를 다시 실행하지 못했어요 ({reason}).",
  "actionError.stopResearch": "리서치를 멈추지 못했어요 ({reason}). 아직 진행 중입니다.",
  "actionError.unmute": "넛지를 다시 켜지 못했어요 ({reason}).",
  "actionError.language": "언어를 바꾸지 못했어요 ({reason}).",
  "actionError.transcriptMode": "전사 상세 수준을 바꾸지 못했어요 ({reason}).",
  "actionError.screenAskDestination": "화면 질문의 보낼 곳을 바꾸지 못했어요 ({reason}).",
  "actionError.takeOver": "가상 화면을 넘겨받지 못했어요 ({reason}).",
};
