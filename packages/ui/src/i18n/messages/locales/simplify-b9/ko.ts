import type { Catalogue } from "../../index.ts";

/** Simplify B9 strings (ko); merged into `../ko.ts`. */
export const simplifyB9: Partial<Catalogue> = {
  "simplifyB9.approval.expiresAt": "{time}에 만료",
  "simplifyB9.execHost.sandboxed": "샌드박스에서 실행됩니다.",
  "simplifyB9.execHost.noSandbox":
    "샌드박스가 설정되지 않아 이 명령은 샌드박스 없이만 실행할 수 있습니다. 샌드박스를 설정하거나 이번 한 번만 샌드박스 없이 실행하세요.",
  "simplifyB9.execHost.noHostSandbox":
    "이 컴퓨터에는 명령용 샌드박스가 없어 이 명령은 샌드박스 없이만 실행할 수 있습니다. 이번 한 번만 실행할 수 있습니다.",
  "simplifyB9.execHost.runOnce": "이번 한 번만 샌드박스 없이 실행",
  "simplifyB9.library.madeBy": "{name}이(가) 만듦",
  "simplifyB9.library.task": "작업",
  "simplifyB9.library.more": "필터 더 보기",
};
