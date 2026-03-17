const fs = require('fs');
const path = require('path');
const youtubedl = require('youtube-dl-exec');

const OUTPUT_DIR = path.resolve(__dirname, '../../temp_videos');

if(!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR); 

class YoutubeService {

    constructor() {}

    async baixarVideo(url) {
        const timestamp = Date.now();
        const outputPath = path.join(OUTPUT_DIR, `video_${timestamp}.mp4`);

        console.log(`Iniciando download do vídeo: ${url}`);

        try {
            await youtubedl(url, {
                format: 'best[ext=mp4][height<=1080]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best', 
                output: outputPath,
                noCheckCertificates: true,
                noWarnings: true,
                preferFreeFormats: true,
                addHeader: ['referer:youtube.com', 'user-agent:googlebot']
            });

            console.log('Download concluído!');
            return outputPath;

        } catch (error) {
            console.error('Erro ao baixar o vídeo do youtube:', error);
            throw new Error('Não consegui baixar esse vídeo. O YouTube bloqueou ou o link é inválido.');
        }
    }

    async baixarVideoEmMp3(url) {
        const timestamp = Date.now();
        const outputPath = path.join(OUTPUT_DIR, `audio_${timestamp}.mp3`);

        console.log(`Iniciando download do vídeo em mp3: ${url}`);

        try {
            await youtubedl(url, {
                extractAudio: true, 
                audioFormat: 'mp3',
                audioQuality: 0,
                output: outputPath,
                noCheckCertificates: true,
                noWarnings: true,
                addHeader: ['referer:youtube.com', 'user-agent:googlebot']
            });

            console.log('Download da música concluído!');
            return outputPath;

        } catch (error) {
            console.log(`Ocorreu um erro! :c `, error);
            throw error;
        }
    }

    async recuperarMetaDadosVideo(url) {
        try {
            const metadados = await youtubedl(url, {
                dumpJson: true,
                noCheckCertificates: true,
                noWarnings: true,
                addHeader: ['refer:youtube.com', 'user-agent:googlebot']
            });

            return {
                titulo: metadados.title,
                autor: metadados.uploader,
                duracao: metadados.duration_string
            };
        } catch (error) {
            console.error('Erro ao buscar as informações do link:', error);
            return { titulo: 'Música Desconhecida', autor: 'YouTube' };
        }
    }
}

module.exports = new YoutubeService();

// Talvez ter um agente que recebe os nomes, faz a pesquisa da musica, encontra o link, baixa pela baixarVideoEmMp3 e retorna