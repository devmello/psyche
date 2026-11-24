import type { Catalogue } from "../../index.ts";

/** Approval-friction and person-interaction strings (zh); merged into `../zh.ts`. */
export const friction: Partial<Catalogue> = {
  "friction.title": "审批打扰",
  "friction.hint": "Psyche 在行动前停下来询问的频率，以及你的回应情况。仅统计数量，来自审计日志。",
  "friction.window": "时间范围",
  "friction.window.days": "最近 {days} 天",
  "friction.loading": "正在统计审批…",
  "friction.error": "无法加载审批打扰情况：{reason}",
  "friction.retry": "重试",
  "friction.empty": "这段时间内 Psyche 没有检查任何操作，因此没有可显示的打扰情况。",
  "friction.since": "自 {date} 起",
  "friction.asked":
    "在检查的 {decisions, plural, one {# 个操作} other {# 个操作}}中，有 {asks, plural, one {# 个} other {# 个}}操作询问了你（{rate}%）。",
  "friction.perRun": "至少询问过一次的运行，平均每次询问 {n} 次。",
  "friction.answered": "在已结束的询问中，{rate}% 在过期前得到了回答。",
  "friction.approved": "在已结束的询问中，{rate}% 获得了批准。",
  "friction.noTimes": "这段时间内没有回答任何询问，因此没有回答时间。",
  "friction.times": "回答的中位时间为 {p50}。最慢的十分之一需要 {p90} 或更久。",
  "friction.expired":
    "{n, plural, =0 {没有询问因未回答而过期。} other {有 # 个询问因未回答而过期。}}",
  "friction.rejected": "{n, plural, =0 {没有回答被拒绝。} other {有 # 个回答因无效被拒绝。}}",
  "friction.saved":
    "{n, plural, =0 {没有操作通过长期授权无需确认就执行。} other {有 # 个操作通过长期授权无需确认就执行。}}",
  "friction.grantsCreated": "{n, plural, =0 {没有创建长期授权。} other {创建了 # 个长期授权。}}",
  "friction.kinds": "询问来自哪些操作",
  "friction.kind.row": "{kind}：询问 {asks}，批准 {approved}，拒绝 {declined}，过期 {expired}",
  "friction.rules": "最常见的询问原因",
  "friction.rule.row": "{label}：{count}",
  "friction.rule.mode": "你的模式设置",
  "friction.rule.taint": "来自外部的内容",
  "friction.rule.policy": "你的策略",
  "friction.rule.designated": "受保护的位置",
  "friction.rule.site": "网站规则",
  "friction.rule.other": "其他规则",
  "friction.modes": "按模式",
  "friction.mode.row": "{mode}：{decisions} 次中询问 {asks} 次",

  "people.interactions.title": "最近互动",
  "people.interactions.empty": "与 {name} 还没有互动。",
  "people.interactions.error": "无法加载互动记录：{reason}",
  "people.interactions.more": "显示更多",
  "people.interactions.loadingMore": "加载中…",
};
