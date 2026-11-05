import type { Catalogue } from "../../index.ts";

/** settings-d strings (pt); merged into `../pt.ts`. */
export const settingsD: Partial<Catalogue> = {
  "settings.pair.via": "De onde o outro computador vai se conectar?",
  "settings.pair.viaAddress": "Pelo Tailscale, no endereço deste Mac",
  "settings.pair.viaLan": "Desta rede",
  "settings.pair.viaLanHint":
    "Um link para esta rede contém a chave e o certificado deste Mac, então só funciona para computadores no mesmo Wi-Fi ou Ethernet.",
  "settings.pair.lanNote":
    "Este link é para computadores na mesma rede que este Mac. Ele indica a chave e o certificado que o Psyche vai exigir.",
  "settings.pair.err.noLan":
    "Ative “Permitir computadores desta rede” e espere até que esteja escutando para criar um link para esta rede.",
  "settings.key.gateway.lan": "Permitir computadores desta rede",
  "settings.key.gateway.lan.rotateCert": "O certificado de rede",
  "settings.lan.title": "Permitir computadores desta rede",
  "settings.lan.description":
    "Deixe o Psyche em outro computador no mesmo Wi-Fi ou Ethernet acessar o Gateway deste Mac, sem Tailscale. Fica desativado até você ativar.",
  "settings.lan.loadLabel": "Acesso à rede",
  "settings.lan.unsupported": "Este Gateway é antigo demais para escutar na rede.",
  "settings.lan.toggle": "Permitir computadores desta rede",
  "settings.lan.toggleHint":
    "O Psyche escuta em uma rede, por uma conexão criptografada com seu próprio certificado. Um computador que se conecta ainda precisa ser aprovado aqui com Touch ID.",
  "settings.lan.ipv6": "Usar também os endereços IPv6 desta rede",
  "settings.lan.ipv6Hint":
    "Adiciona os endereços IPv6 privados (começam com fd ou fc) da rede escolhida. Endereços IPv6 públicos e fe80 nunca são usados.",
  "settings.lan.problem.ipv6Off":
    "{address} é um endereço IPv6 e o IPv6 está desativado, então o Psyche não escuta nele. Ative o IPv6 acima ou remova-o.",
  "settings.lan.problem.ipv6NeedsIpv4":
    "O Psyche não escuta em {address}. O IPv6 só é usado junto com o endereço IPv4 desta rede, que você precisa permitir aqui primeiro.",
  "settings.lan.interface": "Rede",
  "settings.lan.interfaceDefault": "Rede principal",
  "settings.lan.interfaceOption": "{name} ({address})",
  "settings.lan.noInterface": "Nenhuma conexão Wi-Fi ou Ethernet foi encontrada neste Mac.",
  "settings.lan.trustedOnly":
    "Ative só em uma rede em que você confia. Em Wi-Fi compartilhado ou de convidados, qualquer pessoa conectada pode chegar à tela de emparelhamento.",
  "settings.lan.status": "Status",
  "settings.lan.listening": "Escutando em {addresses}",
  "settings.lan.notListening": "Não está escutando",
  "settings.lan.address": "Endereço",
  "settings.lan.discovery": "Descoberta",
  "settings.lan.advertised": "Visível para o Psyche nesta rede",
  "settings.lan.notAdvertised": "Não visível. Adicione este Mac pelo endereço.",
  "settings.lan.certificate": "Certificado",
  "settings.lan.certificateHint":
    "Os computadores que emparelham o memorizam. Se você substituir o certificado, todos precisarão emparelhar novamente.",
  "settings.lan.rotate": "Substituir certificado",
  "settings.lan.rotateTitle": "Substituir o certificado de rede?",
  "settings.lan.rotateBody":
    "Os computadores já emparelhados pela rede deixarão de se conectar até emparelharem novamente. Use se achar que o certificado foi copiado.",
  "settings.lan.rotateConfirm": "Substituir e desconectá-los",
  "settings.lan.rotateFailed": "Não foi possível substituir o certificado ({reason}). Nada mudou.",
  "settings.lan.problem.unknownInterface": "{name} não é uma rede deste Mac.",
  "settings.lan.problem.noInterface":
    "Não há nenhuma rede para escutar, então nada está escutando.",
  "settings.lan.problem.bindFailed":
    "Não foi possível escutar em {address}. Outro programa pode estar usando a porta.",
  "settings.lan.problem.paused":
    "O acesso pela rede local está pausado nesta rede. Você o ativou para outra.",
  "settings.lan.allowHere": "Permitir nesta rede",
  "settings.lan.problem.cert":
    "O Psyche não conseguiu criar nem ler o certificado de rede, então não está escutando.",
  "settings.lan.problem.cloudflare":
    "Este Gateway está configurado para ser acessado apenas pelo Cloudflare Access, então também não vai escutar na rede.",
  "settings.gateways.discoverConflict":
    "Mais de um computador anunciou este nome com chaves diferentes, então o Psyche não o adiciona. Adicione o correto pelo endereço.",
  "settings.lan.problem.container": "Um Gateway em um contêiner não escuta na rede desta forma.",
  "settings.lan.problem.advertise":
    "O Psyche não conseguiu se anunciar na rede. Os computadores ainda podem adicionar este Mac pelo endereço.",
  "settings.gateways.discover": "Procurar nesta rede",
  "settings.gateways.discovering": "Procurando…",
  "settings.gateways.discoverTitle": "Nesta rede",
  "settings.gateways.discoverNone":
    "Nenhum Psyche encontrado. Nesse computador, ative “Permitir computadores desta rede”.",
  "settings.gateways.discoverFailed":
    "Não foi possível procurar na rede. Adicione-o pelo endereço.",
  "settings.gateways.discoverKey": "Chave {fingerprint}",
  "settings.gateways.discoverHint":
    "O que um computador anuncia na rede é uma alegação. A tela de emparelhamento mostra a chave dele: compare-a com a do Host antes de aprovar.",
  "settings.gateways.discoverAdd": "Adicionar {name}",
  "settings.gateways.discoverSaved": "Salvo",
  "settings.devices.gatewayKey": "Chave deste Gateway {fingerprint}",
  "settings.devices.fromAddress": "De {address}",
  "settings.devices.fromLan": "De {address}, na sua rede. Confira a chave completa abaixo.",
  "settings.devices.adminOptIn":
    "Admin permite que este computador altere ajustes de segurança, dispositivos e o cofre. Deixe desativado, a menos que precise.",
  "settings.skills.signer.title": "Quem criou",
  "settings.skills.signer.unsigned":
    "Sem assinatura. Nada indica quem o criou nem que não foi alterado no caminho, então é instalado como um editor desconhecido.",
  "settings.skills.signer.new": "Assinado por {name}. Você nunca viu esta chave antes.",
  "settings.skills.signer.seen":
    "Assinado por {name}, com uma chave que você já viu, mas em que não confiou.",
  "settings.skills.signer.trusted": "Assinado por {name}, um autor em quem você confia.",
  "settings.skills.signer.own": "Assinado por você.",
  "settings.skills.signer.changed":
    "Assinado por {name}, mas não com a chave vista antes. Confira se é a mesma pessoa antes de instalar.",
  "settings.skills.signer.changedUpdate":
    "Assinado por {name}, com uma chave diferente da versão que você tem instalada. Confira se é a mesma pessoa antes de atualizar.",
  "settings.skills.signer.dropped":
    "A versão instalada foi assinada por {name}. Esta não tem assinatura nenhuma.",
  "settings.skills.signer.impersonates":
    "Assinado por {name}, que parece o nome com o qual você assina suas próprias habilidades, mas a chave não é sua. Não instale a menos que saiba de onde veio.",
  "settings.skills.signer.nameChanged":
    "Assinado com uma chave em que você confia, mas com um nome que ela não usava antes: {name}. Confira se ainda é a mesma pessoa.",
  "settings.skills.signer.originAgent":
    "Escrito por um assistente no Mac do remetente. Leia como texto não revisado, seja quem for que assinou.",
  "settings.skills.widened.specialist": "Função em segundo plano",
  "settings.skills.bundleOriginAgent": "Escrito por um assistente em outro lugar",
  "settings.skills.export.label": "Assinando “{name}”",
  "settings.skills.author.label": "Confiança no autor",
  "settings.skills.signer.claim":
    "O nome é uma alegação do próprio autor. A chave é o que liga as versões.",
  "settings.skills.signer.key": "Chave do autor",
  "settings.skills.signer.trust": "Confiar em {name} como autor",
  "settings.skills.signer.trustHint":
    "Versões posteriores assinadas com esta chave são marcadas como de um autor em quem você confia. Cada instalação ainda pergunta antes.",
  "settings.skills.widened.title": "Pede mais que a versão instalada",
  "settings.skills.widened.hint":
    "Aprovar não dá nenhuma permissão por si só, mas agora também levará a estas perguntas.",
  "settings.skills.widened.permissions": "Novas permissões",
  "settings.skills.widened.tools": "Novas ferramentas",
  "settings.skills.widened.prompts": "Novos arquivos de prompt",
  "settings.skills.import.file": "Importar um arquivo…",
  "settings.skills.import.hint":
    "Um arquivo .psyche-skill de outra pessoa, ou um link https para um. Ele é verificado e mostrado a você antes de instalar qualquer coisa.",
  "settings.skills.import.failed": "O Psyche não conseguiu ler esse arquivo ({reason}).",
  "settings.skills.import.tooBig": "esse arquivo é maior que 8 MB",
  "settings.skills.signedBy": "Assinado por {name}",
  "settings.skills.signedState":
    "{state, select, own {você} trusted {confiável} revoked {revogado} other {não confiável}}",
  "settings.skills.export": "Exportar…",
  "settings.skills.export.title": "Exportar “{name}”",
  "settings.skills.export.hint":
    "O arquivo é assinado com a sua chave de autor, para que quem o receba saiba que é seu e que não foi alterado. A chave fica neste Mac.",
  "settings.skills.export.nameLabel": "Nome para assinar",
  "settings.skills.export.nameHint":
    "Criado uma vez. Todos que importarem suas habilidades o veem.",
  "settings.skills.export.go": "Exportar e assinar",
  "settings.skills.exported":
    "“{name}” exportado como {file}, assinado como {author}.{created, select, true { Sua chave de autor foi criada: {key}.} other {}}",
  "settings.skills.author.trust": "Confiar neste autor",
  "settings.skills.author.untrust": "Deixar de confiar neste autor",
  "settings.skills.author.revoke": "Revogar este autor",
  "settings.skills.author.revokeTitle": "Revogar a chave de {name}?",
  "settings.skills.author.revokeDescription":
    "As habilidades assinadas com ela deixam de carregar e novos arquivos assinados com ela são recusados. Você pode confiar nela de novo depois.",
  "settings.skills.author.revokeConfirm": "Revogar",
  "settings.usage.unavailable": "O uso ainda não está disponível neste Gateway.",
  "settings.usage.thisMonth": "Este mês",
  "settings.usage.monthLine":
    "{cost} e {tokens} tokens em {turns, plural, one {# turno} other {# turnos}}. Hoje até agora: {today}.",
  "settings.usage.noBudget": "Nenhum orçamento mensal definido.",
  "settings.usage.byModel": "Últimos 7 dias por modelo",
  "settings.usage.model": "Modelo",
  "settings.usage.turns": "{n, plural, one {# turno} other {# turnos}}",
  "settings.usage.planWindow": "{model}: {pct}% da janela do plano usada, reinicia {when}.",
  "settings.vm.enabledHint":
    "As tarefas que pedem isso rodam no convidado, apenas com as pastas que você compartilha.",
  "settings.vm.credentialsHint":
    "Com o cofre do anfitrião, os valores ficam no seu Mac. Um cofre do convidado guarda a própria cópia.",
  "settings.voice.anyAppHint":
    "onde quer que você esteja digitando. O texto vai para o seu cursor, nunca para o agente nem para um campo de senha.",
  "settings.voice.talkHint":
    "Um botão Voz no campo de mensagem inicia uma conversa falada. A voz nunca aprova nada.",
  "settings.people.title": "Pessoas e projetos",
  "settings.people.description":
    "Os cartões que {persona} guarda sobre as pessoas e projetos da sua vida. Ficam neste Mac e cada fato mostra de onde veio.",
  "settings.people.loadLabel": "Carregando os ajustes de pessoas e projetos",
  "settings.people.off":
    "Desativado. {persona} não guarda cartões das pessoas e projetos da sua vida.",
  "settings.people.turnOn": "Ativar",
  "settings.people.graph": "Aprender sobre pessoas a partir de",
  "settings.people.entityRecall": "Usar nomes nas respostas",
  "settings.people.entityRecallHint":
    "Quando você cita alguém em um chat privado, {persona} acrescenta uma linha sobre a pessoa. Nunca em grupos nem canais.",
  "settings.people.sources": "Aprender sobre pessoas a partir de",
  "settings.people.sourcesHint":
    "Cada fonte fica desativada até você ativar. Desativar uma deixa de lê-la.",
  "settings.people.source.contacts": "Contatos",
  "settings.people.source.mail": "E-mail",
  "settings.people.source.calendar": "Calendário",
  "settings.people.source.messages": "Mensagens",
  "settings.people.source.messagesHint":
    "Usa com quem você fala e quando, nunca o texto das mensagens.",
  "settings.people.source.notes": "Notas",
  "settings.people.source.chats": "Seus chats",
  "settings.people.sourceOff": "Desativado",
  "settings.people.sourceCounts":
    "{entities, plural, one {# pessoa ou projeto} other {# pessoas e projetos}} · {interactions, plural, one {# interação} other {# interações}} · {read, select, none {ainda não lido} other {lido {read}}}",
  "settings.people.retention": "Quanto tempo as interações permanecem",
  "settings.people.retentionLabel": "Guardar as interações por",
  "settings.people.retentionHint":
    "Cabeçalhos e links mais antigos são excluídos toda noite. Cartões, fatos e pendências ficam até você esquecê-los.",
  "settings.people.months": "{n, plural, one {# mês} other {# meses}}",
  "settings.people.learning": "Como os cartões são mantidos",
  "settings.people.learningHint":
    "Resumos, funções e pendências vêm do modelo utilitário, local por padrão.",
  "settings.people.budget":
    "Esta noite: {tokens, number} de {maxTokens, number} tokens, {entities, number} de {maxEntities, number} pessoas e projetos. Resumos, funções e pendências vêm do modelo utilitário, local por padrão.",
  "settings.people.nightly": "Toda noite",
  "settings.people.nightlyHint": "Atualiza resumos e encontra pendências enquanto você dorme.",
  "settings.people.afterRun": "Após cada tarefa",
  "settings.people.afterRunHint": "Atualiza as poucas pessoas e projetos que uma tarefa tocou.",
  "settings.people.precision": "Pendências sugeridas que você manteve: {list}.",
  "settings.people.precisionItem": "{source} {confirmed, number} de {total, number}",
  "settings.people.aboutYou": "Sobre você",
  "settings.people.aboutYouHint":
    "Seu próprio cartão: cada fato que {persona} aprendeu sobre você, com a fonte.",
  "settings.people.openOwnCard": "Abrir seu cartão",
  "settings.people.ownCardHint": "Fatos sobre você do seu perfil, chats e apps conectados.",
  "settings.people.editUserMd": "Editar USER.md",
  "settings.people.blocked": "Bloqueado em Pessoas",
  "settings.people.blockedHint":
    "Nunca mais se aprende sobre isso. Um domínio bloqueado cobre todos os endereços dele.",
  "settings.people.noneBlocked": "Ninguém bloqueado.",
  "settings.people.blockedOn": "{kind} · bloqueado {date}",
  "settings.people.unblock": "Desbloquear",
  "settings.people.unblockLabel": "Desbloquear {hint}",
  "settings.people.block": "Bloquear",
  "settings.people.blockKindLabel": "O que bloquear",
  "settings.people.blockValue": "Endereço, telefone ou domínio",
  "settings.people.blockKind.email": "Endereço de e-mail",
  "settings.people.blockKind.phone": "Número de telefone",
  "settings.people.blockKind.domain": "Domínio",
  "settings.people.blockKind.contact": "Contato",
  "settings.people.blockKind.channel": "Canal",
  "settings.people.blockKind.calendar": "Calendário",
  "settings.people.blockKind.url": "Endereço web",
  "settings.people.blockPlaceholder.email": "nome@exemplo.com",
  "settings.people.blockPlaceholder.phone": "+55 11 99999-0000",
  "settings.people.blockPlaceholder.domain": "exemplo.com",
  "settings.people.nothingStored": "Ainda não há nada guardado de nenhuma fonte.",
  "settings.people.sourceStored":
    "{entities, plural, one {# pessoa ou projeto} other {# pessoas e projetos}} · {interactions, plural, one {# interação} other {# interações}}",
  "settings.people.deleteSource": "Excluir…",
  "settings.people.deleteSourceLabel": "Excluir o que {source} trouxe",
  "settings.people.deleteSourceTitle": "Excluir o que {source} trouxe?",
  "settings.people.deleteSourceAfter":
    "{source} é desativado para que a próxima sincronização não o traga de volta. Fatos que você mesmo adicionou permanecem.",
  "settings.people.deleteSourceConfirm": "Excluir",
  "settings.people.deletedSource": "O que {source} trouxe foi excluído.",
  "settings.people.forgetAll": "Tudo sobre pessoas e projetos",
  "settings.people.forgetAllHint":
    "Exclui cada pessoa, projeto, cartão e pendência, e desativa Pessoas e projetos. Seus próprios arquivos de memória permanecem.",
  "settings.people.forgetAllButton": "Esquecer…",
  "settings.people.forgetAllTitle": "Esquecer tudo sobre pessoas e projetos?",
  "settings.people.forgetAllAfter":
    "Isso não pode ser desfeito. Pessoas e projetos é desativado; ative de novo para recomeçar do zero.",
  "settings.people.typeToConfirm": "Digite “{phrase}” para confirmar",
  "settings.people.forgetAllConfirm": "Esquecer tudo",
  "settings.people.forgotAll": "Tudo sobre pessoas e projetos foi esquecido.",
  "settings.people.counting": "Verificando o que seria excluído…",
  "settings.people.previewFailed": "O Psyche não conseguiu contar o que excluiria ({reason}).",
};
