import './config/env.js';

import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    Browsers,
    fetchLatestBaileysVersion,
    type WASocket
} from '@whiskeysockets/baileys';

import { Boom } from '@hapi/boom';
import NodeCache from 'node-cache';
import pino from 'pino';

import { enviarMensagem } from './core/dispatcher.js';
import { whatsappService } from './services/whatsapp.service.js';
import { startMcpServer } from './mcp/mcp.server.js';
import { schedulerService } from './services/scheduler.service.js';
import { inicializar as inicializarVacuoGrupo } from './core/vacuo-grupo.js';
import { registrarDesligamentoGracioso } from './core/desligamento.js';

const cache = new NodeCache({ stdTTL: 5 * 60, useClones: false });

// Re-armar os timers do anti-vácuo (persistidos) só uma vez, no 1º 'open' — depois
// disso o socket está vivo e o disparo consegue responder. main() é recursivo em
// reconexões, então a flag evita re-armar a cada reconexão.
let vacuoReArmado = false;

// main() é chamado recursivamente nas reconexões, criando um socket novo a cada vez.
// Guardamos a referência viva aqui para que o desligamento gracioso (SIGTERM/SIGINT)
// sempre encerre o socket ATUAL — e não uma referência antiga já descartada.
let socketAtivo: WASocket | null = null;

// Mantém a última função saveCreds pendente para garantir um flush final no shutdown
// (evita ler credenciais "stale" no próximo boot — causa do 401 loggedOut em recreate).
let salvarCredenciais: (() => Promise<void>) | null = null;

async function main() {
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`Versão do whatsapp: v${version.join('.')}, ehMaisRecente: ${isLatest}`);

    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    salvarCredenciais = saveCreds;

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

    socketAtivo = sock;

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

            // Socket vivo: re-arma os timers do anti-vácuo que sobreviveram ao restart.
            if (!vacuoReArmado) {
                vacuoReArmado = true;
                inicializarVacuoGrupo();
            }
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

// Carrega os lembretes agendados e registra as tarefas (node-cron/setTimeout).
// O disparo usa whatsappService.recuperarInstancia() no momento do fire, quando o
// socket já está 'open'.
schedulerService.inicializar();

// Desligamento gracioso: quando o Docker manda SIGTERM (recreate/stop) ou o usuário
// dá Ctrl+C (SIGINT), encerramos o socket de forma limpa e damos um flush final nas
// credenciais. Sem isso, o processo morria no meio de um avanço de chave/ratchet e o
// próximo boot lia credenciais inconsistentes -> WhatsApp respondia 401 loggedOut.
//
// IMPORTANTE: usamos sock.end() (fecha o ws e preserva a sessão), NUNCA sock.logout()
// (logout remove o device no servidor do WhatsApp e apagaria a sessão).
registrarDesligamentoGracioso({
    obterSocket: () => socketAtivo,
    obterSalvarCredenciais: () => salvarCredenciais
});

main();