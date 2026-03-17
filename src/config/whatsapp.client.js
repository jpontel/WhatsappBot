const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const diretorioChrome = process.env.IS_DESENV 
    ? process.env.CHROME_FOLDER_MACOS 
    : process.env.CHROME_FOLDER_LINUX;

const telefone = process.env.TELEFONE_CELULAR;

const client = new Client({
    authStrategy: new LocalAuth(),
    ...(telefone ? {
        pairWithPhoneNumber: {
            phoneNumber: telefone
        }
    } : {}),
    webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
    },
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

client.on('code', (pairingCode) => {
    console.log('\n=============================================');
    console.log('📱 CÓDIGO DE CONEXÃO DO WHATSAPP:');
    console.log(`👉  ${pairingCode}  👈`);
    console.log('=============================================');
    console.log('Vá no seu WhatsApp > Aparelhos Conectados > Conectar com Número');
    console.log('E digite o código acima!\n');
});

client.on('qr', (qr) => {
    if(!telefone)
        qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('Autenticação Concluída! Bot Online.');
});

module.exports = client;