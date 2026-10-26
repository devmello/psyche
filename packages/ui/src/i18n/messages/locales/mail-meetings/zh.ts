import type { Catalogue } from "../../index.ts";

/** Mail and meeting settings and onboarding strings (zh); merged into `../zh.ts`. */
export const mailMeetings: Partial<Catalogue> = {
  "settings.nav.mail": "邮件与会议",
  "settings.mail.title": "邮件与会议",
  "settings.mail.description":
    "设置 Wren 如何处理你的邮件和日历。它只会保存草稿并提出操作建议；未经你批准，不会发送、分享、接受或拒绝任何内容。",
  "settings.mail.quietHours": "免打扰时段请在“通知”中设置。",
  "settings.mail.loadFailed": "无法加载邮件与会议设置。",

  // Group titles
  "settings.mail.group.master": "一键设置",
  "settings.mail.group.accounts": "账户",
  "settings.mail.group.digest": "收件箱摘要",
  "settings.mail.group.followups": "跟进",
  "settings.mail.group.style": "写作风格",
  "settings.mail.group.scheduling": "日程安排",
  "settings.mail.group.prep": "会议准备",
  "settings.mail.group.notes": "会议笔记",
  "settings.mail.group.polling": "检查新邮件",

  // Master switches
  "settings.mail.paused.hint": "在你重新开启之前，停止所有邮件和会议任务。",
  "settings.mail.readOnly.hint":
    "摘要和会议准备照常送达。Wren 不会提出操作建议，也不会起草任何内容。",

  // Accounts
  "settings.mail.accounts.none": "尚未连接邮件账户。请在“连接器”中连接。",
  "settings.mail.accounts.use": "在摘要和跟进中使用 {account}",
  "settings.mail.accounts.connect": "打开连接器",

  // Inbox digest
  "settings.mail.digest.time": "时间",
  "settings.mail.digest.days": "日期",
  "settings.mail.digest.days.weekdays": "工作日",
  "settings.mail.digest.days.everyday": "每天",
  "settings.mail.digest.onlyWhenNeeded.hint":
    "没有需要处理的事时，摘要会静静放入动态，不会提醒你。",
  "settings.mail.digest.rules": "发件人规则",
  "settings.mail.digest.rulesHint": "哪些发件人始终归档、始终允许或需要审核。",
  "settings.mail.digest.openRules": "打开",
  "settings.mail.digest.openRulesAsk": "给我看一下 mail/RULES.md。",

  // Follow-ups
  "settings.mail.followups.waitDays": "等待多久后显示",
  "settings.mail.followups.days": "{n, plural, other {# 个工作日}}",
  "settings.mail.followups.showTwice.hint": "在两次摘要中出现后，就不再显示。",

  // Writing style
  "settings.mail.voice.learn.hint":
    "Wren 只读取你在已发送邮件中亲自写的内容，不含引用文字和签名。档案保存在这台 Mac 上的 mail/VOICE.md 中。",
  "settings.mail.voice.profile": "风格档案",
  "settings.mail.voice.view": "查看",
  "settings.mail.voice.edit": "编辑",
  "settings.mail.voice.reset": "重置",
  "settings.mail.voice.viewAsk": "给我看一下 mail/VOICE.md。",
  "settings.mail.voice.editAsk": "让我编辑 mail/VOICE.md。",
  "settings.mail.voice.resetAsk":
    "重置我的写作风格档案：删除 mail/VOICE.md 和 mail/voice-samples.jsonl。",
  "settings.mail.voice.localModel.hint": "用你的风格起草的内容不会离开这台 Mac。",
  "settings.mail.voice.localModel.none": "使用主模型",
  "settings.mail.voice.localModel.empty": "尚未设置本地模型。",

  // Scheduling
  "settings.mail.schedule.hours": "工作时间",
  "settings.mail.schedule.hoursHint": "来自 USER.md。只会在工作日的这段时间内提供时间段。",
  "settings.mail.schedule.hoursFrom": "开始",
  "settings.mail.schedule.hoursTo": "结束",
  "settings.mail.schedule.buffer.hint": "提供时间时，会议前后预留的间隔。",
  "settings.mail.schedule.minutes": "{n, plural, other {# 分钟}}",
  "settings.mail.schedule.noBuffer": "无",
  "settings.mail.schedule.focusTime.hint": "建议预留一段时间用于专注工作。",
  "settings.mail.schedule.link.hint": "可选。如果你有，会在回复中附上。",

  // Meeting prep
  "settings.mail.prep.scope.hint": "跳过只有你自己团队参加的会议。",
  "settings.mail.prep.leadMin": "会前多久开始准备",
  "settings.mail.prep.notifyMin": "开始前提醒我",
  "settings.mail.prep.saveToNotes.hint": "同时把准备笔记保存到你的笔记应用中。",
  "settings.mail.prep.dailyCap": "每天最多准备次数",
  "settings.mail.prep.calendars": "会议准备涵盖你在“连接器”中连接的日历。",

  // Meeting notes
  "settings.mail.notes.enabled.hint":
    "添加音频之前不会执行任何操作：语音备忘录、文件或你开始的录音。",
  "settings.mail.notes.folder": "录音文件夹",
  "settings.mail.notes.folder.hint": "Wren 可以读取的文件夹。请在“文件访问”中授权。",
  "settings.mail.notes.folder.placeholder": "~/Documents/Recordings",
  "settings.mail.notes.tasksApp": "将待办事项添加到",
  "settings.mail.notes.tasksApp.reminders": "提醒事项",
  "settings.mail.notes.tasksApp.things": "Things",
  "settings.mail.notes.recap.hint": "每次会议后，把总结邮件保存为草稿。",
  "settings.mail.notes.consent.hint": "在你开始的每次录音前显示。你可以口头说出，或粘贴到通话中。",
  "settings.mail.notes.consent.default": "我正在录音以便做笔记，可以吗？",
  "settings.mail.notes.cloud.hint":
    "转写内容包含他人的发言。关闭时，使用本地模型生成总结，或先询问你。",

  // Polling
  "settings.mail.poll.active": "你在使用时",
  "settings.mail.poll.idle": "其他时间",
  "settings.mail.poll.hint": "Wren 检查新邮件的频率。越频繁越耗电。",

  // Setting-key labels (docs/ui-audit.md: a raw key never shows at level 1)
  "settings.key.workflows.paused": "暂停所有邮件与会议工作流",
  "settings.key.workflows.readOnly": "只读（仅摘要和会议准备）",
  "settings.key.mail.accounts": "在摘要和跟进中使用 {account}",
  "settings.key.mail.digest.enabled": "收件箱摘要",
  "settings.key.mail.digest.time": "摘要时间",
  "settings.key.mail.digest.days": "摘要日期",
  "settings.key.mail.digest.onlyWhenNeeded": "仅在有事需要你处理时提醒",
  "settings.key.mail.followups.enabled": "跟踪你在等待的回复",
  "settings.key.mail.followups.waitDays": "跟进等待时间",
  "settings.key.mail.followups.showTwice": "每条跟进最多显示两次",
  "settings.key.mail.voice.enabled": "从已发送邮件中学习",
  "settings.key.mail.draft.localModel": "用本地模型起草",
  "settings.key.mail.schedule.hoursStart": "工作开始时间",
  "settings.key.mail.schedule.hoursEnd": "工作结束时间",
  "settings.key.mail.schedule.bufferMin": "会议间隔",
  "settings.key.mail.schedule.focusTime": "建议专注时间",
  "settings.key.mail.schedulingLink": "预约链接",
  "settings.key.mail.poll.activeMin": "使用时的邮件检查",
  "settings.key.mail.poll.idleMin": "其他时间的邮件检查",
  "settings.key.meetings.prep.enabled": "会议准备",
  "settings.key.meetings.prep.scope": "仅限与我所在域名之外的人开的会议",
  "settings.key.meetings.prep.leadMin": "准备提前量",
  "settings.key.meetings.prep.notifyMin": "准备提醒提前量",
  "settings.key.meetings.prep.saveToNotes": "同时将准备内容存入“备忘录”",
  "settings.key.meetings.prep.dailyCap": "每天最多准备次数",
  "settings.key.meetings.notes.enabled": "根据录音生成会议笔记",
  "settings.key.meetings.notes.folder": "录音文件夹",
  "settings.key.meetings.notes.tasksApp": "将待办事项添加到",
  "settings.key.meetings.notes.recapDraft": "起草总结邮件",
  "settings.key.meetings.notes.consentLine": "录音同意声明",
  "settings.key.meetings.notes.cloudSummary": "用云端模型生成总结",

  // Onboarding decision screen (§7.5)
  "onboarding.step.mail": "邮件与会议",
  "onboarding.mail.title": "{name}可以帮你跟上邮件和会议",
  "onboarding.mail.lead":
    "选择你想要的功能。点击继续之前不会运行任何内容，你也可以随时在设置中更改。",
  "onboarding.mail.digest": "每天早上 7:30 的收件箱摘要",
  "onboarding.mail.digestHint": "每天一份摘要，告诉你哪些事需要处理。绝不会发送任何内容。",
  "onboarding.mail.prep": "在与团队以外的人开会前准备笔记",
  "onboarding.mail.prepHint": "对方是谁、有哪些未决事项、上次聊了什么。",
  "onboarding.mail.followups": "跟踪你在等待的回复",
  "onboarding.mail.followupsHint": "只显示在摘要中，不会另外提醒。",
  "onboarding.mail.voice": "从已发送邮件中学习我的写作风格",
  "onboarding.mail.voiceHint":
    "只读取你亲自写的内容，不含引用文字和签名。内容仅保存在这台 Mac 上，你可以查看、编辑或重置。",
  "onboarding.mail.notes": "根据录音生成会议笔记",
  "onboarding.mail.notesHint":
    "添加音频之前不会执行任何操作。音频和转写内容绝不会被上传或用于训练。",
  "onboarding.mail.summary": "{n, plural, =0 {尚未开启任何功能} other {已开启 # 项功能}}",
  "onboarding.mail.done": "邮件与会议",
  "onboarding.mail.doneOff": "已关闭。你可以在设置中开启。",
  "onboarding.mail.doneOn": "{n, plural, other {已开启 # 个工作流}}",
  "settings.mail.schedule.link.placeholder": "https://",
};
