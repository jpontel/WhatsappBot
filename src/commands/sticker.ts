import type { ComandoExecutarDto } from "../dto/comandos.dto.js";
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { Sticker, StickerTypes } from 'wa-sticker-formatter';
import pino from 'pino';

export default {
    name: '/sticker',
    description: 'Cria stickers para o whatsapp a partir de uma imagem.',

    execute: async(comandoExecutarDto: ComandoExecutarDto) => {
        const { sock, msg, usuarioJid } = comandoExecutarDto;

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
                type: StickerTypes.CROPPED,
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