const googleCloudService = require("../services/google-cloud.service");

module.exports = {
    name: '/perguntar',
    description: 'Geração de conteúdo pela API do Gemini',

    execute: async (message, args) => {
        const content = args.join(" ");
        const chat = await message.getChat();

        if(!content) {
            await message.react('❌');
            return chat.sendMessage("Precisa mandar uma pergunta!!!");
        }

        console.log(`Pergunta: ${content}`);

        let media = null;

        if(message.hasMedia) {

            media = await message.downloadMedia();
            
        } else if(message.hasQuotedMsg) {
            const mensagem = await message.getQuotedMessage();
            
            if(mensagem.hasMedia)
                media = await mensagem.downloadMedia();
        }

        try {

            await message.react('⏳');

            const gerarConteudoDto = {
                chatId: message.from,
                content: content || "",
                media: media ? {
                    data: media.data,
                    mimetype: media.mimetype
                } : null
            }

            const resposta = await googleCloudService.gerarConteudo(gerarConteudoDto);

            chat.sendMessage(resposta);

            await message.react('💅');
            
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