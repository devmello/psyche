import type { Catalogue } from "../../index.ts";

/** keep-awake and retry strings (pt); merged into `../pt.ts`. */
export const keepAwake: Partial<Catalogue> = {
  "settings.daily.group.keepAwake": "Manter este computador acordado",
  "settings.daily.keepAwake.hint":
    "Enquanto uma tarefa agendada está em andamento, este computador não entra em suspensão até ela terminar. A tela ainda pode apagar.",
  "settings.key.scheduled.keepAwake":
    "Manter este computador acordado enquanto as tarefas agendadas rodam",
  "scheduled.history.retryingAt": "Nova tentativa às {time}",
  "scheduled.history.retry": "Tentativa {n} de 3",
  "scheduled.history.failedAfterRetries": "Falhou após {n} novas tentativas",
  "scheduled.history.cancelRetry": "Cancelar nova tentativa",
  "scheduled.history.cancelRetry.aria": "Cancelar a nova tentativa da execução de {when}",
  "scheduled.history.cancelRetry.failed": "Não foi possível cancelar a nova tentativa ({reason}).",
  "settings.updates.group": "Atualizações",
  "settings.updates.hint": "O Psyche procura atualizações assinadas e as instala quando você sai.",
  "settings.updates.channel": "Canal de versões",
  "settings.updates.channel.stable": "Estável",
  "settings.updates.channel.note":
    "Estável é o único canal por enquanto. O Beta aparecerá aqui quando houver builds beta publicados. Toda atualização é verificada com a chave de versões do Psyche de qualquer forma.",
  "settings.storage.title": "Armazenamento",
  "settings.storage.hint":
    "Espaço em disco que o Psyche usa na sua pasta de dados neste computador.",
  "settings.storage.total": "Total",
  "settings.storage.clear": "Limpar…",
  "settings.storage.cleared": "Limpo. {size} liberados.",
  "settings.storage.clearFailed": "Não foi possível limpar o armazenamento ({reason}).",
  "settings.storage.failed": "Não foi possível ler o uso do armazenamento ({reason}).",
  "settings.storage.confirm.title": "Limpar caches e gravações antigas?",
  "settings.storage.confirm.body":
    "Isso apaga {size} de caches e gravações do navegador com mais de 7 dias, junto com as entradas delas na Biblioteca. O Psyche recria os caches quando precisa deles. Suas conversas, memória, outros arquivos da Biblioteca, cofre e ajustes não são afetados.",
  "settings.storage.confirm.clear": "Limpar",
  "settings.storage.cat.database": "Banco de dados",
  "settings.storage.cat.memoryIndex": "Índice de memória",
  "settings.storage.cat.library": "Anexos e Biblioteca",
  "settings.storage.cat.browserProfiles": "Perfis do navegador",
  "settings.storage.cat.recordings": "Gravações",
  "settings.storage.cat.logs": "Registros",
  "settings.storage.cat.caches": "Caches",
  "settings.storage.cat.other": "Todo o resto",
};
