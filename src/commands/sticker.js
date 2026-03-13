module.exports = {
    name: '/sticker',
    description: 'Cria stickers para o whatsapp a partir de uma imagem.',

    execute: async(message, args) => {
        await message.react('⏳');
        const chat = await message.getChat();

        let media = null;

        if(message.hasMedia) {

            media = await message.downloadMedia();

        } else if(message.hasQuotedMsg) {
            const mensagem = await message.getQuotedMessage();
            if(mensagem.hasMedia)
                media = await mensagem.downloadMedia();
        }

        if(!media) {
            await chat.sendMessage("Precisa mandar uma foto ><");
            await message.react('❌');
            return;
        }


        await chat.sendMessage(media, { 
            sendMediaAsSticker: true,
            stickerName: 'Guido',
            stickerAuthor: 'BotGuido'
        });
        
        await message.react('✅');
    }
}