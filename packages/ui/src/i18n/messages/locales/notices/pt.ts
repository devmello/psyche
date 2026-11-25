import type { Catalogue } from "../../index.ts";

/** Notices the Gateway authors (pt); merged into `../pt.ts`. */
export const notices: Partial<Catalogue> = {
  "notice.install.failed.title": "Uma instalação aprovada não foi concluída",
  "notice.connectors.matrix.failed.title": "Uma regra de conector não foi salva",
  "notice.connectors.matrix.failed.body":
    "Não foi possível aplicar {action} em {connector}, então continua valendo a regra anterior. Confira em Ajustes › Conectores.",
  "notice.install.failed.body":
    "{reason, select, lost {O Psyche reiniciou antes de você aprovar, então a proposta se perdeu. Proponha de novo.} expired {A proposta tinha expirado antes de você aprovar. Proponha de novo.} other {O Psyche não conseguiu instalá-la. Proponha de novo ou peça ao Psyche.}}",
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
    "{why, select, expired {A aprovação expirou antes de a automação chegar à ação, então nada foi feito. Se ainda precisar, ela vai pedir de novo.} paused {A automação está pausada ou foi removida, então não foi executada de novo e nada foi feito. Se ainda precisar, ela vai pedir de novo.} restart {O Psyche reiniciou antes de a automação poder ser executada de novo, então nada foi feito. Se ainda precisar, ela vai pedir de novo.} restart_kept {O Psyche reiniciou antes de a automação poder ser executada de novo. A permissão que você deu continua, então a próxima execução fará isto sem perguntar. Para retirá-la, revogue-a em Permissões permanentes, em Aprovações.} failed {A automação executou a ação de novo, mas ela falhou. Veja em Atividade o que deu errado. Se ainda precisar, ela vai pedir de novo.} failed_kept {A automação executou a ação de novo, mas ela falhou. Veja em Atividade o que deu errado. A permissão que você deu continua, então a próxima execução vai tentar de novo sem perguntar. Para retirá-la, revogue-a em Permissões permanentes, em Aprovações.} unknown {A automação executou a ação de novo, mas o Psyche não consegue saber se funcionou. Confira em Atividade.} not_reached_kept {A automação foi executada de novo, mas não chegou à mesma ação, então nada foi feito. A permissão que você deu continua, então a próxima execução fará isto sem perguntar. Para retirá-la, revogue-a em Permissões permanentes, em Aprovações.} other {A automação foi executada de novo, mas não chegou à mesma ação, então nada foi feito. Se ainda precisar, ela vai pedir de novo.}}",
  "notice.specialist.result.title":
    "{outcome, select, done {{who} terminou {title}} partial {{who} parou cedo em {title}} cancelled {{who} foi interrompido em {title}} other {{who} não conseguiu terminar {title}}}",
  "notice.specialist.result.body":
    "{outcome, select, done {Concluído} partial {Parcial} cancelled {Cancelado} other {Falhou}}{findings, plural, =0 {} one { · # achado} other { · # achados}}{cost, select, none {} other { · {cost}}} · {minutes, plural, =0 {menos de 1 min} other {# min}}",
  "notice.mcp.changed.title": "O servidor MCP {server} mudou suas ferramentas",
  "notice.mcp.suspicious.title": "O servidor MCP {server} tem descrições de ferramentas suspeitas",
  "notice.mcp.review.body": "Revise antes de usar este servidor: {details}",
  "notice.security.tightened.title":
    "As configurações de segurança foram reforçadas a partir de {device, select, none {um dispositivo} other {{device}}}",
  "notice.security.tightened.body":
    "Isso apenas reduziu o que o Psyche pode fazer, então nenhuma aprovação foi necessária. Se não foi você, revogue o dispositivo em Ajustes → Dispositivos.",
  "notice.codeRun.held.title":
    "O Psyche reteve configuração de inicialização de uma execução de código em {repo}",
  "notice.codeRun.held.body":
    "Um comando no sandbox criou {paths}. Apps ou seu próximo comando poderiam executar código a partir disso, então o Psyche o deixou de lado sem apagar. Se foi você ou suas ferramentas, toque em Manter.",
  "notice.codeRun.changed.title":
    "A configuração de inicialização mudou durante uma execução de código em {repo}",
  "notice.codeRun.changed.body":
    "{paths} mudou enquanto um comando rodava no sandbox. Se não foi você nem seu editor, confira antes de abrir a pasta.",
  "notice.codeRun.partial.title": "{repo} é grande demais para uma verificação completa",
  "notice.codeRun.partial.body":
    "O Psyche verificou só as pastas de cima em busca de configuração de inicialização criada por execuções de código.",
  "notice.codeRun.recreated.title": "O sandbox de {repo} foi recriado",
  "notice.codeRun.recreated.body":
    "As pastas somente leitura mudaram, então servidores em execução e o que estava instalado fora do repositório se foram. Inicie de novo o que precisar.",
  "notice.action.keepIt": "Manter",
  "notice.codeRun.incident.title":
    "O Psyche reteve algo que talvez não venha de uma execução de código em {repo}",
  "notice.codeRun.incident.body":
    "Enquanto {paths} era deixado de lado, uma pasta no caminho mudou, então o que foi movido pode vir de outro lugar. Está guardado em {place}. Confira antes de tocar em Manter, que o coloca em {paths} dentro de {repo}.",
  "notice.codeRun.unmoved.title":
    "A configuração de inicialização de uma execução de código em {repo} continua no lugar",
  "notice.codeRun.unmoved.body":
    "Um comando no sandbox criou {paths} e o Psyche não conseguiu deixá-lo de lado, então ele não está retido. Apps ou seu próximo comando poderiam executar código a partir disso. Apague antes de abrir a pasta ou executar qualquer coisa nela. Não mude as permissões antes para olhar dentro, porque isso pode deixá-lo ser executado.",
  "notice.codeRun.unchecked.title":
    "O Psyche não conseguiu verificar parte de {repo} depois de uma execução de código",
  "notice.codeRun.unchecked.body":
    "{paths} mudou enquanto o Psyche o verificava depois de um comando no sandbox, então nada dentro dele foi verificado em busca de configuração de inicialização. Se não foi você nem suas ferramentas que o mudaram, olhe antes de abrir a pasta ou executar qualquer coisa nela.",
  "notice.machine.added.title": "{name} foi adicionado como um computador que o Psyche pode usar",
  "notice.machine.added.body":
    "O Psyche pode usar a tela, os apps, o shell e os arquivos dele, e cada ação lá pede sua confirmação antes. Se não foi você que adicionou, remova em Ajustes → Dispositivos.",
  "notice.machine.removed.title": "{name} se removeu sozinho",
  "notice.machine.removed.body":
    "Era um computador que o Psyche podia usar. O Psyche não vai usá-lo de novo, a menos que você o adicione outra vez.",
  "notice.machine.scanIncomplete.title":
    "Não foi possível terminar de verificar {folder} em {name} após um comando",
  "notice.machine.scanIncomplete.body":
    "Repositórios ou arquivos de inicialização novos ali podem não ter sido colocados de lado. Procure pastas .git ou .vscode novas antes de abri-la em um editor ou rodar git ali. Os comandos só poderão gravar ali de novo quando o Psyche reiniciar em {name}.",
  "notice.machine.offline.title": "{name} ficou offline",
  "notice.machine.offline.body":
    "Uma tarefa está esperando para usá-lo e continua quando {name} voltar. Você também pode cancelar a tarefa.",
  "notice.automation.needsApproval.title": "{title} está esperando sua aprovação",
  "notice.automation.needsApproval.body":
    "Parou porque a aprovação expirou. Abra Aprovações para ver o que precisa e execute de novo.",
  "notice.automation.interrupted.title": "{title} foi interrompido",
  "notice.automation.interrupted.body":
    "O Psyche reiniciou enquanto rodava e pode já ter feito uma parte. Confira o resultado e execute de novo se precisar.",
};
