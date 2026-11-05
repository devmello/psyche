import type { Catalogue } from "../../index.ts";

/** The Linux helper check in Settings → Devices (pt); merged into `../pt.ts`. */
export const helperCheck: Partial<Catalogue> = {
  "settings.devices.helperCheck.title": "Verificação do assistente do Linux",
  "settings.devices.helperCheck.description":
    "Quando o assistente do Linux se conecta, o Psyche verifica qual programa ele realmente é.",
  "settings.devices.helperCheck.state.verified": "Verificado: assistente instalado no sistema",
  "settings.devices.helperCheck.state.userOwned": "Não verificado: assistente da sua pasta pessoal",
  "settings.devices.helperCheck.state.unverified":
    "Não verificado: o Psyche não conseguiu verificar o assistente",
  "settings.devices.helperCheck.detail.verified":
    "É o assistente instalado com o Psyche. Só o sistema pode alterá-lo.",
  "settings.devices.helperCheck.detail.userOwned":
    "Ele roda a partir de arquivos seus, como um AppImage ou uma compilação na sua pasta pessoal. O Psyche o aceita, mas não pode descartar que outro programa seu o tenha substituído.",
  "settings.devices.helperCheck.detail.unverified":
    "Por enquanto o Psyche o aceita, mas não conseguiu saber qual programa é.",
  "settings.devices.helperCheck.refused": "Recusado: {reason}",
  "settings.devices.helperCheck.reason.unclear": "o Psyche não conseguiu verificar o assistente",
  "settings.devices.helperCheck.reason.notHelper": "este programa não é o assistente do Psyche",
  "settings.devices.helperCheck.reason.userCopy":
    "é uma cópia fora da instalação do sistema, e o assistente instalado é obrigatório",
  "settings.devices.helperCheck.reason.loaderEnv":
    "foi iniciado com um caminho de bibliotecas ou uma biblioteca pré-carregada",
  "settings.devices.helperCheck.reason.foreignCode": "tem código carregado de fora do sistema",
  "settings.devices.helperCheck.reason.severalPrograms":
    "mais de um programa compartilha a conexão dele",
  "settings.devices.helperCheck.reason.handedOver":
    "a conexão dele foi entregue por outro programa",
  "settings.devices.helperCheck.reason.stillStarting": "ele ainda estava iniciando",
  "settings.devices.helperCheck.reason.debugged": "ele está parado ou sendo depurado",
  "settings.devices.helperCheck.reason.restartNeeded":
    "ele foi substituído ou uma biblioteca do sistema foi atualizada desde que iniciou; reinicie o assistente",
  "settings.devices.helperCheck.reason.filesNotLocked":
    "os arquivos dele poderiam ser alterados por alguém que não é o sistema",
  "settings.devices.helperCheck.reason.otherNamespace":
    "ele roda em um ambiente isolado separado deste computador",
  "settings.devices.helperCheck.reason.busy":
    "o Psyche estava ocupado verificando outras conexões; o assistente tentará de novo",
};
