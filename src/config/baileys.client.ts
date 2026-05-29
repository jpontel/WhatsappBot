import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';

export class BaileysClient {
    sock: any;
    authState: any;
    pairRequested: boolean;
    connected: boolean;
    
    constructor() {
        this.sock;
        this.authState;
        this.pairRequested = false;
        this.connected = false;
    }

    async iniciarCliente() {
        const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
        this.authState = state;

        const logger = pino({ level: 'silent' });

        this.sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            logger: logger 
        });

        this.sock.ev.on('creds.update', saveCreds);

        this.sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (
                !state.creds.registered 
                && !this.pairRequested 
                && (connection === 'connecting' || !!qr)
            ) {

                this.pairRequested = true;
                const number = 'REMOVIDO_TEL'; 

                try {
                    const code = await this.sock.requestPairingCode(number);

                    console.log('\n=============================================');
                    console.log('📱 CÓDIGO DE CONEXÃO DO WHATSAPP:');
                    console.log(`👉  ${code}  👈`);
                    console.log('=============================================');
                    
                } catch (err) {
                    this.pairRequested = false;
                    console.error('Erro no pairing code:', err);
                }
            }

             if(connection === 'open') {
                this.connected = true;
                console.log('✅ WhatsApp conectado!');

                // this.sock.ev.on('messages.upsert', handler);
            }

            if(connection === 'close') {
                const statusCode = (lastDisconnect?.error instanceof Boom)
                    ? lastDisconnect.error.output.statusCode
                    : null;

                console.log('Conexão fechada:', lastDisconnect?.error, ', statusCode:', statusCode);

                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

                if (shouldReconnect)
                    await this.reconectar();

            }
        });
    }

    async reconectar() {
        console.log('🔄 Reconectando...');
        await this.iniciarCliente();
    }

    registrarMensagem(handler) {
        if(!this.sock && !this.connected) return;
        console.log(`Desceu algo aqui: ${handler}`);
        // this.sock.ev.on('messages.upsert', handler);
    }

}