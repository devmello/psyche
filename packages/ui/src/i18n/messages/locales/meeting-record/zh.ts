import type { Catalogue } from "../../index.ts";

/** meeting-record strings (zh); merged into `../zh.ts`. */
export const meetingRecord: Partial<Catalogue> = {
  "meetingRecord.palette": "录制会议…",
  "meetingRecord.title": "录制这场会议？",
  "meetingRecord.intro":
    "开始前请告知所有人。可以口头说明，或粘贴到聊天里。Psyche 从不加入通话，只在你确认后才录制。",
  "meetingRecord.copy": "复制",
  "meetingRecord.copied": "已复制",
  "meetingRecord.confirm": "我已告知所有人",
  "meetingRecord.cancel": "取消",
  "meetingRecord.privacy":
    "音频保留在你的 Psyche 中，在那里转为笔记，绝不会上传到别处，也不会用于训练。",
  "meetingRecord.unavailable": "录制需要一种把音频转成笔记的方式（Mac 助手），但它未连接。",
  "meetingRecord.micDenied": "Psyche 无法使用麦克风。请在“系统设置”中允许。",
  "meetingRecord.failed": "Psyche 无法录制这场会议。",
  "meetingRecord.pill": "正在录制会议 · {time}",
  "meetingRecord.stop": "停止",
  "meetingRecord.stopping": "正在存储…",
  "meetingRecord.notes.processing": "正在撰写笔记…",
  "meetingRecord.notes.done": "笔记已在主页就绪。",
  "meetingRecord.notes.needs_permission": "笔记正在等你同意使用云端模型。",
  "meetingRecord.notes.failed": "Psyche 无法根据这段录音撰写笔记。",
};
