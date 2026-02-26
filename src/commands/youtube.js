const { MessageMedia } = require('whatsapp-web.js');
const youtubeService = require('../services/youtube.service');
const fs = require('fs');

module.exports = {
    name: '/youtube',
    description: 'Baixar videos do youtube',

    execute: async (message, args) => {
        const url = args[0]; 

        if (!url) {
            await message.react('❌');
            return message.getChat().then(chat => chat.sendMessage("Preciso de uma url!!!! 🫠"));
        }

        let videoPath = null;
        try {
            await message.react('⏳');
            videoPath = await youtubeService.baixarVideo(url);
            
            const media = MessageMedia.fromFilePath(videoPath);
            const chat = await message.getChat();
            
            await chat.sendMessage(media);
            await message.react('✅');

        } catch (error) {
            console.error('Erro no comando /youtube:', error);
            try { await message.react('❌'); } catch (e) {}
            await message.getChat().then(chat => chat.sendMessage("Deu erro ao baixar o vídeo. ❌"));
        } finally {
            if (videoPath && fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
        }
    }
}