require('dotenv').config();

const client = require('./config/whatsapp.client');
const carregarComandos = require('./core/comandos');

process.on('uncaughtException', (err) => {
    console.error(`Erro no código: `, err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Promise rejeitada não tratada capturada. Motivo:', reason);
});

const comandos = carregarComandos();
const botInicio = Math.floor(Date.now() / 1000);

client.on('message_create', async (message) => {

    if (message.from?.endsWith('@newsletter')) return;

    if (
        message.timestamp < botInicio || 
        message.from === 'status@broadcast' || 
        message.isStatus || 
        message.type === 'location' || 
        message.type === 'location_live' ||
        message.type === 'live_location'
    ) {
        return;
    }

    const args = message.body.trim().split(/ +/);
    const comando = args.shift().toLowerCase();

    if(comandos.has(comando)) {

        try {

            await comandos.get(comando).execute(message, args);

        } catch (error) {
            // Todo: Adicionar um logger.
            console.error(`Erro ao executar o comando ${comando}`);
        }

    }
});

client.initialize();