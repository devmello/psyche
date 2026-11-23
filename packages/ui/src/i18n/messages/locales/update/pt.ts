import type { Catalogue } from "../../index.ts";

/** App update strings (pt); merged into `../pt.ts`. */
export const update: Partial<Catalogue> = {
  "shell.update.ready": "O Psyche {version} está pronto",
  "shell.update.readyRequired": "O Psyche {version} está pronto. Esta atualização é obrigatória.",
  "shell.update.restart": "Reiniciar para atualizar",
  "shell.update.dismiss": "Dispensar aviso de atualização",
  "settings.updates.status": "Estado",
  "settings.updates.checking": "Verificando atualizações…",
  "settings.updates.upToDate": "Atualizado",
  "settings.updates.ready": "O Psyche {version} está pronto",
  "settings.updates.readyRequired": "O Psyche {version} está pronto (obrigatória)",
  "settings.updates.refused": "Atualização recusada: {reason}",
};
