import type { Catalogue } from "../../index.ts";

/** Native dialogs and notifications (pt); merged into `../pt.ts`. */
export const desktopDialog: Partial<Catalogue> = {
  "desktop.dialog.notificationsOn": "As notificações estão ativadas.",
  "desktop.dialog.anotherCopyTitle": "Outra cópia do Psyche já está em execução",
  "desktop.dialog.anotherCopyDetail":
    "Ela roda de {path}. Usar esta cópia troca o Psyche para este app; a outra cópia então se conecta a esta.",
  "desktop.dialog.keepOtherCopy": "Manter a outra cópia",
  "desktop.dialog.useThisCopy": "Usar esta cópia",
  "desktop.dialog.cancel": "Cancelar",
  "desktop.dialog.ok": "OK",
  "desktop.dialog.shareFolderTitle": "Compartilhar uma pasta com o Psyche",
  "desktop.dialog.share": "Compartilhar",
  "desktop.dialog.gatewaysFileTitle": "O Psyche não consegue ler os Gateways salvos",
  "desktop.dialog.gatewaysFileDetail":
    "{problem}. O Psyche inicia em {os, select, macos {este Mac} windows {este PC} other {este computador}} e deixa o arquivo como está, para que nenhuma identidade fixada se perca. Corrija ou remova o arquivo na pasta de dados do Psyche para usar o Gateway de outro computador.",
  "desktop.dialog.stillRunningTitle": "O Psyche continua em execução",
  "desktop.dialog.stillRunningBody":
    "Tarefas e automações continuam. Abra o Psyche pelo ícone na área de notificações; clique com o botão direito nele para sair.",
  "desktop.dialog.manualStepsTitle": "Falta mais um passo para terminar de remover o Psyche",
  "desktop.dialog.uninstallTitle": "Desinstalar o Psyche?",
  "desktop.dialog.uninstall": "Desinstalar",
  "desktop.dialog.uninstallAndDelete": "Apagar dados e desinstalar",
  "desktop.dialog.uninstallItems":
    "{count, plural, one {# item será movido} other {# itens serão movidos}} para o Lixo, incluindo o Psyche.app.",
  "desktop.dialog.uninstallDataFolder":
    "A sua pasta de dados {folder} também será movida para o Lixo.",
  "desktop.dialog.uninstallDataKept": "A sua pasta de dados será mantida.",
  "desktop.dialog.uninstallKeychain": "Os itens do Llavero que o Psyche guarda serão removidos.",
  "desktop.dialog.uninstallKeychainKept":
    "Os itens do Llavero permanecem; remova-os no Acesso às Chaves, se quiser.",
  "desktop.dialog.stopTitle":
    "Parar o Psyche em {os, select, macos {este Mac} windows {este PC} other {este computador}}?",
  "desktop.dialog.stopDetail":
    "As automações e tarefas agendadas dele param até você voltar atrás. Deixe-o rodando para que continuem.",
  "desktop.dialog.stopButton":
    "Parar o Psyche em {os, select, macos {este Mac} windows {este PC} other {este computador}}",
  "desktop.dialog.keepRunning": "Deixar rodando",
  "desktop.dialog.forgetTitle": "Esquecer {name}?",
  "desktop.dialog.forgetDetail":
    "{origin}\n\nIsso remove a chave deste computador para ele e tudo o que o Psyche guardou aqui por causa dele. {name} continua listando este computador até alguém removê-lo por lá.",
  "desktop.dialog.forgetButton": "Esquecer",
  "desktop.dialog.repairTitle": "Parear com {name} de novo?",
  "desktop.dialog.repairDetail":
    "{origin}\n\nIsso esquece a identidade que o Psyche fixou para ele e a chave deste computador, então a próxima conexão fixa o que responder naquele endereço e pede para parear como um computador novo. Faça isso só se souber por que a identidade mudou.",
  "desktop.dialog.repairButton": "Parear de novo",
  "desktop.dialog.claimTitle": "Configurar o servidor do Psyche em {origin}?",
  "desktop.dialog.claimDetail":
    "O Psyche verifica se o servidor conhece o código de configuração que você digitou antes de confiar nele, e o servidor verifica se este computador o conhece antes de torná-lo administrador. Continue só se você mesmo acabou de instalar esse servidor.",
  "desktop.dialog.setUp": "Configurar",
  "desktop.dialog.addLanTitle": "{origin} é um Psyche desta rede?",
  "desktop.dialog.addLanDetail":
    "Nome: {name}\n\nUm Psyche desta rede usa um certificado próprio, que o Psyche fixa em vez de confiar no do sistema: ele confere o certificado e a chave do Gateway na primeira conexão e recusa qualquer outro depois. Escolha «Https simples» só para um servidor com certificado comum (por exemplo, um proxy reverso com sua própria CA). Nada é compartilhado até o dono aprovar este computador por lá.",
  "desktop.dialog.psycheOnNetwork": "Psyche desta rede",
  "desktop.dialog.plainHttps": "Https simples",
  "desktop.dialog.addLinkTitleLan": "Conectar o Psyche a {origin} nesta rede?",
  "desktop.dialog.addLinkTitle": "Conectar o Psyche a {origin}?",
  "desktop.dialog.addLinkDetail":
    "{external, select, yes {Este link foi aberto por outro app ou site, não foi você que colou. Continue só se você mesmo o criou em {os, select, macos {no Mac} windows {no PC} other {no computador}} que executa o Psyche.\n\n} other {}}O Psyche só se conectará se esse Gateway provar esta identidade:\n{fingerprint}\n\n{lan, select, yes {Ele usa um certificado próprio, não um em que o sistema confie. O Psyche o mantém fixado ao que este link indica ({pin}…) antes de enviar qualquer coisa, e recusa os outros. Continue só se o link veio do seu {os, select, macos {Mac} windows {PC} other {computador}} nesta rede.\n\n} other {}}O código único do link permite que esse Gateway aprove este computador sem perguntar de novo, com o acesso que o dono escolheu ao criá-lo.",
  "desktop.dialog.addDetailKey":
    "Nome: {name}\nChave anunciada: {key}…\n\nEste computador vai pedir a esse Gateway para parear. Nada é compartilhado até o dono aprovar este computador por lá, e o Psyche fixa a identidade do Gateway na primeira conexão.",
  "desktop.dialog.addDetailPlain":
    "Nome: {name}\n\nEste computador vai pedir a esse Gateway para parear. Nada é compartilhado até o dono aprovar este computador por lá, e o Psyche fixa a identidade do Gateway na primeira conexão.",
  "desktop.dialog.addGatewayButton": "Adicionar Gateway",
};
