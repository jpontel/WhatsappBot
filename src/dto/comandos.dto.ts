import type { WASocket, WAMessage } from '@whiskeysockets/baileys';

export interface ComandoExecutarDto {
    sock: WASocket;
    usuarioJid: string;
    conteudo: string;
    msg: WAMessage;
    /** JID bruto de quem enviou (participant em grupo, remoteJid em DM). */
    remetenteJid?: string | undefined;
    /** true quando a mensagem partiu da própria conta do dono (fromMe). */
    ehDono?: boolean | undefined;
}