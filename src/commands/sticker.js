module.exports = {
    name: '/sticker',
    description: 'Cria stickers para o whatsapp a partir de uma imagem.',

    execute: async(message, args) => {
        await message.react('⏳');
        const media = await message.downloadMedia();

        const chat = await message.getChat();

        await chat.sendMessage(media, { 
            sendMediaAsSticker: true,
            stickerName: 'Guido',
            stickerAuthor: 'BotGuido'
        });
        
        await message.react('✅');
    }
}