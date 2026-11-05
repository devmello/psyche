import type { Catalogue } from "../../index.ts";

/** Settings > Computer use > Separate desktop (pt); merged into `../pt.ts`. */
export const separateDesktop: Partial<Catalogue> = {
  "settings.separateDesktop.title": "Área de trabalho separada",
  "settings.separateDesktop.description": "Uma área de trabalho privada num contêiner, com apps e arquivos próprios. Ela só vê as pastas que você compartilha para uma tarefa, não tem internet a menos que você permita para essa tarefa e para quando a tarefa termina.",
  "settings.separateDesktop.state.off": "Parada",
  "settings.separateDesktop.state.starting": "Iniciando",
  "settings.separateDesktop.state.running": "Em execução",
  "settings.separateDesktop.state.stopping": "Parando",
  "settings.separateDesktop.state.failed": "Não foi possível iniciar",
  "settings.separateDesktop.engine": "Mecanismo de contêineres: {engine}",
  "settings.separateDesktop.rootful": "Este mecanismo de contêineres roda como root. Use o Podman sem root para a área de trabalho separada.",
  "settings.separateDesktop.memory": "Limite de memória",
  "settings.separateDesktop.memoryHint": "A maior quantidade de memória que a área de trabalho separada pode usar enquanto roda.",
  "settings.separateDesktop.memoryOption": "{gb} GB",
  "settings.separateDesktop.shares": "Pastas compartilhadas: {names}",
  "settings.separateDesktop.internet": "A internet está ativada para esta tarefa",
  "settings.separateDesktop.reset": "Redefinir a área de trabalho separada",
  "settings.separateDesktop.resetHint": "Exclui o contêiner e tudo o que foi salvo nele. As pastas que você compartilhou não são alteradas.",
};
