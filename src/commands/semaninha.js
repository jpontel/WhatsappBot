const lastfmsService = require('../services/lastfm.service');
const canvas = require('../utils/canvas');
const { MessageMedia } = require('whatsapp-web.js');

module.exports = {
    name: '/semaninha',
    description: 'Cria a semaninha do Last.fm',
    
    execute: async (message, args) => {
        const usuario = args[0];

        if(!usuario) {
            await message.react('❌');
            return message.getChat().then(chat => chat.sendMessage("Não entendi qual a mona da semaninha!!!"));
        }

        const chat = await message.getChat();

        try {
            await message.react('⏳');

            const albums = await lastfmsService.recuperarAlbumsMaisOuvidosSemana(usuario);

            const semaninha = await canvas.criarCanvas(albums);

            const media = new MessageMedia('image/png', semaninha.toString('base64'), 'semaninha.png');

            chat.sendMessage(media);
            await message.react('✅');

        } catch (error) {
            await message.react('❌');

            if(error instanceof Error) {
                
                console.error(error.message);

            } else {
                chat.sendMessage("❌❌ deu ruim :p ❌❌");
            }
        }
    }
}