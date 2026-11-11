import { isJidGroup } from '@whiskeysockets/baileys';
import type { WASocket, WAMessage, MessageUpsertType } from '@whiskeysockets/baileys';
import type { ComandoExecutarDto } from '../dto/comandos.dto.js';
import carregarComandos from './comandos.js';
import { agendamentoRepository } from '../repository/agendamento.repository.js';
import { schedulerService } from '../services/scheduler.service.js';
import { resolverNumeroRemetente, ehAdminPorJid, botFoiMencionado } from './identidade.js';
import { buscarPorNumero } from '../repository/pessoa.repository.js';
import { registrar, textoParaContexto } from './contexto.js';

// Confirmação de lembretes URGENTES: qualquer mensagem do solicitante naquele
// chat encerra a cobrança (nag). Ignora as próprias mensagens de lembrete do bot
// (dedupe por ID em `foiLembrete`), sem confundi-las com a "resposta".
async function confirmarUrgentes(sock: WASocket, msg: WAMessage): Promise<void> {
    const jid = msg.key.remoteJid;
    if (!jid) return;
    if (schedulerService.foiLembrete(msg.key.id)) return; // é o nosso próprio reenvio

    const pendentes = agendamentoRepository.listarAguardandoConfirmacao(jid);
    if (!pendentes.length) return;

    const ehGrupo = isJidGroup(jid);
    const numero = ehGrupo ? await resolverNumeroRemetente(sock, msg) : null;

    let confirmou = false;
    for (const ag of pendentes) {
        // Privado: conversa 1:1, qualquer msg é do solicitante.
        // Grupo: precisa ser quem pediu (contact_id); fallback se não foi capturado.
        const ehSolicitante = !ehGrupo || ag.contact_id === numero || ag.contact_id === jid;
        if (ehSolicitante && schedulerService.confirmar(ag.id)) confirmou = true;
    }
    if (confirmou) {
        await sock.sendMessage(jid, { text: '✅ beleza, vi aqui! parei de te lembrar 💅' });
    }
}

export type Comando = {
    name: string;
    description?: string;
    execute: (dto: ComandoExecutarDto) => Promise<unknown>;
};

export type CarregadorComandos = () => Promise<Map<string, Comando>>;

export async function enviarMensagem(
    sock: WASocket,
    messageDto: {
        messages: WAMessage[];
        type: MessageUpsertType;
        requestId?: string;
    },
    carregador: CarregadorComandos = carregarComandos as CarregadorComandos,
) {
    if (messageDto.type !== 'notify') return;

    const comandos = await carregador();

    for (const msg of messageDto.messages) {
        if (msg.key.remoteJid?.endsWith('@newsletter')) {
            continue;
        }

        // Antes de qualquer filtro de comando: ver se essa mensagem é a "resposta"
        // que encerra a cobrança de um lembrete urgente neste chat.
        await confirmarUrgentes(sock, msg);

        const jid = msg.key.remoteJid!;

        const text = msg.message?.conversation
            || msg.message?.extendedTextMessage?.text
            || msg.message?.imageMessage?.caption
            || msg.message?.videoMessage?.caption;

        // Buffer de contexto: registra TODA mensagem (gatilho ou não, com ou sem
        // texto) ANTES de qualquer `continue`, para que quando um /p ou @menção
        // chegar o agente receba as últimas N mensagens do chat como contexto.
        // Sem resolução LID→PN aqui (async caro no hot path) — pushName basta;
        // fallback para os dígitos do remetente. Mídia entra só como marcador.
        const textoCtx = textoParaContexto(msg.message);
        if (textoCtx) {
            const autorCtx = msg.pushName
                ?? (msg.key.participant ?? jid).split('@')[0]
                ?? null;
            registrar(jid, {
                msgId: msg.key.id ?? '',
                autor: autorCtx,
                texto: textoCtx,
                ts: Number(msg.messageTimestamp) || Date.now(),
            });
        }

        // Mídia direta no turno (foto/figurinha/vídeo/áudio, mesmo SEM legenda).
        // Sem isso, uma figurinha/imagem sozinha não tem `text` e seria descartada
        // antes dos gatilhos — queremos que o agente "veja" e responda a ela.
        const temMidia = !!(msg.message?.imageMessage || msg.message?.stickerMessage
            || msg.message?.videoMessage || msg.message?.audioMessage);

        // Só ignora de vez quando NÃO há texto E NÃO há mídia (mensagem vazia de
        // verdade). Mídia-sozinha segue para os gatilhos (e é barrada lá se não
        // for comando/menção/bypass — ex.: figurinha solta em grupo).
        if (!text && !temMidia) continue;

        console.log(`📩 Mensagem de ${jid}: ${text || '[mídia sem texto]'}`);

        // `text` pode ser vazio/undefined quando é mídia-sozinha — coalesce p/ ''.
        const comando = (text ?? '').split(' ')[0]?.toLowerCase();
        const instrucao = (text ?? '').slice(comando?.length).trim();

        const ehComando = !!comando && comandos.has(comando);
        // Comando explícito sempre vence; senão, dispara se a mensagem mencionar o
        // próprio bot (ignora ecos `fromMe` para não entrar em loop).
        const mencionouBot = !ehComando && !msg.key.fromMe && await botFoiMencionado(sock, msg);

        // Bypass em DM: quem está CADASTRADO no banco (ou é o admin) dispara o
        // agente SEM precisar de /p ou @menção numa conversa PRIVADA — a LulaDroid
        // responde sozinha. Só em DM (nunca em grupo, pra não responder tudo),
        // só para mensagem que não é comando nem menção, e nunca para ecos do
        // próprio bot. A checagem de "cadastrado" é a MESMA do /p (resolve o
        // número e consulta pessoa.repository) — em DM isso é barato.
        let ehDmCadastrado = false;
        if (!ehComando && !mencionouBot && !msg.key.fromMe && !isJidGroup(jid)) {
            const numeroDm = await resolverNumeroRemetente(sock, msg);
            ehDmCadastrado = ehAdminPorJid(numeroDm) || (!!numeroDm && !!buscarPorNumero(numeroDm));
        }

        if (!ehComando && !mencionouBot && !ehDmCadastrado) continue;

        const remetenteNumero = await resolverNumeroRemetente(sock, msg);
        const ehAdmin = ehAdminPorJid(remetenteNumero);
        console.log(`[admin-debug] remoteJid=${msg.key.remoteJid} participant=${msg.key.participant ?? '-'} resolvido=${remetenteNumero ?? 'null'} ehAdmin=${ehAdmin}`);
        const remetenteJid = isJidGroup(jid) ? (msg.key.participant ?? undefined) : jid;

        if (ehComando) {
            const dto: ComandoExecutarDto = {
                sock,
                conteudo: instrucao,
                usuarioJid: jid,
                msg,
                remetenteJid,
                ehAdmin,
            };
            await comandos.get(comando!)!.execute(dto);
            continue;
        }

        // Gatilho por menção/bypass: roteia pro MESMO fluxo do /p, texto sem a menção.
        const conteudoSemMencao = (text ?? '').replace(/@\d+/g, '').replace(/\s+/g, ' ').trim();
        const cmdP = comandos.get('/p');
        if (!cmdP) {
            console.warn('Acionado, mas o comando /p não está disponível.');
            continue;
        }
        // Mesmo SEM texto (só @menção, ou @menção respondendo a uma foto): segue
        // pro /p. O agente responde com base no [contexto-recente] (últimas msgs)
        // + a imagem/mídia em que foi mencionado. Não existe mais o atalho
        // "me chama junto com a pergunta" — mencionar já basta pra ela responder.
        await cmdP.execute({ sock, conteudo: conteudoSemMencao, usuarioJid: jid, msg, remetenteJid, ehAdmin });
    }
}
