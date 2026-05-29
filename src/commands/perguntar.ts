import { downloadMediaMessage, proto } from '@whiskeysockets/baileys';
import type { ComandoExecutarDto } from "../dto/comandos.dto.js";
import { GoogleCloudService } from '../services/google-cloud.service.js';
import pino from 'pino';

export default {
    name: '/p',
    description: 'Geração de conteúdo pela API do Gemini',

    execute: async (comandoExecutarDto: ComandoExecutarDto) => {
        const { sock, msg, usuarioJid, conteudo } = comandoExecutarDto;

        if (!conteudo) {
            await sock.sendMessage(usuarioJid, { react: { text: '❌', key: msg.key } });
            return await sock.sendMessage(usuarioJid, { text: "Precisa mandar uma pergunta!!! 🤨" });
        }

        const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        const mensagemMidia = quoted ? quoted : msg.message;

        const temMidia = mensagemMidia?.imageMessage || mensagemMidia?.videoMessage;

        let mediaBuffer: Buffer | null = null;
        let mimetype: string | null = null;

        try {
            await sock.sendMessage(usuarioJid, { react: { text: '⏳', key: msg.key } });

            if(temMidia) {
                const buffer = await downloadMediaMessage(
                    { message: mensagemMidia, key: msg.key },
                    'buffer',
                    {},
                    {
                        reuploadRequest: sock.updateMediaMessage,
                        logger: pino({ level: 'error' })
                    }
                );
                
                mediaBuffer = buffer as Buffer;
                mimetype = mensagemMidia?.imageMessage?.mimetype || mensagemMidia?.videoMessage?.mimetype || 'image/jpeg';
            }

            const gerarConteudoDto = {
                chatId: usuarioJid,
                content: conteudo,
                media: mediaBuffer ? {
                    data: mediaBuffer.toString('base64'),
                    mimetype: mimetype
                } : null
            };

            const googleCloudService = new GoogleCloudService();

            const resposta = await googleCloudService.gerarConteudo(gerarConteudoDto);

            await sock.sendMessage(usuarioJid, { text: resposta });
            await sock.sendMessage(usuarioJid, { react: { text: '💅', key: msg.key } });

        } catch (error: unknown) {
            console.error("Erro no Gemini:", error);
            await sock.sendMessage(usuarioJid, { react: { text: '❌', key: msg.key } });
            
            const errorMessage = error instanceof Error ? error.message : "Erro desconhecido";
            await sock.sendMessage(usuarioJid, { 
                text: `❌ Ixe, deu ruim na IA :p` 
            });
        }
    }
}