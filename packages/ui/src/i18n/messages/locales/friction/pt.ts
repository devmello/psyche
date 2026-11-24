import type { Catalogue } from "../../index.ts";

/** Approval-friction and person-interaction strings (pt); merged into `../pt.ts`. */
export const friction: Partial<Catalogue> = {
  "friction.title": "Atrito nas aprovações",
  "friction.hint":
    "Com que frequência o Psyche para para perguntar antes de agir, e como você responde. Só contagens, do registro de auditoria.",
  "friction.window": "Período",
  "friction.window.days": "Últimos {days} dias",
  "friction.loading": "Contando aprovações…",
  "friction.error": "Não foi possível carregar o atrito nas aprovações: {reason}",
  "friction.retry": "Tentar de novo",
  "friction.empty": "O Psyche não verificou ações neste período, então não há atrito para mostrar.",
  "friction.since": "Desde {date}",
  "friction.asked":
    "Perguntou sobre {asks, plural, one {# ação} other {# ações}} de {decisions, plural, one {# ação verificada} other {# ações verificadas}} ({rate}%).",
  "friction.perRun":
    "As execuções que perguntaram pelo menos uma vez tiveram em média {n} perguntas cada.",
  "friction.answered": "Das perguntas encerradas, {rate}% foram respondidas antes de expirar.",
  "friction.approved": "Das perguntas encerradas, {rate}% foram aprovadas.",
  "friction.noTimes":
    "Nenhuma pergunta foi respondida neste período, então não há tempo de resposta.",
  "friction.times": "Responder levou em mediana {p50}. O décimo mais lento levou {p90} ou mais.",
  "friction.expired":
    "{n, plural, =0 {Nenhuma pergunta expirou sem resposta.} one {# pergunta expirou sem resposta.} other {# perguntas expiraram sem resposta.}}",
  "friction.rejected":
    "{n, plural, =0 {Nenhuma resposta foi rejeitada.} one {# resposta foi rejeitada por inválida.} other {# respostas foram rejeitadas por inválidas.}}",
  "friction.saved":
    "{n, plural, =0 {Nenhuma ação passou por uma permissão permanente sem confirmação.} one {# ação passou por uma permissão permanente sem confirmação.} other {# ações passaram por uma permissão permanente sem confirmação.}}",
  "friction.grantsCreated":
    "{n, plural, =0 {Nenhuma permissão permanente foi criada.} one {# permissão permanente foi criada.} other {# permissões permanentes foram criadas.}}",
  "friction.kinds": "De onde vieram as perguntas",
  "friction.kind.row":
    "{kind}: perguntou {asks}, aprovou {approved}, recusou {declined}, expirou {expired}",
  "friction.rules": "Motivos mais comuns para perguntar",
  "friction.rule.row": "{label}: {count}",
  "friction.rule.mode": "Sua configuração de modo",
  "friction.rule.taint": "Conteúdo de fora",
  "friction.rule.policy": "Sua política",
  "friction.rule.designated": "Um lugar protegido",
  "friction.rule.site": "Uma regra de site",
  "friction.rule.other": "Outra regra",
  "friction.modes": "Por modo",
  "friction.mode.row": "{mode}: perguntou {asks} de {decisions}",

  "people.interactions.error": "Não foi possível carregar as interações anteriores: {reason}",
  "people.interactions.older": "Mostrar anteriores",
  "people.interactions.retry": "Tentar de novo",
  "people.interactions.loadingMore": "Carregando…",
};
