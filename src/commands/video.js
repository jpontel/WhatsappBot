const googleCloudService = require("../services/google-cloud.service");
const { MessageMedia } = require('whatsapp-web.js');

module.exports = {
    name: '/video',
    description: 'Gera videos com base na descrição',

    execute: async (message, args) => {
        const conteudo = args;
        const chat = await message.getChat();

        if(!conteudo) {
            await message.react('❌');
            return chat.sendMessage("Precisa mandar uma descrição!!!");
        }

        console.log(`Pedido de video: ${conteudo}`);

        try {

            await message.react('⏳');

            const gerarMidiaDto = {
                content: conteudo,
                type: 'video'
            };
            
            const video = await googleCloudService.gerarMidia(gerarMidiaDto);

            const media = new MessageMedia('video/mp4', video, 'video.mp4');

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