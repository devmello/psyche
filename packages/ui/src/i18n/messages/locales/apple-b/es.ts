import type { Catalogue } from "../../index.ts";

/** Apple-design batch B (es): plain approval cards and tool rows; merged into `../es.ts`. */
export const appleB: Partial<Catalogue> = {
  "approvals.plain.run":
    "{who} quiere ejecutar `{command}`{hasFolder, select, true { en {folder}} other {}}.",
  "approvals.plain.save":
    "{who} quiere {mode, select, create {guardar} other {cambiar}} {file}{hasFolder, select, true { en {folder}} other {}}.",
  "approvals.plainWhy.commands": "Pediste aprobar los comandos antes de que se ejecuten.",
  "approvals.plainWhy.yourRule": "Estableciste una regla para preguntar antes.",
  "approvals.plainWhy.noSandbox": "El entorno seguro aún no está configurado.",
  "approvals.plainWhy.protectedFiles":
    "Estos archivos están protegidos, así que Psyche siempre pregunta.",
  "approvals.plainWhy.push": "Publicar tu trabajo siempre necesita tu visto bueno.",
  "approvals.plainWhy.machineFiles":
    "Cambiar archivos en otro ordenador siempre necesita tu visto bueno.",
  "approvals.plainWhy.unknownTool":
    "Esta herramienta viene de un conector que aún no has aprobado.",
  "approvals.plainWhy.connector": "Este conector pregunta antes de actuar.",
  "approvals.plainWhy.outsideNew": "Psyche leyó algo de fuera y esto es nuevo para ella.",
  "approvals.plainWhy.outsideCommand":
    "Psyche leyó algo de fuera y este comando podría salirse de su carpeta.",
  "blocks.toolRun.familyName":
    "{kind, select, command {comandos} file {archivos} web {la web} mail {correo} calendar {calendario} drive {Drive} memory {memoria} task {tareas} other {{name}}}",
  "blocks.toolRun.spoken":
    "{kind, select, command {Ejecutó un comando} write {Guardó un archivo} edit {Editó un archivo} read {Leyó un archivo} web {Buscó en la web} mail {Usó el correo} calendar {Usó tu calendario} memory {Usó la memoria} other {Usó una herramienta}}",
  "blocks.toolRun.line.save": "Guardar {file}{hasFolder, select, true { en {folder}} other {}}",
  "approvals.plainWhy.outsideWorkspace": "Esto está fuera de la carpeta en la que trabaja Psyche.",
};
