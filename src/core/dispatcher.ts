import { isJidGroup } from '@whiskeysockets/baileys';
import type { WASocket, WAMessage, MessageUpsertType } from '@whiskeysockets/baileys';
import type { ComandoExecutarDto } from '../dto/comandos.dto.js';
import carregarComandos from './comandos.js';
import { agendamentoRepository } from '../repository/agendamento.repository.js';
import { schedulerService } from '../services/scheduler.service.js';
import { resolverNumeroRemetente, ehAdminPorJid, botFoiMencionado } from './identidade.js';

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

        if (!text) continue;

        console.log(`📩 Mensagem de ${jid}: ${text}`);

        const comando = text.split(' ')[0]?.toLowerCase();
        const instrucao = text.slice(comando?.length).trim();

        const ehComando = !!comando && comandos.has(comando);
        // Comando explícito sempre vence; senão, dispara se a mensagem mencionar o
        // próprio bot (ignora ecos `fromMe` para não entrar em loop).
        const mencionouBot = !ehComando && !msg.key.fromMe && await botFoiMencionado(sock, msg);

        if (!ehComando && !mencionouBot) continue;

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

        // Gatilho por menção: roteia pro MESMO fluxo do /p, com o texto sem a menção.
        const conteudoSemMencao = text.replace(/@\d+/g, '').replace(/\s+/g, ' ').trim();
        const cmdP = comandos.get('/p');
        if (!cmdP) {
            console.warn('Bot mencionado, mas o comando /p não está disponível.');
            continue;
        }
        if (!conteudoSemMencao) {
            await sock.sendMessage(jid, { text: 'oi! me chama junto com a pergunta que eu te respondo 💅' });
            continue;
        }
        await cmdP.execute({ sock, conteudo: conteudoSemMencao, usuarioJid: jid, msg, remetenteJid, ehAdmin });
    }
}
