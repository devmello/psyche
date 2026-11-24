import type { Catalogue } from "../../index.ts";

/** The Virtual screen watch pane (pt); merged into `../pt.ts`. */
export const computerWatch: Partial<Catalogue> = {
  "computerWatch.title": "Tela virtual",
  "web.panes.title.computer-watch": "Tela virtual",
  "computerWatch.frame.alt": "Visualização ao vivo da tela virtual",
  "computerWatch.stop": "Parar",
  "computerWatch.takeOver": "Assumir o controle",
  "computerWatch.control.agent": "O agente está no controle.",
  "computerWatch.control.you": "Você está no controle. O agente está em pausa.",
  "computerWatch.apps.title": "Apps abertos",
  "computerWatch.apps.empty": "Nenhum app aberto.",
  "computerWatch.apps.unsaved": "Alterações não salvas",
  "computerWatch.empty.title": "Nenhuma tela virtual em execução",
  "computerWatch.empty.body":
    "Quando o agente precisar de uma tela própria, você poderá acompanhá-la aqui.",
  "computerWatch.starting": "Iniciando a tela virtual…",
  "computerWatch.error": "Não foi possível acessar a tela virtual. Tentando de novo…",
  "computerWatch.inputFailed": "Sua ação não chegou à tela virtual ({reason}).",
  "computerWatch.handBackFailed":
    "Não foi possível devolver o controle ao agente ({reason}). Você continua com o controle.",
  "computerWatch.handBack.retry": "Tentar novamente",
  "computerWatch.parked.title": "Aguardando você",
  "computerWatch.parked.body": "Um app tem alterações não salvas, então a tarefa está em pausa.",
  "computerWatch.parked.look": "Ver",
  "computerWatch.parked.discard": "Descartar",
  "computerWatch.parked.keepOpen": "Manter aberto",
};
