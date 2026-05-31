import { downloadMediaMessage } from '@whiskeysockets/baileys';
import type { WASocket, WAMessageKey } from '@whiskeysockets/baileys';
import type { ComandoExecutarDto } from "../dto/comandos.dto.js";
import { ENV } from '../config/env.js';
import { resolverNumeroRemetente } from '../core/identidade.js';
import { buscarPorNumero } from '../repository/pessoa.repository.js';
import axios from 'axios';
import pino from 'pino';

const AGENT_TIMEOUT_MS = 180_000;
// Janela de debounce: agrupa /p em rajada (do mesmo remetente) num lote só.
const DEBOUNCE_MS = 3_000;

type Midia = { base64: string; mimetype: string };
type Remetente = { numero: string | null; nome: string | null; registrado: boolean; ehDono: boolean };
type ItemLote = { conteudo: string; msgKey: WAMessageKey; midia: Midia | null };
type Lote = {
    sock: WASocket;
    usuarioJid: string;
    remetente: Remetente;
    itens: ItemLote[];
    timer: ReturnType<typeof setTimeout>;
};

// Buffer por chave `usuarioJid|remetente`. Persiste entre mensagens porque o
// carregarComandos() reusa o módulo via cache do import() dinâmico.
const buffers = new Map<string, Lote>();

async function flush(chave: string): Promise<void> {
    const lote = buffers.get(chave);
    if (!lote) return;
    buffers.delete(chave);

    const { sock, usuarioJid, remetente, itens } = lote;
    const keys = itens.map(i => i.msgKey);

    try {
        const mensagem = itens.length === 1
            ? itens[0]!.conteudo
            : `[lote de ${itens.length} pedidos do mesmo usuário, em ordem de chegada]\n`
                + itens.map((it, i) => `${i + 1}. ${it.conteudo}`).join('\n');

        const midia = itens.find(i => i.midia)?.midia ?? null;
        const msgKey = itens[itens.length - 1]!.msgKey;

        const resposta = await axios.post(
            `${ENV.AGENT_URL}/chat`,
            { chatId: usuarioJid, mensagem, msgKey, midia, remetente },
            { timeout: AGENT_TIMEOUT_MS },
        );

        const texto: string | null = resposta.data?.texto ?? null;
        if (texto) {
            await sock.sendMessage(usuarioJid, { text: texto });
        }
        for (const key of keys) {
            await sock.sendMessage(usuarioJid, { react: { text: '💅', key } });
        }
    } catch (error: unknown) {
        console.error("Erro no /p (ponte agente):", error);
        const offline = axios.isAxiosError(error) && (error.code === 'ECONNREFUSED' || error.code === 'ECONNABORTED');
        const texto = offline
            ? "❌ Agente fora do ar, tenta de novo daqui a pouco 🥲"
            : "❌ Ixe, deu ruim na IA :p";
        for (const key of keys) {
            await sock.sendMessage(usuarioJid, { react: { text: '❌', key } });
        }
        await sock.sendMessage(usuarioJid, { text: texto });
    }
}

export default {
    name: '/p',
    description: 'Ponte para o agente ADK',

    execute: async (dto: ComandoExecutarDto) => {
        const { sock, msg, usuarioJid, conteudo, ehDono, remetenteJid } = dto;

        if (!conteudo) {
            await sock.sendMessage(usuarioJid, { react: { text: '❌', key: msg.key } });
            return await sock.sendMessage(usuarioJid, { text: "Precisa mandar uma pergunta!!! 🤨" });
        }

        // Acusa o recebimento de cada /p na hora.
        await sock.sendMessage(usuarioJid, { react: { text: '⏳', key: msg.key } });

        // Baixa mídia (se houver) já no recebimento; falha de download não derruba o /p.
        let midia: Midia | null = null;
        const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        const mensagemMidia = quoted ? quoted : msg.message;
        const temMidia = mensagemMidia?.imageMessage || mensagemMidia?.videoMessage;
        if (temMidia) {
            try {
                const buffer = await downloadMediaMessage(
                    { message: mensagemMidia, key: msg.key },
                    'buffer',
                    {},
                    { reuploadRequest: sock.updateMediaMessage, logger: pino({ level: 'error' }) },
                );
                const mimetype = mensagemMidia?.imageMessage?.mimetype
                    || mensagemMidia?.videoMessage?.mimetype
                    || 'image/jpeg';
                midia = { base64: (buffer as Buffer).toString('base64'), mimetype };
            } catch (e) {
                console.error("Erro ao baixar mídia no /p:", e);
            }
        }

        // Resolve quem enviou e consulta o registro (identidade do remetente).
        const numero = await resolverNumeroRemetente(sock, msg);
        const pessoa = numero ? buscarPorNumero(numero) : null;
        const remetente: Remetente = ehDono
            ? { numero, nome: 'guigo', registrado: true, ehDono: true }
            : pessoa
                ? { numero, nome: pessoa.nome, registrado: true, ehDono: false }
                : { numero, nome: null, registrado: false, ehDono: false };

        // Lote por remetente, dentro do chat.
        const chave = `${usuarioJid}|${numero ?? remetenteJid ?? 'anon'}`;
        const existente = buffers.get(chave);
        if (existente) clearTimeout(existente.timer);

        const itens = existente ? existente.itens : [];
        itens.push({ conteudo, msgKey: msg.key, midia });

        const timer = setTimeout(() => { void flush(chave); }, DEBOUNCE_MS);
        buffers.set(chave, { sock, usuarioJid, remetente, itens, timer });
    },
};
