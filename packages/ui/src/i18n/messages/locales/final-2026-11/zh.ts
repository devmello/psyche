import type { Catalogue } from "../../index.ts";

/** Signed connector bundles and teach-by-showing in Mac apps (zh-Hans); merged into `../zh.ts`. */
export const final202611: Partial<Catalogue> = {
  "settings.connectorBundle.title": "共享的连接器 {name}",
  "settings.connectorBundle.intro":
    "有人把这个连接器以文件的形式共享给了你。目前还没有安装任何东西。请先查看它由谁制作、要求什么，然后再决定。",
  "settings.connectorBundle.update": "这是你现有连接器的更新。",
  "settings.connectorBundle.signer.title": "由谁制作",
  "settings.connectorBundle.signer.unsigned": "此文件未签名，因此无法确认是谁制作的。",
  "settings.connectorBundle.signer.dropped": "已安装的版本带有签名，这一版没有。",
  "settings.connectorBundle.signer.new": "由{name}签名。你以前没有见过这个密钥。",
  "settings.connectorBundle.signer.seen": "由{name}签名，所用密钥你以前见过，但尚未信任。",
  "settings.connectorBundle.signer.trusted": "由{name}签名，这是你信任的作者。",
  "settings.connectorBundle.signer.own": "由你签名。",
  "settings.connectorBundle.signer.changed":
    "由{name}签名，但所用密钥与以前见过的不同。请确认是同一个人。",
  "settings.connectorBundle.signer.impersonates": "签名所用的名字与你的名字相似，但密钥不是你的。",
  "settings.connectorBundle.signer.nameChanged":
    "你信任的密钥正在使用它以前没用过的名字签名：{name}。",
  "settings.connectorBundle.signer.revoked": "由你已撤销的密钥签名。",
  "settings.connectorBundle.signer.rotated":
    "由{name}签名：作者相同，密钥是新的（由旧密钥签名）。在你信任新密钥之前，它不会被信任。",
  "settings.connectorBundle.signer.claim": "名字是作者自己的声明。只有密钥才能确认作者身份。",
  "settings.connectorBundle.signer.key": "作者密钥",
  "settings.connectorBundle.signer.trust": "信任{name}为作者",
  "settings.connectorBundle.signer.trustHint":
    "这只会改变之后文件的标签和警告，绝不会跳过这张卡片。",
  "settings.connectorBundle.command": "它运行的命令",
  "settings.connectorBundle.commandHint":
    "先写程序，然后每个参数单独占一行。它不会通过 shell 运行。",
  "settings.connectorBundle.network": "它请求的网络",
  "settings.connectorBundle.noNetwork": "无网络",
  "settings.connectorBundle.networkHint": "只有沙盒能够强制执行这一点。这份列表是作者的声明。",
  "settings.connectorBundle.env": "它读取的变量",
  "settings.connectorBundle.noEnv": "无",
  "settings.connectorBundle.envHint": "仅显示名称。安装后由你为它们设置值。",
  "settings.connectorBundle.secrets": "它需要的密文",
  "settings.connectorBundle.noSecrets": "无",
  "settings.connectorBundle.secretsHint":
    "仅显示名称。文件中不含任何密文。安装后你为每一项设置值，它们会保存在你的保险库中。",
  "settings.connectorBundle.tools": "作者声称它提供的工具",
  "settings.connectorBundle.toolsCount": "{n, plural, other {# 个工具}}",
  "settings.connectorBundle.toolsHint":
    "Psyche 会在沙盒中启动它，并列出它实际提供的内容。以这些工具为准。",
  "settings.connectorBundle.toolsUndeclared": "服务器列出了文件中未声明的工具：{names}",
  "settings.connectorBundle.toolsMissing": "文件中声明了服务器未列出的工具：{names}",
  "settings.connectorBundle.files": "随附的脚本（{n}）",
  "settings.connectorBundle.file": "{path} · {bytes} B",
  "settings.connectorBundle.fileBinary": "这不是文本，因此无法在此显示。",
  "settings.connectorBundle.findings": "检查发现了什么",
  "settings.connectorBundle.finding.high": "阻止安装：{message}",
  "settings.connectorBundle.finding.warn": "请检查：{message}",
  "settings.connectorBundle.finding.info": "{message}",
  "settings.connectorBundle.sandbox.srt":
    "首次运行在沙盒中进行。Psyche 在那里启动它以列出其工具，之后它也会一直在那里运行。",
  "settings.connectorBundle.sandbox.container":
    "首次运行在沙盒容器中进行。Psyche 在那里启动它以列出其工具，之后它也会一直在那里运行。",
  "settings.connectorBundle.sandbox.none":
    "这台 Mac 没有用于命令连接器的沙盒，而 Psyche 绝不会在沙盒之外运行它们。此连接器无法在这里安装。没有启动或保存任何内容。",
  "settings.connectorBundle.blocker.scan": "检查发现了阻止安装的问题。没有启动或保存任何内容。",
  "settings.connectorBundle.blocker.probe_failed":
    "在没有网络、没有密文的情况下首次运行，未能启动它。没有保存任何内容。",
  "settings.connectorBundle.signer.ownRetired": "由你已更换的旧密钥签名。它不再被视为你的密钥。",
  "settings.connectorBundle.signer.retired":
    "由{name}签名，所用密钥已在你见过的一次轮换中被替换。来自它的新文件可疑。",
  "settings.connectorBundle.carry.kept": "你设置的值中会保留的有：{names}",
  "settings.connectorBundle.carry.cleared":
    "因签名者或命令已更改，你设置的这些值不会沿用。请重新输入：{names}",
  "settings.connectorBundle.carry.vault": "你之前存储的密文仍保留在保险库中，但不会交给这个版本。",
  "settings.connectorBundle.reset.title": "如果共享连接器的记录已损坏",
  "settings.connectorBundle.reset.hint":
    "来自文件的连接器在其记录无法读取时会保持关闭。此操作会把损坏的记录搁置一旁（如果有上一份完好的副本，则会恢复它）；这些连接器会一直保持关闭，直到你移除它们或重新导入。",
  "settings.connectorBundle.reset.go": "重置记录…",
  "settings.connectorBundle.reset.confirm": "是，重置",
  "settings.connectorBundle.reset.done":
    "记录已重置。{restored, select, true {已恢复上一份完好的副本。} other {它现在是空的。}}",
  "settings.connectorBundle.reset.failed": "无法重置记录：{reason}",
  "settings.connectorBundle.hash": "包 ID",
  "settings.connectorBundle.close": "关闭",
  "settings.connectorBundle.widened.title": "所要求的比你现有的版本更多",
  "settings.connectorBundle.widened.hint":
    "批准这张卡片就会授予这些权限。针对范围更窄的版本的卡片并未涵盖它们。",
  "settings.connectorBundle.widened.command": "不同的命令",
  "settings.connectorBundle.widened.commandValue": "现在：{now}。之前：{before}",
  "settings.connectorBundle.widened.env": "更多变量",
  "settings.connectorBundle.widened.secrets": "更多密文",
  "settings.connectorBundle.widened.network": "更多网络",
  "settings.connectorBundle.widened.tools": "更多工具，或能力更强的工具",
  "settings.connectorBundle.widened.payload": "不同的脚本",
  "settings.connectorBundle.widened.payloadValue": "随附文件已更改",
  "settings.connectorBundle.diff": "更改内容",
  "settings.connectorBundle.noChanges": "没有其他更改。",
  "settings.connectorBundle.import.title": "共享的连接器",
  "settings.connectorBundle.import.hint":
    "导入别人以文件或链接发给你的连接器。在安装任何内容之前，你会看到它要求的一切。",
  "settings.connectorBundle.import.file": "导入连接器文件",
  "settings.connectorBundle.import.linkLabel": "或粘贴链接",
  "settings.connectorBundle.import.linkPlaceholder": "https://example.com/notes.psyche-connector",
  "settings.connectorBundle.import.review": "审核",
  "settings.connectorBundle.import.checking": "正在检查…",
  "settings.connectorBundle.import.failed": "无法导入连接器：{reason}",
  "settings.connectorBundle.import.tooBig": "该文件太大，不可能是连接器。",
  "settings.connectorBundle.import.denied": "未安装{name}。",
  "settings.connectorBundle.import.lapsed":
    "{expired, select, true {{name}的卡片已过期。} other {{name}的卡片已不再适用。}}请重新导入以进行审核。",
  "settings.connectorBundle.import.added":
    "已添加{name}。请在下方为它提供所需的密文，之后它就可以使用了。",
  "settings.connectorBundle.import.addedNoSecrets": "已添加{name}。",
  "settings.connectorBundle.import.addFailed": "无法添加{name}：{reason}",
  "settings.connectorBundle.import.secretsTitle": "{name}的密文",
  "settings.connectorBundle.share.title": "共享此连接器",
  "settings.connectorBundle.share.hint":
    "生成一个已签名的文件，其中包含命令、变量和密文的名称、它访问的网络以及它的工具。绝不会包含任何值。你会先确认其中包含什么。",
  "settings.connectorBundle.share.go": "共享…",
  "settings.connectorBundle.share.nameLabel": "你在共享连接器上显示的名字",
  "settings.connectorBundle.share.nameHint":
    "所有导入你文件的人都会看到这个名字。只会询问一次；你的签名密钥将在此时生成。",
  "settings.connectorBundle.share.make": "生成文件",
  "settings.connectorBundle.share.label": "共享{name}",
  "settings.connectorBundle.share.done":
    "已保存{file}，以{author}的身份签名。其中只有名称：没有任何变量或密文的值。",
  "settings.connectorBundle.share.failed": "无法共享连接器：{reason}",
  "settings.connectorBundle.share.unavailable": "只有运行该连接器的 Mac 上的 Psyche 才能为其签名。",
  "settings.skills.signer.ownRetired": "由你已更换的旧密钥签名。它不再被视为你的密钥。",
  "settings.skills.signer.retired":
    "由{name}签名，所用密钥已在你见过的一次轮换中被替换。来自它的新文件可疑。",
  "settings.skills.signer.rotated":
    "由{name}签名：作者相同，密钥是新的（由旧密钥签名）。在你信任新密钥之前，它不会被信任。",
  "settings.skills.author.state.seen": "已见过，未信任",
  "settings.skills.author.state.trusted": "已信任",
  "settings.skills.author.state.revoked": "已撤销",
  "settings.skills.keys.title": "你的作者密钥和通知",
  "settings.skills.keys.hint":
    "用来为你共享的技能和连接器签名的密钥。你可以更换它，并在某个密钥或文件不应再被信任时发布通知。",
  "settings.skills.keys.none": "你还没有签过任何东西。你的密钥会在你第一次共享技能或连接器时生成。",
  "settings.skills.keys.own": "以{name}的身份签名",
  "settings.skills.keys.fingerprint": "密钥",
  "settings.skills.keys.rotate": "更换我的密钥…",
  "settings.skills.keys.rotateHint":
    "以同一个名字生成新密钥。旧密钥会签署一份指明新密钥的声明，这样信任过你的人会看到同一位作者使用了新密钥。他们仍需自己决定是否信任它。你会先确认。",
  "settings.skills.keys.rotateLabel": "更换你的作者密钥",
  "settings.skills.keys.rotated": "你的密钥已更换。新密钥是 {key}。",
  "settings.skills.keys.rotateFailed": "无法更换密钥：{reason}",
  "settings.skills.keys.notice.title": "发布通知",
  "settings.skills.keys.notice.hint":
    "通知是一个已签名的小文件。你可以发送或托管它，任何见过你的密钥的人都可以导入它，以屏蔽某个密钥或某一个文件。",
  "settings.skills.keys.notice.kindKey": "我的密钥（当前的）",
  "settings.skills.keys.notice.kindBundle": "我共享的某一个文件，按包 ID 指定",
  "settings.skills.keys.notice.kind": "有问题的是什么",
  "settings.skills.keys.notice.hash": "包 ID（sha256:…）",
  "settings.skills.keys.notice.reason": "原因（所有导入它的人都会看到）",
  "settings.skills.keys.notice.make": "生成通知",
  "settings.skills.keys.notice.label": "签署撤销通知",
  "settings.skills.keys.notice.done": "已保存{file}。你可以用任何方式发布它。",
  "settings.skills.keys.notice.failed": "无法生成通知：{reason}",
  "settings.skills.keys.import.title": "导入撤销通知",
  "settings.skills.keys.import.hint":
    "仅当它由你见过的作者签名时才会生效。它只能屏蔽：绝不会去信任任何东西。",
  "settings.skills.keys.import.file": "导入通知文件",
  "settings.skills.keys.import.linkLabel": "或粘贴链接",
  "settings.skills.keys.import.linkPlaceholder": "https://example.com/revoke.psyche-notice",
  "settings.skills.keys.import.go": "导入",
  "settings.skills.keys.import.key": "已屏蔽密钥 {key}。给出的原因：{reason}",
  "settings.skills.keys.import.bundle": "已屏蔽文件 {hash}。给出的原因：{reason}",
  "settings.skills.keys.import.previewKey":
    "这将撤销密钥 {key}{names, select, none {} other {（名为{names}）}}。签名者给出的原因：{reason}",
  "settings.skills.keys.import.previewBundle": "这将屏蔽文件 {hash}。签名者给出的原因：{reason}",
  "settings.skills.keys.import.already": "它已经生效。",
  "settings.skills.keys.import.apply": "应用",
  "settings.skills.keys.import.signedBy": "由{name}签名。",
  "settings.skills.keys.import.failed": "无法使用该通知：{reason}",
  "web.teach.app.record": "在 App 中录制",
  "web.teach.app.recordHint": "向 Psyche 演示如何在你已允许的 Mac App 中完成某件事",
  "web.teach.app.pickTitle": "在哪个 App 中录制？",
  "web.teach.app.pickLabel": "App",
  "web.teach.app.pickHint":
    "这里只列出你已允许用于电脑使用的 App。请先打开该 App。密码、卡号和验证码绝不会被录制，Psyche 自己的窗口以及登录和安全提示也不会。",
  "web.teach.app.none":
    "没有可录制的 App。请先在设置中开启电脑使用，并为某个 App 授予点击或交互权限。",
  "web.teach.app.start": "开始录制",
  "web.teach.app.cancelPick": "暂不",
  "web.teach.app.startFailed":
    "Psyche 无法开始录制该 App。请先打开它，并确认 Psyche 拥有辅助功能权限。",
  "web.teach.app.bar.title": "正在录制 {app}",
  "web.teach.app.bar.body":
    "Psyche 只会记录你在 {app} 中的点击、菜单选择和输入。安全字段绝不会被录制，不会截取屏幕，在你保存之前也不会有任何内容离开这台 Mac。菜单栏中也有“停止”按钮。",
  "web.teach.app.bar.endedLimit": "录制已在 200 步的上限处停止。请查看它记录了什么。",
  "web.teach.app.bar.endedTimeout": "录制已在时间上限处停止。请查看它记录了什么。",
  "web.teach.app.bar.endedInterrupted": "由于该 App 已关闭，录制提前结束。请查看它记录了什么。",
  "web.teach.app.stopFailed": "Psyche 无法完成录制。",
  "web.teach.app.skipped":
    "{count, plural, other {有 # 项被略过：安全字段，或没有名称、无法定位的控件。}}",
  "web.teach.app.privacy":
    "这些步骤中的文字来自该 App 的窗口和菜单。它们被视为数据，绝不会被当作指令。保存时，技能运行之前会先请你批准。",
  "web.teach.app.sensitive": "未录制。Psyche 会请你自己完成这一部分。",
  "web.teach.app.runHint":
    "把技能填入消息框。点按“发送”，然后观察该 App：每次点击和输入都会照常请求批准，如果有东西不在原来的位置，它会停下来询问。",
  "web.teach.step.app.click": "在 {app} 中，点击“{name}”",
  "web.teach.step.app.clickRole": "在 {app} 中，点击{role}",
  "web.teach.step.app.menu": "在 {app} 中，选择 {path}",
  "web.teach.step.app.type": "在 {app} 中，在“{name}”中输入",
  "web.teach.step.app.typeKept": "在 {app} 中，在“{name}”中输入 {value}",
  "web.teach.step.app.typeInput": "在 {app} 中，在“{name}”中输入{input}",
  "web.teach.step.app.typeAsk": "在 {app} 中，在“{name}”中输入你指定的内容",
  "web.teach.step.app.typeSensitive": "在 {app} 中，由你自己在“{name}”中输入",
};
