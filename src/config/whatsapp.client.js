const { Client, LocalAuth } = require('whatsapp-web.js');

const diretorioChrome = process.env.IS_DESENV 
    ? process.env.CHROME_FOLDER_MACOS 
    : process.env.CHROME_FOLDER_LINUX;

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

const qrcode = require('qrcode-terminal');
client.on('qr', (qr) => {
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('Autenticação Concluída! Bot Online.');
});

module.exports = client;