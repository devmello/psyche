import type { Catalogue } from "../../index.ts";

/** meetingRecord strings not covered elsewhere (ko); merged into `../ko.ts`. */
export const meetingRecordRest: Partial<Catalogue> = {
  "meetingRecord.palette": "회의 녹음…",
  "meetingRecord.title": "이 회의를 녹음하시겠습니까?",
  "meetingRecord.intro":
    "시작하기 전에 모두에게 알리십시오. 말로 알리거나 대화창에 붙여넣으십시오. Psyche는 통화에 참여하지 않으며 확인하기 전에는 녹음하지 않습니다.",
  "meetingRecord.copy": "복사",
  "meetingRecord.copied": "복사됨",
  "meetingRecord.confirm": "모두에게 알렸습니다",
  "meetingRecord.cancel": "취소",
  "meetingRecord.privacy":
    "오디오는 사용자의 Psyche 안에 머물며 그곳에서 노트로 변환됩니다. 다른 곳에 업로드되거나 학습에 사용되지 않습니다.",
  "meetingRecord.unavailable":
    "녹음하려면 오디오를 노트로 변환하는 수단(Mac 도우미)이 필요한데 연결되어 있지 않습니다.",
  "meetingRecord.micDenied": "Psyche가 마이크를 사용할 수 없습니다. 시스템 설정에서 허용하십시오.",
  "meetingRecord.failed": "Psyche가 이 회의를 녹음하지 못했습니다.",
  "meetingRecord.pill": "회의 녹음 중 · {time}",
  "meetingRecord.stop": "중지",
  "meetingRecord.stopping": "저장 중…",
  "meetingRecord.notes.processing": "노트를 작성하는 중…",
  "meetingRecord.notes.done": "노트가 홈에 준비되었습니다.",
  "meetingRecord.notes.needs_permission": "클라우드 모델 사용에 대한 승인을 기다리고 있습니다.",
  "meetingRecord.notes.failed": "Psyche가 이 녹음으로 노트를 작성하지 못했습니다.",
};
