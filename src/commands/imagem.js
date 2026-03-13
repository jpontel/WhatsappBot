const googleCloudService = require("../services/google-cloud.service");
const { MessageMedia } = require('whatsapp-web.js');

module.exports = {
    name: '/imagem',
    description: 'Gera imagens com base na descrição',

    execute: async (message, args) => {
        const conteudo = args;
        const chat = await message.getChat();

        if(!conteudo) {
            await message.react('❌');
            return chat.sendMessage("Precisa mandar uma descrição!!!");
        }

        console.log(`Pedido de imagem: ${conteudo}`);

        try {

            await message.react('⏳');

            const gerarMidiaDto = {
                content: conteudo,
                type: 'image'
            };
            
            const imagem = await googleCloudService.gerarMidia(gerarMidiaDto);

            const media = new MessageMedia('image/png', imagem, 'imagem.png');

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