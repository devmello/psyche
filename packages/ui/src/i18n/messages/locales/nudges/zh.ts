import type { Catalogue } from "../../index.ts";

/** nudges strings (zh); merged into `../zh.ts`. */
export const nudges: Partial<Catalogue> = {
  "settings.key.nudges.enabled": "关系提醒",
  "settings.key.nudges.consentedAt": "关系提醒授权",
  "settings.key.nudges.sensitivity": "提醒频率",
  "settings.key.nudges.phrasing": "改写提醒建议",
  "nudges.kind": "保持联系",
  "nudges.draftReply": "起草回复",
  "nudges.draftMessage": "起草消息",
  "nudges.snooze": "稍后提醒",
  "nudges.snoozeWeek": "一周后",
  "nudges.snoozeMonth": "一个月后",
  "nudges.mutePerson": "不再提醒此人",
  "nudges.done": "完成",
  "nudges.overdue": "已逾期",
  "nudges.moreActions": "更多处理方式：{name}",
  "nudges.result.done": "已标记为完成。",
  "nudges.result.snooze_week": "已推迟一周。",
  "nudges.result.snooze_month": "已推迟一个月。",
  "nudges.result.mute_person": "不再提醒关于{name}的事。你可以在其页面重新开启。",
  "nudges.gone": "这里已没有需要做的事。",
  "nudges.failed": "未能存储：{reason}",
  "nudges.draft.unanswered":
    "帮我回复{name}。对方最近给我的{channel, select, mail {邮件} other {消息}}是 {days} 天前的，我还没有回复。请先查看这段对话，再起草一条简短的回复供我阅读。不要发送任何内容。",
  "nudges.draft.drift":
    "我有一阵子没和{name}联系了。请起草一条简短、亲切的消息，供我发出去叙叙旧。不要发送任何内容。",
  "nudges.draft.birthday":
    "{name}的重要日子快到了（{date}）。请起草一条简短、亲切的消息供我发送。不要发送任何内容。",
  "nudges.draft.promise":
    "{text} 帮我跟进：起草一条关于此事、发给{name}的简短消息。不要发送任何内容。",
  "nudges.starters.title": "可以聊的话题",
  "nudges.draft.starters": "根据 Psyche 掌握的资料，我可以聊的话题（只用这些，不要编造其他内容）：",
  "nudges.settings.phrasing": "用我的模型改写建议",
  "nudges.settings.phrasingHint": "使用你为“全部记忆”选择的模型，用更友好的措辞来表达。默认关闭。",
  "nudges.person.title": "保持联系",
  "nudges.person.none": "没有需要跟进的事。",
  "nudges.person.muted": "已关闭对{name}的提醒。",
  "nudges.person.unmute": "重新开启提醒",
  "nudges.settings.title": "保持联系",
  "nudges.settings.description": "温和地提醒你联系久未联系的人、生日，以及你许下的承诺。",
  "nudges.settings.enabled": "提醒我保持联系",
  "nudges.settings.enabledHint": "早间简报中最多三条，另有安静的动态卡片。绝不会替你发送任何内容。",
  "nudges.settings.sensitivity": "频率",
  "nudges.settings.sensitivityHint": "一条消息要等多久，Psyche 才会提醒。",
  "nudges.settings.low": "温和",
  "nudges.settings.normal": "正常",
  "nudges.settings.high": "积极",
  "nudges.settings.quietHours": "卡片会等到“设置 → 通用 → 通知”中的免打扰时段结束后再出现。",
  "nudges.consent.title": "开启关系提醒？",
  "nudges.consent.body":
    "Psyche 会查看你与通信对象上次往来的时间（只看日期，不看内容）、你确认过的生日，以及你亲口许下的承诺。",
  "nudges.consent.rules":
    "你排除的人绝不会出现，敏感信息绝不会使用，每条提醒只是一句带姓名和天数的简单话。你可以用“不再提醒此人”将任何人静音，也可以随时关闭。",
  "nudges.consent.confirm": "开启",
  "nudges.consent.cancel": "暂不",
};
