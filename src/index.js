const criarSemaninha = require('./semaninha/criar-semaninha');
const criarSticker = require('./sticker/criar-sticker');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const dotenv = require('dotenv');
const { MessageMedia } = require('whatsapp-web.js');
const { listarDiretorios } = require('./services/craft.service');
dotenv.config();

const diretorioChrome = process.env.IS_DESENV ? process.env.CHROME_FOLDER_MACOS : process.env.CHROME_FOLDER_LINUX;

// Autenticação
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        executablePath: diretorioChrome,
        
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process', 
            '--disable-gpu' 
        ]
    }
});

client.on('qr', (qr) => {
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('Autenticação Concluída! Bot preparado.');
});

const botInicio = Math.floor(Date.now() / 1000);

// Captura dos comandos de mensagem
client.on('message_create', async (message) => {

    if (message.from?.endsWith('@newsletter')) return;

    if((message.timestamp < botInicio && message.from === 'status@broadcast') || message.isStatus) return;

    const chat = await message.getChat();

    // Criação da semaninha
    if(message.body.startsWith("/semaninha")) {
        const usuario = message.body.split(' ')[1]?.trim();

        if(!usuario) {
            const chat = await message.getChat();
            chat.sendMessage("Não entendi qual a mona da semaninha!!!");
            return;
        }

        try {
            await message.react('⏳');
            const semaninha = await criarSemaninha(usuario);

            const media = new MessageMedia('image/png', semaninha.toString('base64'), 'semaninha.png');

            chat.sendMessage(media);
            await message.react('✅');

        } catch (error) {
            await message.react('❌');

            if(error instanceof Error) {
                
                chat.sendMessage(error.message);

            } else {
                chat.sendMessage("❌❌ deu ruim :p ❌❌");
            }
        }

        return;
    }

    if(message.body.startsWith("/registro")) {
        return;
        // const relatorioPeriodo = message.body.split(' ')[1]?.trim();

        // A ideia eh ser um criador de registro diário pelo zap, eu passou uma mensagem com tags que serão procuradas para adicionar 
    }

    // Comandos rápidos
    switch(message.body) {
        case "/sticker":
            if(message.hasMedia) {
                try {

                    await message.react('⏳');
                    await criarSticker(message);
                    await message.react('✅');

                } catch (error) {
                    await message.react('❌');
                    throw error;
                }

            }
            break;
        case "/oie":
            chat.sendMessage("OieeEEEEEEE 🧚‍♂️"); 
            break;
        case "/listar":
            const diretoriosRecuperados = await listarDiretorios();

            let diretorios = '';
            for(const diretorio of diretoriosRecuperados.items) {
                diretorios += `Diretório: ${diretorio.name}\n\n`;
            }

            chat.sendMessage(diretorios);
            break;
        default:
            if(message.body.startsWith('/')) 
                chat.sendMessage("Não encontrei o comando! ><");  

            break;  
    }

});

client.initialize();