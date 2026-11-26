import type { Catalogue } from "../../index.ts";

/** Apple-design batch B (it): plain approval cards and tool rows; merged into `../it.ts`. */
export const appleB: Partial<Catalogue> = {
  "approvals.plain.run":
    "{who} vuole eseguire `{command}`{hasFolder, select, true { in {folder}} other {}}.",
  "approvals.plain.save":
    "{who} vuole {mode, select, create {salvare} other {modificare}} {file}{hasFolder, select, true { in {folder}} other {}}.",
  "approvals.plainWhy.commands": "Hai chiesto di approvare i comandi prima che vengano eseguiti.",
  "approvals.plainWhy.yourRule": "Hai impostato una regola per chiedere prima.",
  "approvals.plainWhy.noSandbox": "La sandbox sicura non è ancora configurata.",
  "approvals.plainWhy.protectedFiles": "Questi file sono protetti, quindi Psyche chiede sempre.",
  "approvals.plainWhy.push": "Pubblicare il tuo lavoro richiede sempre il tuo OK.",
  "approvals.plainWhy.machineFiles":
    "Modificare file su un altro computer richiede sempre il tuo OK.",
  "approvals.plainWhy.unknownTool":
    "Questo strumento proviene da un connettore che non hai ancora approvato.",
  "approvals.plainWhy.connector": "Questo connettore chiede prima di agire.",
  "approvals.plainWhy.outsideNew": "Psyche ha letto qualcosa dall’esterno e questo è nuovo.",
  "approvals.plainWhy.outsideCommand":
    "Psyche ha letto qualcosa dall’esterno e questo comando potrebbe uscire dalla sua cartella.",
  "blocks.toolRun.familyName":
    "{kind, select, command {comandi} file {file} web {il web} mail {email} calendar {calendario} drive {Drive} memory {memoria} task {attività} other {{name}}}",
  "blocks.toolRun.spoken":
    "{kind, select, command {Ha eseguito un comando} write {Ha salvato un file} edit {Ha modificato un file} read {Ha letto un file} web {Ha cercato sul web} mail {Ha usato la posta} calendar {Ha usato il calendario} memory {Ha usato la memoria} other {Ha usato uno strumento}}",
  "blocks.toolRun.line.save": "Salva {file}{hasFolder, select, true { in {folder}} other {}}",
  "approvals.plainWhy.outsideWorkspace": "Questo è fuori dalla cartella in cui lavora Psyche.",
};
