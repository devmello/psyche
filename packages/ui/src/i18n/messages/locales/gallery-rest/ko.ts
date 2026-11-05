import type { Catalogue } from "../../index.ts";

/** gallery strings not covered elsewhere (ko); merged into `../ko.ts`. */
export const galleryRest: Partial<Catalogue> = {
  "gallery.intro":
    "사용해 볼 것을 선택하십시오. 모든 커넥터는 실행 전에 확인하며 언제든 삭제할 수 있습니다.",
  "gallery.search": "커넥터 검색",
  "gallery.noMatch":
    "일치하는 항목이 없습니다. 다른 단어를 시도하거나 직접 만든 MCP 서버를 추가하십시오.",
  "gallery.back": "모든 커넥터",
  "gallery.getKey": "발급받는 곳.",
  "gallery.keyStaysInVault": "보관함에 저장되며 서버 설정에는 저장되지 않습니다.",
  "gallery.tryAsking": "추가한 뒤 이렇게 요청해 보십시오:",
  "gallery.custom.desc": "모든 MCP 서버: 샌드박스에서 실행하는 명령 또는 웹 주소.",
  "gallery.badge.builtIn": "내장",
  "gallery.badge.official": "공식",
  "gallery.badge.community": "커뮤니티",
  "gallery.category.popular": "인기",
  "gallery.category.files": "파일 및 지식",
  "gallery.category.dev": "개발",
  "gallery.category.productivity": "생산성",
  "gallery.category.comms": "메시지 및 메일",
  "gallery.category.web": "웹",
  "gallery.category.everyday": "일상",
  "gallery.category.finance": "금융",
  "gallery.category.custom": "직접 추가",
  "gallery.builtin.google": "Gmail, Google 캘린더, 드라이브.",
  "gallery.builtin.microsoft": "Outlook 메일과 캘린더.",
  "gallery.builtin.imap": "IMAP을 지원하는 모든 메일 계정.",
  "gallery.builtin.appleNotes": "Apple 메모의 메모를 읽고 추가합니다.",
  "gallery.builtin.appleReminders": "미리 알림을 확인하고 만듭니다.",
  "gallery.builtin.appleCalendar": "캘린더를 확인하고 일정을 추가합니다.",
  "gallery.builtin.appleMail": "Apple Mail의 메일을 읽고 초안을 작성합니다.",
  "gallery.builtin.appleShortcuts": "선택한 단축어를 실행합니다.",
  "gallery.builtin.obsidian": "Obsidian Vault를 검색하고 읽습니다.",
  "gallery.builtin.slack": "Slack에서 Psyche와 대화합니다. 채널에서 설정합니다.",
  "gallery.preset.github.desc": "저장소, 이슈, 풀 리퀘스트를 둘러봅니다.",
  "gallery.preset.github.example": "제 리뷰를 기다리는 풀 리퀘스트는 무엇인가요?",
  "gallery.preset.github.field.token.label": "개인 액세스 토큰",
  "gallery.preset.github.field.token.help":
    "Psyche에 보여 주고 싶은 저장소로만 제한한 세분화된 토큰입니다.",
  "gallery.preset.gitlab.desc":
    "GitLab.com의 프로젝트, 머지 리퀘스트, 이슈. 연결할 때 로그인합니다.",
  "gallery.preset.gitlab.example": "메인 프로젝트의 열려 있는 머지 리퀘스트를 요약해 줘.",
  "gallery.preset.git.desc": "로컬 저장소 하나의 기록, 브랜치, 차이를 읽습니다.",
  "gallery.preset.git.example": "이 저장소에서 지난 1주일 동안 무엇이 바뀌었나요?",
  "gallery.preset.git.field.repo.label": "저장소 폴더",
  "gallery.preset.git.field.repo.help":
    "이 Mac의 Git 저장소 폴더입니다. Psyche가 기록과 차이를 읽을 수 있습니다.",
  "gallery.preset.sentry.desc":
    "Sentry 프로젝트의 오류와 이슈를 조사합니다. 연결할 때 로그인합니다.",
  "gallery.preset.sentry.example": "이번 주에 가장 자주 발생한 미해결 오류는 무엇인가요?",
  "gallery.preset.linear.desc": "이슈와 프로젝트를 찾고 업데이트합니다. 연결할 때 로그인합니다.",
  "gallery.preset.linear.example": "제게 할당되어 있고 이번 주가 기한인 이슈는 무엇인가요?",
  "gallery.preset.jira.desc": "Jira 이슈와 Confluence 페이지를 검색합니다. 연결할 때 로그인합니다.",
  "gallery.preset.jira.example": "어제 업데이트한 Jira 티켓을 보여 줘.",
  "gallery.preset.notion.desc":
    "Notion 워크스페이스의 페이지를 검색, 읽기, 편집합니다. 연결할 때 로그인합니다.",
  "gallery.preset.notion.example": "지난주 화요일 회의 메모를 Notion에서 찾아 줘.",
  "gallery.preset.todoist.desc":
    "Todoist의 작업과 프로젝트를 확인하고 관리합니다. 연결할 때 로그인합니다.",
  "gallery.preset.todoist.example": "Todoist에서 오늘 기한인 항목은 무엇인가요?",
  "gallery.preset.airtable.desc": "Airtable 베이스의 레코드를 읽고 업데이트합니다.",
  "gallery.preset.airtable.example": "Projects 베이스에서 차단됨으로 표시된 레코드를 나열해 줘.",
  "gallery.preset.airtable.field.key.label": "개인 액세스 토큰",
  "gallery.preset.airtable.field.key.help": "사용할 베이스를 읽을 수 있는 토큰을 만드십시오.",
  "gallery.preset.fetch.desc": "웹 페이지를 가져와 일반 텍스트로 읽습니다.",
  "gallery.preset.fetch.example": "이 페이지를 읽고 핵심 내용 세 가지를 알려 줘.",
  "gallery.preset.fetch.field.sites.label": "접근할 수 있는 웹사이트",
  "gallery.preset.fetch.field.sites.help":
    "ko.wikipedia.org 같은 호스트 이름을 쉼표로 구분해 입력합니다. 비워 두면 패키지 레지스트리에만 접속할 수 있습니다.",
  "gallery.preset.braveSearch.desc": "Brave로 웹, 뉴스, 이미지를 검색합니다.",
  "gallery.preset.braveSearch.example": "오픈 소스 AI 모델에 관한 이번 주 뉴스를 검색해 줘.",
  "gallery.preset.braveSearch.field.key.label": "API 키",
  "gallery.preset.braveSearch.field.key.help": "사용해 보기에는 무료 플랜으로 충분합니다.",
  "gallery.preset.playwright.desc": "별도의 브라우저를 조작해 페이지를 읽고 양식을 채웁니다.",
  "gallery.preset.playwright.example": "example.com을 열어 페이지 내용을 알려 줘.",
  "gallery.preset.playwright.field.sites.label": "접근할 수 있는 웹사이트",
  "gallery.preset.playwright.field.sites.help":
    "열 수 있는 호스트 이름을 쉼표로 구분해 입력합니다. 비워 두면 오프라인으로 유지됩니다.",
  "gallery.preset.firecrawl.desc": "웹사이트를 스크레이핑하고 크롤링해 깔끔한 텍스트로 만듭니다.",
  "gallery.preset.firecrawl.example": "example.com의 문서 사이트를 크롤링해 주요 섹션을 요약해 줘.",
  "gallery.preset.firecrawl.field.key.label": "API 키",
  "gallery.preset.firecrawl.field.key.help":
    "사용자를 대신해 사이트를 스크레이핑하고 크롤링하는 데 사용합니다.",
  "gallery.preset.time.desc": "현재 시간을 가져오고 시간대를 변환합니다.",
  "gallery.preset.time.example": "샌프란시스코가 오전 9시일 때 서울은 몇 시인가요?",
  "gallery.preset.homeAssistant.desc": "Home Assistant에서 공개한 기기를 확인하고 제어합니다.",
  "gallery.preset.homeAssistant.example": "지금 켜져 있는 조명은 무엇인가요?",
  "gallery.preset.homeAssistant.field.url.label": "서버 주소",
  "gallery.preset.homeAssistant.field.url.help":
    "Model Context Protocol Server 통합을 켠 다음 설정 → 시스템 → AI에서 해당 주소를 복사하십시오. https://로 시작해야 합니다.",
  "gallery.preset.stripe.desc":
    "고객, 결제, 잔액을 조회합니다. 읽기 전용이며 제한된 키로 설정됩니다.",
  "gallery.preset.stripe.example": "지난 30일 동안 얼마를 청구했나요?",
  "gallery.preset.stripe.field.key.label": "제한된 키",
  "gallery.preset.stripe.field.key.help":
    "읽기 권한만 있는 제한된 키(rk_로 시작)를 만드십시오. 다른 키는 여기서 거부됩니다.",
};
