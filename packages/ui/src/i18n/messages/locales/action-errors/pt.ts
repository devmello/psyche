import type { Catalogue } from "../../index.ts";

/** Failure messages for user actions (pt); merged into `../pt.ts`. */
export const actionErrors: Partial<Catalogue> = {
  "actionError.exportPerson": "Não foi possível exportar os dados desta pessoa ({reason}).",
  "actionError.revokeGrant":
    "Não foi possível revogar esta aprovação ({reason}). Ela continua valendo.",
  "actionError.reindex": "Não foi possível reconstruir o índice de pesquisa ({reason}).",
  "actionError.rerun": "Não foi possível executar esta automação novamente ({reason}).",
  "actionError.stopResearch":
    "Não foi possível parar a pesquisa ({reason}). Ela continua em andamento.",
  "actionError.unmute": "Não foi possível reativar os lembretes ({reason}).",
  "actionError.language": "Não foi possível mudar o idioma ({reason}).",
  "actionError.transcriptMode": "Não foi possível mudar o detalhe da transcrição ({reason}).",
  "actionError.screenAskDestination":
    "Não foi possível mudar o destino das perguntas sobre a tela ({reason}).",
  "actionError.takeOver": "Não foi possível assumir a tela virtual ({reason}).",
};
