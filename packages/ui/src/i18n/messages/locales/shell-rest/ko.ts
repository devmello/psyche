import type { Catalogue } from "../../index.ts";

/** shell strings not covered elsewhere (ko); merged into `../ko.ts`. */
export const shellRest: Partial<Catalogue> = {
  "shell.rail.scheduled": "예약됨",
  "shell.rail.waiting": "{label}, {n, number}건이 확인을 기다리는 중",
  "shell.palette.addMcp": "MCP 서버 추가",
  "shell.palette.settingsSection": "설정 → {section}",
  "shell.palette.librarySection": "라이브러리 → {section}",
  "shell.palette.canDo": "무엇을 할 수 있나요?",
  "shell.palette.rerunSetup": "설정 다시 실행",
  "shell.palette.you": "개요 열기 (활동 및 성장)",
  "shell.palette.briefInstructions": "홈 → 브리핑 지침",
  "shell.palette.fullSearch": "전체 검색 열기",
  "shell.palette.keywords.feedInstructions": "브리핑 데일리 무엇을 쓸지 주제 brief daily topics",
  "shell.palette.scheduledRuns": "예약됨 → 실행",
  "shell.palette.memoryReview": "메모리 → 검토",
  "shell.palette.keywords.settings": "환경설정 옵션 구성 preferences options",
  "shell.palette.keywords.canDo": "도움말 기능 예시 시도 아이디어 help capabilities examples",
  "shell.palette.keywords.rerunSetup": "온보딩 설정 환영 onboarding setup welcome",
  "shell.palette.keywords.approvals": "권한 결정 확인 필요 permissions approvals",
  "shell.palette.keywords.memoryReview": "기억 사실 후속 조치 사람 격리 검토 remember facts review",
  "shell.palette.memoryKind": "메모리 → {kind}",
  "shell.palette.keywords.memoryPeople":
    "연락처 친구 가족 동료 관계 연락 유지 contacts friends family",
  "shell.palette.keywords.memoryProjects":
    "과정 수업 직업 프로젝트 진행 중 courses jobs initiatives",
  "shell.palette.keywords.memoryDue":
    "할 일 작업 마감 기한 기한 지남 숙제 과제 청구서 월세 갱신 세금 집안일 결과물 제출 todo deadlines due overdue homework",
  "shell.palette.keywords.memoryEvents":
    "캘린더 회의 약속 일정 여행 행사 calendar meetings appointments trips",
  "shell.palette.addTodo": "할 일 추가",
  "shell.palette.keywords.addTodo":
    "새로운 할 일 작업 숙제 과제 마감 기한 알림 만들기 new todo task homework deadline",
  "shell.palette.addProject": "프로젝트 추가",
  "shell.palette.keywords.addProject":
    "새로운 프로젝트 과정 수업 직업 만들기 추적 new project course class job",
  "shell.browser.open": "브라우저 열기",
  "shell.search.keyCmdL": "⌘L",
  "shell.search.keyCtrlL": "Ctrl L",
};
