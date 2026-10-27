import { downloadMediaMessage } from '@whiskeysockets/baileys';
import type { WASocket, WAMessageKey, WAMessage } from '@whiskeysockets/baileys';
import type { ComandoExecutarDto } from "../dto/comandos.dto.js";
import { ENV } from '../config/env.js';
import { resolverNumeroRemetente } from '../core/identidade.js';
import { iniciarDigitando, pararDigitando } from '../core/presenca.js';
import { buscarPorNumero } from '../repository/pessoa.repository.js';
import { snapshot } from '../core/contexto.js';
import axios from 'axios';
import pino from 'pino';

const AGENT_TIMEOUT_MS = 180_000;
// Janela de debounce: agrupa /p em rajada (do mesmo remetente) num lote só.
const DEBOUNCE_MS = 3_000;

type Midia = { base64: string; mimetype: string };
type Remetente = { numero: string | null; nome: string | null; registrado: boolean; ehAdmin: boolean };
type Citacao = { texto: string; autor: string | null };
type ItemLote = { conteudo: string; msgKey: WAMessageKey; midia: Midia | null; citacao: Citacao | null };

// Extrai o texto de uma IMessage (mesma cadeia do dispatcher), serve para a msg citada.
function extrairTextoMensagem(m: WAMessage['message']): string | null {
    return m?.conversation
        || m?.extendedTextMessage?.text
        || m?.imageMessage?.caption
        || m?.videoMessage?.caption
        || null;
}
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
        // Citação (mensagem respondida): para 1 item vai como campo estruturado;
        // no lote, embute inline em cada item (cada /p pode responder a algo diferente).
        const prefixoCitacao = (c: Citacao | null) =>
            c ? `[em resposta a ${c.autor ?? 'alguém'}: "${c.texto}"] ` : '';

        const mensagem = itens.length === 1
            ? itens[0]!.conteudo
            : `[lote de ${itens.length} pedidos do mesmo usuário, em ordem de chegada]\n`
                + itens.map((it, i) => `${i + 1}. ${prefixoCitacao(it.citacao)}${it.conteudo}`).join('\n');

        const midia = itens.find(i => i.midia)?.midia ?? null;
        const msgKey = itens[itens.length - 1]!.msgKey;
        const citacao = itens.length === 1 ? itens[0]!.citacao : null;

        // Contexto recente do chat: as últimas N mensagens que chegaram ANTES do
        // gatilho. Excluímos os ids do próprio lote (já registrados no buffer pelo
        // dispatcher) para não duplicar a mensagem-gatilho — ela já vai em `mensagem`.
        const idsLote = new Set(
            itens.map(i => i.msgKey.id).filter((id): id is string => !!id),
        );
        const contexto = snapshot(usuarioJid, idsLote, ENV.CONTEXTO_MAX_MSGS);

        const resposta = await axios.post(
            `${ENV.AGENT_URL}/chat`,
            { chatId: usuarioJid, mensagem, msgKey, midia, remetente, citacao, contexto },
            { timeout: AGENT_TIMEOUT_MS },
        );

        const texto: string | null = resposta.data?.texto ?? null;
        // Só envia se houver conteúdo de verdade: ao mandar só áudio, o agente
        // devolve texto vazio/em branco de propósito (o áudio é a mensagem).
        // Remove invisíveis (zero-width/BOM) p/ não escapar uma bolha "em branco".
        const visivel = (texto ?? '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
        if (texto && visivel) {
            await sock.sendMessage(usuarioJid, { text: texto });
        }
        // A reação de conclusão (💅) é emitida pelo AGENTE, e só em turnos de
        // AÇÃO (ver agente/src/api/chat.py). Conversa normal não ganha reação.
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
    } finally {
        // Equilibra os incrementos feitos no execute (1 por /p): só para de
        // "digitar" quando toda a fila do chat foi processada.
        for (let i = 0; i < itens.length; i++) {
            pararDigitando(sock, usuarioJid);
        }
    }
}

export default {
    name: '/p',
    description: 'Ponte para o agente ADK',

    execute: async (dto: ComandoExecutarDto) => {
        const { sock, msg, usuarioJid, conteudo, ehAdmin, remetenteJid } = dto;

        // Mídia do turno (anexada OU citada): foto, figurinha, vídeo ou áudio.
        // Detectada ANTES de rejeitar, para aceitar mídia-sozinha (ex.: só uma
        // figurinha, sem texto) — o agente a "vê" e comenta.
        const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
        const quoted = contextInfo?.quotedMessage;
        const mensagemMidia = quoted ? quoted : msg.message;
        const temMidia = mensagemMidia?.imageMessage || mensagemMidia?.stickerMessage
            || mensagemMidia?.videoMessage || mensagemMidia?.audioMessage;

        // Só rejeita quando NÃO há texto E NÃO há mídia (aí não há o que processar).
        if (!conteudo && !temMidia) {
            await sock.sendMessage(usuarioJid, { react: { text: '❌', key: msg.key } });
            return await sock.sendMessage(usuarioJid, { text: "Precisa mandar uma pergunta!!! 🤨" });
        }

        // Mostra os três pontinhos de "digitando…" enquanto a IA processa o lote.
        // A reação ⏳ NÃO sai mais daqui: quem reage (⏳/💅) é o AGENTE, e só em
        // turnos de AÇÃO — assim conversa normal não ganha reação nenhuma.
        iniciarDigitando(sock, usuarioJid);

        // Baixa a mídia (se houver) já no recebimento; falha de download não derruba o /p.
        let midia: Midia | null = null;
        if (temMidia) {
            try {
                const buffer = await downloadMediaMessage(
                    { message: mensagemMidia, key: msg.key },
                    'buffer',
                    {},
                    { reuploadRequest: sock.updateMediaMessage, logger: pino({ level: 'error' }) },
                );
                const mimetype = mensagemMidia?.imageMessage?.mimetype
                    || mensagemMidia?.stickerMessage?.mimetype
                    || mensagemMidia?.videoMessage?.mimetype
                    || mensagemMidia?.audioMessage?.mimetype
                    || 'image/jpeg';
                midia = { base64: (buffer as Buffer).toString('base64'), mimetype };
            } catch (e) {
                console.error("Erro ao baixar mídia no /p:", e);
            }
        }

        // Texto da mensagem citada (reply): contexto que o usuário está respondendo.
        let citacao: Citacao | null = null;
        const textoCitado = quoted ? extrairTextoMensagem(quoted) : null;
        if (textoCitado) {
            const autor = contextInfo?.participant?.split('@')[0] ?? null;
            citacao = { texto: textoCitado, autor };
        }

        // Resolve quem enviou e consulta o registro (identidade do remetente).
        const numero = await resolverNumeroRemetente(sock, msg);
        const pessoa = numero ? buscarPorNumero(numero) : null;
        const ehAdminBool = !!ehAdmin;
        const nome = pessoa?.nome ?? (ehAdminBool ? (ENV.ADMIN_NOME ?? 'guigo') : null);
        const remetente: Remetente = { numero, nome, registrado: ehAdminBool || !!pessoa, ehAdmin: ehAdminBool };

        // Lote por remetente, dentro do chat.
        const chave = `${usuarioJid}|${numero ?? remetenteJid ?? 'anon'}`;
        const existente = buffers.get(chave);
        if (existente) clearTimeout(existente.timer);

        const itens = existente ? existente.itens : [];
        itens.push({ conteudo, msgKey: msg.key, midia, citacao });

        const timer = setTimeout(() => { void flush(chave); }, DEBOUNCE_MS);
        buffers.set(chave, { sock, usuarioJid, remetente, itens, timer });
    },
};
