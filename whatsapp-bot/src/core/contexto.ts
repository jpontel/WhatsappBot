import type { WAMessage } from '@whiskeysockets/baileys';
import { ENV } from '../config/env.js';

// Item do buffer de contexto. Guardamos só texto (ou marcador de mídia) — NUNCA
// bytes de mídia. `msgId` serve para deduplicar a(s) mensagem(ns)-gatilho na hora
// de montar o snapshot; `ts` é só metadado (a ordem vem da ordem de chegada).
export type ItemCtx = { msgId: string; autor: string | null; texto: string; ts: number };

// Buffer EM MEMÓRIA das últimas mensagens por chat, para dar contexto ao agente
// quando houver um /p ou @menção. Node é single-thread → Map síncrono, sem lock.
// Sem persistência e sem LRU de chats de propósito: para um bot pessoal o nº de
// chats ativos é desprezível, então o custo de memória é irrelevante (YAGNI/KISS).
const buffers = new Map<string, ItemCtx[]>();

// Margem acima do teto de envio: guardamos um pouco mais do que será enviado para
// sobrar contexto de verdade depois de excluir a(s) mensagem(ns)-gatilho do lote.
const MARGEM = ENV.CONTEXTO_MAX_MSGS + 5;

// Deriva o texto que representa a mensagem no contexto. Texto puro vai como está;
// mídia vira um marcador textual (+ legenda, quando houver). Devolve null quando
// não há nada aproveitável (ex.: tipos de mensagem que não interessam ao contexto).
export function textoParaContexto(message: WAMessage['message']): string | null {
    if (!message) return null;

    const textoPuro = message.conversation || message.extendedTextMessage?.text;
    if (textoPuro) return textoPuro;

    // Marcador + legenda (quando o tipo de mídia carrega caption).
    const comLegenda = (marcador: string, legenda?: string | null) =>
        legenda ? `${marcador} ${legenda}` : marcador;

    if (message.imageMessage) return comLegenda('[imagem]', message.imageMessage.caption);
    if (message.audioMessage) return '[áudio]';
    if (message.videoMessage) return comLegenda('[vídeo]', message.videoMessage.caption);
    if (message.stickerMessage) return '[figurinha]';
    if (message.documentMessage) return comLegenda('[documento]', message.documentMessage.caption);

    return null;
}

// Registra uma mensagem no buffer do chat e corta para as últimas MARGEM (descarta
// as mais antigas). Chamado para TODA mensagem — gatilho ou não.
export function registrar(chatId: string, item: ItemCtx): void {
    const lista = buffers.get(chatId) ?? [];
    lista.push(item);
    if (lista.length > MARGEM) lista.splice(0, lista.length - MARGEM);
    buffers.set(chatId, lista);
}

// Devolve as últimas `max` mensagens do chat em ordem cronológica, EXCLUINDO as de
// `idsExcluir` (os ids do lote-gatilho, que já vão como `mensagem` no payload — não
// podem se duplicar no contexto). Mapeado para o formato enxuto que o agente espera.
export function snapshot(
    chatId: string,
    idsExcluir: Set<string>,
    max: number,
): { autor: string | null; texto: string }[] {
    const lista = buffers.get(chatId) ?? [];
    return lista
        .filter(i => !idsExcluir.has(i.msgId))
        .slice(-max)
        .map(({ autor, texto }) => ({ autor, texto }));
}
