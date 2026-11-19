import type { Catalogue } from "../../index.ts";

/** Notices the Gateway authors (pt); merged into `../pt.ts`. */
export const notices: Partial<Catalogue> = {
  "notice.security.changed.title": "O Psyche desfez uma alteração de segurança feita fora do app",
  "notice.security.changed.body":
    "Um programa neste Mac alterou {count, plural, =1 {# registro de segurança} other {# registros de segurança}} (dispositivos, chaves, permissões ou configurações) sem passar pelo Psyche{times, plural, =0 {} =1 {} other {, # vezes até agora}}. O Psyche os restaurou. Se não foi você, verifique se o Mac tem software indesejado.",
  "notice.security.untrusted.title": "O Psyche não pode confiar nos seus registros de segurança",
  "notice.security.untrusted.body":
    "A verificação dos registros de segurança do Psyche falhou, então alterações de segurança, novos dispositivos e aprovações com Touch ID estão bloqueados. Revise seus dispositivos e execute `psyched security reseal` no Mac (vale após 24 horas).",
  "notice.security.firstSeal.title": "O Psyche agora verifica seus registros de segurança",
  "notice.security.firstSeal.body":
    "O Psyche selou {devices, plural, =1 {# dispositivo pareado} other {# dispositivos pareados}} e suas configurações de segurança. A partir de agora, uma alteração feita fora do Psyche é desfeita e mostrada aqui. Revise seus dispositivos uma vez.",
  "notice.security.resealed.title":
    "{restored, select, yes {Registros de segurança selados após uma restauração} other {Registros de segurança selados de novo}}",
  "notice.security.resealed.body":
    "{restored, select, yes {O Psyche iniciou a partir de um backup restaurado e selou seus registros de segurança como estão. Se você não restaurou um backup, revise seus dispositivos.} other {O Psyche selou seus registros de segurança de novo após o período de espera.}}",
  "notice.security.firstAdmin.title":
    "Um comando neste Mac criou o primeiro dispositivo administrador",
  "notice.security.firstAdmin.body":
    "{device}{key, select, none {} other { (chave {key})}} virou o primeiro dispositivo administrador {via, select, desktop {pelo app do Psyche} other {por meio do `psyched`}} neste Mac. Se não foi você, revogue-o em Ajustes → Dispositivos.",
  "notice.security.recovery.title":
    "{state, select, requested {Um comando neste Mac pediu uma alteração de segurança} applied {Uma alteração de segurança deste Mac foi aplicada} cancelled {Uma alteração de segurança deste Mac foi cancelada} other {Uma alteração de segurança deste Mac não pôde ser aplicada}}",
  "notice.security.recovery.body":
    "{op, select, approve {Aprovar o dispositivo {device}{key, select, none {} other { (chave {key})}} com {scopes}.} grant {Dar a {device}{key, select, none {} other { (chave {key})}} {scopes}.} presence {Desativar a exigência de Touch ID e passkey para alterações de segurança até que uma nova chave seja registrada.} seal {Aceitar os registros de segurança atuais como estão.} other {Uma alteração de segurança.}}{state, select, requested { Ela vale {when, select, none {em 24 horas} other {em {when}}} a menos que você a cancele no Psyche.} failed {{reason, select, none {} other { {reason}}}} other {}}",
  "notice.browser.chrome.title": "O Psyche está controlando seu Chrome",
  "notice.browser.chrome.body":
    "Uma tarefa está usando o perfil do Chrome do Psyche, onde você está conectado. O título da janela diz “Psyche is driving this window”. Ela fecha quando a tarefa termina; você também pode sair do Chrome.",
  "notice.browser.takeover.title": "O Psyche precisa de você no navegador",
  "notice.browser.takeover.body":
    "Em {host}, o agente pergunta: {reason}. Assuma o controle no painel do navegador e depois devolva.",
  "notice.connector.consent.title": "Conclua a conexão com o Google",
  "notice.connector.consent.body":
    "Abra este link no computador onde o Psyche está rodando para conceder acesso: {url}",
  "notice.connector.changed.title": "Uma conexão mudou",
  "notice.connector.changed.body":
    "{reason, select, account_changed {Um conector agora entra em outra conta. O trabalho ligado à conta antiga foi interrompido.} disconnected {Um conector foi desconectado. O trabalho que dependia dele foi interrompido.} scope_changed {Um conector agora é somente leitura. As ações pendentes por meio dele foram interrompidas.} other {O acesso de um conector foi revogado. Entre de novo para continuar usando.}}",
  "notice.connector.reconnect.title": "É preciso reconectar",
  "notice.connector.reconnect.body": "Um conector perdeu o acesso e você precisa entrar de novo.",
  "notice.attention.paused.title": "Uma tarefa está esperando por você",
  "notice.attention.paused.body":
    "Em pausa antes de {tool} em um app ou site sensível, até você voltar ao Psyche.",
  "notice.apiKey.changed.title":
    "{kind, select, brave {A chave do {provider} foi {action, select, changed {alterada} other {removida}}} other {A chave de API do {provider} foi {action, select, changed {alterada} other {removida}}}}",
  "notice.apiKey.changed.body":
    '{action, select, changed {Alterada} other {Removida}} por {device, select, none {um dispositivo} other {"{device}" ({platform}{paired, select, none {} other {, pareado em {paired}}})}}. Se não foi você, revogue o dispositivo em Ajustes → Dispositivos.',
  "notice.approvals.digest.title":
    "{count, plural, =1 {# ação das suas automações está aguardando} other {# ações das suas automações estão aguardando}}",
  "notice.approvals.digest.body": "Abra Aprovações para aprová-las ou recusá-las",
  "notice.approvals.resumeMissed.title":
    "{automation, select, none {Uma ação aprovada de uma automação não foi feita} other {{automation}: a ação aprovada não foi feita}}",
  "notice.approvals.resumeMissed.body":
    "A automação foi executada de novo, mas não chegou à mesma ação, então nada foi feito. Se ainda precisar, ela vai pedir de novo.",
};
