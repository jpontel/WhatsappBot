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

        try {

            await message.react('⏳');

            const gerarConteudoDto = {
                chatId: message.from,
                content: content
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