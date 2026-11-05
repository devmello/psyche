import type { Catalogue } from "../../index.ts";

/** Settings > Computer use > Separate desktop (pt); merged into `../pt.ts`. */
export const separateDesktop: Partial<Catalogue> = {
  "settings.separateDesktop.title": "Área de trabalho separada",
  "settings.separateDesktop.description":
    "Uma área de trabalho privada num contêiner, com apps e arquivos próprios. Ela só vê as pastas que você compartilha para uma tarefa, não tem internet a menos que você permita para essa tarefa e para quando a tarefa termina.",
  "settings.separateDesktop.state.off": "Parada",
  "settings.separateDesktop.state.starting": "Iniciando",
  "settings.separateDesktop.state.running": "Em execução",
  "settings.separateDesktop.state.stopping": "Parando",
  "settings.separateDesktop.state.failed": "Não foi possível iniciar",
  "settings.separateDesktop.engine": "Mecanismo de contêineres: {engine}",
  "settings.separateDesktop.rootful":
    "Este mecanismo de contêineres roda como root. Use o Podman sem root para a área de trabalho separada.",
  "settings.separateDesktop.memory": "Limite de memória",
  "settings.separateDesktop.memoryHint":
    "A maior quantidade de memória que a área de trabalho separada pode usar enquanto roda.",
  "settings.separateDesktop.memoryOption": "{gb} GB",
  "settings.separateDesktop.shares": "Pastas compartilhadas: {names}",
  "settings.separateDesktop.internet": "A internet está ativada para esta tarefa",
  "settings.separateDesktop.reset": "Redefinir a área de trabalho separada",
  "settings.separateDesktop.resetHint":
    "Exclui o contêiner e tudo o que foi salvo nele. As pastas que você compartilhou não são alteradas.",
  "blocks.folder.sd.explain.ro":
    "{persona} quer deixar a área de trabalho separada ler os arquivos de uma pasta.",
  "blocks.folder.sd.explain.rw":
    "{persona} quer deixar a área de trabalho separada ler e alterar os arquivos de uma pasta. Os programas da área de trabalho separada podem alterar arquivos ali, e as alterações aparecem neste computador.",
  "blocks.folder.sd.scope":
    "A área de trabalho separada vê esta pasta só durante esta tarefa. Nada mais neste computador é compartilhado, e nenhuma outra ferramenta deste computador recebe a pasta.",
  "blocks.folder.sd.scope.once": "Só esta tarefa",
  "settings.separateDesktop.limitMemory": "O limite de memória não é aplicado neste sistema",
  "settings.separateDesktop.limitPids": "O limite de processos não é aplicado neste sistema",
  "blocks.details.sdUnverified":
    "A área de trabalho separada não consegue confirmar que esta página é mesmo {origin}. Continue só se confiar no lugar para onde a tarefa levou.",
  "blocks.details.sdFiles": "Arquivos",
  "blocks.details.sdAlsoChanges":
    "Esta tarefa também pode alterar {folder} e enviar arquivos de lá.",
};
