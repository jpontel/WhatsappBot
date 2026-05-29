import type { WASocket } from "@whiskeysockets/baileys";

export class WhatsappService {
    private sock: WASocket | null = null;

    inicializarInstancia(sock: WASocket) {
        this.sock = sock;
    }

    recuperarInstancia(): WASocket {
        if (!this.sock) throw new Error("Whatsapp Socket não inicializado!");
        return this.sock;
    }
}

export const whatsappService = new WhatsappService();