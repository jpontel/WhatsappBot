const hevyService = require('../services/heavy.service');

module.exports = {
    name: '/historico-academia',
    description: 'Exibe o histórico mais recentes de exercícios realizados no Hevy',

    execute: async (message, args) => {
        const chat = await message.getChat();

        try {

            await message.react('⏳');
            
            const resposta = await hevyService.recuperarHistoricoExercicios();

            chat.sendMessage(resposta);

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