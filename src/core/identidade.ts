import { jidNormalizedUser, isLidUser, isPnUser, isJidGroup } from '@whiskeysockets/baileys';
import type { WASocket, WAMessage } from '@whiskeysockets/baileys';

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
