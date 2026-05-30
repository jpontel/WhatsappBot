import './config/env.js';

import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    Browsers,
    fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';

import { Boom } from '@hapi/boom';
import NodeCache from 'node-cache';
import pino from 'pino';

import { enviarMensagem } from './core/dispatcher.js';
import { whatsappService } from './services/whatsapp.service.js';
import { startMcpServer } from './mcp/mcp.server.js';

const cache = new NodeCache({ stdTTL: 5 * 60, useClones: false });

async function main() {
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`Versão do whatsapp: v${version.join('.')}, ehMaisRecente: ${isLatest}`);

    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        version,
        auth: state,
        mobile: false,
        logger: pino({ level: 'error' }),
        printQRInTerminal: false, 
        browser: Browsers.macOS('Chrome'), 
        markOnlineOnConnect: true,
        cachedGroupMetadata: async (jid) => cache.get(jid)
    });

    let codigoEnviado = false;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        const telefone = process.env.TELEFONE_CELULAR ?? "";

        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
            
            const delay = statusCode === 405 ? 15000 : 5000;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            if(statusCode === DisconnectReason.restartRequired) {
                
                console.log('Tudo certo✅ Reiniciando conexão...');
                
            } else {
                console.log(`⚠️ Conexão fechada (${statusCode}). Tentando em ${delay/1000}s...`);
            }
            
            if(shouldReconnect) 
                setTimeout(() => main(), delay); 

        } else if (connection === 'connecting') {

            console.log('⏳ Estabelecendo túnel de conexão...');

        } else if (connection === 'open') {
            console.log('✅ Bot conectado e pronto!');

            whatsappService.inicializarInstancia(sock);
            codigoEnviado = false;
        }

        if(qr && !sock.authState.creds.me && !codigoEnviado) {
            codigoEnviado = true; 
            
            console.log('🚀 Servidor pronto! Solicitando código de pareamento...');
            
            setTimeout(async () => {
                try {
                    const code = await sock.requestPairingCode(telefone);
                    console.log('\n=============================================');
                    console.log('📱 SEU CÓDIGO DE CONEXÃO:');
                    console.log(`👉  ${code}  👈`);
                    console.log('=============================================');
                } catch (err) {
                    console.error("❌ Falha ao gerar código:", err);
                    codigoEnviado = false; 
                }
            }, 10000);
        }
    });

    sock.ev.on('messages.upsert', async(messageDto) => {
        try {
            await enviarMensagem(sock, messageDto);
        } catch (error) {
            console.error("Erro no dispatcher:", error);
        }
    });
}

// MCP Server sobe uma única vez no boot — main() é chamado recursivamente em reconexões,
// então iniciar o express lá dentro causaria EADDRINUSE.
startMcpServer();

main();