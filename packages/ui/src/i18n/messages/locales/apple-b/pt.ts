import type { Catalogue } from "../../index.ts";

/** Apple-design batch B (pt): plain approval cards and tool rows; merged into `../pt.ts`. */
export const appleB: Partial<Catalogue> = {
  "approvals.plain.run":
    "{who} quer executar `{command}`{hasFolder, select, true { em {folder}} other {}}.",
  "approvals.plain.save":
    "{who} quer {mode, select, create {salvar} other {alterar}} {file}{hasFolder, select, true { em {folder}} other {}}.",
  "approvals.plainWhy.commands": "Você pediu para aprovar comandos antes de serem executados.",
  "approvals.plainWhy.yourRule": "Você definiu uma regra para perguntar antes.",
  "approvals.plainWhy.noSandbox": "O ambiente seguro ainda não foi configurado.",
  "approvals.plainWhy.protectedFiles":
    "Estes arquivos são protegidos, então a Psyche sempre pergunta.",
  "approvals.plainWhy.push": "Publicar seu trabalho sempre precisa do seu OK.",
  "approvals.plainWhy.machineFiles":
    "Alterar arquivos em outro computador sempre precisa do seu OK.",
  "approvals.plainWhy.unknownTool":
    "Esta ferramenta vem de um conector que você ainda não aprovou.",
  "approvals.plainWhy.connector": "Este conector pergunta antes de agir.",
  "approvals.plainWhy.outsideNew": "A Psyche leu algo de fora e isto é novo para ela.",
  "approvals.plainWhy.outsideCommand":
    "A Psyche leu algo de fora e este comando poderia ir além da própria pasta.",
  "blocks.toolRun.familyName":
    "{kind, select, command {comandos} file {arquivos} web {a web} mail {e-mail} calendar {calendário} drive {Drive} memory {memória} task {tarefas} other {{name}}}",
  "blocks.toolRun.spoken":
    "{kind, select, command {Executou um comando} write {Salvou um arquivo} edit {Editou um arquivo} read {Leu um arquivo} web {Pesquisou na web} mail {Usou o e-mail} calendar {Usou seu calendário} memory {Usou a memória} other {Usou uma ferramenta}}",
  "blocks.toolRun.line.save": "Salvar {file}{hasFolder, select, true { em {folder}} other {}}",
};
