import type { Catalogue } from "../../index.ts";

/** Overview Growth and People & projects strings (pt); merged into `../pt.ts`. */
export const overviewGrowth: Partial<Catalogue> = {
  "overview.meta.7d": "Últimos 7 dias",
  "overview.meta.30d": "Últimos 30 dias",
  "overview.meta.all": "Todo o período",
  "overview.growth.loading": "Carregando o crescimento",
  "overview.growth.loadFailed": "Não foi possível carregar o crescimento",
  "overview.growth.empty": "Nada foi aprendido neste período ainda.",
  "overview.growth.counts": "Lições deste período",
  "overview.growth.learned": "{n, plural, one {# lição aprendida} other {# lições aprendidas}}",
  "overview.growth.refined": "{n, plural, one {# refinada} other {# refinadas}}",
  "overview.growth.confirmed": "{n, plural, one {# confirmada} other {# confirmadas}}",
  "overview.growth.forgotten": "{n, plural, one {# esquecida} other {# esquecidas}}",
  "overview.growth.milestones": "Marcos",
  "overview.growth.seeAll": "Ver todas as lições",
  "overview.growth.sheetTitle": "O que {agent} aprendeu",
  "overview.growth.evidenceTitle": "Eventos por trás de “{metric}”",
  "overview.growth.card.thisWeek": "Lições desta semana ({n})",
  "overview.growth.card.week": "Lições da semana de {date} ({n})",
  "overview.growth.card.review": "Revisar",
  "overview.growth.card.sheetTitle": "O que {agent} aprendeu esta semana",
  "overview.growth.card.sheetDescription": "Mantenha, edite ou esqueça o que {agent} aprendeu.",
  "overview.people.loading": "Carregando pessoas e projetos",
  "overview.people.loadFailed": "Não foi possível carregar pessoas e projetos",
  "overview.people.paused":
    "O grafo de pessoas e projetos está em pausa, então nada está sendo registrado. Ative-o em Ajustes para vê-lo aqui.",
  "overview.people.empty":
    "Ninguém ainda neste período. Pessoas e projetos aparecem aqui quando {agent} trabalha com eles por você.",
  "overview.people.map": "Mapa de pessoas e projetos",
  "overview.people.mapHint":
    "As setas movem entre pessoas e projetos, primeiro os com mais interações. Enter abre um.",
  "overview.people.caption":
    "Anéis a partir do centro: esta semana, este mês, antes. Maior significa mais interações. Círculos são pessoas; quadrados são projetos e organizações.",
  "overview.people.you": "Você",
  "overview.people.kind.person": "Pessoa",
  "overview.people.kind.org": "Organização",
  "overview.people.kind.project": "Projeto",
  "overview.people.kind.place": "Lugar",
  "overview.people.interactions": "{n, plural, one {# interação} other {# interações}}",
  "overview.people.openLoops": "{n, plural, one {# pendência} other {# pendências}}",
  "overview.people.last": "Última interação {when}",
  "overview.people.node": "{name}, {kind}. {interactions}. Última interação {when}. {loops}.",
  "overview.people.detailHint":
    "Passe o mouse ou o foco sobre uma pessoa ou um projeto para ver os detalhes.",
  "overview.people.counts":
    "{people, plural, one {# pessoa} other {# pessoas}} · {projects, plural, one {# projeto} other {# projetos}} · {loops, plural, one {# pendência} other {# pendências}}",
  "overview.people.ranked": "{name} {n}",
  "overview.people.showList": "Mostrar como lista",
  "overview.people.showMap": "Mostrar mapa",
  "overview.people.seeAll": "Ver tudo",
  "overview.people.list": "Pessoas e projetos, primeiro os com mais interações",
  "overview.people.table.name": "Nome",
  "overview.people.table.kind": "Tipo",
  "overview.people.table.interactions": "Interações",
  "overview.people.table.last": "Última interação",
  "overview.people.table.loops": "Pendências",
};
