import type { Catalogue } from "../../index.ts";

/** Apple-design batch B (de): plain approval cards and tool rows; merged into `../de.ts`. */
export const appleB: Partial<Catalogue> = {
  "approvals.plain.run":
    "{who} möchte `{command}`{hasFolder, select, true { in {folder}} other {}} ausführen.",
  "approvals.plain.save":
    "{who} möchte {file}{hasFolder, select, true { in {folder}} other {}} {mode, select, create {speichern} other {ändern}}.",
  "approvals.plainWhy.commands":
    "Du hast festgelegt, dass Befehle vor dem Ausführen bestätigt werden.",
  "approvals.plainWhy.yourRule": "Du hast eine Regel festgelegt, die vorher nachfragt.",
  "approvals.plainWhy.noSandbox": "Die sichere Sandbox ist noch nicht eingerichtet.",
  "approvals.plainWhy.protectedFiles":
    "Diese Dateien sind geschützt, deshalb fragt Psyche immer nach.",
  "approvals.plainWhy.push": "Das Veröffentlichen deiner Arbeit braucht immer dein OK.",
  "approvals.plainWhy.machineFiles":
    "Dateien auf einem anderen Computer zu ändern braucht immer dein OK.",
  "approvals.plainWhy.unknownTool":
    "Dieses Werkzeug stammt von einem Connector, den du noch nicht freigegeben hast.",
  "approvals.plainWhy.connector": "Dieser Connector fragt nach, bevor er etwas tut.",
  "approvals.plainWhy.outsideNew": "Psyche hat etwas von außen gelesen, und das hier ist neu.",
  "approvals.plainWhy.outsideCommand":
    "Psyche hat etwas von außen gelesen, und dieser Befehl könnte über seinen Ordner hinausreichen.",
  "blocks.toolRun.familyName":
    "{kind, select, command {Befehle} file {Dateien} web {Web} mail {E-Mail} calendar {Kalender} drive {Drive} memory {Gedächtnis} task {Aufgaben} other {{name}}}",
  "blocks.toolRun.spoken":
    "{kind, select, command {Befehl ausgeführt} write {Datei gespeichert} edit {Datei bearbeitet} read {Datei gelesen} web {Im Web gesucht} mail {E-Mail verwendet} calendar {Kalender verwendet} memory {Gedächtnis verwendet} other {Werkzeug verwendet}}",
  "blocks.toolRun.line.save": "{file}{hasFolder, select, true { in {folder}} other {}} speichern",
};
