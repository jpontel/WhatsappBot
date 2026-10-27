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
 * Lista os `mentionedJid` da mensagem, seja qual for o tipo: texto
 * (`extendedTextMessage`) ou legenda de mídia (`imageMessage`, `videoMessage`,
 * `documentMessage`). Cada tipo guarda o `contextInfo` no seu próprio nó.
 */
function extrairMencoes(msg: WAMessage): string[] {
    const m = msg.message;
    const ctx = m?.extendedTextMessage?.contextInfo
        ?? m?.imageMessage?.contextInfo
        ?? m?.videoMessage?.contextInfo
        ?? m?.documentMessage?.contextInfo;
    return ctx?.mentionedJid ?? [];
}

/**
 * True se alguma menção (`mentionedJid`) da mensagem aponta para o PRÓPRIO bot.
 * Considera o JID principal (`sock.user.id`), o LID (`sock.user.lid`) e o
 * `TELEFONE_CELULAR`; resolve LID→PN das menções quando preciso e tolera o 9º
 * dígito BR. Em DM não há menções, então retorna false naturalmente.
 */
export async function botFoiMencionado(sock: WASocket, msg: WAMessage): Promise<boolean> {
    const mencoes = extrairMencoes(msg);
    if (!mencoes.length) return false;

    const selfs: string[] = [];
    if (ENV.TELEFONE_CELULAR) selfs.push(`${ENV.TELEFONE_CELULAR}@s.whatsapp.net`);
    if (sock.user?.id) selfs.push(jidNormalizedUser(sock.user.id));
    if (sock.user?.lid) selfs.push(jidNormalizedUser(sock.user.lid));

    for (const bruto of mencoes) {
        const m = jidNormalizedUser(bruto);
        if (selfs.some((s) => mesmaPessoaTolerante(s, m))) return true;
        // Menção veio como LID e só temos o PN do bot: resolve e compara.
        if (isLidUser(m)) {
            const pn = await resolverNumero(sock, m);
            if (pn && selfs.some((s) => mesmaPessoaTolerante(s, pn))) return true;
        }
    }
    return false;
}
