import type { Catalogue } from "../../index.ts";

/** The security-records banner and review panel (pt); merged into `../pt.ts`. */
export const securityState: Partial<Catalogue> = {
  "web.security.banner.changed":
    "O Psyche desfez uma alteração nos registros de segurança feita fora do app.",
  "web.security.banner.untrusted":
    "A verificação dos registros de segurança do Psyche falhou. Alterações que ampliam o acesso estão bloqueadas.",
  "web.security.banner.recovery":
    "{count, plural, one {Uma alteração de segurança pedida neste Mac será aplicada em {when}, a menos que você a cancele.} other {# alterações de segurança pedidas neste Mac estão aguardando. A próxima será aplicada em {when}.}}",
  "web.security.banner.notice":
    "{count, plural, one {1 aviso de segurança para revisar.} other {# avisos de segurança para revisar.}}",
  "web.security.review": "Revisar",
  "web.security.hide": "Ocultar",
  "web.security.panel.label": "Registros de segurança",
  "web.security.alert.changed":
    "Um programa neste Mac alterou {count, plural, one {1 registro de segurança} other {# registros de segurança}} sem passar pelo Psyche. O Psyche {count, plural, one {o restaurou} other {os restaurou}}. Se não foi você, verifique se há software indesejado no Mac.",
  "web.security.alert.untrusted":
    "A verificação dos registros de segurança do Psyche falhou. Novos dispositivos, ajustes de segurança e aprovações com Touch ID estão bloqueados. Revise seus dispositivos e depois execute psyched security reseal no Mac; isso é aplicado após 24 horas.",
  "web.security.alert.firstSeal":
    "O Psyche agora verifica seus registros de segurança ({devices, plural, one {1 dispositivo pareado} other {# dispositivos pareados}}). Uma alteração feita fora do Psyche é desfeita e mostrada aqui. Revise seus dispositivos uma vez.",
  "web.security.alert.resealed": "O Psyche selou de novo seus registros de segurança.",
  "web.security.alert.restored":
    "O Psyche iniciou a partir de um backup restaurado e selou os registros de segurança como estão. Se você não restaurou um backup, revise seus dispositivos.",
  "web.security.alert.firstAdmin":
    "Um comando neste Mac tornou {name} o primeiro dispositivo administrador. Se não foi você, revogue-o em Dispositivos.",
  "web.security.alert.requested": "Pedido neste Mac: {action} Será aplicado em {when}.",
  "web.security.alert.applied": "Aplicado: {action}",
  "web.security.alert.cancelled": "Cancelado: {action}",
  "web.security.alert.failed": "Não foi possível aplicar: {action}",
  "web.security.op.devicesApprove": "aprovar o dispositivo {name}.",
  "web.security.op.devicesGrant": "mudar o que {name} pode fazer.",
  "web.security.op.presenceReset":
    "deixar de exigir Touch ID ou uma chave de acesso para alterações de segurança até que uma nova chave seja registrada.",
  "web.security.op.sealReset": "aceitar os registros de segurança atuais como estão.",
  "web.security.device": "um dispositivo",
  "web.security.change":
    "{change, select, added {Adicionado} modified {Alterado} other {Removido}}: {what}",
  "web.security.more": "{count, plural, one {e mais 1} other {e mais #}}",
  "web.security.ack": "Marcar como revisado",
  "web.security.approveNow": "Aprovar agora",
  "web.security.cancel": "Cancelar pedido",
  "web.security.needsApproval":
    "Aprove o cartão com Touch ID ou uma chave de acesso e toque no botão de novo.",
  "web.security.failed": "Não funcionou: {message}",
};
