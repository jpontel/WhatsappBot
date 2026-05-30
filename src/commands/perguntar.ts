import { downloadMediaMessage } from '@whiskeysockets/baileys';
import type { ComandoExecutarDto } from "../dto/comandos.dto.js";
import { ENV } from '../config/env.js';
import { resolverNumeroRemetente } from '../core/identidade.js';
import { buscarPorNumero } from '../repository/pessoa.repository.js';
import axios from 'axios';
import pino from 'pino';

const AGENT_TIMEOUT_MS = 90_000;

export default {
    name: '/p',
    description: 'Ponte para o agente ADK',

    execute: async (comandoExecutarDto: ComandoExecutarDto) => {
        const { sock, msg, usuarioJid, conteudo, ehDono } = comandoExecutarDto;

        if (!conteudo) {
            await sock.sendMessage(usuarioJid, { react: { text: '❌', key: msg.key } });
            return await sock.sendMessage(usuarioJid, { text: "Precisa mandar uma pergunta!!! 🤨" });
        }

        const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        const mensagemMidia = quoted ? quoted : msg.message;
        const temMidia = mensagemMidia?.imageMessage || mensagemMidia?.videoMessage;

        try {
            await sock.sendMessage(usuarioJid, { react: { text: '⏳', key: msg.key } });

            let midia: { base64: string; mimetype: string } | null = null;

            if (temMidia) {
                const buffer = await downloadMediaMessage(
                    { message: mensagemMidia, key: msg.key },
                    'buffer',
                    {},
                    {
                        reuploadRequest: sock.updateMediaMessage,
                        logger: pino({ level: 'error' })
                    }
                );

                const mimetype = mensagemMidia?.imageMessage?.mimetype
                    || mensagemMidia?.videoMessage?.mimetype
                    || 'image/jpeg';

                midia = {
                    base64: (buffer as Buffer).toString('base64'),
                    mimetype
                };
            }

            // Resolve quem enviou e consulta o registro para o agente saber com quem fala.
            const numero = await resolverNumeroRemetente(sock, msg);
            const pessoa = numero ? buscarPorNumero(numero) : null;

            const remetente = ehDono
                ? { numero, nome: 'dono', registrado: true, ehDono: true }
                : pessoa
                    ? { numero, nome: pessoa.nome, registrado: true, ehDono: false }
                    : { numero, nome: null, registrado: false, ehDono: false };

            const resposta = await axios.post(
                `${ENV.AGENT_URL}/chat`,
                {
                    chatId: usuarioJid,
                    mensagem: conteudo,
                    msgKey: msg.key,
                    midia,
                    remetente
                },
                { timeout: AGENT_TIMEOUT_MS }
            );

            const texto: string | null = resposta.data?.texto ?? null;

            if (texto) {
                await sock.sendMessage(usuarioJid, { text: texto });
            }

            await sock.sendMessage(usuarioJid, { react: { text: '💅', key: msg.key } });

        } catch (error: unknown) {
            console.error("Erro no /p (ponte agente):", error);
            await sock.sendMessage(usuarioJid, { react: { text: '❌', key: msg.key } });

            const offline = axios.isAxiosError(error) && (error.code === 'ECONNREFUSED' || error.code === 'ECONNABORTED');
            const texto = offline
                ? "❌ Agente fora do ar, tenta de novo daqui a pouco 🥲"
                : "❌ Ixe, deu ruim na IA :p";

            await sock.sendMessage(usuarioJid, { text: texto });
        }
    }
};
