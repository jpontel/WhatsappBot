import { isJidGroup } from '@whiskeysockets/baileys';
import type { WASocket, WAMessage, MessageUpsertType } from '@whiskeysockets/baileys';
import type { ComandoExecutarDto } from '../dto/comandos.dto.js';
import carregarComandos from './comandos.js';

const JID_IGNORADO = '5547992706378';

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
        if (
            msg.key.remoteJid === JID_IGNORADO
            || msg.key.remoteJid?.endsWith('@newsletter')
        ) {
            return;
        }

        const jid = msg.key.remoteJid!;

        const text = msg.message?.conversation
            || msg.message?.extendedTextMessage?.text
            || msg.message?.imageMessage?.caption
            || msg.message?.videoMessage?.caption;

        if (!text) continue;

        console.log(`📩 Mensagem de ${jid}: ${text}`);

        const comando = text.split(' ')[0]?.toLowerCase();
        const instrucao = text.slice(comando?.length).trim();

        if (!comando || !comandos.has(comando)) continue;

        const ehDono = !!msg.key.fromMe;
        const remetenteJid = isJidGroup(jid) ? (msg.key.participant ?? undefined) : jid;

        const dto: ComandoExecutarDto = {
            sock,
            conteudo: instrucao,
            usuarioJid: jid,
            msg,
            remetenteJid,
            ehDono,
        };

        await comandos.get(comando)!.execute(dto);
    }
}
