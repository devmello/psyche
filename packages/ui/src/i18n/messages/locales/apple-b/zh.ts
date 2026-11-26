import type { Catalogue } from "../../index.ts";

/** Apple-design batch B (zh): plain approval cards and tool rows; merged into `../zh.ts`. */
export const appleB: Partial<Catalogue> = {
  "approvals.plain.run":
    "{who}想要运行 `{command}`{hasFolder, select, true {（在 {folder} 中）} other {}}。",
  "approvals.plain.save":
    "{who}想要{mode, select, create {保存} other {修改}} {file}{hasFolder, select, true {（在 {folder} 中）} other {}}。",
  "approvals.plainWhy.commands": "你设置了命令在运行前需要先批准。",
  "approvals.plainWhy.yourRule": "你设置了一条规则：先询问。",
  "approvals.plainWhy.noSandbox": "安全沙盒尚未设置。",
  "approvals.plainWhy.protectedFiles": "这些文件受到保护，所以 Psyche 总会先询问。",
  "approvals.plainWhy.push": "发布你的工作成果始终需要你的同意。",
  "approvals.plainWhy.machineFiles": "修改另一台电脑上的文件始终需要你的同意。",
  "approvals.plainWhy.unknownTool": "这个工具来自你尚未批准的连接器。",
  "approvals.plainWhy.connector": "这个连接器在操作前会先询问。",
  "approvals.plainWhy.outsideNew": "Psyche 刚读取了外部内容，而这是一个新的操作对象。",
  "approvals.plainWhy.outsideCommand":
    "Psyche 刚读取了外部内容，而这个命令可能影响文件夹之外的内容。",
  "blocks.toolRun.familyName":
    "{kind, select, command {命令} file {文件} web {网页} mail {邮件} calendar {日历} drive {云端硬盘} memory {记忆} task {任务} other {{name}}}",
  "blocks.toolRun.spoken":
    "{kind, select, command {运行了命令} write {保存了文件} edit {编辑了文件} read {读取了文件} web {搜索了网页} mail {使用了邮件} calendar {使用了日历} memory {使用了记忆} other {使用了工具}}",
  "blocks.toolRun.line.save": "保存 {file}{hasFolder, select, true {（在 {folder} 中）} other {}}",
  "approvals.plainWhy.outsideWorkspace": "这在 Psyche 工作的文件夹之外。",
};
