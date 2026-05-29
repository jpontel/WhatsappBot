import type { WASocket, WAMessage } from '@whiskeysockets/baileys';

export interface ComandoExecutarDto {
    sock: WASocket;
    usuarioJid: string;
    conteudo: string;
    msg: WAMessage;
}