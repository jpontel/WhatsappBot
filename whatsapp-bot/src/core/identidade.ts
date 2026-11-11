import { jidNormalizedUser, isLidUser, isPnUser, isJidGroup, areJidsSameUser } from '@whiskeysockets/baileys';
import type { WASocket, WAMessage } from '@whiskeysockets/baileys';
import { ENV } from '../config/env.js';

/**
 * Resolve qualquer JID (LID de grupo ou número/PN) para o número canônico
 * normalizado (<num>@s.whatsapp.net). Retorna null se for um LID cujo
 * mapeamento LID→número ainda não é conhecido pelo Baileys.
 */
export async function resolverNumero(sock: WASocket, jid?: string | null): Promise<string | null> {
    if (!jid) return null;

    if (isLidUser(jid)) {
        const pn = await sock.signalRepository?.lidMapping?.getPNForLID(jid);
        return pn ? jidNormalizedUser(pn) : null;
    }

    return jidNormalizedUser(jid);
}

/**
 * Resolve qualquer JID para a forma LID (<id>@lid), usada para MENCIONAR alguém
 * em grupos endereçados por LID. Espelho reverso de `resolverNumero`:
 * - se já for LID, normaliza e devolve;
 * - se for número/PN, consulta o mapa reverso PN→LID do Baileys;
 * - retorna null se o mapeamento ainda não é conhecido (pessoa nunca vista).
 */
export async function resolverLid(sock: WASocket, jid?: string | null): Promise<string | null> {
    if (!jid) return null;

    if (isLidUser(jid)) {
        return jidNormalizedUser(jid);
    }

    if (isPnUser(jid)) {
        const lid = await sock.signalRepository?.lidMapping?.getLIDForPN(jid);
        return lid ? jidNormalizedUser(lid) : null;
    }

    return null;
}

/**
 * Descobre o número canônico de quem realmente enviou a mensagem:
 * - em grupo, o remetente é `participant` (e `participantAlt` traz o número
 *   alternativo quando o endereçamento veio como LID);
 * - em DM, é o próprio `remoteJid`.
 */
export async function resolverNumeroRemetente(sock: WASocket, msg: WAMessage): Promise<string | null> {
    const { remoteJid, participant, participantAlt } = msg.key;

    if (isJidGroup(remoteJid ?? undefined)) {
        // Prioriza o alternativo quando já vier como número (evita ida ao mapa LID→PN).
        if (participantAlt && isPnUser(participantAlt)) {
            return jidNormalizedUser(participantAlt);
        }
        return resolverNumero(sock, participant);
    }

    return resolverNumero(sock, remoteJid);
}

/** JID do admin normalizado a partir de ENV.ADMIN_JID (número puro ou JID completo). */
export function adminJid(): string | undefined {
    const bruto = ENV.ADMIN_JID?.trim();
    if (!bruto) return undefined;
    return bruto.includes('@') ? bruto : `${bruto}@s.whatsapp.net`;
}

/** Só os dígitos de um JID/número (descarta @server, sufixo de device, símbolos). */
function soDigitos(jid: string): string {
    return (jid.split(/[@:]/)[0] || '').replace(/\D/g, '');
}

/**
 * Celular BR (55 + DDD): o WhatsApp às vezes reporta SEM o 9º dígito. Reduz a
 * forma de 13 dígitos (55 DD 9 XXXXXXXX) para a de 12 (55 DD XXXXXXXX), para que
 * as duas representem o mesmo número. Não-BR / não-celular passam intactos.
 */
export function normalizarNonoDigito(num: string): string {
    const m = num.match(/^55(\d{2})9(\d{8})$/);
    return m ? `55${m[1]}${m[2]}` : num;
}

/**
 * Compara dois JIDs/números tolerando sufixo de device/servidor (via
 * `areJidsSameUser`) e a variação do 9º dígito brasileiro (LID→PN às vezes vem
 * sem o 9). Retorna false se algum for vazio.
 */
export function mesmaPessoaTolerante(a?: string | null, b?: string | null): boolean {
    if (!a || !b) return false;
    if (areJidsSameUser(a, b)) return true;
    return normalizarNonoDigito(soDigitos(a)) === normalizarNonoDigito(soDigitos(b));
}

/** True se o número/JID resolvido do remetente é o admin configurado (ADMIN_JID). */
export function ehAdminPorJid(numeroRemetente?: string | null): boolean {
    return mesmaPessoaTolerante(numeroRemetente, adminJid());
}

/**
 * `contextInfo` da mensagem, seja qual for o tipo que a carrega: texto
 * (`extendedTextMessage`), legenda de mídia (`imageMessage`, `videoMessage`,
 * `documentMessage`) ou mídia-sozinha (`stickerMessage`, `audioMessage`). Cada
 * tipo guarda o `contextInfo` no seu próprio nó. É daqui que saem tanto as
 * menções (`mentionedJid`) quanto os dados de reply (`participant`/`quotedMessage`).
 */
function extrairContextInfo(msg: WAMessage) {
    const m = msg.message;
    return m?.extendedTextMessage?.contextInfo
        ?? m?.imageMessage?.contextInfo
        ?? m?.videoMessage?.contextInfo
        ?? m?.documentMessage?.contextInfo
        ?? m?.stickerMessage?.contextInfo
        ?? m?.audioMessage?.contextInfo;
}

/** Lista os `mentionedJid` da mensagem (vazio se não houver). */
function extrairMencoes(msg: WAMessage): string[] {
    return extrairContextInfo(msg)?.mentionedJid ?? [];
}

/**
 * Conjunto de JIDs que representam o PRÓPRIO bot: o JID principal (`sock.user.id`),
 * o LID (`sock.user.lid`) e o `TELEFONE_CELULAR`.
 */
function montarSelfs(sock: WASocket): string[] {
    const selfs: string[] = [];
    if (ENV.TELEFONE_CELULAR) selfs.push(`${ENV.TELEFONE_CELULAR}@s.whatsapp.net`);
    if (sock.user?.id) selfs.push(jidNormalizedUser(sock.user.id));
    if (sock.user?.lid) selfs.push(jidNormalizedUser(sock.user.lid));
    return selfs;
}

/**
 * True se o `jid` aponta para o PRÓPRIO bot. Tolera sufixo de device e o 9º
 * dígito BR; se o jid vier como LID e só tivermos o PN do bot, resolve LID→PN e
 * recompara. Base compartilhada por `botFoiMencionado` e `respondeuAoBot`.
 */
export async function ehJidDoBot(sock: WASocket, jid?: string | null): Promise<boolean> {
    if (!jid) return false;
    const selfs = montarSelfs(sock);
    const m = jidNormalizedUser(jid);
    if (selfs.some((s) => mesmaPessoaTolerante(s, m))) return true;
    // Veio como LID e só temos o PN do bot: resolve e compara.
    if (isLidUser(m)) {
        const pn = await resolverNumero(sock, m);
        if (pn && selfs.some((s) => mesmaPessoaTolerante(s, pn))) return true;
    }
    return false;
}

/**
 * True se alguma menção (`mentionedJid`) da mensagem aponta para o PRÓPRIO bot.
 * Em DM não há menções, então retorna false naturalmente.
 */
export async function botFoiMencionado(sock: WASocket, msg: WAMessage): Promise<boolean> {
    const mencoes = extrairMencoes(msg);
    if (!mencoes.length) return false;
    for (const bruto of mencoes) {
        if (await ehJidDoBot(sock, bruto)) return true;
    }
    return false;
}

/**
 * JID do AUTOR da mensagem citada (reply/quote). O Baileys guarda em
 * `contextInfo.participant` quem escreveu a mensagem respondida; só é um reply de
 * verdade quando há `quotedMessage`. Retorna null se a mensagem não é um reply.
 */
export function extrairParticipanteCitado(msg: WAMessage): string | null {
    const ctx = extrairContextInfo(msg);
    if (!ctx?.quotedMessage) return null;
    return ctx.participant ?? null;
}

/**
 * True se a mensagem é um reply a uma mensagem enviada pelo PRÓPRIO bot — ou seja,
 * o autor citado é o bot. Independe de a mensagem ter texto (reply de figurinha/
 * foto também conta). É o gatilho de "responder ao bot sem precisar @mencionar".
 */
export async function respondeuAoBot(sock: WASocket, msg: WAMessage): Promise<boolean> {
    return ehJidDoBot(sock, extrairParticipanteCitado(msg));
}
