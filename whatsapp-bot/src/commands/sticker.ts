import type { ComandoExecutarDto } from "../dto/comandos.dto.js";
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { Sticker, StickerTypes } from 'wa-sticker-formatter';
import pino from 'pino';

// Tipos de corte aceitos pelo /sticker — espelham os nomes da interface do
// wa-sticker-formatter (StickerTypes). Chave = nome digitado pelo usuário.
const TIPOS_CORTE: Record<string, StickerTypes> = {
    default: StickerTypes.DEFAULT,
    cropped: StickerTypes.CROPPED,
    full: StickerTypes.FULL,
    circle: StickerTypes.CIRCLE,
    rounded: StickerTypes.ROUNDED
};

export default {
    name: '/sticker',
    description: 'Cria stickers para o whatsapp a partir de uma imagem. Corte opcional: /sticker <default|cropped|full|circle|rounded> (default: default).',

    execute: async(comandoExecutarDto: ComandoExecutarDto) => {
        const { sock, msg, usuarioJid, conteudo } = comandoExecutarDto;

        // Primeiro token após o comando define o tipo de corte (opcional).
        const tipoInformado = conteudo?.trim().split(/\s+/)[0]?.toLowerCase();
        const tipoCorte = (tipoInformado && TIPOS_CORTE[tipoInformado]) || StickerTypes.DEFAULT;

        const mensagemRespondida = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        const mensagemMidia = mensagemRespondida ? mensagemRespondida : msg.message;

        if (
            !mensagemMidia?.imageMessage 
            && !mensagemMidia?.videoMessage
        ) {

            return await sock.sendMessage(usuarioJid, { 
                text: "Precisa de uma imagem ><",
                react: { text: '❌', key: msg.key } 
            });

        }

        try {
            await sock.sendMessage(usuarioJid, {
                react: { text: '⏳', key: msg.key }
            });

            const buffer = await downloadMediaMessage(
                {
                    message: mensagemMidia,
                    key: msg.key
                },
                'buffer',
                {},
                {
                    reuploadRequest: sock.updateMediaMessage,
                    logger: pino({ level: 'error' })
                }
            );

            const sticker = new Sticker(buffer as Buffer, {
                pack: 'bot do guigo',
                author: 'guig0',
                type: tipoCorte,
                quality: 30
            });

            const stickerBuffer = await sticker.toBuffer();

            await sock.sendMessage(usuarioJid, { 
                react: { text: '✅', key: msg.key } 
            });

            await sock.sendMessage(usuarioJid, { sticker: stickerBuffer });
            
        } catch (error: unknown) {
            return await sock.sendMessage(usuarioJid, { 
                text: `Deu ruim :p [Erro]: ${(error as Error).message}`,
                react: { text: '❌', key: msg.key }
            });
        }
    }
}