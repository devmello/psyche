import type { Catalogue } from "../../index.ts";

/** Apple-design batch B (ko): plain approval cards and tool rows; merged into `../ko.ts`. */
export const appleB: Partial<Catalogue> = {
  "approvals.plain.run":
    "{who}이(가) `{command}`을(를) 실행하려고 해요{hasFolder, select, true { ({folder} 안)} other {}}.",
  "approvals.plain.save":
    "{who}이(가) {file}{hasFolder, select, true { ({folder} 안)} other {}}을(를) {mode, select, create {저장} other {변경}}하려고 해요.",
  "approvals.plainWhy.commands": "명령어는 실행 전에 승인하도록 설정했어요.",
  "approvals.plainWhy.yourRule": "먼저 물어보도록 규칙을 정해 두었어요.",
  "approvals.plainWhy.noSandbox": "안전한 샌드박스가 아직 설정되지 않았어요.",
  "approvals.plainWhy.protectedFiles": "이 파일은 보호되어 있어서 Psyche가 항상 먼저 물어봐요.",
  "approvals.plainWhy.push": "작업을 게시할 때는 항상 확인이 필요해요.",
  "approvals.plainWhy.machineFiles": "다른 컴퓨터의 파일을 바꿀 때는 항상 확인이 필요해요.",
  "approvals.plainWhy.unknownTool": "이 도구는 아직 승인하지 않은 커넥터에서 왔어요.",
  "approvals.plainWhy.connector": "이 커넥터는 실행하기 전에 먼저 물어봐요.",
  "approvals.plainWhy.outsideNew": "외부에서 가져온 내용을 읽은 뒤이고, 이 작업은 처음이에요.",
  "approvals.plainWhy.outsideCommand":
    "외부에서 가져온 내용을 읽은 뒤이고, 이 명령어는 폴더 밖까지 영향을 줄 수 있어요.",
  "blocks.toolRun.familyName":
    "{kind, select, command {명령어} file {파일} web {웹} mail {이메일} calendar {캘린더} drive {Drive} memory {메모리} task {작업} other {{name}}}",
  "blocks.toolRun.spoken":
    "{kind, select, command {명령어를 실행했어요} write {파일을 저장했어요} edit {파일을 편집했어요} read {파일을 읽었어요} web {웹을 검색했어요} mail {이메일을 사용했어요} calendar {캘린더를 사용했어요} memory {메모리를 사용했어요} other {도구를 사용했어요}}",
  "blocks.toolRun.line.save": "{file}{hasFolder, select, true { ({folder} 안)} other {}} 저장",
};
