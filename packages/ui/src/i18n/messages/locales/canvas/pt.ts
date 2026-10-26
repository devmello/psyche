import type { Catalogue } from "../../index.ts";

/** Output canvas strings (pt); merged into `../pt.ts`. */
export const canvas: Partial<Catalogue> = {
  "canvas.chart": "Gráfico",
  "canvas.label": "Tela: {title}",
  "canvas.recents": "Resultados recentes",
  "canvas.loading": "Carregando…",
  "canvas.missing": "O Psyche não conseguiu carregar este resultado.",
  "canvas.untrusted": "De conteúdo não confiável",
  "canvas.version": "Versão",
  "canvas.versionOption":
    "v{version} · {author, select, user {você} specialist {especialista} other {Psyche}} · {time}",
  "canvas.copy": "Copiar",
  "canvas.copied": "Copiado",
  "canvas.download": "Baixar",
  "canvas.restore": "Restaurar como nova versão",
  "canvas.oldVersion": "Versão {version} (somente leitura).",
  "canvas.conflict":
    "Isso mudou enquanto você editava, então sua edição não foi salva. Tente de novo na versão mais recente.",
  "canvas.saveFailed": "Não foi possível salvar: {message}",
};
