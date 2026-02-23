async function criarSticker(message) {
    const media = await message.downloadMedia();

    const chat = await message.getChat();

    await chat.sendMessage(media, { 
        sendMediaAsSticker: true,
        stickerName: 'Guido',
        stickerAuthor: 'BotGuido'
    });

}

module.exports = criarSticker;