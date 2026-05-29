const { MessageMedia } = require('whatsapp-web.js');
const youtubeService = require('../services/youtube.service');
const fs = require('fs');

module.exports = {
    name: '/musica',
    description: 'Baixa musicas com base no nome(s) recebido(s).',

    execute: async (message, args) => {
        const chat = await message.getChat();

        if(!args || args.length === 0) {
            await message.react('❌');
            return chat.sendMessage("Preciso de pelo menos um link!");
        }

        await message.react('⏳');

        if(args.length > 1) 
            await chat.sendMessage(`Vou baixar as ${args.length} músicas uma por uma. Só um pouco...`);

        let sucessos = 0;

        for(const[index, url] of args.entries()) {
            let audio = null;

            try {

                const metadados = await youtubeService.recuperarMetaDadosVideo(url);

                audio = await youtubeService.baixarVideoEmMp3(url);
                const media = MessageMedia.fromFilePath(audio);

                await chat.sendMessage(`Música: ${metadados.titulo}`);

                await chat.sendMessage(media, { 
                    sendAudioAsVoice: false 
                });

                sucessos++;
                
            } catch (error) {
                console.error(`Erro ao baixar a música ${index + 1}:`, error);
                await chat.sendMessage(`❌ Deu erro ao baixar o link [${index + 1}]: ${url}`);
            } finally {

                if(audio && fs.existsSync(audio)) {
                    try {
                        fs.unlinkSync(audio);
                    } catch (e) {
                        console.error('Falha ao apagar o arquivo temporário:', e);
                    }
                }

            }
        }
        
        if(sucessos > 0) {
            
            await message.react('✅');
            await chat.sendMessage("Download finalizado XD");

        } else {
            await message.react('❌');
        }
          
    }
}