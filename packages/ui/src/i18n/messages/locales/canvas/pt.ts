import type { Catalogue } from "../../index.ts";

/** Output canvas strings (pt); merged into `../pt.ts`. */
export const canvas: Partial<Catalogue> = {
  "canvas.chart": "Gráfico",
  "canvas.htmlOff":
    "Isto veio de conteúdo não confiável, então a prévia está desligada. Execute apenas se confiar. Roda em um ambiente isolado sem rede.",
  "canvas.htmlRun": "Executar",
  "canvas.htmlNoPreview": "Este host não consegue pré-visualizar HTML; o código-fonte é mostrado.",
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
  "canvas.map": "Mapa",
  "map.label": "Mapa: {title}",
  "map.untitled": "Mapa",
  "map.list": "Lugares",
  "map.openLink": "Abrir link",
  "map.empty": "Nenhum lugar para mostrar.",
  "map.tilesOff": "Os blocos do mapa estão desativados em Ajustes. Mostrando a lista.",
  "map.tilesFailed": "Não foi possível carregar o mapa. Mostrando a lista.",
  "map.showMap": "Mostrar mapa",
  "map.showList": "Mostrar lista",
  "map.card": "Mapa: {title}",
  "map.meta": "{count, plural, one {# lugar} other {# lugares}} · {date}",
  "map.openCanvas": "Abrir no canvas",
  "map.invalid": "Não foi possível ler este mapa.",
  "map.gesture.windows": "Use Ctrl + rolagem para dar zoom no mapa",
  "map.gesture.mac": "Use ⌘ + rolagem para dar zoom no mapa",
  "map.gesture.mobile": "Use dois dedos para mover o mapa",
  "settings.map.title": "Mapas",
  "settings.map.privacy":
    "Mostrar um mapa pede a um servidor de blocos a área que você vê, então esse servidor pode saber aproximadamente onde você olha. Desative os blocos para ver os lugares só em lista, ou use seu próprio servidor. Os pedidos passam pelo seu Gateway, então o servidor de blocos vê o Gateway, não o seu dispositivo.",
  "settings.map.tiles": "Mostrar blocos do mapa",
  "settings.map.tilesHint": "Desativado mostra os lugares em lista, sem pedidos de mapa.",
  "settings.map.style": "URL de estilo do servidor de blocos",
  "settings.map.styleHint":
    "Uma URL de estilo JSON do MapLibre, por exemplo do seu servidor. Vazia usa os blocos gratuitos do OpenFreeMap (só https; http para localhost).",
  "settings.map.styleDark": "URL de estilo (escuro)",
  "settings.map.styleDarkHint":
    "Opcional. Vazia usa o estilo acima também no modo escuro, ou o estilo escuro do OpenFreeMap.",
};
