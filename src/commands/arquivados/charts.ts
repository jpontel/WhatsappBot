const lastfmService = require("../services/lastfm.service");

module.exports = {
    name: '/charts',
    description: 'Recupera as 10 ouvidas da semana em forma de lista com a quantidade de vezes ouvida',

    execute: async (message, args) => {
        const usuario = args[0];

        if(!usuario) {
            await message.react('❌');
            return message.getChat().then(chat => chat.sendMessage("Não entendi qual a mona do charts!!!"));
        }

        const chat = await message.getChat();

        try {
            await message.react('⏳');

            const chartsRecuperados = await lastfmService.listarMaisOuvidasSemana(usuario);

            let charts = `Charts: ${usuario}\n\n`;
            for(const chart of chartsRecuperados) {
                charts += `Posição: ${chart.posicao} - ${chart.musica}\nArtista: ${chart.artista}\nContagem: ${chart.contagem}\n\n`;
            }

            chat.sendMessage(charts);

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