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

        console.log(`Iniciando download: ${url}`);

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

    async baixarMusica(url) {

    }
}

module.exports = new YoutubeService();